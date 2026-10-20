'use strict';

/**
 * DLSS 5 Swapper - Crash Review, Diagnostics & Auto-Optimizer
 * 
 * Automatically discovers, parses, and diagnoses game crash logs (including NVIDIA Aftermath
 * GPU crash dumps .nv-gpudmp, Unreal Engine FGenericCrashContext XML, ReShade logs, and Sentry reports).
 * Detects known architectural collisions such as:
 *  1. D3D12 Agility SDK (D3D12Core.dll) vs ReShade dxgi.dll deadlock (DXGI_ERROR_DEVICE_HUNG 0x887A0006)
 *  2. ReShade duplicate add-on heap collisions (.addon64)
 *  3. Incompatible DLSS-NR (nvngx_dlssnr.dll) injection on Ampere/Turing without hardware ray tracing
 * 
 * Provides automated 1-click optimization to Pure Native DLSS mode, safely stripping conflicting
 * proxy injectors while keeping upgraded DLSS DLLs active in the native game/plugin folders.
 */

const fs = require('fs');
const path = require('path');
const pe = require('./pe');
const journal = require('./file-journal');

// Known crash codes
const CRASH_CODES = {
  '0x887A0006': {
    name: 'DXGI_ERROR_DEVICE_HUNG',
    description: 'The GPU device hung due to an invalid command or pipeline deadlock (Timeout Detection and Recovery / TDR).'
  },
  '0x887A0005': {
    name: 'DXGI_ERROR_DEVICE_REMOVED',
    description: 'The GPU device was removed, reset, or encountered an unrecoverable driver crash.'
  },
  '0x887A0001': {
    name: 'DXGI_ERROR_INVALID_CALL',
    description: 'The application provided invalid parameters to the DirectX Graphics Infrastructure.'
  },
  '0x887A002B': {
    name: 'DXGI_ERROR_ACCESS_DENIED',
    description: 'Access denied to DirectX Graphics Infrastructure device or resource.'
  }
};

/**
 * Searches potential LocalAppData directories for Unreal Engine / game logs
 */
function getPotentialLocalAppDataDirs(gameDir, exePath) {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return [];

  const candidates = new Set();
  const dirName = path.basename(gameDir);
  candidates.add(dirName);

  if (exePath) {
    const exeName = path.basename(exePath, path.extname(exePath));
    candidates.add(exeName);
    // Remove common Unreal shipping suffixes
    const stripped = exeName
      .replace(/-Win64-Shipping$/i, '')
      .replace(/Client-Win64-Shipping$/i, '')
      .replace(/-Shipping$/i, '')
      .replace(/Client$/i, '');
    if (stripped) candidates.add(stripped);
  }

  // Also look for game folder sub-names (e.g. Wardogs/Wardogs)
  try {
    const subdirs = fs.readdirSync(gameDir, { withFileTypes: true });
    for (const d of subdirs) {
      if (d.isDirectory()) {
        candidates.add(d.name);
      }
    }
  } catch {}

  const result = [];
  for (const name of candidates) {
    const logDir = path.join(localAppData, name, 'Saved', 'Logs');
    if (fs.existsSync(logDir)) result.push(logDir);
    const crashesDir = path.join(localAppData, name, 'Saved', 'Crashes');
    if (fs.existsSync(crashesDir)) result.push(crashesDir);
  }

  return result;
}

/**
 * Parses binary or text Aftermath crash dumps (.nv-gpudmp / .nvdbg)
 */
function parseGpuCrashDump(filePath) {
  try {
    const stat = fs.statSync(filePath);
    // Read up to 2MB to find crash context XML
    const readSize = Math.min(stat.size, 2 * 1024 * 1024);
    const buffer = Buffer.alloc(readSize);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, readSize, 0);
    fs.closeSync(fd);

    const str = buffer.toString('binary');
    const xmlMatch = str.match(/<FGenericCrashContext>[\s\S]*?<\/FGenericCrashContext>/);
    if (!xmlMatch) return null;

    const xml = xmlMatch[0];
    const extract = (tag) => {
      const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
      return m ? m[1].trim() : null;
    };

    return {
      file: path.basename(filePath),
      filePath,
      fileSize: stat.size,
      mtime: stat.mtime,
      crashType: extract('CrashType'),
      errorMessage: extract('ErrorMessage'),
      secondsSinceStart: Number(extract('SecondsSinceStart')) || null,
      gameName: extract('GameName'),
      engineVersion: extract('EngineVersion'),
      gpuBrand: extract('Misc.PrimaryGPUBrand') || extract('RHI.AdapterName'),
      rhiName: extract('RHI.RHIName'),
      deviceRemovedReason: extract('RHI.DeviceRemovedReason'),
      deviceRemovedReasonCode: extract('RHI.DeviceRemovedReasonCode'),
      d3dDeviceRemovedReason: extract('GPUCrash.D3DDeviceRemovedReason'),
      isStuck: extract('Misc.IsStuck') === 'true',
      stuckThreadId: extract('Misc.StuckThreadId'),
      baseDir: extract('BaseDir')
    };
  } catch (err) {
    return null;
  }
}

/**
 * Scans a directory for crash dumps
 */
function findCrashDumps(gameDir, exePath) {
  const searchDirs = [
    ...getPotentialLocalAppDataDirs(gameDir, exePath),
    path.join(gameDir, 'Saved', 'Logs'),
    path.join(gameDir, 'Saved', 'Crashes'),
    path.dirname(exePath || gameDir)
  ];

  const dumps = [];
  const visited = new Set();

  for (const dir of searchDirs) {
    if (!dir || visited.has(path.resolve(dir).toLowerCase())) continue;
    visited.add(path.resolve(dir).toLowerCase());

    if (!fs.existsSync(dir)) continue;

    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (/\.(nv-gpudmp|nvdbg|dmp)$/i.test(file)) {
          const fullPath = path.join(dir, file);
          const parsed = parseGpuCrashDump(fullPath);
          if (parsed) {
            dumps.push(parsed);
          } else {
            const stat = fs.statSync(fullPath);
            dumps.push({
              file,
              filePath: fullPath,
              fileSize: stat.size,
              mtime: stat.mtime,
              crashType: 'DumpFile',
              errorMessage: 'Binary Crash Dump'
            });
          }
        }
      }
    } catch {}
  }

  // Sort most recent first, prioritizing rich parsed XML dumps over raw companion dumps
  return dumps.sort((a, b) => {
    const timeDiff = b.mtime.getTime() - a.mtime.getTime();
    if (Math.abs(timeDiff) < 15000) {
      const aRich = Boolean(a.deviceRemovedReasonCode || a.engineVersion);
      const bRich = Boolean(b.deviceRemovedReasonCode || b.engineVersion);
      if (bRich && !aRich) return 1;
      if (aRich && !bRich) return -1;
    }
    return timeDiff;
  });
}

/**
 * Checks for D3D12 Agility SDK in or below game directory
 */
function findAgilitySdk(gameDir, exeDir) {
  const checkPaths = [
    path.join(exeDir, 'D3D12', 'x64', 'D3D12Core.dll'),
    path.join(exeDir, 'D3D12Core.dll'),
    path.join(gameDir, 'D3D12Core.dll')
  ];

  for (const p of checkPaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Checks if game has a native Unreal Engine NVIDIA DLSS plugin directory
 */
function findNativeDlssPlugin(gameDir) {
  const pluginPaths = [
    path.join(gameDir, 'Wardogs', 'Plugins', 'External', 'Nvidia', 'DLSS', 'Binaries', 'ThirdParty', 'Win64', 'nvngx_dlss.dll'),
    path.join(gameDir, 'Engine', 'Plugins', 'Marketplace', 'DLSS', 'Binaries', 'ThirdParty', 'Win64', 'nvngx_dlss.dll'),
    path.join(gameDir, 'Plugins', 'NVIDIA', 'DLSS', 'Binaries', 'ThirdParty', 'Win64', 'nvngx_dlss.dll'),
    path.join(gameDir, 'Plugins', 'External', 'Nvidia', 'DLSS', 'Binaries', 'ThirdParty', 'Win64', 'nvngx_dlss.dll')
  ];

  for (const p of pluginPaths) {
    if (fs.existsSync(p)) return p;
  }

  // General recursive search in Plugins/ for nvngx_dlss.dll
  try {
    const findInDir = (dir, depth = 0) => {
      if (depth > 6) return null;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && /^(plugins|external|nvidia|dlss|thirdparty|binaries|win64)$/i.test(e.name)) {
          const res = findInDir(full, depth + 1);
          if (res) return res;
        } else if (e.isFile() && /^nvngx_dlss\.dll$/i.test(e.name)) {
          return full;
        }
      }
      return null;
    };
    return findInDir(gameDir);
  } catch {
    return null;
  }
}

/**
 * Comprehensive Game Crash & Conflict Diagnosis
 */
function diagnoseGame(gameDir, exePath) {
  if (!exePath) {
    // Attempt auto-discovery
    const manifestPath = path.join(gameDir, '_DLSS5_Backup', 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (m.game && m.game.exe) exePath = path.join(gameDir, m.game.exe);
      } catch {}
    }
  }

  const exeDir = exePath ? path.dirname(exePath) : gameDir;
  const dumps = findCrashDumps(gameDir, exePath);
  const latestDump = dumps.find(d => d.deviceRemovedReasonCode || d.engineVersion) || dumps[0] || null;

  let manifest = null;
  const manifestPath = path.join(gameDir, '_DLSS5_Backup', 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
  }

  const agilitySdkPath = findAgilitySdk(gameDir, exeDir);
  const nativePluginDlss = findNativeDlssPlugin(gameDir);

  // Check files in exeDir
  let hasDxgi = false;
  let isDxgiReShade = false;
  const addons = [];
  let hasDlssnr = false;

  if (fs.existsSync(exeDir)) {
    try {
      const files = fs.readdirSync(exeDir);
      for (const file of files) {
        const lower = file.toLowerCase();
        if (lower === 'dxgi.dll') {
          hasDxgi = true;
          try {
            isDxgiReShade = pe.versionMentions(path.join(exeDir, file), 'ReShade');
          } catch {
            isDxgiReShade = true;
          }
          if (!isDxgiReShade && (manifest?.reshade?.installedByUs || manifest?.added?.some(a => a.toLowerCase().endsWith('dxgi.dll')) || agilitySdkPath)) {
            isDxgiReShade = true;
          }
        } else if (lower.endsWith('.addon64') || lower.endsWith('.addon')) {
          addons.push(file);
        } else if (lower === 'nvngx_dlssnr.dll') {
          hasDlssnr = true;
        }
      }
    } catch {}
  }

  // Check Engine.ini if available
  let hardwareRayTracingDisabled = false;
  const engineIniPaths = [
    path.join(process.env.LOCALAPPDATA || '', path.basename(gameDir), 'Saved', 'Config', 'WindowsClient', 'Engine.ini'),
    path.join(gameDir, 'Saved', 'Config', 'WindowsClient', 'Engine.ini')
  ];
  for (const ep of engineIniPaths) {
    if (fs.existsSync(ep)) {
      try {
        const content = fs.readFileSync(ep, 'utf8');
        if (/r\.Lumen\.HardwareRayTracing\s*=\s*0/i.test(content)) {
          hardwareRayTracingDisabled = true;
          break;
        }
      } catch {}
    }
  }

  // Root cause deduction
  const rootCauses = [];
  const conflictingFiles = [];

  // Check 1: Agility SDK vs ReShade dxgi.dll hook
  const hasAgilityConflict = Boolean(agilitySdkPath && hasDxgi && isDxgiReShade);
  if (hasAgilityConflict) {
    rootCauses.push(
      'DirectX 12 Agility SDK (D3D12Core.dll) deadlock with ReShade dxgi.dll hook during swapchain and command queue recreation.'
    );
    conflictingFiles.push(path.relative(gameDir, path.join(exeDir, 'dxgi.dll')));
  }

  // Check 2: Double ReShade Addon Conflict
  const hasAddonConflict = addons.length > 1;
  if (hasAddonConflict) {
    rootCauses.push(
      `Multiple ReShade add-ons (${addons.join(', ')}) hooked DirectX 12 descriptor heaps simultaneously, causing GPU pipeline resource collision.`
    );
    for (const addon of addons) {
      conflictingFiles.push(path.relative(gameDir, path.join(exeDir, addon)));
    }
  } else if (addons.length === 1 && hasAgilityConflict) {
    conflictingFiles.push(path.relative(gameDir, path.join(exeDir, addons[0])));
  }

  // Check 3: DLSS-NR (Neural Reconstruction) on unsupported pipeline or non-Blackwell without RT
  const isGpuAmpereOrTuring = latestDump?.gpuBrand ? /RTX\s*(30|20|16)/i.test(latestDump.gpuBrand) : true;
  const hasDlssnrConflict = Boolean(hasDlssnr && (isGpuAmpereOrTuring || hardwareRayTracingDisabled || nativePluginDlss));
  if (hasDlssnrConflict) {
    rootCauses.push(
      'DLSS-NR (nvngx_dlssnr.dll) was injected into the game directory on a GPU architecture (RTX 30-series / Ampere) with Hardware Ray Tracing disabled (r.Lumen.HardwareRayTracing=0), resulting in fatal shader descriptor loss.'
    );
    conflictingFiles.push(path.relative(gameDir, path.join(exeDir, 'nvngx_dlssnr.dll')));
  }

  // Check 4: Preview / Unstable Neural DLSS DLL (e.g. 310.9.1.0) on modern drivers
  let dlssVersion = null;
  if (nativePluginDlss && fs.existsSync(nativePluginDlss)) {
    try { dlssVersion = pe.getFileVersion(nativePluginDlss); } catch {}
  } else if (fs.existsSync(path.join(exeDir, 'nvngx_dlss.dll'))) {
    try { dlssVersion = pe.getFileVersion(path.join(exeDir, 'nvngx_dlss.dll')); } catch {}
  }

  let hasPreviewDlssIssue = false;
  if (dlssVersion && /^310\.9\./.test(dlssVersion)) {
    hasPreviewDlssIssue = true;
    rootCauses.push(
      `Experimental preview DLSS build (${dlssVersion}) detected. On NVIDIA drivers >= 616.64, this version triggers driver neural/watchdog timeouts (nvlddmkm Event ID 153 / DXGI_ERROR_DEVICE_HUNG) when paired with Streamline 2.11.`
    );
  }

  const hasCrash = Boolean(latestDump || rootCauses.length > 0);
  const errorCode = latestDump?.deviceRemovedReasonCode || (latestDump?.deviceRemovedReason ? '0x887A0006' : null);
  const errorInfo = errorCode ? CRASH_CODES[errorCode] : null;

  return {
    ok: true,
    crashed: hasCrash,
    crashCount: dumps.length,
    latestDump: latestDump ? {
      file: latestDump.file,
      mtime: latestDump.mtime,
      crashType: latestDump.crashType,
      errorMessage: latestDump.errorMessage,
      secondsSinceStart: latestDump.secondsSinceStart,
      engineVersion: latestDump.engineVersion,
      gpuBrand: latestDump.gpuBrand,
      rhiName: latestDump.rhiName,
      deviceRemovedReason: latestDump.deviceRemovedReason,
      deviceRemovedReasonCode: latestDump.deviceRemovedReasonCode,
      isStuck: latestDump.isStuck,
      stuckThreadId: latestDump.stuckThreadId
    } : null,
    errorCode: errorCode ? `${errorCode} (${errorInfo ? errorInfo.name : latestDump?.deviceRemovedReason})` : null,
    errorDescription: errorInfo?.description || latestDump?.errorMessage || null,
    engine: latestDump?.engineVersion ? `Unreal Engine ${latestDump.engineVersion.split('-')[0]}` : (agilitySdkPath ? 'Unreal Engine (D3D12 Agility SDK)' : null),
    gpu: latestDump?.gpuBrand || null,
    hasAgilityConflict,
    hasAddonConflict,
    hasDlssnrConflict,
    hasPreviewDlssIssue,
    dlssVersion,
    nativePluginDlss: nativePluginDlss ? path.relative(gameDir, nativePluginDlss) : null,
    rootCauses,
    conflictingFiles: [...new Set(conflictingFiles)],
    canAutoFix: conflictingFiles.length > 0 || hasCrash,
    recommendedAction: nativePluginDlss
      ? 'Switch to Pure Native DLSS mode. Safely purge ReShade proxy hooks, duplicate add-ons, and DLSS-NR from the executable folder, preserving the upgraded DLSS DLL inside the native plugin directory.'
      : 'Remove conflicting proxy injectors and optimize graphics settings for stable execution.'
  };
}

/**
 * Automatically Fixes and Optimizes Game to Pure Native DLSS mode
 */
async function optimizeGame(gameDir, options = {}) {
  const diagnosis = diagnoseGame(gameDir);
  const manifestPath = path.join(gameDir, '_DLSS5_Backup', 'manifest.json');
  let manifest = null;

  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {}
  }

  const removed = [];
  const kept = [];
  const exePath = manifest?.game?.exe ? path.join(gameDir, manifest.game.exe) : null;
  const exeDir = exePath ? path.dirname(exePath) : gameDir;

  // 1. Files to remove from exeDir to eliminate proxy hook conflicts
  const filesToPurge = [
    'dxgi.dll',
    'renodx-dlss5.addon64',
    'renodx-dlss.addon64',
    'nvngx_dlssnr.dll',
    'ReShade.ini',
    'ReShade.log'
  ];

  // Also include any dlss5-lab-overlay-*.addon64
  if (fs.existsSync(exeDir)) {
    try {
      const existing = fs.readdirSync(exeDir);
      for (const f of existing) {
        if (/^dlss5-lab-overlay.*\.addon64$/i.test(f) || /^renodx.*\.addon64$/i.test(f)) {
          if (!filesToPurge.includes(f)) filesToPurge.push(f);
        }
      }
    } catch {}
  }

  // Purge the conflicting files
  for (const name of filesToPurge) {
    const target = path.join(exeDir, name);
    if (fs.existsSync(target)) {
      try {
        fs.unlinkSync(target);
        const rel = path.relative(gameDir, target);
        removed.push(rel);
      } catch (err) {
        // EPERM or busy
      }
    }
  }

  // 2. Handle DLSS file: rollback preview builds or verify native DLSS replacement
  const nativePlugin = findNativeDlssPlugin(gameDir);
  if (nativePlugin && fs.existsSync(nativePlugin)) {
    let currentVer = pe.getFileVersion(nativePlugin);
    if (/^310\.9\./.test(currentVer)) {
      const relPath = path.relative(gameDir, nativePlugin);
      let restored = false;
      if (manifest?.replaced) {
        const rep = manifest.replaced.find(r => r.rel.toLowerCase() === relPath.toLowerCase());
        if (rep) {
          const origBackup = path.join(gameDir, '_DLSS5_Backup', manifest.backupPrefix || '', rep.rel);
          if (fs.existsSync(origBackup)) {
            try {
              fs.copyFileSync(origBackup, nativePlugin);
              currentVer = pe.getFileVersion(nativePlugin);
              restored = true;
            } catch {}
          }
        }
      }
      kept.push({
        rel: relPath,
        version: currentVer,
        revertedPreview: restored
      });
    } else {
      kept.push({
        rel: path.relative(gameDir, nativePlugin),
        version: currentVer
      });
    }
  }

  // Also check replaced files from manifest
  if (manifest?.replaced) {
    for (const rep of manifest.replaced) {
      const full = path.join(gameDir, rep.rel);
      if (fs.existsSync(full) && !kept.some(k => k.rel.toLowerCase() === rep.rel.toLowerCase())) {
        kept.push({
          rel: rep.rel,
          version: pe.getFileVersion(full) || rep.newVersion
        });
      }
    }
  }

  // 3. Update manifest.json cleanly
  if (manifest) {
    // Filter out removed files from manifest.added
    if (Array.isArray(manifest.added)) {
      manifest.added = manifest.added.filter(addedRel => {
        const full = path.join(gameDir, addedRel);
        return fs.existsSync(full) && !removed.some(r => r.toLowerCase() === addedRel.toLowerCase());
      });
    }

    manifest.route = 'pure-native';
    manifest.reshade = {
      installedByUs: false,
      file: null,
      filesAdded: []
    };
    delete manifest.labOverlay;

    try {
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    } catch {}
  }

  // 4. Save optimization record
  const profilesDir = path.join(gameDir, '_DLSS5_Backup', '.profiles');
  try {
    if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir, { recursive: true });
    const optRecord = {
      optimized: true,
      mode: 'pure-native',
      timestamp: new Date().toISOString(),
      previousCrash: diagnosis.errorCode,
      removedHooks: removed,
      retainedDlss: kept
    };
    fs.writeFileSync(path.join(profilesDir, 'optimization.json'), JSON.stringify(optRecord, null, 2), 'utf8');
  } catch {}

  return {
    ok: true,
    mode: 'pure-native',
    message: 'Auto-fix completed successfully. Game profile optimized to Pure Native DLSS mode.',
    removed,
    kept,
    previousCrash: diagnosis.errorCode,
    diagnosis
  };
}

module.exports = {
  diagnoseGame,
  optimizeGame,
  findCrashDumps,
  parseGpuCrashDump,
  CRASH_CODES
};
