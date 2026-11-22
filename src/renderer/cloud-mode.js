'use strict';

// Cloud Gaming screen. Shows what reaches a browser game stream (RTX Video
// Super Resolution, hardware acceleration, a Lossless Scaling profile) and
// sets it up per browser with one button. The rules live in
// src/core/cloud-mode.js; this file only draws and calls window.lab.
(function () {
  const $ = (id) => document.getElementById(id);
  const tr = (key, ...args) => (typeof t === 'function' ? t(key, ...args) : key);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let busy = false;
  let last = null;

  function mark(on) {
    return on === true ? '<b class="cloud-mark on" aria-hidden="true">&#10003;</b>'
      : on === false ? '<b class="cloud-mark off" aria-hidden="true">&#10005;</b>'
      : '<b class="cloud-mark" aria-hidden="true">?</b>';
  }

  function vsrLine(vsr) {
    if (!vsr || !vsr.known) return { on: null, text: tr('cloudVsrUnknown') };
    if (!vsr.enabled) return { on: false, text: tr('cloudVsrOff') };
    return { on: true, text: vsr.auto ? tr('cloudVsrAuto') : tr('cloudVsrOn', vsr.level) };
  }

  function browserRow(b) {
    if (!b.installed) {
      return `<div class="set-row"><div><div class="k">${esc(b.name)}</div><div class="v">${esc(tr('cloudNotInstalled'))}</div></div></div>`;
    }
    const hw = b.hardwareAcceleration === true ? tr('cloudHwOn') : b.hardwareAcceleration === false ? tr('cloudHwOff') : tr('cloudHwUnknown');
    const ready = b.hardwareAcceleration === true && b.losslessProfile;
    return `<div class="set-row cloud-browser">
      <div><div class="k">${esc(b.name)}</div>
        <div class="v">${mark(b.hardwareAcceleration)} ${esc(hw)}</div>
        <div class="v">${mark(b.losslessProfile)} ${esc(b.losslessProfile ? tr('cloudProfileYes') : tr('cloudProfileNo'))}</div></div>
      <div class="row">
        <button class="${ready ? 'ghost' : 'glass-btn'} sm" type="button" data-cloud-setup="${esc(b.id)}" ${busy ? 'disabled' : ''}>${esc(ready ? tr('cloudSetUpAgain') : tr('cloudSetUp'))}</button>
        <button class="ghost sm" type="button" data-cloud-open="${esc(b.id)}">${esc(tr('cloudOpenPlay'))}</button>
      </div></div>`;
  }

  function draw(status) {
    last = status;
    $('cloudSubtitle').textContent = tr('cloudSubtitle');
    $('cloudRefresh').textContent = tr('cloudRefresh');
    if (!status || !status.ok) {
      $('cloudPanel').innerHTML = '';
      say(tr('cloudStatusError', status?.message || ''));
      return;
    }
    const vsr = vsrLine(status.vsr);
    const d = status.display;
    const ls = status.lossless;
    const profileName = (status.browsers.find((b) => b.running && b.installed) || status.browsers.find((b) => b.installed) || {}).profileTitle || '';
    $('cloudPanel').innerHTML = `
      <div class="glass pad">
        <div class="set-row"><div><div class="k">${esc(tr('cloudVsrTitle'))}</div>
          <div class="v">${mark(vsr.on)} ${esc(vsr.text)}</div></div>
          <button class="ghost sm" type="button" id="cloudNvidia">${esc(tr('cloudOpenNvidia'))}</button></div>
        <div class="set-row"><div><div class="k">${esc(tr('cloudLsTitle'))}</div>
          <div class="v">${mark(ls.installed)} ${esc(!ls.installed ? tr('cloudLsMissing') : ls.running ? tr('cloudLsRunning') : tr('cloudLsInstalled'))}</div>
          <div class="v">${esc(tr('cloudDisplay', d.width, d.height, d.refreshRate, d.target, d.flowScale))}</div></div></div>
        ${status.browsers.map(browserRow).join('')}
      </div>
      <p class="hint">${esc(tr('cloudHowTo', profileName))}</p>
      <p class="hint">${esc(tr('cloudTip1440'))}</p>`;
    wire();
  }

  function say(text, extraHtml = '') {
    $('cloudMessage').innerHTML = esc(text) + extraHtml;
  }

  function wire() {
    $('cloudNvidia').onclick = async () => {
      const result = await window.lab.cloudOpenNvidia();
      if (!result.ok) say(tr(result.reason || 'cloudNoNvidiaApp'));
    };
    for (const button of document.querySelectorAll('[data-cloud-setup]')) {
      button.onclick = () => setup(button.dataset.cloudSetup, false);
    }
    for (const button of document.querySelectorAll('[data-cloud-open]')) {
      button.onclick = async () => {
        const result = await window.lab.cloudOpen(button.dataset.cloudOpen);
        if (!result.ok) say(tr(result.reason, nameOf(button.dataset.cloudOpen)));
      };
    }
  }

  function nameOf(id) { return (last?.browsers || []).find((b) => b.id === id)?.name || id; }

  async function setup(id, restartLossless) {
    if (busy) return;
    busy = true;
    const name = nameOf(id);
    say(tr('cloudWorking', name));
    for (const button of document.querySelectorAll('[data-cloud-setup]')) button.disabled = true;
    let result;
    try { result = await window.lab.cloudApply(id, { restartLossless }); }
    catch (error) { result = { ok: false, message: error.message }; }
    busy = false;
    if (!result.steps) {
      await render();
      say(tr('cloudStatusError', result.message || result.reason || ''));
      return;
    }
    const lines = [];
    let restartButton = '';
    for (const step of result.steps) {
      if (step.step === 'hardwareAcceleration') {
        if (!step.ok) lines.push(tr(step.reason, name));
        else if (step.changed) lines.push(tr('cloudHwChanged', name));
      } else if (step.step === 'lossless') {
        if (step.ok) lines.push(tr('cloudSavedProfile', step.title));
        else {
          lines.push(tr(step.reason));
          if (step.canRestart) restartButton = ` <button class="glass-btn sm" type="button" id="cloudRestartLs">${esc(tr('cloudRestartLossless'))}</button>`;
        }
      } else if (step.step === 'vsr' && !step.ok) {
        lines.push(tr(step.reason));
      }
    }
    if (result.ok) lines.unshift(tr('cloudAllSet', name));
    // Lossless Scaling was started again; give it a moment before re-reading.
    await new Promise((r) => setTimeout(r, 1200));
    await render();
    say(lines.join(' '), restartButton);
    const restart = $('cloudRestartLs');
    if (restart) restart.onclick = () => setup(id, true);
  }

  async function render() {
    $('cloudRefresh').onclick = () => { say(''); render(); };
    let status;
    try { status = await window.lab.cloudStatus(); }
    catch (error) { status = { ok: false, message: error.message }; }
    draw(status);
  }

  window.cloudModeUi = { render };
})();
