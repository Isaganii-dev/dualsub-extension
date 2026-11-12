/*
 * Runs in the PAGE's JS world (manifest "world": "MAIN") at document_start.
 * Job: find subtitle tracks, download + parse them, hand cues to content.js
 * through window.postMessage. Nothing here touches the DOM.
 */
(() => {
  'use strict';
  if (window.__dualsubMain) return;
  window.__dualsubMain = true;

  const SRC_MAIN = 'dualsub-main';
  const SRC_ISO = 'dualsub-iso';
  const IS_YT = /(^|\.)youtube\.com$/.test(location.hostname);
  const IS_NF = /(^|\.)netflix\.com$/.test(location.hostname);
  const NF_PROFILE = 'webvtt-lssdh-ios8';
  const origFetch = window.fetch.bind(window);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const post = (m) => window.postMessage({ src: SRC_MAIN, ...m }, '*');
  const baseLang = (c) => String(c || '').toLowerCase().split(/[-_]/)[0];
  const langScore = (have, want) => {
    const h = String(have).toLowerCase(), w = String(want).toLowerCase();
    return h === w ? 2 : baseLang(h) === baseLang(w) ? 1 : 0;
  };
  // best track for a language: exact > same base language, then caller's rank
  function pickTrack(tracks, want, rank) {
    let best = null, bestScore = 0;
    for (const t of tracks) {
      const ls = langScore(t.lang, want);
      if (!ls) continue;
      const s = ls * 10 + rank(t);
      if (s > bestScore) { best = t; bestScore = s; }
    }
    return best;
  }

  /* ---------- parsers ---------- */
  const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&lrm;': '', '&rlm;': '', '&quot;': '"', '&#39;': "'" };
  const decode = (s) => s.replace(/&(amp|lt|gt|nbsp|lrm|rlm|quot|#39);/g, (m) => ENT[m]);
  const toSec = (s) => s.replace(',', '.').split(':').map(Number).reduce((a, v) => a * 60 + v, 0);

  function parseVtt(txt) {
    const cues = [];
    for (const block of txt.replace(/\r/g, '').split(/\n\n+/)) {
      const lines = block.split('\n');
      const i = lines.findIndex((l) => l.includes('-->'));
      if (i < 0) continue;
      const m = lines[i].match(/((?:\d+:)?\d+:\d+[.,]\d+)\s*-->\s*((?:\d+:)?\d+:\d+[.,]\d+)/);
      if (!m) continue;
      const t = decode(lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '')).trim();
      if (t) cues.push({ s: toSec(m[1]), e: toSec(m[2]), t });
    }
    return cues.sort((a, b) => a.s - b.s);
  }

  function parseJson3(txt) {
    const j = JSON.parse(txt);
    const cues = [];
    for (const ev of j.events || []) {
      if (!ev.segs) continue;
      const t = ev.segs.map((g) => g.utf8 || '').join('').replace(/\u200b/g, '').trim();
      if (!t) continue;
      const s = (ev.tStartMs || 0) / 1000;
      cues.push({ s, e: s + (ev.dDurationMs || 2000) / 1000, t });
    }
    return cues.sort((a, b) => a.s - b.s);
  }

  /* ---------- YouTube ---------- */
  let ytPot = null;       // token the player itself used for /api/timedtext
  let ytPriming = null;

  function noteTimedText(input) {
    try {
      const u = new URL(String(input && input.url ? input.url : input), location.href);
      if (!u.pathname.includes('/api/timedtext') || !u.searchParams.get('pot')) return;
      const params = {};
      for (const k of ['pot', 'potc', 'c', 'cver']) if (u.searchParams.get(k)) params[k] = u.searchParams.get(k);
      ytPot = { vid: u.searchParams.get('v'), params };
    } catch (_) {}
  }

  if (IS_YT) {
    const xo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      noteTimedText(url);
      return xo.apply(this, arguments);
    };
    window.fetch = function (input, init) {
      noteTimedText(input);
      return origFetch(input, init);
    };
  }

  const ytText = (x) => (x && (x.simpleText || (x.runs && x.runs.map((r) => r.text).join('')))) || '';

  function ytInfo() {
    const vid = new URLSearchParams(location.search).get('v');
    if (!vid) return null;
    const player = document.getElementById('movie_player');
    let pr;
    try { pr = player && player.getPlayerResponse && player.getPlayerResponse(); } catch (_) {}
    if (!pr || !pr.videoDetails || pr.videoDetails.videoId !== vid) return null;

    const r = pr.captions && pr.captions.playerCaptionsTracklistRenderer;
    const raw = r && r.captionTracks;
    if (!raw || !raw.length) {
      return { site: 'youtube', key: vid + ':0', vid, languages: [], note: 'This video has no captions.', tracks: [] };
    }
    const tracks = raw.map((t) => ({
      lang: t.languageCode, name: ytText(t.name), asr: t.kind === 'asr',
      translatable: !!t.isTranslatable, baseUrl: t.baseUrl
    }));
    const tl = (r.translationLanguages || []).map((l) => ({ code: l.languageCode, name: ytText(l.languageName) }));
    const names = new Map();
    tracks.forEach((t) => names.set(t.lang, t.name.replace(/\s*\(.*\)\s*$/, '') || t.lang));
    tl.forEach((l) => { if (!names.has(l.code)) names.set(l.code, l.name); });
    const di = (r.audioTracks && r.audioTracks[0] && r.audioTracks[0].defaultCaptionTrackIndex) || 0;
    return {
      site: 'youtube', key: vid + ':' + tracks.length, vid, tracks,
      original: tracks[di] || tracks[0],
      canTranslate: tracks.some((t) => t.translatable),
      translationCodes: new Set(tl.map((l) => l.code)),
      languages: [...names].map(([code, name]) => ({ code, name }))
    };
  }

  function ytPrime(vid) {
    if (ytPriming) return ytPriming;
    ytPriming = (async () => {
      const p = document.getElementById('movie_player');
      try { p && p.toggleSubtitlesOn && p.toggleSubtitlesOn(); } catch (_) {}
      for (let i = 0; i < 30; i++) {
        if (ytPot && ytPot.vid === vid) return;
        await sleep(150);
      }
    })().finally(() => { ytPriming = null; });
    return ytPriming;
  }

  async function ytFetch(track, tlang, vid) {
    const build = () => {
      const u = new URL(track.baseUrl, location.href);
      u.searchParams.set('fmt', 'json3');
      if (tlang) u.searchParams.set('tlang', tlang);
      if (ytPot && ytPot.vid === vid) for (const [k, v] of Object.entries(ytPot.params)) u.searchParams.set(k, v);
      return u.toString();
    };
    let txt = await (await origFetch(build(), { credentials: 'include' })).text();
    if (!txt.trim() && !(ytPot && ytPot.vid === vid)) {
      await ytPrime(vid);   // let the player request captions once so we can reuse its token
      txt = await (await origFetch(build(), { credentials: 'include' })).text();
    }
    if (!txt.trim()) throw new Error('YouTube returned no caption data (it may require a token we could not get).');
    return parseJson3(txt);
  }

  async function ytLoad(info, want) {
    const rank = (t) => (t.asr ? 0 : 1);
    let track, tlang = null;
    const lang = want === '__original__' ? null : want;
    if (!lang) track = info.original;
    else {
      track = info.tracks.filter((t) => langScore(t.lang, lang) === 2).sort((a, b) => rank(b) - rank(a))[0];
      if (!track && info.canTranslate && info.translationCodes.has(lang)) {
        track = info.tracks.find((t) => t.translatable && t === info.original) || info.tracks.find((t) => t.translatable);
        tlang = lang;
      }
      if (!track) track = pickTrack(info.tracks, lang, rank);
    }
    if (!track) throw new Error('No "' + want + '" captions available for this video.');
    return ytFetch(track, tlang, info.vid);
  }

  /* ---------- Netflix ---------- */
  const nf = { manifests: new Map(), latest: null, latestAt: 0, urlChangedAt: 0, path: '' };

  if (IS_NF) {
    const origParse = JSON.parse;
    JSON.parse = function () {
      const r = origParse.apply(this, arguments);
      try {
        const m = r && r.result;
        if (m && m.movieId && Array.isArray(m.timedtexttracks)) {
          nf.manifests.set(String(m.movieId), m);
          nf.latest = String(m.movieId);
          nf.latestAt = Date.now();
        }
      } catch (_) {}
      return r;
    };
    // Ask Netflix for text (WebVTT) subtitle files for every language.
    const origStringify = JSON.stringify;
    JSON.stringify = function (value) {
      try {
        const p = value && (value.params || value);
        if (p && Array.isArray(p.profiles) && p.profiles.length && !p.profiles.includes(NF_PROFILE) &&
            (p.type === 'standard' || p.manifestVersion || value.url === '/manifest')) {
          p.profiles.push(NF_PROFILE);
          p.showAllSubDubTracks = true;
        }
      } catch (_) {}
      return origStringify.apply(this, arguments);
    };
  }

  function nfInfo() {
    const id = (location.pathname.match(/\/watch\/(\d+)/) || [])[1];
    if (!id) return null;
    let m = nf.manifests.get(id);
    if (!m && nf.latest && nf.latestAt >= nf.urlChangedAt) m = nf.manifests.get(nf.latest);
    if (!m) return null;

    const tracks = (m.timedtexttracks || [])
      .filter((t) => !t.isNoneTrack && !t.isForcedNarrative && t.ttDownloadables && t.ttDownloadables[NF_PROFILE])
      .map((t) => ({
        lang: t.language, name: t.languageDescription || t.language, cc: t.rawTrackType === 'closedcaptions',
        url: Object.values(t.ttDownloadables[NF_PROFILE].downloadUrls || {})[0]
      }))
      .filter((t) => t.url);
    const vid = String(m.movieId);
    if (!tracks.length) {
      return { site: 'netflix', key: vid + ':0', vid, languages: [], tracks, note: 'No text subtitles were offered for this title. Reload the page and try again.' };
    }
    const audio = m.audio_tracks || [];
    const origLang = ((audio.find((a) => a.isNative) || audio[0] || {}).language) || tracks[0].lang;
    const names = new Map();
    tracks.forEach((t) => { if (!names.has(t.lang)) names.set(t.lang, t.name); });
    return {
      site: 'netflix', key: vid + ':' + tracks.length, vid, tracks, original: origLang,
      languages: [...names].map(([code, name]) => ({ code, name }))
    };
  }

  async function nfLoad(info, want) {
    const lang = want === '__original__' ? info.original : want;
    const track = pickTrack(info.tracks, lang, (t) => (t.cc ? 0 : 1));
    if (!track) throw new Error('Netflix has no "' + lang + '" subtitles for this title.');
    const res = await origFetch(track.url);
    if (!res.ok) throw new Error('Subtitle download failed (' + res.status + ').');
    return parseVtt(await res.text());
  }

  /* ---------- bridge to content.js ---------- */
  const cache = new Map();
  let lastKey = null;
  let currentInfo = null;

  function tick() {
    if (location.pathname !== nf.path) { nf.path = location.pathname; nf.urlChangedAt = Date.now(); }
    let info = null;
    try { info = IS_YT ? ytInfo() : IS_NF ? nfInfo() : null; } catch (_) {}
    const key = info ? info.key : '';
    if (key === lastKey) return;
    lastKey = key;
    currentInfo = info;
    cache.clear();
    post({
      type: 'info',
      info: info && { site: info.site, key: info.key, vid: info.vid, languages: info.languages, note: info.note || '' }
    });
  }
  setInterval(tick, 700);

  window.addEventListener('message', async (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.src !== SRC_ISO) return;
    if (d.type === 'requestInfo') { lastKey = null; tick(); return; }
    if (d.type !== 'load') return;
    try {
      const info = currentInfo;
      if (!info) throw new Error('Subtitle data is not ready yet.');
      const ck = info.vid + '|' + d.lang;
      let cues = cache.get(ck);
      if (!cues) {
        cues = await (IS_YT ? ytLoad : nfLoad)(info, d.lang);
        cache.set(ck, cues);
      }
      post({ type: 'result', id: d.id, ok: true, cues });
    } catch (err) {
      post({ type: 'result', id: d.id, ok: false, error: String((err && err.message) || err) });
    }
  });
})();
