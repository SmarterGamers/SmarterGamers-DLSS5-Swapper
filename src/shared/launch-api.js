'use strict';

// Per-game DirectX 11 / DirectX 12 launch switch.
//
// The API picker on a game's sheet records which renderer that game runs on,
// and the install routes follow it. For engines that take the renderer on the
// command line, Play can pass the same choice on, so one control switches both
// what the game starts as and what gets installed for it. Engines that keep
// the renderer in their own settings are left alone and say so.
//
// Only arguments from the table below are ever passed. Nothing typed by a
// person or read from a game folder reaches a command line or a Steam URL.
(function (root) {
  const ENGINES = Object.freeze({
    unreal: Object.freeze({ d3d11: Object.freeze(['-dx11']), d3d12: Object.freeze(['-dx12']) }),
    unity: Object.freeze({ d3d11: Object.freeze(['-force-d3d11']), d3d12: Object.freeze(['-force-d3d12']) })
  });
  const CHOICES = Object.freeze(['d3d11', 'd3d12']);
  const KNOWN_ARGS = new Set(Object.values(ENGINES).flatMap(table => Object.values(table).flat()));

  // Unity first: its player DLL and <name>_Data folder are unambiguous, while
  // an "Engine" folder turns up beside launchers that are not Unreal at all.
  function engineFor(facts) {
    if (!facts) return null;
    if (facts.hasUnityPlayer || facts.hasUnityData) return 'unity';
    if (/-Win(?:64|GDK)-(?:Shipping|Test|DebugGame|Development)\.exe$/i.test(String(facts.exeName || ''))) return 'unreal';
    if (facts.hasUnrealEngineDir && facts.inBinariesWin64) return 'unreal';
    return null;
  }
  function supported(engine) { return typeof engine === 'string' && Object.hasOwn(ENGINES, engine); }
  function argsFor(engine, choice) {
    if (!supported(engine) || !CHOICES.includes(choice)) return [];
    return ENGINES[engine][choice].slice();
  }
  function describe(engine) {
    return supported(engine)
      ? { engine, supported: true, args: { d3d11: argsFor(engine, 'd3d11'), d3d12: argsFor(engine, 'd3d12') } }
      : { engine: null, supported: false, args: { d3d11: [], d3d12: [] } };
  }
  function steamUrl(appid, args) {
    const id = String(appid == null ? '' : appid).replace(/[^0-9]/g, '');
    if (!id) return null;
    const list = (Array.isArray(args) ? args : []).filter(arg => KNOWN_ARGS.has(arg));
    return list.length ? `steam://run/${id}//${list.map(encodeURIComponent).join('%20')}/` : `steam://rungameid/${id}`;
  }
  // What Play should do for one executable. `via` is null when the game is
  // simply started the way it always was; `reason` then says why a DirectX
  // choice could not travel with it.
  function plan({ engine, choice, launcher, appid } = {}) {
    if (!CHOICES.includes(choice)) return { via: null, args: [], reason: null };
    const args = argsFor(engine, choice);
    if (!args.length) return { via: null, args: [], reason: 'launchSwitchUnsupported' };
    // Xbox app games start through the store's own launcher, which takes no
    // arguments from outside.
    if (launcher === 'Xbox') return { via: null, args: [], reason: 'launchSwitchStore' };
    const url = appid ? steamUrl(appid, args) : null;
    if (url) return { via: 'steam', args, url, reason: null };
    return { via: 'exe', args, reason: null };
  }
  const api = { ENGINES, CHOICES, engineFor, supported, argsFor, describe, steamUrl, plan };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.launchApi = api;
})(typeof window !== 'undefined' ? window : globalThis);