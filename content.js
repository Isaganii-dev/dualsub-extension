/*
 * Isolated-world content script: settings, overlay rendering, and the
 * conversation with inject.js (which owns subtitle discovery/download).
 */
(() => {
  'use strict';
  const IS_YT = /(^|\.)youtube\.com$/.test(location.hostname);
  const SRC_MAIN = 'dualsub-main', SRC_ISO = 'dualsub-iso';

  let settings = { ...DS_DEFAULTS };
  let info = null;
  let cues = { p: [], s: [] };
  let status = 'Starting…';
  let token = 0, seq = 0;
  const pending = new Map();

  /* ---------- overlay ---------- */
  const overlay = document.createElement('div');
  overlay.id = 'ds-overlay';
  const box = document.createElement('div'); box.className = 'ds-box';
  const lineP = document.createElement('div'); lineP.className = 'ds-line ds-p';
  const lineS = document.createElement('div'); lineS.className = 'ds-line ds-s';
  box.append(lineP, lineS);
  overlay.append(box);

  function applyStyle() {
    const s = overlay.style;
    s.setProperty('--ds-fp', settings.sizePrimary);
    s.setProperty('--ds-fs', settings.sizeSecondary);
    s.setProperty('--ds-cp', settings.colorPrimary);
    s.setProperty('--ds-cs', settings.colorSecondary);
    s.setProperty('--ds-bg', settings.bg);
    s.setProperty('--ds-bottom', settings.bottom + '%');
    box.style.flexDirection = settings.order === 'secondary-top' ? 'column-reverse' : 'column';
    document.documentElement.classList.toggle('ds-on', !!settings.enabled);
  }

  const getVideo = () => document.querySelector(IS_YT ? 'video.html5-main-video' : 'video');
  function getContainer(video) {
    const fs = document.fullscreenElement;
    if (IS_YT) return document.getElementById('movie_player') || video.parentElement;
    if (fs && fs.contains(video)) return fs;
    return document.querySelector('.watch-video--player-view') || video.parentElement;
  }

  function activeCue(list, t) {
    let lo = 0, hi = list.length - 1, i = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (list[m].s <= t) { i = m; lo = m + 1; } else hi = m - 1;
    }
    for (let k = i; k >= 0 && k > i - 4; k--) if (list[k].e > t) return list[k].t;
    return '';
  }

  function setText(el, txt) {
    if (el._t !== txt) { el.textContent = txt; el._t = txt; }
  }

  let lastH = 0;
  function frame() {
    requestAnimationFrame(frame);
    const video = settings.enabled ? getVideo() : null;
    if (!video) { overlay.style.display = 'none'; return; }
    const c = getContainer(video);
    if (!c) return;
    if (overlay.parentElement !== c) {
      if (getComputedStyle(c).position === 'static') c.style.position = 'relative';
      c.appendChild(overlay);
    }
    const ad = IS_YT && document.getElementById('movie_player')?.classList.contains('ad-showing');
    const t = video.currentTime;
    const a = ad ? '' : activeCue(cues.p, t);
    const b = ad ? '' : activeCue(cues.s, t);
    setText(lineP, a);
    setText(lineS, b);
    const h = c.clientHeight;
    if (h && h !== lastH) { lastH = h; overlay.style.setProperty('--ds-h', h + 'px'); }
    overlay.style.display = a || b ? '' : 'none';
  }

  /* ---------- talking to inject.js ---------- */
  function ask(lang) {
    return new Promise((resolve) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: 'Timed out loading subtitles.' }); }, 20000);
      pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
      window.postMessage({ src: SRC_ISO, type: 'load', id, lang }, '*');
    });
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.src !== SRC_MAIN) return;
    if (d.type === 'info') { info = d.info; reload(); }
    else if (d.type === 'result') {
      const cb = pending.get(d.id);
      if (cb) { pending.delete(d.id); cb(d); }
    }
  });

  async function reload() {
    const my = ++token;
    cues = { p: [], s: [] };
    applyStyle();
    if (!settings.enabled) { status = 'Turned off.'; return; }
    if (!info) { status = IS_YT ? 'Open a video to begin.' : 'Waiting for Netflix subtitle data. If this stays, reload the page.'; return; }
    if (info.note && !info.languages.length) { status = info.note; return; }

    status = 'Loading subtitles…';
    const none = settings.secondary === '__none__';
    const [p, s] = await Promise.all([ask(settings.primary), none ? null : ask(settings.secondary)]);
    if (my !== token) return;

    const errors = [];
    if (p.ok) cues.p = p.cues; else errors.push('Top line: ' + p.error);
    if (s) { if (s.ok) cues.s = s.cues; else errors.push('Second line: ' + s.error); }
    status = errors.length ? errors.join(' ') : 'Ready.';
  }

  /* ---------- settings + popup ---------- */
  chrome.storage.local.get(DS_DEFAULTS).then((s) => {
    settings = { ...DS_DEFAULTS, ...s };
    applyStyle();
    reload();
    window.postMessage({ src: SRC_ISO, type: 'requestInfo' }, '*');
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let needsReload = false;
    for (const [k, v] of Object.entries(changes)) {
      settings[k] = v.newValue;
      if (k === 'enabled' || k === 'primary' || k === 'secondary') needsReload = true;
    }
    if (needsReload) reload(); else applyStyle();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, send) => {
    if (msg && msg.type === 'getState') send({ info, status });
  });

  applyStyle();
  requestAnimationFrame(frame);
  window.postMessage({ src: SRC_ISO, type: 'requestInfo' }, '*');
})();
