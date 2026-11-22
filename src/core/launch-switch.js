'use strict';

// The folder facts the DirectX 11 / 12 launch switch is decided from. Kept
// apart from main.js so the rules can be tested without Electron.
const fs = require('fs');
const path = require('path');
const launchApi = require('../shared/launch-api');

function exists(file) { try { return fs.existsSync(file); } catch { return false; } }

function factsFor(gameDir, exePath) {
  const exeDir = path.dirname(exePath);
  const exeName = path.basename(exePath);
  const stem = exeName.replace(/\.exe$/i, '');
  return {
    exeName,
    hasUnityPlayer: exists(path.join(exeDir, 'UnityPlayer.dll')),
    hasUnityData: exists(path.join(exeDir, stem + '_Data')),
    hasUnrealEngineDir: exists(path.join(gameDir, 'Engine', 'Binaries')),
    inBinariesWin64: /[\\/]Binaries[\\/]Win(?:64|GDK)$/i.test(exeDir)
  };
}

// What the sheet shows and Play acts on for one executable.
function forExe(gameDir, exePath) {
  if (typeof gameDir !== 'string' || typeof exePath !== 'string' || !exePath) return launchApi.describe(null);
  return launchApi.describe(launchApi.engineFor(factsFor(gameDir, exePath)));
}

// Xbox app games start through the store's launcher, which takes no arguments
// from outside, so the sheet must not promise a switch Play cannot deliver.
function forGame(gameDir, exePath, launcher) {
  if (launcher === 'Xbox') return { ...launchApi.describe(null), reason: 'launchSwitchStore' };
  const info = forExe(gameDir, exePath);
  return { ...info, reason: info.supported ? null : 'launchSwitchUnsupported' };
}

module.exports = { factsFor, forExe, forGame };