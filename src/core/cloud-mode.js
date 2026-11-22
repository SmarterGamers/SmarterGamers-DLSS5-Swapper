'use strict';

// Cloud gaming / browser mode.
//
// DLSS cannot reach a game that runs on someone else's server (Xbox Cloud
// Gaming, Remote Play): the browser only plays video. What does help is
//   1. the browser's hardware acceleration, so video decode and RTX Video
//      Super Resolution run on the GPU,
//   2. RTX Video Super Resolution in the NVIDIA driver (AI upscaling of the
//      stream), and
//   3. a Lossless Scaling profile tied to the browser (frame generation).
// This module holds the rules and the file edits for those three. It takes no
// Electron and no global state, so every rule can be tested with temp files.
const fs = require('fs');
const path = require('path');

const BROWSERS = {
  chrome: {
    id: 'chrome',
    name: 'Google Chrome',
    exe: 'chrome.exe',
    userData: ['Google', 'Chrome', 'User Data'],
    installs: [
      ['PROGRAMFILES', 'Google', 'Chrome', 'Application', 'chrome.exe'],
      ['PROGRAMFILES(X86)', 'Google', 'Chrome', 'Application', 'chrome.exe'],
      ['LOCALAPPDATA', 'Google', 'Chrome', 'Application', 'chrome.exe']
    ]
  },
  edge: {
    id: 'edge',
    name: 'Microsoft Edge',
    exe: 'msedge.exe',
    userData: ['Microsoft', 'Edge', 'User Data'],
    installs: [
      ['PROGRAMFILES(X86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['PROGRAMFILES', 'Microsoft', 'Edge', 'Application', 'msedge.exe']
    ]
  }
};

const PROFILE_PREFIX = 'Cloud Gaming - ';
const CLOUD_URL = 'https://www.xbox.com/play';

function exists(file) { try { return fs.existsSync(file); } catch { return false; } }

function envPath(env, parts) {
  const [variable, ...rest] = parts;
  const base = env[variable];
  return base ? path.join(base, ...rest) : null;
}

// ---------------- browsers ----------------

function browserExe(id, env = process.env) {
  const browser = BROWSERS[id];
  if (!browser) return null;
  for (const parts of browser.installs) {
    const file = envPath(env, parts);
    if (file && exists(file)) return file;
  }
  return null;
}

function localStatePath(id, env = process.env) {
  const browser = BROWSERS[id];
  if (!browser || !env.LOCALAPPDATA) return null;
  return path.join(env.LOCALAPPDATA, ...browser.userData, 'Local State');
}

function readJson(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  return JSON.parse(text);
}

// Chrome and Edge keep "Use graphics acceleration when available" in the
// profile folder's Local State. A missing key means the browser default: on.
function hardwareAcceleration(id, env = process.env) {
  const file = localStatePath(id, env);
  if (!file || !exists(file)) return { known: false, enabled: null, file };
  try {
    const mode = readJson(file).hardware_acceleration_mode;
    const enabled = mode && typeof mode.enabled === 'boolean' ? mode.enabled : true;
    return { known: true, enabled, file };
  } catch (error) {
    return { known: false, enabled: null, file, error: error.message };
  }
}

// The browser rewrites Local State when it exits, so an edit made while it
// runs is lost. The caller says whether the browser is running; this refuses
// rather than writing a change that would silently disappear.
function enableHardwareAcceleration(id, { running, env = process.env } = {}) {
  const current = hardwareAcceleration(id, env);
  if (!current.known) return { ok: false, reason: 'cloudNoBrowserProfile' };
  if (current.enabled) return { ok: true, changed: false };
  if (running) return { ok: false, reason: 'cloudCloseBrowser' };
  const data = readJson(current.file);
  data.hardware_acceleration_mode = { ...(data.hardware_acceleration_mode || {}), enabled: true };
  writeAtomic(current.file, JSON.stringify(data));
  return { ok: true, changed: true };
}

function writeAtomic(file, text) {
  const temp = file + '.sg-tmp';
  fs.writeFileSync(temp, text, 'utf8');
  fs.renameSync(temp, file);
}

// ---------------- RTX Video Super Resolution ----------------

// The NVIDIA app stores RTX Video settings on the display adapter's class key.
// Observed on driver 621.14: _User_Global_VAL_SuperResolution is 0 when off
// and the quality level 1-4 when on; _User_Global_VAL_SuperResolution_Auto is
// 1 when the NVIDIA app picks the level itself. This is not a published API,
// so anything unexpected is reported as unknown rather than guessed.
const DISPLAY_CLASS_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';

// Parses `reg query <DISPLAY_CLASS_KEY> /s /f SuperResolution /v` output.
function parseVsr(regOutput) {
  const values = {};
  for (const line of String(regOutput || '').split(/\r?\n/)) {
    const match = line.match(/^\s+(_User_Global_VAL_SuperResolution(?:_Auto)?)\s+REG_DWORD\s+0x([0-9a-f]+)/i);
    if (match && !(match[1] in values)) values[match[1]] = parseInt(match[2], 16);
  }
  const level = values._User_Global_VAL_SuperResolution;
  if (level === undefined) return { known: false, enabled: null, level: null, auto: false };
  const auto = values._User_Global_VAL_SuperResolution_Auto === 1;
  if (!Number.isInteger(level) || level < 0 || level > 4) return { known: false, enabled: null, level, auto };
  return { known: true, enabled: level > 0 || auto, level, auto };
}

// ---------------- processes ----------------

// Parses `tasklist /FO CSV /NH` into a set of lower-case image names.
function runningImages(tasklistCsv) {
  const names = new Set();
  for (const line of String(tasklistCsv || '').split(/\r?\n/)) {
    const match = line.match(/^"([^"]+)"/);
    if (match) names.add(match[1].toLowerCase());
  }
  return names;
}

// ---------------- Lossless Scaling ----------------

const LS_APP_ID = '993090';

function steamLibraries(steamRoot) {
  const roots = steamRoot ? [steamRoot] : [];
  const vdf = steamRoot && path.join(steamRoot, 'steamapps', 'libraryfolders.vdf');
  if (vdf && exists(vdf)) {
    try {
      const text = fs.readFileSync(vdf, 'utf8');
      for (const match of text.matchAll(/"path"\s+"([^"]+)"/g)) roots.push(match[1].replace(/\\\\/g, '\\'));
    } catch {}
  }
  return [...new Set(roots.map(root => path.normalize(root).toLowerCase()))].map(lower => roots.find(r => path.normalize(r).toLowerCase() === lower));
}

function losslessExe({ steamRoot, env = process.env } = {}) {
  const root = steamRoot || envPath(env, ['PROGRAMFILES(X86)', 'Steam']);
  for (const library of steamLibraries(root)) {
    const file = path.join(library, 'steamapps', 'common', 'Lossless Scaling', 'LosslessScaling.exe');
    if (exists(file)) return file;
  }
  return null;
}

function losslessSettingsPath(env = process.env) {
  return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Lossless Scaling', 'Settings.xml') : null;
}

// Flow scale is the share of the input resolution the frame generator studies
// for motion. Lossless Scaling's own guidance: 100% at 1080p, lower above it.
function flowScaleFor(displayHeight) {
  const height = Number(displayHeight) || 1080;
  if (height <= 1080) return 100;
  if (height <= 1440) return 75;
  return 50;
}

// Frame generation can never show more frames than the monitor refreshes, so
// the adaptive target is the refresh rate, clamped to what the app accepts.
// Windows reports NTSC-style rates as 59 / 119 / 239 (59.94 Hz and so on);
// those are the 60 / 120 / 240 Hz modes and get the round target.
function targetFor(refreshRate) {
  let hz = Math.round(Number(refreshRate) || 60);
  if (hz % 10 === 9) hz += 1;
  return Math.min(360, Math.max(30, hz));
}

function profileTitle(id) { return PROFILE_PREFIX + BROWSERS[id].name; }

// The values the cloud profile sets on top of the app's own Default profile.
function profileValues(id, display = {}) {
  return {
    Title: profileTitle(id),
    AutoScale: 'false',
    ScalingType: 'Off',
    FrameGeneration: 'LSFG3',
    LSFG3Mode1: 'ADAPTIVE',
    LSFG3Target: String(targetFor(display.refreshRate)),
    LSFGFlowScale: String(flowScaleFor(display.height)),
    MaxFrameLatency: '1',
    HideCursor: 'true',
    DrawFps: 'true',
    CaptureApi: 'WGC'
  };
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function profileBlocks(xml) {
  return [...String(xml).matchAll(/([ \t]*)<Profile>[\s\S]*?<\/Profile>/g)].map(match => {
    const title = (match[0].match(/<Title>([\s\S]*?)<\/Title>/) || [])[1] || '';
    return { text: match[0], indent: match[1], title, index: match.index };
  });
}

function setElement(block, name, value) {
  const pattern = new RegExp(`<${name}>[\\s\\S]*?</${name}>|<${name}\\s*/>`);
  const element = `<${name}>${xmlEscape(value)}</${name}>`;
  if (pattern.test(block)) return block.replace(pattern, element);
  // Not in the app's current schema: add it after the title, where the app's
  // own profile editor writes its application path.
  const indent = (block.match(/\n([ \t]+)<Title>/) || [])[1] || '      ';
  return block.replace(/(<Title>[\s\S]*?<\/Title>)/, `$1\n${indent}${element}`);
}

// Builds the cloud profile from the app's own Default profile, so every
// setting this module does not care about keeps the value and schema of the
// Lossless Scaling version that is installed.
function buildProfile(defaultBlock, id, display) {
  let block = defaultBlock.trim();
  for (const [name, value] of Object.entries(profileValues(id, display))) block = setElement(block, name, value);
  // The application the profile belongs to. Lossless Scaling matches it
  // against the window being scaled when the hotkey is pressed.
  block = setElement(block, 'Path', BROWSERS[id].exe);
  return block;
}

// Adds the browser's profile, or replaces the one this module wrote before.
// Every other profile, and every setting outside <GameProfiles>, is left as is.
function upsertCloudProfile(xml, id, display) {
  const blocks = profileBlocks(xml);
  if (!blocks.length || !/<\/GameProfiles>/.test(xml)) throw new Error('Lossless Scaling settings have no profiles to copy from.');
  const base = blocks.find(block => block.title === 'Default') || blocks[0];
  const fresh = buildProfile(base.text, id, display);
  const existing = blocks.find(block => block.title === profileTitle(id));
  const indent = base.indent || '    ';
  if (existing) {
    return xml.slice(0, existing.index) + existing.indent + fresh + xml.slice(existing.index + existing.text.length);
  }
  return xml.replace(/(\r?\n)?([ \t]*)<\/GameProfiles>/, (match, newline = '\n', closeIndent) =>
    `${newline}${indent}${fresh}${newline}${closeIndent}</GameProfiles>`);
}

function hasCloudProfile(xml, id) {
  return profileBlocks(xml).some(block => block.title === profileTitle(id));
}

// A cheap structural check before the file is replaced: every element that
// opens must close, in order. Lossless Scaling resets to defaults when it
// cannot read its settings, so a broken write would lose the user's profiles.
function wellFormed(xml) {
  const stack = [];
  const body = String(xml).replace(/<\?xml[\s\S]*?\?>/, '');
  for (const match of body.matchAll(/<(\/?)([A-Za-z_][\w.-]*)[^>]*?(\/?)>/g)) {
    const [, closing, name, selfClosing] = match;
    if (selfClosing) continue;
    if (!closing) stack.push(name);
    else if (stack.pop() !== name) return false;
  }
  return stack.length === 0;
}

// Writes the browser's profile into Lossless Scaling's settings. The app keeps
// its settings in memory and saves them on exit, so the caller must close it
// first (running: true is refused). The first edit of a day keeps a backup.
function writeLosslessProfile(id, { display, running, env = process.env, now = new Date() } = {}) {
  if (!BROWSERS[id]) return { ok: false, reason: 'cloudUnknownBrowser' };
  const file = losslessSettingsPath(env);
  if (!file || !exists(file)) return { ok: false, reason: 'cloudLosslessNoSettings' };
  if (running) return { ok: false, reason: 'cloudLosslessRunning' };
  const before = fs.readFileSync(file, 'utf8');
  const after = upsertCloudProfile(before, id, display);
  if (!wellFormed(after)) return { ok: false, reason: 'cloudLosslessBadXml' };
  // Local date, so the backup is named for the day the user made the change.
  const stamp = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  const backup = file.replace(/\.xml$/i, `.before-cloud-mode-${stamp}.xml`);
  if (!exists(backup)) fs.copyFileSync(file, backup);
  writeAtomic(file, after);
  return { ok: true, changed: before !== after, backup, title: profileTitle(id) };
}

function losslessStatus(id, env = process.env) {
  const file = losslessSettingsPath(env);
  if (!file || !exists(file)) return { settings: false, profile: false };
  try { return { settings: true, profile: hasCloudProfile(fs.readFileSync(file, 'utf8'), id) }; }
  catch { return { settings: false, profile: false }; }
}

module.exports = {
  BROWSERS, CLOUD_URL, DISPLAY_CLASS_KEY, LS_APP_ID, PROFILE_PREFIX,
  browserExe, localStatePath, hardwareAcceleration, enableHardwareAcceleration,
  parseVsr, runningImages,
  steamLibraries, losslessExe, losslessSettingsPath, losslessStatus,
  flowScaleFor, targetFor, profileTitle, profileValues,
  buildProfile, upsertCloudProfile, hasCloudProfile, wellFormed, writeLosslessProfile
};
