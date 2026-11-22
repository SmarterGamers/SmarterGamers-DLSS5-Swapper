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
    path.join(exeDir, 'D3D12', 'D3D12Core.dll'),
    path.join(exeDir, 'D3D12Core.dll'),
    path.join(gameDir, 'D3D12Core.dll'),
    path.join(gameDir, 'D3D12', 'D3D12Core.dll'),
    path.join(gameDir, 'D3D12', 'x64', 'D3D12Core.dll')
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
    path.join(gameDir, 'win64', 'nvngx_dlss.dll'),
    path.join(gameDir, 'Wardogs', 'Plugins', 'External', 'Nvidia', 'DLSS', 'Binaries', 'ThirdParty', 'Win64', 'nvngx_dlss.dll'),
    path.join(gameDir, 'Engine', 'Plugins', 'Marketplace', 'DLSS', 'Binaries', 'ThirdParty', 'Win64', 'nvngx_dlss.dll'),
    path.join(gameDir, 'Plugins', 'NVIDIA', 'DLSS', 'Binaries', 'ThirdParty', 'Win64', 'nvngx_dlss.dll'),
    path.join(gameDir, 'Plugins', 'External', 'Nvidia', 'DLSS', 'Binaries', 'ThirdParty', 'Win64', 'nvngx_dlss.dll')
  ];

  for (const p of pluginPaths) {
    if (fs.existsSync(p)) return p;
  }

  // Recursive search in Plugins or subdirectories for nvngx_dlss.dll
  try {
    const skipDirs = new Set([
      '.git', 'node_modules', '_dlss5_backup', '_dlss5_mod_disabled',
      'win-arm64ec', 'arm64', 'win32', 'saved', 'intermediate', 'deriveddatacache'
    ]);
    const findInDir = (dir, depth = 0) => {
      if (depth > 6) return null;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return null;
      }
      for (const e of entries) {
        if (e.isFile() && /^nvngx_dlss\.dll$/i.test(e.name)) {
          return path.join(dir, e.name);
        }
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const lower = e.name.toLowerCase();
        if (skipDirs.has(lower)) continue;
        const matchesStructure = depth === 0 ||
          /(plugins|external|nvidia|dlss|streamline|thirdparty|binaries|win64|engine|marketplace)/i.test(e.name) ||
          e.name.toLowerCase() === path.basename(gameDir).toLowerCase();
        if (matchesStructure) {
          const res = findInDir(path.join(dir, e.name), depth + 1);
          if (res) return res;
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
 * Optimizes Dagor Engine (War Thunder) config.blk for Native DLSS 5 Neural Rendering
 */
function optimizeDagorConfigBlk(gameDir) {
  const configPath = path.join(gameDir, 'config.blk');
  if (!fs.existsSync(configPath)) return null;
  let content;
  try {
    content = fs.readFileSync(configPath, 'utf8');
  } catch {
    return null;
  }

  const backupPath = path.join(gameDir, 'config.blk.bak');
  try {
    if (!fs.existsSync(backupPath)) {
      fs.writeFileSync(backupPath, content, 'utf8');
    }
  } catch {}

  let updated = content;

  // Helper to update or insert a key inside a named top-level block (e.g. video{ ... } or graphics{ ... })
  const setBlockKey = (src, blockName, keyName, typeTag, valueStr) => {
    const blockRe = new RegExp(`(^|\\r?\\n)(${blockName}\\s*\\{)([\\s\\S]*?)(\\r?\\n\\})`, 'i');
    const match = src.match(blockRe);
    if (!match) return src;
    let body = match[3];
    const keyRe = new RegExp(`(^|\\r?\\n)([ \\t]*)${keyName}:${typeTag}=[^\\r\\n]*`, 'i');
    if (keyRe.test(body)) {
      body = body.replace(keyRe, `$1$2${keyName}:${typeTag}=${valueStr}`);
    } else {
      body = body + `\r\n  ${keyName}:${typeTag}=${valueStr}`;
    }
    return src.replace(blockRe, `$1$2${body}$4`);
  };

  // 1. DirectX 12 is mandatory for Dagor Engine's Streamline 2.14 DLSS 5 Neural Rendering path
  updated = setBlockKey(updated, 'video', 'driver', 't', '"dx12"');
  // 2. Enable Native DLSS 5 Neural Rendering (DataBlock::getBool("neuralRendering", false))
  updated = setBlockKey(updated, 'video', 'neuralRendering', 'b', 'yes');
  // 3. Ensure DLSS Super Resolution Quality + NVIDIA Reflex Low Latency
  updated = setBlockKey(updated, 'video', 'antialiasing_mode', 't', '"dlss"');
  updated = setBlockKey(updated, 'video', 'antialiasing_upscaling', 't', '"quality"');
  updated = setBlockKey(updated, 'video', 'antialiasing_sharpening', 'i', '15');
  updated = setBlockKey(updated, 'video', 'latency', 'i', '1');
  // 4. Enable F9 live toggle for DLSS 5 Neural Rendering comparison in debug block
  updated = setBlockKey(updated, 'debug', 'remapF9toDLSS5', 'b', 'yes');
  // 5. Tune heavy frametime settings in graphics block for locked 60+ FPS on 8GB VRAM @ 1440p
  updated = setBlockKey(updated, 'graphics', 'mirrorQuality', 'i', '5');
  updated = setBlockKey(updated, 'graphics', 'grassRadiusMul', 'r', '1.0');
  updated = setBlockKey(updated, 'graphics', 'rendinstDistMul', 'r', '1.8');

  if (updated !== content) {
    try {
      fs.writeFileSync(configPath, updated, 'utf8');
      return {
        updated: true,
        configPath,
        backupPath
      };
    } catch {
      return { updated: false, configPath };
    }
  }
  return { updated: false, configPath, alreadyOptimized: true };
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
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
        if (m.game && m.game.exe) exePath = path.join(gameDir, m.game.exe);
      } catch {}
    }
    if (!exePath && fs.existsSync(path.join(gameDir, 'win64', 'aces.exe'))) {
      exePath = path.join(gameDir, 'win64', 'aces.exe');
    }
  }

  const exeDir = exePath ? path.dirname(exePath) : gameDir;
  const dumps = findCrashDumps(gameDir, exePath);
  const latestDump = dumps.find(d => d.deviceRemovedReasonCode || d.engineVersion) || dumps[0] || null;

  let manifest = null;
  const manifestPath = path.join(gameDir, '_DLSS5_Backup', 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '')); } catch {}
  }

  const agilitySdkPath = findAgilitySdk(gameDir, exeDir);
  const nativePluginDlss = findNativeDlssPlugin(gameDir);

  // Check files in exeDir
  let hasDxgi = false;
  let isDxgiReShade = false;
  const addons = [];
  let hasDlssnr = false;
  let hasNativeSlDlssNr = false;
  let slDlssNrVersion = null;
  let hasDisabledLegacyModDir = false;

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
        } else if (lower === 'sl.dlss_nr.dll') {
          hasNativeSlDlssNr = true;
          try { slDlssNrVersion = pe.getFileVersion(path.join(exeDir, file)); } catch {}
        } else if (lower === '_dlss5_mod_disabled') {
          hasDisabledLegacyModDir = true;
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

  // Check Dagor Engine config.blk if present
  let needsDagorDlss5Config = false;
  const dagorConfigPath = path.join(gameDir, 'config.blk');
  if (hasNativeSlDlssNr && fs.existsSync(dagorConfigPath)) {
    try {
      const blk = fs.readFileSync(dagorConfigPath, 'utf8');
      const hasNr = /neuralRendering:b=yes/i.test(blk);
      const hasDx12 = /driver:t="dx12"/i.test(blk);
      if (!hasNr || !hasDx12) {
        needsDagorDlss5Config = true;
      }
    } catch {}
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
  } else if (addons.length === 1 && (hasAgilityConflict || hasNativeSlDlssNr)) {
    conflictingFiles.push(path.relative(gameDir, path.join(exeDir, addons[0])));
  }

  // Check 3: DLSS-NR (Neural Reconstruction) injected on unsupported pipeline (NOT when game has native sl.dlss_nr.dll!)
  const isGpuAmpereOrTuring = latestDump?.gpuBrand ? /RTX\s*(30|20|16)/i.test(latestDump.gpuBrand) : false;
  const hasDlssnrConflict = Boolean(hasDlssnr && !hasNativeSlDlssNr && (isGpuAmpereOrTuring || hardwareRayTracingDisabled || nativePluginDlss));
  if (hasDlssnrConflict) {
    rootCauses.push(
      'DLSS-NR (nvngx_dlssnr.dll) was injected into a non-DLSS-NR game directory without native Streamline sl.dlss_nr.dll support, resulting in shader descriptor conflicts.'
    );
    conflictingFiles.push(path.relative(gameDir, path.join(exeDir, 'nvngx_dlssnr.dll')));
  }

  // Check 4: Preview / Unstable Neural DLSS DLL (310.9.1.0) on non-DLSS5 Streamline 2.11 games
  let dlssVersion = null;
  if (fs.existsSync(path.join(exeDir, 'nvngx_dlss.dll'))) {
    try { dlssVersion = pe.getFileVersion(path.join(exeDir, 'nvngx_dlss.dll')); } catch {}
  } else if (nativePluginDlss && fs.existsSync(nativePluginDlss)) {
    try { dlssVersion = pe.getFileVersion(nativePluginDlss); } catch {}
  }

  let hasPreviewDlssIssue = false;
  if (dlssVersion && /^310\.9\.[01]\./.test(dlssVersion) && !hasNativeSlDlssNr) {
    hasPreviewDlssIssue = true;
    rootCauses.push(
      `Experimental preview DLSS build (${dlssVersion}) detected. On NVIDIA drivers >= 616.64, this version triggers driver neural/watchdog timeouts (nvlddmkm Event ID 153 / DXGI_ERROR_DEVICE_HUNG) when paired with Streamline 2.11.`
    );
  }

  // Check 5: Native DLSS 5 game with stale ReShade manifest or unenabled config.blk neuralRendering
  const hasStaleReShadeManifest = Boolean(manifest && manifest.route !== 'pure-native' && hasNativeSlDlssNr);
  if (hasNativeSlDlssNr && needsDagorDlss5Config) {
    rootCauses.push(
      `Game natively ships with NVIDIA DLSS 5 Neural Rendering (${dlssVersion || '310.9.16.0'} + Streamline ${slDlssNrVersion || '2.14.16.0'}), but config.blk does not yet have video { neuralRendering:b=yes; driver:t="dx12" } enabled.`
    );
  }
  if (hasStaleReShadeManifest || hasDisabledLegacyModDir) {
    rootCauses.push(
      'Stale ReShade proxy manifest or disabled mod artifacts detected in a game that now supports Pure Native DLSS 5 Neural Rendering.'
    );
  }

  const hasCrash = Boolean(latestDump || rootCauses.length > 0);
  const errorCode = latestDump?.deviceRemovedReasonCode ||
    (latestDump?.deviceRemovedReason ? '0x887A0006' : null) ||
    ((latestDump?.isStuck || latestDump?.crashType === 'GPUCrash') ? '0x887A0006' : null);
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
    errorCode: errorCode ? `${errorCode} (${errorInfo ? errorInfo.name : (latestDump?.deviceRemovedReason || 'DXGI_ERROR_DEVICE_HUNG')})` : null,
    errorDescription: errorInfo?.description || latestDump?.errorMessage || null,
    engine: hasNativeSlDlssNr && fs.existsSync(dagorConfigPath)
      ? 'Dagor Engine 6.5 (Native DLSS 5 Neural Rendering + Streamline 2.14)'
      : (latestDump?.engineVersion ? `Unreal Engine ${latestDump.engineVersion.split('-')[0]}` : (agilitySdkPath ? 'Unreal Engine (D3D12 Agility SDK)' : null)),
    gpu: latestDump?.gpuBrand || null,
    hasAgilityConflict,
    hasAddonConflict,
    hasDlssnrConflict,
    hasPreviewDlssIssue,
    hasNativeSlDlssNr,
    slDlssNrVersion,
    needsDagorDlss5Config,
    hasStaleReShadeManifest,
    dlssVersion,
    nativePluginDlss: nativePluginDlss ? path.relative(gameDir, nativePluginDlss) : null,
    rootCauses,
    conflictingFiles: [...new Set(conflictingFiles)],
    canAutoFix: conflictingFiles.length > 0 || hasCrash || needsDagorDlss5Config || hasStaleReShadeManifest,
    recommendedAction: hasNativeSlDlssNr
      ? 'Optimize for Pure Native DLSS 5 Neural Rendering: preserve official nvngx_dlssnr.dll + sl.dlss_nr.dll runtime, purge stale ReShade proxy hooks, and enable DX12 + neuralRendering:b=yes in config.blk.'
      : (nativePluginDlss
        ? 'Switch to Pure Native DLSS mode. Safely purge ReShade proxy hooks, duplicate add-ons, and DLSS-NR from the executable folder, preserving the upgraded DLSS DLL inside the native plugin directory.'
        : 'Remove conflicting proxy injectors and optimize graphics settings for stable execution.')
  };
}

// Says what was actually found and changed: the versions read from the game's
// own DLSS-NR and Streamline files, and whether config.blk was edited.
function nativeDlss5Message(kept, configResult) {
  const versionOf = (name) => (kept.find(k => path.basename(k.rel).toLowerCase() === name) || {}).version;
  const nr = versionOf('nvngx_dlssnr.dll');
  const sl = versionOf('sl.dlss_nr.dll');
  const runtime = [nr && `DLSS-NR ${nr}`, sl && `Streamline ${sl}`].filter(Boolean).join(' + ');
  const config = configResult?.updated ? ' DX12 and neuralRendering enabled in config.blk (backup: config.blk.bak).'
    : configResult?.alreadyOptimized ? ' config.blk already had DX12 and neuralRendering enabled.'
      : configResult ? ' config.blk could not be updated.' : '';
  return `Auto-optimization completed: the game's own DLSS 5 Neural Rendering runtime was kept${runtime ? ` (${runtime})` : ''}.${config}`;
}

/**
 * Automatically Fixes and Optimizes Game to Pure Native DLSS / DLSS 5 mode
 */
async function optimizeGame(gameDir, options = {}) {
  const diagnosis = diagnoseGame(gameDir);
  const manifestPath = path.join(gameDir, '_DLSS5_Backup', 'manifest.json');
  let manifest = null;

  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
    } catch {}
  }

  const removed = [];
  const kept = [];
  let exePath = manifest?.game?.exe ? path.join(gameDir, manifest.game.exe) : null;
  if (!exePath && fs.existsSync(path.join(gameDir, 'win64', 'aces.exe'))) {
    exePath = path.join(gameDir, 'win64', 'aces.exe');
  }
  const exeDir = exePath ? path.dirname(exePath) : gameDir;
  const hasNativeSlDlssNr = fs.existsSync(path.join(exeDir, 'sl.dlss_nr.dll'));

  // 1. Files to remove from exeDir to eliminate proxy hook conflicts
  // NEVER purge nvngx_dlssnr.dll when the game has native Streamline DLSS-NR (sl.dlss_nr.dll)!
  const filesToPurge = [
    'dxgi.dll',
    'renodx-dlss5.addon64',
    'renodx-dlss.addon64',
    'dlss5-feed.addon64',
    'dlss5-feed.cfg',
    ...(hasNativeSlDlssNr ? [] : ['nvngx_dlssnr.dll']),
    'ReShade.ini',
    'ReShade.log'
  ];

  // Also include any dlss5-lab-overlay-*.addon64
  if (fs.existsSync(exeDir)) {
    try {
      const existing = fs.readdirSync(exeDir);
      for (const f of existing) {
        if (/^dlss5-lab-overlay.*\.addon64$/i.test(f) || /^renodx.*\.addon64$/i.test(f) || /^dlss5-feed.*\.addon64$/i.test(f)) {
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
        if (!removed.includes(rel)) removed.push(rel);
      } catch (err) {
        // EPERM or busy
      }
    }
  }

  // Clean up legacy _DLSS5_Mod_Disabled inside exeDir by moving it into _DLSS5_Backup/legacy_disabled_mod
  const disabledModDir = path.join(exeDir, '_DLSS5_Mod_Disabled');
  if (fs.existsSync(disabledModDir)) {
    const archiveDir = path.join(gameDir, '_DLSS5_Backup', 'legacy_disabled_mod');
    try {
      if (!fs.existsSync(path.dirname(archiveDir))) fs.mkdirSync(path.dirname(archiveDir), { recursive: true });
      fs.renameSync(disabledModDir, archiveDir);
      removed.push(path.relative(gameDir, disabledModDir));
    } catch {}
  }

  // Also purge any conflicting files identified during diagnosis across subdirectories
  if (diagnosis?.conflictingFiles) {
    for (const rel of diagnosis.conflictingFiles) {
      const target = path.isAbsolute(rel) ? rel : path.join(gameDir, rel);
      if (fs.existsSync(target)) {
        try {
          fs.unlinkSync(target);
          const relPath = path.relative(gameDir, target);
          if (!removed.includes(relPath)) removed.push(relPath);
        } catch (err) {}
      }
    }
  }

  // 2. Handle DLSS file: rollback unstable 310.9.1.0 preview builds on non-DLSS5 games,
  //    or preserve official 310.9.16.0 native DLSS 5 runtime on native DLSS-NR games.
  const nativePlugin = findNativeDlssPlugin(gameDir);
  if (nativePlugin && fs.existsSync(nativePlugin)) {
    let currentVer = pe.getFileVersion(nativePlugin);
    if (/^310\.9\.[01]\./.test(currentVer) && !hasNativeSlDlssNr) {
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

  // Record native DLSS 5 Neural Rendering DLLs when present
  if (hasNativeSlDlssNr) {
    for (const nativeFile of ['nvngx_dlssnr.dll', 'nvngx_dlssd.dll', 'nvngx_dlssg.dll', 'sl.dlss_nr.dll', 'sl.interposer.dll']) {
      const full = path.join(exeDir, nativeFile);
      if (fs.existsSync(full)) {
        const rel = path.relative(gameDir, full);
        if (!kept.some(k => k.rel.toLowerCase() === rel.toLowerCase())) {
          kept.push({
            rel,
            version: pe.getFileVersion(full)
          });
        }
      }
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

  // 3. Optimize Dagor Engine config.blk if present
  let engineConfigOptimization = null;
  if (hasNativeSlDlssNr && fs.existsSync(path.join(gameDir, 'config.blk'))) {
    engineConfigOptimization = optimizeDagorConfigBlk(gameDir);
  }

  // 4. Update manifest.json cleanly
  if (manifest) {
    // Filter out removed files (and native DLSS-NR runtime when natively supported) from manifest.added
    if (Array.isArray(manifest.added)) {
      manifest.added = manifest.added.filter(addedRel => {
        const full = path.join(gameDir, addedRel);
        if (hasNativeSlDlssNr && /nvngx_dlssnr\.dll$/i.test(addedRel)) return false;
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

  // 5. Save optimization record
  const profilesDir = path.join(gameDir, '_DLSS5_Backup', '.profiles');
  try {
    if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir, { recursive: true });
    const optRecord = {
      optimized: true,
      mode: hasNativeSlDlssNr ? 'pure-native-dlss5' : 'pure-native',
      timestamp: new Date().toISOString(),
      previousCrash: diagnosis.errorCode,
      removedHooks: removed,
      retainedDlss: kept,
      engineConfigOptimization
    };
    fs.writeFileSync(path.join(profilesDir, 'optimization.json'), JSON.stringify(optRecord, null, 2), 'utf8');
  } catch {}

  return {
    ok: true,
    mode: hasNativeSlDlssNr ? 'pure-native-dlss5' : 'pure-native',
    message: hasNativeSlDlssNr
      ? nativeDlss5Message(kept, engineConfigOptimization)
      : 'Auto-fix completed successfully. Game profile optimized to Pure Native DLSS mode.',
    removed,
    kept,
    engineConfigOptimization,
    previousCrash: diagnosis.errorCode,
    diagnosis
  };
}

module.exports = {
  diagnoseGame,
  optimizeGame,
  optimizeDagorConfigBlk,
  findCrashDumps,
  parseGpuCrashDump,
  CRASH_CODES
};
