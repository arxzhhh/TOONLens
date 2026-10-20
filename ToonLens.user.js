// ==UserScript==
// @name         ToonLens
// @namespace    https://toonlens.local/
// @version      1.4.0
// @description  Live manhwa / manga / webtoon translator for Safari. Reader mode that detects and translates text as you scroll.
// @match        http://*/*
// @match        https://*/*
// @run-at       document-idle
// @inject-into  content
// @noframes
// @connect      *
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

/*
 * ToonLens: live manhwa translator (Safari / iOS userscript)
 *
 * How it works
 *  1. Open any chapter page (or paste a link on https://example.com/#toonlens).
 *  2. ToonLens collects the chapter images and shows them in a clean scrolling reader.
 *  3. As each image nears the screen, it is sliced at blank gutters and sent to a vision model
 *     (Gemini by default) that finds every bubble, reads it and translates it with chapter context.
 *  4. The original text is erased by inpainting the bubble's own fill over it (edge-sampled
 *     colour + soft feathered mask, so no rectangle ever shows) and the translation is typeset
 *     to fit. Results are cached on-device, so re-reading is instant and free.
 */

(() => {
'use strict';
if (window.top !== window.self || window.__toonlens) return;
window.__toonlens = true;

/* ───────────────────────── helpers ───────────────────────── */

const G = typeof GM !== 'undefined' ? GM : {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const NET = { ms: 90000 };
/* Per-provider request timeouts. Free hosted tiers and local servers (LM Studio / Ollama / llama.cpp) can take
   minutes on the first call of a session while the model loads off disk, so they get a much
   longer budget than cloud APIs. */
const netMsFor = p => (p === 'local' || p === 'openrouter' ? 300000 : NET.ms);
const withTimeout = (pr, ms, msg) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(msg)), ms); pr.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); }); });
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const tagOf = v => Object.prototype.toString.call(v);
const hsh = s => { let x = 5381; for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0; return (x >>> 0).toString(36); };
const absUrl = u => { try { return new URL(u, location.href).href; } catch (e) { return ''; } };

class TLError extends Error {
  constructor(msg, kind, wait) { super(msg); this.kind = kind || 'retry'; this.wait = wait || 0; }
}

/* Errors thrown while the "Test connection" button is running. The reader must NOT treat these
   as fatal (they would silently block every page), so we tag them and filter them out in run(). */
class TestError extends Error {
  constructor(msg, kind, wait) { super(msg); this.name = 'TestError'; this.kind = kind || 'retry'; this.wait = wait || 0; }
}
let testingNow = false;
/* Which model names the last test attempt actually tried — used in error messages. */
let lastTriedChain = [];
const chainNote = () => ((S.provider === 'gemini' || S.provider === 'openrouter') && lastTriedChain.length > 1 ? lastTriedChain.join(' → ') : modelName());

function el(tag, a, ...kids) {
  const e = document.createElement(tag);
  for (const k in a || {}) {
    const v = a[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'style') Object.assign(e.style, v);
    else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids) if (c != null) e.append(c);
  return e;
}

const ICONS = {
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
  pause: '<path d="M9 5.5v13M15 5.5v13"/>',
  minus: '<path d="M6 12h12"/>',
  plus: '<path d="M6 12h12M12 6v12"/>',
};
function ico(n) {
  const s = document.createElement('span');
  s.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICONS[n] + '</svg>';
  return s.firstChild;
}
const iconBtn = (n, label, fn) => el('button', { class: 'ib', 'aria-label': label, title: label, onclick: fn }, ico(n));

/* ───────────────────── userscript-manager shims ───────────────────── */

async function gmGet(k, d) {
  try {
    if (G.getValue) { const v = await G.getValue(k, d); return v === undefined ? d : v; }
    if (typeof GM_getValue === 'function') return GM_getValue(k, d);
  } catch (e) { /* fall through */ }
  try { const v = localStorage.getItem('toonlens:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
}
async function gmSet(k, v) {
  try {
    if (G.setValue) return await G.setValue(k, v);
    if (typeof GM_setValue === 'function') return GM_setValue(k, v);
  } catch (e) { /* fall through */ }
  try { localStorage.setItem('toonlens:' + k, JSON.stringify(v)); } catch (e) { /* ignore */ }
}

function gmRequest(opts) {
  const fn = G.xmlHttpRequest || (typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : null);
  if (!fn) return Promise.reject(new Error('no-gm'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no response from the userscript manager')), (opts.timeout || NET.ms) + 2000);
    const ok = v => { clearTimeout(timer); resolve(v); }, bad = e => { clearTimeout(timer); reject(e); };
    const d = Object.assign({}, opts, {
      onload: ok,
      onerror: () => bad(new Error('Network error')),
      ontimeout: () => bad(new Error('Request timed out')),
      onabort: () => bad(new Error('Request aborted')),
    });
    try {
      const r = fn.call(G.xmlHttpRequest ? G : undefined, d);
      if (r && typeof r.then === 'function') r.then(ok, bad);
    } catch (e) { bad(e); }
  });
}

/* ───────────────────────── settings ───────────────────────── */

const DEFAULTS = {
  v: 2, provider: 'gemini', apiKey: '', model: '', baseUrl: 'https://api.openai.com/v1', localBase: 'http://localhost:1234/v1', orModel: '', thinking: 'low', keys: [], keyIdx: 0, keysText: '',
  target: 'English', source: 'auto', style: 'natural', honorifics: true, sfx: true, glossary: '', extra: '',
  font: 'comic', fontScale: 100, pad: 6, caps: false, cover: true, clean: true, blend: true,
  prefetch: 2, concurrency: 1, scrollSpeed: 4, autoStart: false, pill: 'detected',
  imgMax: 1000, quality: 0.85,
};
const MODEL_DEFAULT = { gemini: 'gemini-2.5-flash-lite', anthropic: 'claude-sonnet-5-5', openai: '', openrouter: '' };
/* Free hosted vision models on OpenRouter's no-restrictions route (:free), tried in order when
   the Model field is empty. These run on other people's GPUs — zero load on your PC, zero $ cost.
   NOTE: OpenRouter retires :free ids without notice (e.g. qwen/qwen2.5-vl-7b-instruct:free and
   google/gemini-2.0-flash-exp:free were removed; they now return "400 ... is not a valid model
   ID"). Keep this list in sync with https://openrouter.ai/api/v1/models (vision-capable, :free). */
const OPENROUTER_FREE_MODELS = ['nvidia/nemotron-3.5-super-vl:free', 'google/gemma-4-26b-a4b-it:free', 'google/gemma-4-31b-it:free'];
/* Retired/invalid OpenRouter model ids users may still have saved in Settings → Model or as the
   sticky pick. Mapped to a current free vision model so old settings don't error out with
   "is not a valid model ID". */
const OR_RETIRED_MODELS = {
  'qwen/qwen2.5-vl-7b-instruct:free': 'nvidia/nemotron-3.5-super-vl:free',
  'qwen/qwen3-vl-8b-instruct:free': 'nvidia/nemotron-3.5-super-vl:free',
  'google/gemini-2.0-flash-exp:free': 'google/gemma-4-26b-a4b-it:free',
};
/* Models that Google offers on the free tier of AI Studio keys, in order of preference. */
const GEMINI_FREE_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash'];
const RETR = new Set(['provider', 'model', 'baseUrl', 'localBase', 'orModel', 'target', 'source', 'style', 'honorifics', 'sfx', 'glossary', 'extra']);
const LOOK = new Set(['font', 'fontScale', 'pad', 'caps', 'cover', 'clean', 'blend']);
const FONTS = {
  comic: { l: 'Comic', f: '"Chalkboard SE","Marker Felt","Comic Neue","Comic Sans MS","Bradley Hand",system-ui,sans-serif', w: 700 },
  clean: { l: 'Clean', f: 'ui-rounded,"SF Pro Rounded",-apple-system,"Helvetica Neue",Arial,sans-serif', w: 650 },
  tight: { l: 'Condensed', f: '"Avenir Next Condensed","Arial Narrow","Helvetica Neue",Arial,sans-serif', w: 700 },
};
const LANGS = ['English', 'Spanish', 'French', 'German', 'Portuguese (Brazil)', 'Italian', 'Russian', 'Turkish', 'Arabic', 'Indonesian', 'Vietnamese', 'Thai', 'Polish', 'Dutch', 'Hindi', 'Filipino', 'Malay', 'Ukrainian', 'Swedish', 'Czech', 'Romanian', 'Hebrew', 'Persian', 'Japanese', 'Korean', 'Chinese (Simplified)', 'Chinese (Traditional)'];
const RTL = /arabic|hebrew|persian|farsi|urdu/i;

const S = Object.assign({}, DEFAULTS);
const ST = {
  view: null, pages: [], running: 0, backoff: 0, session: 0, recent: [], learned: {},
  nav: {}, title: '', origin: 'page', chapterLike: false, auto: 0, dirtyTr: false, dirtyLook: false,
};
const ui = {};
/* ui holds live DOM refs (ui.root, ui.keysText…) and is only valid after mountUI()/loadSettings()
   have run. Anything that renders before boot must use this safe stand-in instead of reading ui
   directly — otherwise a ReferenceError ("can't access dead object") silently kills the action
   (this used to break opening the Settings sheet). */
const uiSafe = () => (ui && ui.root ? ui : {});

async function loadSettings() {
  const v = await gmGet('settings', null);
  if (v && typeof v === 'object') {
    if (v.v !== 2) { v.v = 2; v.concurrency = 1; v.prefetch = Math.min(v.prefetch || 2, 2); if (v.model === 'gemini-flash-latest') v.model = ''; }
    /* 'gemini-2.5-flash' stopped having a free tier for many keys — fall back to the empty
       default so modelName() picks a model that is currently free. */
    if (v.model === 'gemini-2.5-flash') v.model = '';
    /* Migrate OpenRouter model ids that have since been retired — otherwise every call fails with
       "400 ... is not a valid model ID" before the fallback chain can even run. */
    if (v.model && OR_RETIRED_MODELS[v.model]) v.model = OR_RETIRED_MODELS[v.model];
    if (v.orModel && OR_RETIRED_MODELS[v.orModel]) v.orModel = OR_RETIRED_MODELS[v.orModel];
    /* One free AI Studio key has a small daily quota. Extra keys go in the "Backup API keys"
       field (one per line) and are rotated automatically, which is how near-unlimited free
       usage is achieved. Migrate anything pasted into the old single-key box. */
    Object.assign(S, v);
    if (!Array.isArray(S.keys)) S.keys = [];
    const allKeys = [S.apiKey, ...S.keys].map(k => String(k).trim()).filter(Boolean);
    const uniq = [...new Set(allKeys)];
    if (uniq.length !== allKeys.length || (S.apiKey && !S.keys.length)) {
      S.apiKey = uniq[0] || ''; S.keys = uniq.slice(1);
    }
    if (!Number.isInteger(S.keyIdx) || S.keyIdx < 0) S.keyIdx = 0;
  }
  uiSafe().keysText = [S.apiKey, ...S.keys].filter(Boolean).join('\n');
}
const saveSettings = () => gmSet('settings', S);
const modelName = () => (S.provider === 'local' ? String(S.model || '').trim() : S.provider === 'openrouter' ? (String(S.model || '').trim() || String(S.orModel || '').trim()) : S.model || MODEL_DEFAULT[S.provider] || '');

/* All configured keys, primary first. */
const allKeys = () => {
  const raw = [S.apiKey, ...(Array.isArray(S.keys) ? S.keys : [])];
  return [...new Set(raw.map(k => String(k).trim()).filter(Boolean))];
};

/* ─────────────────────── translation cache (IndexedDB) ─────────────────────── */

const mem = new Map();
const idb = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    if (typeof indexedDB === 'undefined') return rej(new Error('no idb'));
    const r = indexedDB.open('toonlens', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('p');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('p', mode); const rq = fn(t.objectStore('p'));
      t.oncomplete = () => res(rq && rq.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  };
  return {
    get: k => tx('readonly', s => s.get(k)).catch(() => mem.get(k)),
    set: (k, v) => { mem.set(k, v); return tx('readwrite', s => s.put(v, k)).catch(() => {}); },
    clear: () => { mem.clear(); return tx('readwrite', s => s.clear()).catch(() => {}); },
  };
})();

const cacheKey = p => 'v2|' + hsh([S.provider, modelName(), S.target, S.source, S.style, S.honorifics, S.sfx, S.glossary, S.extra].join('|')) + '|' + hsh(p.id);

/* ───────────────────────── fetching images ───────────────────────── */

async function toBlob(res) {
  const r = res.response;
  const mime = (/content-type:\s*([^\r\n;]+)/i.exec(res.responseHeaders || '') || [])[1] || 'image/jpeg';
  const t = tagOf(r);
  if (t === '[object Blob]') return r;
  if (t === '[object ArrayBuffer]' || ArrayBuffer.isView(r)) return new Blob([r], { type: mime });
  if (typeof r === 'string') {
    if (r.startsWith('data:')) return (await fetch(r)).blob();
    const u8 = new Uint8Array(r.length);
    for (let i = 0; i < r.length; i++) u8[i] = r.charCodeAt(i) & 255;
    return new Blob([u8], { type: mime });
  }
  throw new Error('Unsupported response');
}

async function fetchImageBlob(url, referer) {
  if (/^(blob|data):/.test(url)) return (await fetch(url)).blob();
  try {
    const r = await fetch(url);
    if (r.ok) { const b = await r.blob(); if (b.size > 500) return b; }
  } catch (e) { /* cross-origin without CORS: use the userscript manager */ }
  for (const responseType of ['blob', 'arraybuffer']) {
    try {
      const res = await gmRequest({
        url, method: 'GET', responseType, timeout: 45000,
        headers: { Referer: referer || location.href, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
      });
      if (res.status >= 200 && res.status < 300) { const b = await toBlob(res); if (b.size > 500) return b; }
    } catch (e) { /* try next */ }
  }
  throw new TLError('Could not download this image (the site may block it).', 'final');
}

async function decode(blob) {
  if (typeof createImageBitmap === 'function') {
    try { const b = await createImageBitmap(blob); return { w: b.width, h: b.height, src: b, close: () => b.close && b.close() }; } catch (e) { /* fall back */ }
  }
  const u = URL.createObjectURL(blob);
  const im = new Image(); im.src = u;
  try { await im.decode(); } catch (e) { URL.revokeObjectURL(u); throw new TLError('Could not decode this image.', 'final'); }
  return { w: im.naturalWidth, h: im.naturalHeight, src: im, close: () => URL.revokeObjectURL(u) };
}

/* ─────────────── slicing: cut tall strips at blank gutters ─────────────── */

function findGutter(bmp, a, b) {
  a = Math.max(0, Math.round(a)); b = Math.min(bmp.h, Math.round(b));
  const cw = 96, ch = Math.max(4, Math.round((b - a) * cw / bmp.w));
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  const x = cv.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp.src, 0, a, bmp.w, b - a, 0, 0, cw, ch);
  const d = x.getImageData(0, 0, cw, ch).data, vars = new Float32Array(ch);
  for (let r = 0; r < ch; r++) {
    let s = 0, s2 = 0;
    for (let c = 0; c < cw; c++) { const i = (r * cw + c) * 4, l = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; s += l; s2 += l * l; }
    const m = s / cw; vars[r] = s2 / cw - m * m;
  }
  let mn = Infinity; for (const v of vars) if (v < mn) mn = v;
  const lim = Math.max(mn * 1.5, mn + 1), mid = ch / 2;
  let best = 0, bd = Infinity;
  for (let r = 0; r < ch; r++) if (vars[r] <= lim && Math.abs(r - mid) < bd) { bd = Math.abs(r - mid); best = r; }
  return { y: Math.round(a + (best + 0.5) * (b - a) / ch), clean: mn < 6 };
}

function planSlices(bmp) {
  const W = bmp.w, H = bmp.h, maxH = Math.max(1000, Math.round(W * 2.1));
  if (H <= maxH * 1.2) return [{ y0: 0, y1: H }];
  const cuts = []; let y = 0;
  while (H - y > maxH * 1.2) {
    const t = y + maxH, win = Math.round(maxH * 0.22);
    const g = findGutter(bmp, t - win, t + win);
    cuts.push(g); y = g.y;
  }
  const ov = Math.round(W * 0.1), out = [];
  for (let i = 0; i <= cuts.length; i++) {
    const p = cuts[i - 1], n = cuts[i];
    out.push({ y0: p ? (p.clean ? p.y : p.y - ov) : 0, y1: n ? (n.clean ? n.y : n.y + ov) : H });
  }
  return out;
}

function drawSlice(bmp, sl) {
  const sh = sl.y1 - sl.y0, scale = bmp.w < 600 ? 800 / bmp.w : Math.min(1, S.imgMax / bmp.w);
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.w * scale); cv.height = Math.max(1, Math.round(sh * scale));
  const x = cv.getContext('2d', { willReadFrequently: true });
  x.fillStyle = '#fff'; x.fillRect(0, 0, cv.width, cv.height);
  x.imageSmoothingQuality = 'high';
  x.drawImage(bmp.src, 0, sl.y0, bmp.w, sh, 0, 0, cv.width, cv.height);
  return cv;
}

/* sample the bubble's own colour from the inner edge of the box (median = robust to text) */
function sampleBg(ctx, cw, ch, y1, x1, y2, x2) {
  const X1 = clamp(Math.round(x1 / 1000 * cw), 0, cw - 2), X2 = clamp(Math.round(x2 / 1000 * cw), X1 + 1, cw);
  const Y1 = clamp(Math.round(y1 / 1000 * ch), 0, ch - 2), Y2 = clamp(Math.round(y2 / 1000 * ch), Y1 + 1, ch);
  const bw = X2 - X1, bh = Y2 - Y1;
  let d; try { d = ctx.getImageData(X1, Y1, bw, bh).data; } catch (e) { return null; }
  const t = Math.max(1, Math.round(Math.min(bw, bh) * 0.1)), R = [], Gc = [], B = [];
  const push = (x, y) => { const i = (y * bw + x) * 4; R.push(d[i]); Gc.push(d[i + 1]); B.push(d[i + 2]); };
  for (let y = 0; y < bh; y++) {
    if (y < t || y >= bh - t) { for (let x = 0; x < bw; x += 2) push(x, y); }
    else { for (let x = 0; x < t; x++) push(x, y); for (let x = bw - t; x < bw; x++) push(x, y); }
  }
  const med = a => Uint8Array.from(a).sort()[a.length >> 1];
  const c = [med(R), med(Gc), med(B)], lm = c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
  let dev = 0; for (let i = 0; i < R.length; i++) dev += Math.abs(R[i] * 0.299 + Gc[i] * 0.587 + B[i] * 0.114 - lm);
  /* spread of the raw channels around the median → how noisy the fill is (grain, gradients,
     colouring flat-shading). Used to pick a feather wide enough to hide any seam. */
  let sd = 0; for (let i = 0; i < R.length; i++) sd += Math.abs(R[i] - c[0]) + Math.abs(Gc[i] - c[1]) + Math.abs(B[i] - c[2]);
  return { c, busy: R.length ? dev / R.length > 26 : false, spread: R.length ? sd / (R.length * 3) : 0 };
}

/* Detect whether a model box hugs the lettering inside the bubble instead of boxing the whole
   bubble including its dark outline. Vision models sometimes return "the speech bubble" rather
   than "the text inside it"; painting such a box would erase the bubble's own border and replace
   it with a flat rectangle that screams sticker. A real glyph box has clean fill along ALL four
   edges; an outline-inclusive box has ink at the top AND bottom (and usually left/right). So we
   measure each side independently: a side counts as dirty when many of its pixels are far from
   the sampled fill. Any dirty side fails the check, forcing callers to shrink toward the glyphs. */
function edgeClean(d, bw, bh, t, c) {
  const near = (i) => Math.abs(d[i] - c[0]) <= 34 && Math.abs(d[i + 1] - c[1]) <= 34 && Math.abs(d[i + 2] - c[2]) <= 34;
  /* fraction of non-fill pixels on one edge band that makes the side count as "covered by ink" */
  const DIRTY = 0.25;
  const band = (ys, xs) => { let hits = 0, n = 0;
    for (const y of ys) { const rowStart = y * bw * 4;
      for (const x of xs) { const i = rowStart + x * 4; if (d[i + 3] > 200) { n++; if (!near(i)) hits++; } } }
    return n >= 4 && hits / n > DIRTY; };
  const hrows = [], vrows = [];
  for (let y = 0; y < bh; y++) if (y < t || y >= bh - t) hrows.push(y);
  for (let y = Math.floor(bh / 4); y < Math.ceil(bh * 3 / 4); y++) vrows.push(y);
  const hx = []; for (let x = 0; x < bw; x += 2) hx.push(x);
  const vx = []; for (let x = 0; x < t; x++) vx.push(x); for (let x = bw - t; x < bw; x++) vx.push(x);
  return !(band(hrows, hx) || band(vrows, vx));
}

/* Shrink a box away from the bubble outline until ALL FOUR edges sit on clean fill (max ~26% per
   axis, then give up). Returns updated coords or null if hopeless. */
function trimToFill(ctx, cw, ch, b) {
  let [y1, x1, y2, x2] = b;
  for (let i = 0; i < 4; i++) {
    const X1 = clamp(Math.round(x1 / 1000 * cw), 0, cw - 2), X2 = clamp(Math.round(x2 / 1000 * cw), X1 + 1, cw);
    const Y1 = clamp(Math.round(y1 / 1000 * ch), 0, ch - 2), Y2 = clamp(Math.round(y2 / 1000 * ch), Y1 + 1, ch);
    const bw = X2 - X1, bh = Y2 - Y1;
    if (bw < 6 || bh < 6) return null;
    let d; try { d = ctx.getImageData(X1, Y1, bw, bh).data; } catch (e) { return null; }
    const t = Math.max(1, Math.round(Math.min(bw, bh) * 0.1));
    /* Sample the FILL only from top/bottom edge bands: a glyph box has clean fill there, while an
       outline-inclusive box's left/right bands are mostly outline ink — sampling them would drag
       the median toward the border colour and make every edge look "clean". */
    const R = [], Gc = [], B = [];
    const push = (x, y) => { const j = (y * bw + x) * 4; if (d[j + 3] > 200) { R.push(d[j]); Gc.push(d[j + 1]); B.push(d[j + 2]); } };
    for (let y = 0; y < bh; y++) if (y < t || y >= bh - t) for (let x = 0; x < bw; x += 2) push(x, y);
    if (!R.length) return null;
    const med = a => Uint8Array.from(a).sort()[a.length >> 1];
    const fillC = [med(R), med(Gc), med(B)];
    if (edgeClean(d, bw, bh, t, fillC)) return [y1, x1, y2, x2];
    const my = clamp(Math.round(t * 1.7), 1, 18), mx = clamp(Math.round(t * 1.7), 1, 18);
    if ((y2 - y1) - 2 * my < 12 || (x2 - x1) - 2 * mx < 20) return [y1, x1, y2, x2]; /* can't shrink further */
    y1 += my / ch * 1000; y2 -= my / ch * 1000; x1 += mx / cw * 1000; x2 -= mx / cw * 1000;
  }
  return [y1, x1, y2, x2];
}

/* ───────────────────────── prompt + parsing ───────────────────────── */

function buildSystem() {
  const src = S.source === 'auto' ? 'Korean, Japanese, Chinese, Spanish or another language (detect it)' : S.source;
  const style = {
    natural: 'Natural, idiomatic, the way an official localisation would read. Preserve tone, humour, slang and register.',
    literal: 'Faithful and close to the original wording, while still reading as correct ' + S.target + '.',
    casual: 'Casual and conversational, like a good fan translation: contractions, natural slang, punchy lines.',
  }[S.style] || '';
  return [
    'You are an award-winning comic localiser and typesetter. You translate ' + src + ' manhwa, manga, manhua and webtoons into ' + S.target + '.',
    'You receive one vertical slice of a chapter page. Find every piece of story text in it and answer with JSON only.',
    '',
    'Output format (no commentary, no code fences):',
    '{"items":[{"box_2d":[ymin,xmin,ymax,xmax],"text":"original text","translation":"' + S.target + ' text","kind":"speech|thought|narration|sfx|sign"}],"names":[{"src":"original name","tgt":"chosen rendering"}]}',
    '',
    'Rules:',
    '- box_2d is a tight box around ALL text lines of ONE bubble, caption or sign, as [ymin, xmin, ymax, xmax] normalised to 0-1000 relative to this image. It must hug the GLYPHS only: at least one body-length of clean empty padding between the box and the bubble outline / frame on every side. Never include the outline, tail, border or background art; never merge different bubbles; never split one bubble.',
    '- text: copy the original wording EXACTLY, character for character (this is verified against the art), lines joined with a single space. Use "..." where the art shows an ellipsis; never use asterisks.',
    '- translation: ' + style + ' Keep each character\'s voice, relationships and tension consistent. Use the whole slice, the earlier lines and the glossary to resolve dropped subjects, speaker identity and ambiguity.',
    '- The translation is typeset INSIDE the original bubble where the source text stood, so it must fit: keep it as short as the meaning allows (aim for no longer than the original). Prefer a shorter natural phrasing over shrinking the font.',
    '- Output plain word characters only in translations: no markdown (* _ ** ~ < >), no brackets or braces around words, no quotation marks wrapping a whole line unless the original shows them, no emoji, no trailing spaces or newlines. One line per item.',
    '- Keep emphasis such as "?!" and "...", but never add extra punctuation, notes or explanations.',
    S.honorifics
      ? '- Keep honorifics and kinship terms the original uses (-nim, -ssi, hyung, noona, oppa, sunbae, -san, -kun, -sama...).'
      : '- Localise honorifics into natural ' + S.target + ' forms of address.',
    S.sfx
      ? '- Sound effects: kind "sfx", translated as a short onomatopoeia in ' + S.target + '.'
      : '- Do not output sound effects at all.',
    '- Ignore watermarks, site names, credits, URLs, page numbers, adverts and translator notes unless they belong to the story.',
    '- Order items in reading order: top to bottom; right to left within a row for Japanese manga, left to right otherwise.',
    '- names: only NEW proper nouns (people, places, skills, groups) missing from the glossary, with the spelling you chose, so later pages stay consistent.',
    '- If the slice has no story text return {"items":[],"names":[]}.',
  ].join('\n');
}

function buildUser(w, h, i, n) {
  const gl = [];
  for (const line of String(S.glossary || '').split('\n')) if (line.trim()) gl.push(line.trim());
  for (const [k, v] of Object.entries(ST.learned).slice(-60)) gl.push(k + ' = ' + v);
  const parts = ['Slice ' + (i + 1) + ' of ' + n + '. Image size: ' + w + 'x' + h + ' px.'];
  if (gl.length) parts.push('Glossary (use these renderings consistently):\n' + gl.join('\n'));
  if (String(S.extra || '').trim()) parts.push('Reader instructions: ' + S.extra.trim());
  if (ST.recent.length) parts.push('Earlier lines of this chapter, already translated (context only, do not output them):\n' + ST.recent.join('\n'));
  parts.push('Return the JSON now.');
  return parts.join('\n\n');
}

function parseModelJSON(t) {
  t = String(t || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (t[0] === '[') t = '{"items":' + t + '}';
  try { const j = JSON.parse(t); if (j && typeof j === 'object') return j; } catch (e) { /* salvage below */ }
  const grab = key => {
    const m = new RegExp('"' + key + '"\\s*:\\s*\\[').exec(t);
    if (!m) return [];
    const res = []; let depth = 0, start = -1, str = false, esc = false;
    for (let i = m.index + m[0].length; i < t.length; i++) {
      const c = t[i];
      if (str) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false; continue; }
      if (c === '"') str = true;
      else if (c === '{') { if (depth++ === 0) start = i; }
      else if (c === '}') { if (--depth === 0 && start >= 0) { try { res.push(JSON.parse(t.slice(start, i + 1))); } catch (e) { /* skip */ } start = -1; } }
      else if (c === ']' && depth === 0) break;
    }
    return res;
  };
  return { items: grab('items'), names: grab('names') };
}

const KINDS = { speech: 1, thought: 1, narration: 1, sfx: 1, sign: 1 };
const normKind = k => { k = String(k || '').toLowerCase(); return KINDS[k] ? k : (/sfx|sound|onomat/.test(k) ? 'sfx' : (/narr|caption/.test(k) ? 'narration' : 'speech')); };

/* strip model artefacts so the line reads like native lettering: markdown emphasis, wrapping
   quotes/brackets, stray emoji, non-breaking spaces, multiple newlines */
function cleanTr(s) {
  s = String(s || '').replace(/\r/g, '');
  s = s.replace(/[*_~]{1,3}(?=\S)|(?<=\S)[*_~]{1,3}/g, '');            /* markdown emphasis */
  s = s.replace(/`{1,3}/g, '').replace(/<\/?(?:b|i|em|strong|u)>/gi, '');
  s = s.replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/\s*\n+\s*/g, ' ');
  s = s.replace(/\p{Extended_Pictographic}+/gu, '');                     /* emoji */
  s = s.replace(/\s{2,}/g, ' ').trim();
  const pair = [['"', '"'], ['“', '”'], ['「', '」'], ['『', '』'], ['‘', '’'], ['(', ')'], ['[', ']'], ['<', '>']];
  for (let i = 0; i < 3 && s.length > 3; i++) for (const [o, c] of pair) if (s.startsWith(o) && s.endsWith(c)) s = s.slice(1, -1).trim();
  return s.replace(/\s{2,}/g, ' ').trim();
}

/* convert model boxes (slice-relative, 0-1000) to fractions of the whole image */
function normItems(list, sl, cv) {
  const out = [], ctx = cv ? cv.getContext('2d', { willReadFrequently: true }) : null;
  for (const it of list || []) {
    const b = it && (it.box_2d || it.box || it.bbox);
    if (!Array.isArray(b) || b.length < 4) continue;
    let [y1, x1, y2, x2] = b.map(Number);
    if ([y1, x1, y2, x2].some(Number.isNaN)) continue;
    if (y1 > y2) [y1, y2] = [y2, y1];
    if (x1 > x2) [x1, x2] = [x2, x1];
    [y1, x1, y2, x2] = [y1, x1, y2, x2].map(v => clamp(v, 0, 1000));
    if (x2 - x1 < 4 || y2 - y1 < 4) continue;
    const tr = cleanTr(String(it.translation != null ? it.translation : (it.tr || '')).trim());
    if (!tr) continue;
    const kind = normKind(it.kind);
    if (kind === 'sfx' && !S.sfx) continue;
    const shH = sl.y1 - sl.y0;
    /* keep the paint box on the text glyphs only — if the model boxed the whole bubble, shrink
       it inside the outline so we never erase the bubble's own border */
    let bx = [y1, x1, y2, x2];
    if (ctx) { const t = trimToFill(ctx, cv.width, cv.height, bx); if (!t) continue; bx = t; }
    const bg = ctx ? sampleBg(ctx, cv.width, cv.height, bx[0], bx[1], bx[2], bx[3]) : null;
    /* recompute page fractions from the TRIMMED box: fy1/fy2 must match bx, otherwise a shrunk
       box still paints/overlays at the original (outline-inclusive) height and covers the border */
    const gy1 = (sl.y0 + bx[0] / 1000 * shH) / sl.H, gy2 = (sl.y0 + bx[2] / 1000 * shH) / sl.H;
    out.push({
      x: +(bx[1] / 1000).toFixed(4), y: +gy1.toFixed(5), w: +((bx[3] - bx[1]) / 1000).toFixed(4), h: +(gy2 - gy1).toFixed(5),
      sx: Math.round(bx[1] / 1000 * cv.width), sy: Math.round(bx[0] / 1000 * cv.height),
      sw: Math.max(1, Math.round((bx[3] - bx[1]) / 1000 * cv.width)), sh: Math.max(1, Math.round((bx[2] - bx[0]) / 1000 * cv.height)),
      text: String(it.text || '').trim(), tr, kind, bg: bg ? bg.c : null, busy: bg ? bg.busy : false, spread: bg ? bg.spread : 0,
      edge: (sl.cutTop && y1 < 15) || (sl.cutBot && y2 > 985),
    });
  }
  return out;
}

function mergeItems(list) {
  const out = [];
  const inter = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  for (const it of list.slice().sort((a, b) => a.y - b.y)) {
    const j = out.findIndex(o => inter(o, it) / Math.min(o.w * o.h, it.w * it.h) > 0.5);
    if (j < 0) out.push(it); else if (out[j].edge && !it.edge) out[j] = it;
  }
  return out.map(o => { const r = Object.assign({}, o); delete r.edge; return r; });
}

function learn(res) {
  for (const n of (res && res.names) || []) {
    if (!n || !n.src || !n.tgt || String(n.src).length > 40) continue;
    ST.learned[String(n.src).trim()] = String(n.tgt).trim();
  }
  const ks = Object.keys(ST.learned); if (ks.length > 120) delete ST.learned[ks[0]];
}

/* ───────────────────────── model providers ───────────────────────── */

/* Errors are plain TLErrors while the reader works, but become TestErrors while the settings
   "Test connection" button runs, so a failed test never freezes the whole reader. */
function netErr(msg, kind, wait) { return testingNow ? new TestError(msg, kind, wait) : new TLError(msg, kind, wait); }

/* Daily free quota exhausted — Google says "Resource has been exhausted" / "PerDay". */
const isDailyQuota = text => {
  const t = String(text || '');
  return /RESOURCE_EXHAUSTED/i.test(t) || (/quota/i.test(t) && /(exhausted|PerDay|per day|daily|24 ?h)/i.test(t));
};

function httpError(r, keyLabel) {
  let msg = ''; try { const j = JSON.parse(r.text); msg = (j.error && (j.error.message || j.error)) || j.message || ''; } catch (e) { msg = String(r.text || '').slice(0, 200); }
  msg = String(msg);
  const who = keyLabel ? ' (' + keyLabel + ')' : '';
  if (r.status === 401 || r.status === 403) return netErr('API key rejected' + who + ' (' + r.status + '). Double-check the whole key is pasted in Settings — copy it again from aistudio.google.com/apikey. ' + (msg || ''), 'fatal');
  if (r.status === 429) {
    if (/limit:\s*0\b/.test(r.text || '')) return netErr('This model has no free quota on your key. Leave the Model field empty (or use gemini-2.5-flash-lite).', 'fatal');
    if (isDailyQuota(r.text)) return netErr('Daily free quota used up' + who + '. Add another free key in Settings → Backup API keys (one per line), or wait until tomorrow.', 'daily');
    const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(r.text || '') || /retry-after:\s*(\d+)/i.exec(r.headers || '');
    return netErr('Rate limited', 'rate', clamp(m ? Math.ceil(parseFloat(m[1]) * 1000) + 500 : 20000, 3000, 120000));
  }
  if (r.status === 400 && isDailyQuota(r.text)) return netErr('Daily free quota used up' + who + '. Add another free key in Settings → Backup API keys (one per line), or wait until tomorrow.', 'daily');
  if (r.status === 400 && /api key|API_KEY/i.test(msg)) return netErr('API key invalid: ' + msg.slice(0, 120), 'fatal');
  if (r.status === 403 && /permission|disabled|not serve|region/i.test(msg)) return netErr('Google refused this request: ' + msg.slice(0, 160), 'fatal');
  if (r.status === 404) return netErr('Model "' + modelName() + '" not found. Leave the Model field empty for the default, or type an exact name like gemini-2.5-flash-lite.', 'fatal');
  if (r.status >= 500) return netErr('Provider error ' + r.status, 'retry');
  return netErr('Request failed (' + r.status + '): ' + msg.slice(0, 160), 'retry');
}

async function apiPost(url, headers, body, timeout) {
  const data = JSON.stringify(body), ms = timeout || NET.ms, errs = [];
  try {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => ctl && ctl.abort(), ms);
    try {
      const r = await fetch(url, { method: 'POST', headers, body: data, signal: ctl ? ctl.signal : undefined });
      return { status: r.status, text: await r.text(), headers: Array.from(r.headers.entries()).map(e => e[0] + ': ' + e[1]).join('\n') };
    } finally { clearTimeout(timer); }
  } catch (e) { errs.push('direct: ' + ((e && e.message) || e)); }
  try {
    const r = await gmRequest({ url, method: 'POST', headers, data, responseType: 'text', timeout: ms });
    return { status: r.status, text: r.responseText != null ? r.responseText : (typeof r.response === 'string' ? r.response : ''), headers: r.responseHeaders || '' };
  } catch (e) { errs.push('userscript: ' + ((e && e.message) || e)); }
  throw netErr('Could not reach the AI service (' + errs.join('; ') + ')', 'retry');
}

/* Plain GET via fetch with GM fallback — used to probe local servers (/v1/models, /api/tags). */
async function apiGet(url, headers, timeout) {
  const ms = timeout || NET.ms, errs = [];
  try {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => ctl && ctl.abort(), ms);
    try {
      const r = await fetch(url, { method: 'GET', headers, signal: ctl ? ctl.signal : undefined });
      return { status: r.status, text: await r.text() };
    } finally { clearTimeout(timer); }
  } catch (e) { errs.push('direct: ' + ((e && e.message) || e)); }
  try {
    const r = await gmRequest({ url, method: 'GET', headers, responseType: 'text', timeout: ms });
    return { status: r.status, text: r.responseText != null ? r.responseText : (typeof r.response === 'string' ? r.response : '') };
  } catch (e) { errs.push('userscript: ' + ((e && e.message) || e)); }
  throw netErr('Could not reach the AI service (' + errs.join('; ') + ')', 'retry');
}

async function callModel(req) {
  /* Local servers need no key at all — skip the key-rotation machinery entirely. */
  if (S.provider === 'local') return callModelOnce(req, S.apiKey || 'local');
  const keys = allKeys();
  /* OpenRouter works without a key too (free models only, tighter anonymous limits). */
  if (S.provider === 'openrouter' && !keys.length) return callModelOnce(req, '');
  if (!keys.length) throw netErr('Add your API key in Settings.', 'fatal');
  /* Try every configured key in turn (round-robin starting at the last one that worked). When a
     free key hits its DAILY quota the next key is used automatically — this is how ToonLens keeps
     translating past a single key's limit, the same trick OpenToon does with multiple accounts. */
  let idx = clamp(Number.isInteger(S.keyIdx) ? S.keyIdx : 0, 0, keys.length - 1);
  let lastErr = null;
  for (let tried = 0; tried < keys.length; tried++) {
    S.keyIdx = idx % keys.length;
    try { return await callModelOnce(req, keys[S.keyIdx]); }
    catch (e) {
      lastErr = e;
      if (!(e && e.kind === 'daily')) throw e;
      idx++;
    }
  }
  throw lastErr || netErr('Every API key has hit its daily quota.', 'daily');
}

async function callModelOnce({ system, text, image }, apiKey) {
  const p = S.provider;
  if (p === 'local') return callLocal({ system, text, image }, apiKey);
  if (p === 'openrouter') return callOpenRouter({ system, text, image }, apiKey);
  const model = modelName();
  if (!model) throw netErr('Enter a model name in Settings.', 'fatal');
  const keyLabel = 'key #' + (clamp(S.keyIdx || 0, 0, 99) + 1);

  if (p === 'gemini') {
    const gen = { temperature: 0.3, maxOutputTokens: 8192, responseMimeType: 'application/json' };
    if (S.thinking && S.thinking !== 'off') gen.thinkingConfig = { thinkingLevel: S.thinking };
    const parts = []; if (image) parts.push({ inlineData: { mimeType: 'image/jpeg', data: image } }); parts.push({ text });
    const body = {
      systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts }], generationConfig: gen,
      safetySettings: ['HARASSMENT', 'HATE_SPEECH', 'SEXUALLY_EXPLICIT', 'DANGEROUS_CONTENT'].map(c => ({ category: 'HARM_CATEGORY_' + c, threshold: 'BLOCK_NONE' })),
    };
    const headers = { 'content-type': 'application/json', 'x-goog-api-key': apiKey };
    /* Free-tier models change often; if the configured one is missing/has no quota, quietly try
       the other known free ones before giving up. */
    const chain = [model];
    for (const m of GEMINI_FREE_MODELS) if (!chain.includes(m)) chain.push(m);
    lastTriedChain = S.provider === 'gemini' ? chain.slice() : [];
    let ok = null;
    for (let i = 0; i < chain.length; i++) {
      const m = chain[i];
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(m) + ':generateContent';
      let r = await apiPost(url, headers, body);
      if (r.status === 400 && gen.thinkingConfig && /think/i.test(r.text)) { delete gen.thinkingConfig; r = await apiPost(url, headers, body); }
      if (r.status === 200) {
        if (m !== model && !S.model) { S.model = m; saveSettings(); toast('Using ' + m + ' (your default model had no free quota).', true); }
        ok = r; break;
      }
      const switchable = r.status === 404 || (r.status === 429 && /limit:\s*0\b/.test(r.text || ''));
      if (!(switchable && i < chain.length - 1)) throw httpError(r, keyLabel);
    }
    let j; try { j = JSON.parse(ok.text); } catch (e) { throw netErr('Bad response from Gemini', 'retry'); }
    if (j.promptFeedback && j.promptFeedback.blockReason) throw netErr('Blocked by Gemini (' + j.promptFeedback.blockReason + ')', 'final');
    const c = j.candidates && j.candidates[0];
    const out = ((c && c.content && c.content.parts) || []).filter(x => !x.thought).map(x => x.text || '').join('');
    if (!out) throw netErr('Gemini returned no text' + (c && c.finishReason ? ' (' + c.finishReason + ')' : ''), 'retry');
    return out;
  }

  if (p === 'anthropic') {
    const content = []; if (image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } }); content.push({ type: 'text', text });
    const body = { model, max_tokens: 8192, temperature: 0.3, system, messages: [{ role: 'user', content }] };
    const headers = { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
    let r = await apiPost('https://api.anthropic.com/v1/messages', headers, body);
    if (r.status === 400 && /temperature/i.test(r.text)) { delete body.temperature; r = await apiPost('https://api.anthropic.com/v1/messages', headers, body); }
    if (r.status !== 200) throw httpError(r, keyLabel);
    let j; try { j = JSON.parse(r.text); } catch (e) { throw netErr('Bad response from Claude', 'retry'); }
    const out = (j.content || []).filter(x => x.type === 'text').map(x => x.text).join('');
    if (!out) throw netErr('Claude returned no text', 'retry');
    return out;
  }

  const base = String(S.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const content = [{ type: 'text', text }]; if (image) content.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + image } });
  const body = { model, temperature: 0.3, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content }] };
  const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey };
  let r;
  for (let i = 0; i < 3; i++) {
    r = await apiPost(base + '/chat/completions', headers, body);
    if (r.status !== 400) break;
    let stripped = false;
    for (const k of ['temperature', 'response_format']) if (body[k] !== undefined && new RegExp(k, 'i').test(r.text)) { delete body[k]; stripped = true; }
    if (!stripped) break;
  }
  if (r.status !== 200) throw httpError(r, keyLabel);
  let j; try { j = JSON.parse(r.text); } catch (e) { throw netErr('Bad response from provider', 'retry'); }
  const out = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!out) throw netErr('Provider returned no text', 'retry');
  return out;
}

/* ─────────────── free hosted vision models (OpenRouter) ─────────────── */

/* For PCs too weak for local models: OpenRouter runs small vision models on THEIR servers and
   offers several ":free" routes — no credit card, nothing installed. Free routes have modest
   limits (~50 requests/day per key, 20 req/min), so ToonLens rotates through your backup keys
   exactly like it does for Gemini, and falls back between free models when one is unavailable.
   A key is optional (anonymous calls work with tighter limits). The allow-list below pins the
   route to free/no-restrictions providers only, so a :free model can never silently spill onto
   a paid provider and burn credits. */

async function orOnce(url, headers, body, ms) {
  const r = await apiPost(url, headers, body, ms);
  let j = null; try { j = JSON.parse(r.text); } catch (e) { /* handled below */ }
  return { r, j };
}

async function callOpenRouter({ system, text, image }, apiKey) {
  const ms = netMsFor('openrouter');
  const headers = { 'content-type': 'application/json', 'HTTP-Referer': 'https://toonlens.local/', 'X-Title': 'ToonLens' };
  if (apiKey) headers.authorization = 'Bearer ' + apiKey;
  const content = [{ type: 'text', text }]; if (image) content.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + image } });
  /* Sticky model: once a free model has worked we keep using it instead of re-probing the chain. */
  const sticky = String(S.orModel || '').trim();
  const custom = String(S.model || '').trim();
  const chain = [];
  for (const m of [custom, sticky]) if (m && !chain.includes(m)) chain.push(m);
  for (const m of OPENROUTER_FREE_MODELS) if (!chain.includes(m)) chain.push(m);
  lastTriedChain = chain.slice();
  const keyLabel = apiKey ? 'key #' + (clamp(S.keyIdx || 0, 0, 99) + 1) : '';
  const url = 'https://openrouter.ai/api/v1/chat/completions';
  let lastErr = null;
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    const body = {
      model, messages: [{ role: 'system', content: system }, { role: 'user', content }],
      temperature: 0.3, max_tokens: 8192, response_format: { type: 'json_object' },
    };
    /* Free routes must never spill onto paid providers — pin the route to no-restriction
       endpoints and disable fallbacks so a $0 model can't silently bill a $10 one. */
    body.provider = { allow_fallbacks: false };
    if (/:free$/.test(model)) body.provider.order = ['*'];
    let r, j;
    try { ({ r, j } = await orOnce(url, headers, body, ms)); }
    catch (e) { lastErr = e; break; } /* network failure — retryable, bubble up */
    if (r.status === 200 && j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) {
      if (model !== sticky) { S.orModel = model; saveSettings(); if (!custom && sticky) toast('Using ' + model + ' on OpenRouter.', true); }
      return j.choices[0].message.content;
    }
    const msg = (j && j.error && (j.error.message || j.error.code)) || String(r.text || '').slice(0, 200);
    if (r.status === 429) {
      if (/day/i.test(String(msg))) { lastErr = netErr('Daily free limit reached on OpenRouter' + (keyLabel ? ' (' + keyLabel + ')' : '') + '. Add another free OpenRouter key in Settings → Backup API keys (one per line), or wait until tomorrow.', 'daily'); continue; }
      lastErr = netErr('Rate limited by OpenRouter: ' + String(msg).slice(0, 140), 'rate', 60000); continue;
    }
    if (r.status === 401 || r.status === 403) { lastErr = netErr('OpenRouter rejected the key' + (keyLabel ? ' ' + keyLabel : '') + '. Copy a fresh key from openrouter.ai/keys, or leave the key field empty to use it anonymously.', 'fatal'); continue; }
    /* Model missing / no free providers / bad request → quietly try the next free model. */
    lastErr = netErr('OpenRouter error (' + r.status + '): ' + String(msg).slice(0, 160), i < chain.length - 1 ? 'retry' : 'final');
  }
  throw lastErr || netErr('No free OpenRouter model responded. Try again shortly or pick another :free model in Settings → Model.', 'retry');
}

/* ─────────────────── local vision models (LM Studio / Ollama / llama.cpp) ─────────────────── */

/* Local servers have NO quotas at all — this is the fully unlimited option. The OpenAI-style
   chat endpoint below works with LM Studio (Server tab → enable "Local Server" + CORS, default
   port 1234), llama.cpp's server (-ngl 99 --port 8080), Jan, KoboldCpp's OpenAI layer and any
   other OpenAI-compatible local runtime. Ollama is auto-detected from its base URL and uses its
   native /api/chat endpoint (set a model's num_ctx to >= 8192 for best results). */

const LOCAL_DEFAULT_BASE = 'http://localhost:1234/v1';
let localModelCache = { base: '', ids: [], at: 0 };

const isOllamaUrl = u => { try { const x = new URL(u); return x.hostname === 'localhost' && x.port === '11434'; } catch (e) { return false; } };
const ollamaOrigin = u => { try { const x = new URL(u); return x.protocol + '//' + x.host; } catch (e) { return ''; } };

async function listLocalModels() {
  const base = String(S.localBase || LOCAL_DEFAULT_BASE).replace(/\/+$/, '');
  if (localModelCache.base === base && Date.now() - localModelCache.at < 60000) return localModelCache.ids;
  const headers = { 'content-type': 'application/json', ...(S.apiKey ? { authorization: 'Bearer ' + S.apiKey } : {}) };
  const urls = isOllamaUrl(base) ? [ollamaOrigin(base) + '/api/tags', base + '/models'] : [base + '/models'];
  let lastErr = null;
  for (const url of urls) {
    try {
      const r = await apiGet(url, headers, 15000);
      if (r.status !== 200) { lastErr = 'HTTP ' + r.status; continue; }
      let j; try { j = JSON.parse(r.text); } catch (e) { lastErr = 'not JSON'; continue; }
      const arr = Array.isArray(j) ? j : (j.data || j.models || []);
      const ids = arr.map(m => (typeof m === 'string' ? m : (m.id || m.model || m.name))).filter(Boolean);
      if (ids.length) { localModelCache = { base, ids, at: Date.now() }; return ids; }
      lastErr = 'empty list';
    } catch (e) { lastErr = (e && e.message) || String(e); }
  }
  throw netErr('Could not read the model list from ' + base + ' (' + lastErr + '). Make sure the local server is running and CORS is enabled.', 'retry');
}

const VISION_HINT = /(vision|vl|moondrop)/i;
const pickVisionModel = ids => {
  const vis = ids.filter(id => VISION_HINT.test(id));
  const pool = vis.length ? vis : ids;
  const qw = pool.filter(id => /qwen.*[23]/i.test(id));
  if (qw.length) return qw[qw.length - 1];
  return pool[0];
};

function localError(r) {
  const low = String(r.text || '').toLowerCase();
  if (r.status === 404 && /model/.test(low)) return netErr('The local server does not have that model loaded. Load it in LM Studio/Ollama first, or press "Use a loaded model" in Settings.', 'fatal');
  if (r.status === 400 && /does not support images|image.*not support|unsupported.*image/i.test(r.text || '')) return netErr('That model cannot see images. Pick a vision model like Qwen2.5-VL 7B or Moondream.', 'fatal');
  if (r.status >= 500) return netErr('Local server error ' + r.status + ': ' + String(r.text || '').slice(0, 160), 'retry');
  return netErr('Local request failed (' + r.status + '): ' + String(r.text || '').slice(0, 160), 'retry');
}

async function callLocal({ system, text, image }, apiKey) {
  const ms = netMsFor('local');
  const base = String(S.localBase || LOCAL_DEFAULT_BASE).replace(/\/+$/, '') || LOCAL_DEFAULT_BASE.replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json', ...(apiKey && apiKey !== 'local' ? { authorization: 'Bearer ' + apiKey } : {}) };
  let model = modelName(), out = '';
  if (!model) { try { model = pickVisionModel(await listLocalModels()); } catch (e) { /* fall through to a clearer error below */ } }

  if (isOllamaUrl(base)) {
    /* Ollama's native API: no "/v1" suffix, images as plain base64, JSON mode via "format". */
    const content = []; if (image) content.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + image } }); content.push({ type: 'text', text });
    const body = { model, stream: false, format: 'json', options: { temperature: 0.3 }, messages: [{ role: 'system', content: system }, { role: 'user', content }] };
    const r = await apiPost(ollamaOrigin(base) + '/api/chat', headers, body, ms);
    if (r.status !== 200) { if (r.status === 404 && !model) throw netErr('Enter the exact Ollama model name in Settings → Model (see "ollama list"), e.g. llava:13b.', 'fatal'); throw localError(r); }
    let j; try { j = JSON.parse(r.text); } catch (e) { throw netErr('Bad response from Ollama', 'retry'); }
    out = (j.message && j.message.content) || '';
  } else {
    if (!model) throw netErr('Enter the exact model name your local server exposes in Settings → Model (or press "Use a loaded model").', 'fatal');
    const content = [{ type: 'text', text }]; if (image) content.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + image } });
    const body = { model, temperature: 0.3, max_tokens: 8192, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content }] };
    let r;
    for (let i = 0; i < 3; i++) {
      r = await apiPost(base + '/chat/completions', headers, body, ms);
      if (r.status !== 400) break;
      let stripped = false;
      for (const k of ['temperature', 'response_format', 'max_tokens']) if (body[k] !== undefined && new RegExp(k.replace('_', '[_ ]?'), 'i').test(r.text)) { delete body[k]; stripped = true; }
      if (!stripped) break;
    }
    if (r.status !== 200) { if (r.status === 404 && !S.model) throw netErr('Model "' + modelName() + '" not found on the local server. Press "Use a loaded model" in Settings.', 'fatal'); throw localError(r); }
    let j; try { j = JSON.parse(r.text); } catch (e) { throw netErr('Bad response from the local server', 'retry'); }
    out = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  }
  if (!out) throw netErr('The local model returned no text. If it is still loading the first run, try again.', 'retry');
  return out;
}

/* ───────────────────────── page translation job ───────────────────────── */

async function translatePage(p) {
  const key = cacheKey(p), hit = await idb.get(key);
  if (hit && hit.v === 1) { p.rec = hit; p.key = key; renderPage(p); return; }
  if (S.provider !== 'local' && S.provider !== 'openrouter' && !allKeys().length) throw new TLError('Add your API key in Settings.', 'fatal');
  const blob = p.blob || await fetchImageBlob(p.url, p.ref);
  const bmp = await decode(blob);
  try {
    const slices = planSlices(bmp), all = [];
    for (let i = 0; i < slices.length; i++) {
      const sl = Object.assign({}, slices[i], { H: bmp.h, cutTop: i > 0, cutBot: i < slices.length - 1 });
      const cv = drawSlice(bmp, sl);
      const b64 = cv.toDataURL('image/jpeg', S.quality).split(',')[1];
      const out = await callModel({ system: buildSystem(), text: buildUser(cv.width, cv.height, i, slices.length), image: b64 });
      const res = parseModelJSON(out);
      learn(res);
      all.push(...normItems(res.items, sl, cv));
    }
    const items = mergeItems(all);
    /* Erase the original lettering by inpainting each bubble's own fill over it, feathered at
       the edges so no rectangle is ever visible — the page then reads as if it were drawn in
       the target language. The clean image is stored as a BLOB (not a data-URL string: full-page
       JPEG data-URLs bloat IndexedDB and can hit quota on long chapters) and cached with it. */
    let cleanBlob = null;
    if (S.clean && S.cover) {
      try {
        const cv = document.createElement('canvas');
        cv.width = bmp.w; cv.height = bmp.h;
        const cx = cv.getContext('2d', { willReadFrequently: true });
        cx.drawImage(bmp.src, 0, 0);
        /* Boxes come back in SLICE coordinates (sy/sh are relative to the slice canvas the
           model saw). Slice heights vary, so converting through the item's page-fraction box
           (y/h were already mapped to full-page fractions in normItems) is exact — do that
           before painting. */
        const W = bmp.w, H = bmp.h;
        for (const it of items) {
          const pg = Object.assign({}, it, {
            sx: Math.round(it.x * W), sw: Math.max(1, Math.round(it.w * W)),
            sy: Math.round(it.y * H), sh: Math.max(1, Math.round(it.h * H)),
          });
          paintOver(cx, W, pg);
          it.sx = pg.sx; it.sw = pg.sw; it.sy = pg.sy; it.sh = pg.sh;   /* store page coords */
        }
        cleanBlob = await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.9));
        if (!(cleanBlob instanceof Blob)) cleanBlob = null;
        /* Only swap in the inpainted page when every text region was actually covered: if any
           item lacks a sampled fill (tainted canvas, degenerate box) its original glyphs would
           survive inside an otherwise-clean image — worse than the overlay fallback, which
           still paints an opaque cover rect per bubble. */
        else if (!items.every(it => it.kind === 'sfx' || it.bg)) cleanBlob = null;
        /* ...and never on pages that are too small to sample reliably: slice-relative boxes
           round to wrong pixels there, so we keep the per-bubble overlay path instead. */
        else if (bmp.w < 200 || bmp.h < 200) cleanBlob = null;
      } catch (e) { cleanBlob = null; } /* tainted canvas or memory pressure → fall back to overlays */
    }
    p.rec = { v: 1, W: bmp.w, H: bmp.h, items, clean: cleanBlob }; p.key = key;
    idb.set(key, p.rec);
    for (const it of items.slice(-6)) ST.recent.push(it.tr);
    ST.recent = ST.recent.slice(-14);
    renderPage(p);
  } finally { bmp.close(); }
}

/* ─────────────────────────── queue ─────────────────────────── */

function schedule() { if (ST.sched) return; ST.sched = setTimeout(() => { ST.sched = 0; pump(); }, 30); }

function pump() {
  if (ST.view !== 'reader') return;
  const now = Date.now();
  if (now < ST.backoff) { clearTimeout(ST.bt); ST.bt = setTimeout(schedule, ST.backoff - now + 50); return; }
  const mid = innerHeight / 2;
  const cand = ST.pages.filter(p => p.near && p.status === 'idle')
    .map(p => ({ p, d: Math.abs(p.el.getBoundingClientRect().top + p.el.offsetHeight / 2 - mid) })).sort((a, b) => a.d - b.d);
  for (const c of cand) { if (ST.running >= S.concurrency) break; run(c.p); }
}

async function run(p) {
  const sid = ST.session;
  p.status = 'run'; ST.running++; chip(p);
  dropClean(p); /* never show a stale inpaint while this page re-runs */
  try { await translatePage(p); p.status = 'done'; p.err = null; }
  catch (e) {
    if (sid !== ST.session) return;
    if (e && e.name === 'TestError') return; // settings test in flight — never touch the queue state
    const kind = e.kind || 'retry';
    if (kind === 'fatal') {
      /* Do NOT freeze every page forever. Park this page with its error message so the user can
         tap it to retry after fixing the key/model, and other pages stay actionable too. */
      p.status = 'error'; p.err = e.message;
      toast(e.message, true);
      if (/key|model/i.test(e.message)) openSettings();
    }
    else if (kind === 'daily') {
      /* Every configured key is out of daily quota. Park this page with a clear message; other
         pages stay actionable and everything resumes automatically when a quota resets. */
      p.status = 'error'; p.err = e.message;
      toast(e.message, true);
      openSettings();
    }
    else if (kind === 'rate') {
      ST.backoff = Date.now() + (e.wait || 15000); p.status = 'idle';
      if (++p.rl > 6) { p.status = 'error'; p.err = 'Rate limit kept blocking this page.'; } else toast('Rate limited. Pausing ' + Math.ceil((e.wait || 15000) / 1000) + 's.');
    }
    else if (kind === 'final') { p.status = 'error'; p.err = e.message; }
    else if (++p.tries < 3) { p.status = 'idle'; ST.backoff = Math.max(ST.backoff, Date.now() + 1500 * p.tries); }
    else { p.status = 'error'; p.err = e.message || String(e); }
  } finally {
    if (sid === ST.session) { ST.running--; chip(p); updateProgress(); schedule(); }
  }
}

function chip(p) {
  const c = p.st; if (!c) return;
  c.className = 'st'; c.textContent = '';
  if (p.status === 'run') { c.append(el('i', { class: 'dot' }), el('span', { text: 'Translating' })); c.hidden = false; }
  else if (p.status === 'error') { c.classList.add('err'); c.append(el('span', { text: 'Failed. Tap to retry' })); c.title = p.err || ''; c.hidden = false; }
  else c.hidden = true;
}

function retry(p) { p.status = 'idle'; p.tries = 0; p.rl = 0; chip(p); schedule(); }

function updateProgress() {
  if (!ui.sub) return;
  const d = ST.pages.filter(p => p.status === 'done').length, e = ST.pages.filter(p => p.status === 'error').length;
  ui.sub.textContent = d + ' of ' + ST.pages.length + ' translated' + (e ? ' · ' + e + ' failed' : '');
}

/* ───────────────────────── bubble rendering ───────────────────────── */

/* Swap the page's visible image for the inpainted (original-text-erased) version. The original
   download stays in p.imgSrc so toggling "Inpaint" off restores it untouched. The clean image is
   a Blob (small in IndexedDB); we show it through an object URL and revoke old ones so Safari
   doesn't accumulate them across a long chapter. */
function setCleanImg(p) {
  if (!p.img || !p.el.isConnected) return;
  const use = S.clean && S.cover && p.rec && p.rec.clean instanceof Blob;
  if (use) {
    if (!p.cleanUrl) { try { p.cleanUrl = URL.createObjectURL(p.rec.clean); } catch (e) { p.cleanUrl = ''; } }
    if (p.cleanUrl && p.img.src !== p.cleanUrl) p.img.src = p.cleanUrl;
  } else if (p.cleanUrl) {
    if (p.img.src === p.cleanUrl && p.imgSrc) p.img.src = p.imgSrc;
    URL.revokeObjectURL(p.cleanUrl); p.cleanUrl = '';
  } else if (p.imgSrc && p.img.src !== p.imgSrc) p.img.src = p.imgSrc;
}

/* Drop any cached clean render of a page — called before re-running translatePage so a stale
   inpaint never flashes while the new one is produced. */
function dropClean(p) {
  if (p.cleanUrl) { URL.revokeObjectURL(p.cleanUrl); p.cleanUrl = ''; }
  if (p.rec) p.rec.clean = null;
}

/* Paint the sampled bubble fill over the original glyphs on a full-page canvas, with a soft
   feathered mask so the patch blends into the art instead of looking like a pasted rectangle.
   `it` carries a box in FULL-PAGE pixel coordinates (sy/sh) plus x/w as page fractions. */
function paintOver(cx, W, it) {
  if (it.kind === 'sfx') return;                       /* SFX overlays never erase the art */
  const H = cx.canvas.height;
  /* re-sample the bubble fill from the FULL-PAGE canvas: it.bg was sampled on a resized slice,
     and flat-filled patches only look native when they match the exact pixels underneath */
  let c = it.bg, spread = it.spread || 0;
  try {
    const sx = clamp(it.sx, 0, W - 2), sy = clamp(it.sy, 0, H - 2);
    const sw = clamp(it.sw, 1, W - sx), sh = clamp(it.sh, 1, H - sy);
    const d = cx.getImageData(sx, sy, sw, sh).data;
    const t = Math.max(1, Math.round(Math.min(sw, sh) * 0.1)), R = [], Gc = [], B = [];
    const push = (x, y) => { const i = (y * sw + x) * 4; if (d[i + 3] > 200) { R.push(d[i]); Gc.push(d[i + 1]); B.push(d[i + 2]); } };
    for (let y = 0; y < sh; y++) { if (y < t || y >= sh - t) { for (let x = 0; x < sw; x += 2) push(x, y); } else { for (let x = 0; x < t; x++) push(x, y); for (let x = sw - t; x < sw; x++) push(x, y); } }
    if (R.length >= 8) {
      const med = a => Uint8Array.from(a).sort()[a.length >> 1];
      c = [med(R), med(Gc), med(B)];
      let sd = 0; for (let i = 0; i < R.length; i++) sd += Math.abs(R[i] - c[0]) + Math.abs(Gc[i] - c[1]) + Math.abs(B[i] - c[2]);
      spread = sd / (R.length * 3);
    }
  } catch (e) { /* tainted canvas — fall back to the slice sample below */ }
  if (!c) return;
  /* pad in the same units the overlay cover uses (page fractions), so the painted patch always
     extends at least as far as the DOM rectangle and no leftover glyph peeks out beside it */
  const padX = Math.max(2, Math.round(W * it.w * (S.pad / 100 + 0.02)));
  const padY = Math.max(2, Math.round(H * it.h * (S.pad / 100 + 0.02)));
  const x = clamp(it.sx - padX, 0, W - 1), y = clamp(it.sy - padY, 0, H - 1);
  const w = clamp(it.sw + padX * 2, 1, W - x), h = clamp(it.sh + padY * 2, 1, H - y);
  /* Feather width adapts to how noisy the surrounding fill is: a perfectly flat white bubble
     needs only a couple of px to kill the seam, but grainy/gradient-shaded art shows a flat
     rectangle even with soft edges, so we blend over a much wider band there. Scale with the
     page resolution too — a few px means nothing on a 3000px-wide webtoon page. */
  const grain = clamp(Math.round(spread * 0.9), 0, 16);
  const res = clamp(Math.round(W / 500), 1, 4);
  const feather = clamp(4 * res + Math.round(Math.min(w, h) * 0.08) + grain, 3, Math.max(4, Math.floor(Math.min(w, h) / 2.5)));
  /* The blurred outer ring only feathers a band `feather` wide — everything further in must be
     solid or ghosted glyphs show through the patch. On small boxes (narration strips, tight
     captions) that interior would vanish, so cap the feather to keep ≥ 6px of dead-solid core
     on every side; the box padding already gives most of the visual softness there. */
  const f = Math.min(feather, Math.max(3, Math.floor((Math.min(w, h) - 12) / 2)));
  const mk = document.createElement('canvas');
  mk.width = w; mk.height = h;
  const m = mk.getContext('2d');
  m.fillStyle = '#fff';
  m.beginPath();
  const r = Math.min(h / 2, Math.max(3, f));
  if (m.roundRect) m.roundRect(0, 0, w, h, r); else m.rect(0, 0, w, h);
  m.fill();
  /* feathered frame: stroke a ring just OUTSIDE the rect edge with a blurred line, then punch
     the still-solid interior back in. Only the blur's inner tail bleeds into the mask, so alpha
     ramps from ~0 at the very edge to fully solid one feather inward — the seam disappears while
     the whole interior stays opaque enough to actually hide the original glyphs. */
  m.globalCompositeOperation = 'destination-out';
  m.filter = 'blur(' + f + 'px)';
  m.lineWidth = f * 2;
  m.strokeStyle = '#fff';
  if (m.roundRect) { m.beginPath(); m.roundRect(-f, -f, w + 2 * f, h + 2 * f, r + f); m.stroke(); }
  else m.strokeRect(-f, -f, w + 2 * f, h + 2 * f);
  m.filter = 'none';
  m.globalCompositeOperation = 'destination-over';
  m.fillStyle = '#fff';
  m.beginPath();
  if (m.roundRect) m.roundRect(f, f, Math.max(1, w - 2 * f), Math.max(1, h - 2 * f), Math.max(0, r - f));
  else m.rect(f, f, Math.max(1, w - 2 * f), Math.max(1, h - 2 * f));
  m.fill();
  m.globalCompositeOperation = 'source-over';
  const pc = document.createElement('canvas');
  pc.width = w; pc.height = h;
  const pctx = pc.getContext('2d');
  pctx.fillStyle = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
  pctx.fillRect(0, 0, w, h);
  /* Match the texture of the art around the bubble: a dead-flat fill under grainy or
     gradient-shaded lettering reads as a pasted sticker. Sprinkle low-amplitude noise into the
     patch (amplitude derived from the measured spread) so the inpainted area has the same
     micro-contrast as its surroundings. */
  if (grain >= 2) {
    try {
      const pd = pctx.getImageData(0, 0, w, h), q = pd.data, amp = Math.min(10, Math.max(2, Math.round(grain * 0.7)));
      for (let i = 0; i < q.length; i += 4) {
        if (q[i + 3] < 8) continue;
        const n = Math.round((Math.random() * 2 - 1) * amp);
        q[i] = clamp(q[i] + n, 0, 255); q[i + 1] = clamp(q[i + 1] + n, 0, 255); q[i + 2] = clamp(q[i + 2] + n, 0, 255);
      }
      pctx.putImageData(pd, 0, 0);
    } catch (e) { /* getImageData unavailable on this context — flat fill still works */ }
  }
  pctx.globalCompositeOperation = 'destination-in';
  pctx.drawImage(mk, 0, 0);
  cx.drawImage(pc, x, y);
}

function fit(text, wN, hN, maxPx, rtl) {
  if (!ui.meas) { ui.meas = el('div', { class: 'meas' }); ui.root.appendChild(ui.meas); }
  const m = ui.meas;
  m.dir = rtl ? 'rtl' : 'ltr'; m.style.width = Math.max(8, wN) + 'px'; m.textContent = text;
  let lo = 5, hi = clamp(hN, 8, maxPx), best = lo;
  for (let i = 0; i < 9 && hi - lo > 0.6; i++) {
    const mid = (lo + hi) / 2; m.style.fontSize = mid + 'px';
    if (m.scrollHeight <= hN && m.scrollWidth <= wN + 1) { best = mid; lo = mid; } else hi = mid;
  }
  return best;
}

function renderPage(p) {
  const rec = p.rec; if (!rec || !p.ov || !p.el.isConnected) return;
  setCleanImg(p);
  p.ov.textContent = '';
  const rtl = RTL.test(S.target), frag = document.createDocumentFragment();
  for (const it of rec.items) frag.appendChild(bubble(p, it, rec, rtl));
  p.ov.appendChild(frag);
}

function bubble(p, it, rec, rtl) {
  const W = rec.W, sfx = it.kind === 'sfx';
  const px = it.w * S.pad / 100, py = it.h * S.pad / 100;
  const x = it.x - px, y = it.y - py, w = it.w + 2 * px, h = it.h + 2 * py;
  const text = S.caps ? it.tr.toUpperCase() : it.tr;
  const size = fit(text, w * W * 0.94, h * rec.H * 0.92, W * 0.055, rtl) * S.fontScale / 100;
  const b = el('div', { class: 'bb ' + it.kind + (S.cover ? '' : ' nocover') });
  const tx = el('span', { class: 'tx', text: it.tr });
  if (rtl) tx.dir = 'rtl';
  const f = n => (n * 100).toFixed(3) + '%';
  if (sfx) {
    Object.assign(b.style, { left: f(x + w / 2), top: f(y + h / 2) });
    tx.style.fontSize = (Math.min(size, W * 0.04) / W * 100).toFixed(3) + 'cqw';
  } else {
    Object.assign(b.style, { left: f(x), top: f(y), width: f(w), height: f(h) });
    tx.style.fontSize = (size / W * 100).toFixed(3) + 'cqw';
    if (S.cover && it.bg) {
      const c = it.bg, lum = c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114, rgb = 'rgb(' + c.join(',') + ')';
      b.style.background = rgb;
      /* Inpaint mode already erased the original text into the page image, so the DOM box is
         only a safety cover — feather its edges and drop the halo glow, otherwise the box's own
         rectangle/blur outline sits over a perfectly clean bubble and "looks off". When the
         inpainted image is unavailable (fallback overlays), keep the solid cover + glow. */
      if (S.blend && S.clean && rec.clean) {
        const r = Math.min(6, Math.max(2, w * W * 0.012));
        b.style.borderRadius = r.toFixed(1) + 'px';
        b.style.boxShadow = 'none';
        b.style.webkitMaskImage = 'radial-gradient(closest-side, #000 calc(100% - ' + Math.ceil(r + 3) + 'px), transparent 100%)';
        b.style.maskImage = 'radial-gradient(closest-side, #000 calc(100% - ' + Math.ceil(r + 3) + 'px), transparent 100%)';
      } else {
        b.style.boxShadow = '0 0 0.5cqw 0.2cqw ' + rgb;
      }
      if (it.busy) b.style.opacity = '0.94';
      tx.style.color = lum > 135 ? '#111' : '#fff';
    } else if (S.cover) { b.style.background = '#fff'; tx.style.color = '#111'; }
  }
  b.append(tx); b._p = p; b._it = it;
  return b;
}

function openPeek(b) {
  const p = b._p, it = b._it;
  ui.peek.replaceChildren(
    el('div', { class: 'o', text: it.text || 'Original not available' }),
    el('div', { class: 't', text: it.tr }),
    el('div', { class: 'row' },
      el('button', { class: 'btn pri', text: 'Edit', onclick: () => {
        const v = prompt('Edit translation\n\n' + (it.text || ''), it.tr);
        if (v != null && v.trim()) { it.tr = v.trim(); it.edited = true; if (p.key) idb.set(p.key, p.rec); renderPage(p); }
        closePeek();
      } }),
      el('button', { class: 'btn', text: 'Copy', onclick: async () => { try { await navigator.clipboard.writeText(it.tr); toast('Copied'); } catch (e) { toast('Copy failed'); } closePeek(); } }),
      el('button', { class: 'btn', text: 'Close', onclick: closePeek })));
  ui.peek.classList.add('on'); clearTimeout(ST.peekT); ST.peekT = setTimeout(closePeek, 9000);
}
function closePeek() { clearTimeout(ST.peekT); ui.peek && ui.peek.classList.remove('on'); }

/* ───────────────────────── finding chapter images ───────────────────────── */

function imgSrcOf(img) {
  for (const k of ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-echo', 'data-lazy', 'data-image', 'data-img', 'data-cfsrc']) {
    const v = img.getAttribute(k);
    if (v && /[./]/.test(v) && !/^data:/.test(v)) return absUrl(v.trim());
  }
  const ss = img.getAttribute('data-srcset') || img.getAttribute('srcset');
  if (ss) {
    let best = '', bw = -1;
    for (const part of ss.split(',')) { const q = part.trim().split(/\s+/), w = parseFloat(q[1]) || 1; if (q[0] && w > bw) { bw = w; best = q[0]; } }
    if (best) return absUrl(best);
  }
  const s = img.currentSrc || img.getAttribute('src') || '';
  if (/^data:/.test(s) && s.length < 2000) return '';
  return /^data:image\/(gif|svg)/.test(s) ? '' : absUrl(s);
}

function collectImages(loose) {
  const raw = [];
  for (const img of document.images) {
    if (img.closest && img.closest('header,nav,footer,aside,[class*="comment"],[class*="avatar"],[id*="comment"]')) continue;
    const url = imgSrcOf(img); if (!url) continue;
    const r = img.getBoundingClientRect();
    raw.push({ img, url, w: img.naturalWidth || +img.getAttribute('width') || r.width, h: img.naturalHeight || +img.getAttribute('height') || r.height, rw: r.width });
  }
  const buckets = new Map();
  for (const c of raw) { const w = c.rw || c.w; if (w >= 200) { const k = Math.round(w / 40); buckets.set(k, (buckets.get(k) || 0) + 1); } }
  let mk = 0, mc = 0; for (const [k, c] of buckets) if (c > mc || (c === mc && k > mk)) { mk = k; mc = c; }
  const mainW = mk * 40, seen = new Set(), out = [];
  for (const c of raw) {
    const w = c.rw || c.w;
    if (loose ? w < 120 : (mainW && w < mainW * 0.6)) continue;
    if (!loose && c.h && c.h < 120) continue;
    if (seen.has(c.url)) continue; seen.add(c.url);
    out.push({ url: c.url, w: c.img.naturalWidth || 0, h: c.img.naturalHeight || 0 });
  }
  return out;
}

function findNav() {
  const here = location.href.split('#')[0];
  const links = Array.from(document.querySelectorAll('a[href]')).filter(a => /^https?:/.test(a.href) && a.href.split('#')[0] !== here);
  const txt = a => ((a.textContent || '') + ' ' + (a.getAttribute('aria-label') || '') + ' ' + (a.title || '')).trim().toLowerCase();
  const attr = a => ((a.className && a.className.baseVal !== undefined ? a.className.baseVal : a.className) + ' ' + (a.id || '') + ' ' + (a.rel || '')).toLowerCase();
  const NEXT = /\b(next|siguiente|suivant|pr[óo]ximo|weiter|sonraki|selanjutnya|berikutnya)\b|다음|次|下一|下页|›|»/;
  const PREV = /\b(prev|previous|anterior|pr[ée]c[ée]dent|zur[üu]ck|[öo]nceki|sebelumnya)\b|이전|前|上一|上页|‹|«/;
  const find = (rel, ap, an, tr) => links.find(a => rel.test(a.rel || '')) || links.find(a => ap.test(attr(a)) && !an.test(attr(a))) || links.find(a => tr.test(txt(a)) && txt(a).length < 40);
  const n = find(/\bnext\b/, /next|nxt/, /prev/, NEXT), p = find(/\bprev\b/, /prev/, /next|nxt/, PREV);
  return { next: n ? n.href : '', prev: p ? p.href : '' };
}

/* ───────────────────────── taking over the page ───────────────────────── */

function takeOver() {
  if (ST.took) return;
  const html = document.documentElement, body = document.body, t = ST.took = { hidden: [], html: html.style.cssText, body: body.style.cssText, y: scrollY };
  for (const c of Array.from(body.children)) if (c !== ui.host) {
    t.hidden.push([c, c.style.getPropertyValue('display'), c.style.getPropertyPriority('display')]);
    c.style.setProperty('display', 'none', 'important');
  }
  const set = (e, o) => { for (const k in o) e.style.setProperty(k, o[k], 'important'); };
  set(html, { background: '#0e0f12', overflow: 'visible', height: 'auto' });
  set(body, { background: '#0e0f12', margin: '0', padding: '0', overflow: 'visible', height: 'auto', position: 'static', transform: 'none', display: 'block', width: 'auto', 'min-width': '0' });
  let vm = document.querySelector('meta[name="viewport"]');
  t.vm = vm ? vm.getAttribute('content') : null;
  if (!vm) { vm = el('meta', { name: 'viewport' }); document.head.appendChild(vm); t.vmNew = vm; }
  vm.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover');
  scrollTo(0, 0);
}

function giveBack() {
  const t = ST.took; if (!t) return;
  for (const [c, v, pr] of t.hidden) { c.style.removeProperty('display'); if (v) c.style.setProperty('display', v, pr); }
  document.documentElement.style.cssText = t.html; document.body.style.cssText = t.body;
  const vm = document.querySelector('meta[name="viewport"]');
  if (t.vmNew) t.vmNew.remove(); else if (vm && t.vm != null) vm.setAttribute('content', t.vm);
  ST.took = null; scrollTo(0, t.y);
}

/* ───────────────────────── reader ───────────────────────── */

function buildReader() {
  ui.pagesEl = el('main', { class: 'pages' });
  ui.title = el('div', { class: 't' }); ui.sub = el('div', { class: 's' });
  ui.eye = iconBtn('eye', 'Show original', () => { const on = ui.reader.classList.toggle('orig'); ui.eye.classList.toggle('on', on); toast(on ? 'Showing original' : 'Showing translation'); });
  ui.play = iconBtn('play', 'Auto-scroll', () => toggleAuto());
  ui.hud = el('header', { class: 'hud' }, iconBtn('x', 'Close reader', exitReader), el('div', { class: 'ttl' }, ui.title, ui.sub), ui.eye, ui.play, iconBtn('sliders', 'Settings', openSettings));
  ui.end = el('footer', { class: 'end' });
  ui.reader = el('div', { class: 'reader' }, ui.hud, ui.pagesEl, ui.end);
  ui.pagesEl.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('.bb'), s = e.target.closest && e.target.closest('.st');
    if (s) { retry(s._p); return; }
    if (b) { openPeek(b); return; }
    closePeek(); ui.reader.classList.toggle('hud-off');
  });
  ui.reader.addEventListener('touchstart', () => { if (ST.auto) toggleAuto(false); }, { passive: true });
  ui.root.insertBefore(ui.reader, ui.root.firstChild);
  let last = scrollY;
  ST.onScroll = () => {
    const y = scrollY, dy = y - last;
    if (y < 60) ui.reader.classList.remove('hud-off');
    else if (dy > 14) ui.reader.classList.add('hud-off');
    else if (dy < -14) ui.reader.classList.remove('hud-off');
    if (Math.abs(dy) > 14) last = y;
    schedule();
  };
  addEventListener('scroll', ST.onScroll, { passive: true });
}

function rebuildIO() {
  if (ST.io) ST.io.disconnect();
  if (typeof IntersectionObserver === 'undefined') { ST.pages.forEach(p => { p.near = true; }); return; }
  ST.io = new IntersectionObserver(es => { for (const e of es) e.target._p.near = e.isIntersecting; schedule(); },
    { rootMargin: '30% 0px ' + clamp(S.prefetch, 1, 8) * 100 + '% 0px' });
  ST.pages.forEach(p => ST.io.observe(p.el));
}

function buildPages(list) {
  ui.pagesEl.textContent = '';
  ST.pages = list.map((it, i) => {
    const p = { i, url: it.url, blob: it.blob, id: it.id || it.url.split('#')[0], ref: it.ref, status: 'idle', tries: 0, rl: 0, near: false };
    p.el = el('div', { class: 'pg' });
    p.el.style.aspectRatio = it.w && it.h ? it.w + ' / ' + it.h : 'auto 800 / 1200';
    p.img = el('img', { alt: '', decoding: 'async', loading: i < 3 ? 'eager' : 'lazy' });
    p.img.addEventListener('load', () => { if (p.img.naturalWidth) p.el.style.aspectRatio = p.img.naturalWidth + ' / ' + p.img.naturalHeight; });
    p.img.addEventListener('error', async () => {
      if (p.imgTried) { p.el.classList.add('broken'); return; }
      p.imgTried = true;
      try { p.img.src = URL.createObjectURL(await fetchImageBlob(p.url, p.ref)); } catch (e) { p.el.classList.add('broken'); }
    });
    p.img.src = it.url;
    p.imgSrc = it.url;                                  /* remembered so inpaint can be toggled back */
    p.ov = el('div', { class: 'ov' });
    p.st = el('button', { class: 'st', hidden: true }); p.st._p = p;
    p.el.append(p.img, p.ov, p.st); p.el._p = p;
    ui.pagesEl.appendChild(p.el);
    return p;
  });
}

function buildEnd() {
  const row = el('div', { class: 'row' });
  if (ST.nav.prev) row.append(el('button', { class: 'btn', text: 'Previous chapter', onclick: () => openLink(ST.nav.prev) }));
  if (ST.nav.next) row.append(el('button', { class: 'btn pri', text: 'Next chapter', onclick: () => openLink(ST.nav.next) }));
  ui.end.replaceChildren(el('div', { text: 'End of chapter' }), row, el('div', { class: 'row' }, el('button', { class: 'btn', text: 'Back to top', onclick: () => scrollTo({ top: 0 }) })));
}

async function startReader(o) {
  takeOver(); if (ui.home) { ui.home.remove(); ui.home = null; }
  closePeek(); stopReader();
  ST.view = 'reader'; ST.origin = o.origin; ST.nav = o.nav || {}; ST.title = o.title; ST.session++; ST.running = 0; ST.backoff = 0;
  buildReader(); buildPages(o.pages); buildEnd(); rebuildIO(); applyLook();
  ui.title.textContent = o.title || 'Chapter'; updateProgress(); syncPill();
  if (o.origin === 'page') {
    const hst = (await gmGet('history', [])).filter(x => x.url !== location.href);
    hst.unshift({ url: location.href, title: o.title, ts: Date.now() }); gmSet('history', hst.slice(0, 25));
  }
  if (!allKeys().length) { toast('Add your API key to start translating.', true); openSettings(); }
  schedule();
}

function stopReader() {
  toggleAuto(false);
  if (ST.io) ST.io.disconnect();
  if (ST.onScroll) removeEventListener('scroll', ST.onScroll);
  if (ui.reader) ui.reader.remove();
  ui.reader = null; ST.pages = []; ST.session++; ST.running = 0;
}

function exitReader() {
  stopReader(); ST.view = null;
  if (ST.origin === 'home') showHome(); else { giveBack(); syncPill(); }
}

function toggleAuto(on) {
  if (on === undefined) on = !ST.auto;
  if (!on) {
    cancelAnimationFrame(ST.auto); ST.auto = 0;
    if (ui.play) { ui.play.replaceChildren(ico('play')); ui.play.classList.remove('on'); }
    if (ui.autobar) ui.autobar.classList.add('hide');
    return;
  }
  ui.play.replaceChildren(ico('pause')); ui.play.classList.add('on'); ui.autobar.classList.remove('hide'); ui.speed.textContent = S.scrollSpeed;
  ui.reader.classList.add('hud-off');
  let last = performance.now(), acc = 0;
  const tick = t => {
    acc += S.scrollSpeed * 22 * (t - last) / 1000; last = t;
    const d = Math.floor(acc); if (d) { scrollBy(0, d); acc -= d; }
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 2) { toggleAuto(false); return; }
    ST.auto = requestAnimationFrame(tick);
  };
  ST.auto = requestAnimationFrame(tick);
}

/* ───────────── show original / inpaint toggle ───────────── */

function setOrig(on) {
  if (!ui.reader) return;
  ui.reader.classList.toggle('orig', on);
  for (const p of ST.pages) setCleanImg(p);   /* shared logic: swaps blob URL / original, revokes stale URLs */
}

function applyLook() {
  const f = FONTS[S.font] || FONTS.comic;
  ui.root.style.setProperty('--font', f.f); ui.root.style.setProperty('--fw', f.w);
  if (ui.reader) ui.reader.classList.toggle('caps', !!S.caps);
  /* keep the visible pages consistent with the inpaint/erase settings without a re-run */
  if (ST.view === 'reader') setOrig(ui.reader && ui.reader.classList.contains('orig'));
}

/* ───────────────────────── entry points ───────────────────────── */

function cleanTitle(t) { return String(t || '').replace(/\s+/g, ' ').trim().slice(0, 90); }

function startFromPage() {
  const imgs = collectImages(!ST.chapterLike);
  if (!imgs.length) { toast('No chapter images found on this page.'); return; }
  startReader({ pages: imgs.map(i => Object.assign(i, { ref: location.href })), title: cleanTitle(document.title), nav: findNav(), origin: 'page' });
}

async function openLink(u) { await gmSet('pending', { ts: Date.now() }); location.href = u; }

function fromFiles(files) {
  if (!files.length) return;
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  startReader({
    pages: files.map(f => ({ url: URL.createObjectURL(f), blob: f, id: 'file:' + f.name + ':' + f.size + ':' + f.lastModified })),
    title: 'Photos (' + files.length + ')', origin: 'home',
  });
}

async function showHome() {
  takeOver(); ST.view = 'home'; syncPill();
  const hist = await gmGet('history', []);
  if (ui.home) ui.home.remove();
  const input = el('input', { type: 'url', placeholder: 'https://example.com/chapter-12', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', inputmode: 'url' });
  const go = () => { let u = input.value.trim(); if (!u) return; if (!/^https?:\/\//i.test(u)) u = 'https://' + u; openLink(u); };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  const file = el('input', { type: 'file', accept: 'image/*', multiple: true, class: 'hide' });
  file.addEventListener('change', () => fromFiles(Array.from(file.files)));
  const recent = el('div', { class: 'recent' });
  if (hist.length) {
    recent.append(el('h3', { text: 'Recent chapters' }));
    for (const h of hist.slice(0, 12)) recent.append(el('button', { class: 'ri', onclick: () => openLink(h.url) }, el('b', { text: h.title || h.url }), el('span', { text: h.url })));
  }
  ui.home = el('div', { class: 'home' },
    el('div', { class: 'top' }, el('div', { class: 'brand', text: 'ToonLens' }), el('button', { class: 'btn', text: 'Close', onclick: hideHome })),
    el('p', { class: 'lede', text: 'Paste a chapter link. It opens like a normal page, then translates as you scroll.' }),
    allKeys().length ? null : el('div', { class: 'note', text: 'No API key yet. On a computer, open aistudio.google.com/apikey, sign in with any Google account and press "Create API key" (it is free, no credit card). Copy the key that starts with AIza, then paste it into ToonLens Settings → API key.' }),
    el('div', { class: 'url' }, input, el('button', { class: 'btn pri', text: 'Open', onclick: go })),
    el('div', { class: 'row gap' }, el('button', { class: 'btn', text: 'Translate images from Photos', onclick: () => file.click() }), el('button', { class: 'btn', text: 'Settings', onclick: openSettings })),
    file, recent);
  ui.root.insertBefore(ui.home, ui.root.firstChild);
}

function hideHome() {
  if (ui.home) ui.home.remove(); ui.home = null; ST.view = null;
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  giveBack(); syncPill();
}

function syncPill() {
  const show = !ST.view && (S.pill === 'always' || (S.pill === 'detected' && ST.chapterLike));
  ui.pillWrap.classList.toggle('hide', !show);
}

function scanForChapter(n) {
  if (ST.view) return;
  if (!ui.host.isConnected) (document.body || document.documentElement).appendChild(ui.host);
  ST.chapterLike = collectImages(false).length >= 3;
  syncPill();
  if (ST.chapterLike && S.autoStart && !ST.autoDone) { ST.autoDone = true; startFromPage(); return; }
  if (n < 10) setTimeout(() => scanForChapter(n + 1), 1500);
}

async function waitAndStart() {
  for (let i = 0; i < 22; i++) {
    if (collectImages(false).length >= 2) { await sleep(900); ST.chapterLike = true; await gmSet('pending', null); startFromPage(); return; }
    await sleep(700);
  }
  scanForChapter(0);
}

/* ───────────────────────── settings sheet ───────────────────────── */

const SCHEMA = [
  ['AI engine', [
    { k: 'provider', t: 'select', l: 'Provider', o: [['gemini', 'Google Gemini (recommended)'], ['openrouter', 'OpenRouter free hosted models (no PC power needed)'], ['local', 'Local model — LM Studio / Ollama (no limits)'], ['anthropic', 'Anthropic Claude'], ['openai', 'OpenAI-compatible']] },
    { k: 'apiKey', t: 'password', l: 'API key', h: 'Free Google key: open aistudio.google.com/apikey on a computer, sign in with any Google account, press "Create API key", copy it (starts with AIza) and paste it here. No credit card needed. Stays on this device. Not needed for Local models; optional for OpenRouter (free models also work without a key, but a key from openrouter.ai/keys gives higher limits).', show: s => s.provider !== 'local' },
    { k: 'keysText', t: 'area', l: 'Backup API keys', ph: 'AIza... / sk-or-... (one per line)', h: 'Each free key has a small daily quota. Paste more free keys here, one per line (each comes from a different free Google account at aistudio.google.com/apikey, or a different free OpenRouter account at openrouter.ai/keys). ToonLens automatically switches to the next key when one runs out of quota, so you can keep reading past the limit.', show: s => s.provider === 'gemini' || s.provider === 'openrouter' || s.provider === 'openai' },
    { k: 'model', t: 'text', l: 'Model', h: s => s.provider === 'openrouter' ? 'Leave empty to auto-pick a free hosted vision model (Qwen3-VL :free routes). You can type any OpenRouter model id, e.g. qwen/qwen3-vl-8b-instruct:free.' : s.provider === 'local' ? 'Leave empty or press the loaded-models button below.' : 'Leave empty for the default (gemini-2.5-flash-lite, free tier). If you get quota errors, type gemini-2.0-flash.' },
    { k: 'baseUrl', t: 'text', l: 'API base URL', show: s => s.provider === 'openai' },
    { k: 'localBase', t: 'text', l: 'Local server URL', show: s => s.provider === 'local' },
    /* localPick is not a real setting — openSettings() renders pickBtn in its place. */
    { k: 'localPick', t: 'button', l: 'Loaded models', show: () => false },
    { k: 'thinking', t: 'select', l: 'Gemini thinking', show: s => s.provider === 'gemini', o: [['minimal', 'Minimal (fastest)'], ['low', 'Low (balanced)'], ['medium', 'Medium'], ['high', 'High (slowest)'], ['off', 'Do not send']] },
  ]],
  ['Translation', [
    { k: 'target', t: 'text', l: 'Translate into', list: true },
    { k: 'source', t: 'select', l: 'Original language', o: [['auto', 'Detect automatically'], ['Korean', 'Korean'], ['Japanese', 'Japanese'], ['Chinese', 'Chinese'], ['English', 'English'], ['Spanish', 'Spanish']] },
    { k: 'style', t: 'select', l: 'Style', o: [['natural', 'Natural'], ['literal', 'Faithful'], ['casual', 'Casual']] },
    { k: 'honorifics', t: 'check', l: 'Keep honorifics (-nim, hyung, senpai)' },
    { k: 'sfx', t: 'check', l: 'Translate sound effects' },
    { k: 'glossary', t: 'area', l: 'Glossary', ph: '도윤 = Do-yoon\n마왕 = Demon King' },
    { k: 'extra', t: 'area', l: 'Extra instructions', ph: 'The narrator is sarcastic. Keep swear words mild.' },
  ]],
  ['Lettering', [
    { k: 'font', t: 'select', l: 'Font', o: Object.keys(FONTS).map(k => [k, FONTS[k].l]) },
    { k: 'fontScale', t: 'range', l: 'Text size', min: 60, max: 140, step: 5, u: '%' },
    { k: 'pad', t: 'range', l: 'Cover padding', min: 0, max: 20, step: 1, u: '%' },
    { k: 'caps', t: 'check', l: 'Uppercase lettering' },
    { k: 'cover', t: 'check', l: 'Erase the original text' },
    { k: 'blend', t: 'check', l: 'Seamless lettering (hide cover-box edges)' },
  ]],
  ['Reading', [
    { k: 'prefetch', t: 'range', l: 'Translate ahead', min: 1, max: 6, step: 1, u: ' screens' },
    { k: 'concurrency', t: 'range', l: 'Parallel requests', min: 1, max: 4, step: 1 },
    { k: 'scrollSpeed', t: 'range', l: 'Auto-scroll speed', min: 1, max: 10, step: 1 },
    { k: 'autoStart', t: 'check', l: 'Open the reader automatically on chapter pages' },
    { k: 'pill', t: 'select', l: 'Floating button', o: [['detected', 'Only on chapter pages'], ['always', 'On every page'], ['never', 'Hidden']] },
  ]],
];

/* Builds the whole settings sheet. Every failure mode is contained: if anything throws while
   rendering, the sheet still opens with an error note instead of the button silently doing
   nothing (that was the "can't open settings" bug). */
function openSettings() {
  /* If boot hasn't finished mounting the overlay (e.g. an early click on a slow page), mount it
     now instead of doing nothing — the old code appended to a missing ui.root and died silently. */
  if (!ui.root) { try { mountUI(); } catch (e) { console.error('[ToonLens] mount failed:', e); } }
  try { openSettingsInner(); } catch (e) {
    console.error('[ToonLens] settings failed to open:', e);
    try {
      if (ui.sheet) { ui.sheet.remove(); ui.sheet = null; }
      const target = ui.root || document.body || document.documentElement;
      target.appendChild(el('div', { class: 'root' },
        el('div', { class: 'sheet' }, el('div', { class: 'card' },
          el('h2', { text: 'ToonLens settings' }),
          el('div', { class: 'note', text: 'The settings panel hit an error while opening: ' + ((e && e.message) || e) + '. Reload the page and try again.' }),
          el('div', { class: 'row gap end2' }, el('button', { class: 'btn pri', text: 'Close', onclick: ev => { const s = ev.currentTarget.closest('.sheet'); if (s) s.remove(); } }))))));
    } catch (e2) { /* last resort: nothing more we can do */ }
  }
}

function openSettingsInner() {
  /* Never stack a second sheet on top of an existing one (would leave two "Done" buttons and
     double-persist settings). Remove any stale sheet first, then build fresh. */
  const stale = document.querySelectorAll('#toonlens-host .sheet, body > .root > .sheet');
  for (const s of stale) s.remove();
  ui.sheet = null;
  const vis = [], persist = () => { clearTimeout(ST.pt); ST.pt = setTimeout(saveSettings, 300); };
  let refresh = () => vis.forEach(v => v.w.classList.toggle('hide', !v.show(S)));
  const body = el('div');
  const ctl = {};
  for (const [title, fields] of SCHEMA) {
    body.append(el('div', { class: 'grp', text: title }));
    for (const f of fields) {
      const upd = v => {
        if (f.k === 'keysText') {
          /* Primary box keeps the first key so it stays masked; the rest go to S.keys. */
          const list = String(v).split(/[\n;,]+/).map(x => x.trim()).filter(Boolean);
          const uniq = [...new Set(list)];
          S.apiKey = uniq[0] || ''; S.keys = uniq.slice(1); S.keyIdx = 0;
          persist(); refresh(); return;
        }
        S[f.k] = v; if (RETR.has(f.k)) ST.dirtyTr = true; if (LOOK.has(f.k)) ST.dirtyLook = true;
        if (f.k === 'provider') { ctl.model.placeholder = MODEL_DEFAULT[v] || (v === 'local' ? 'empty = auto-pick a loaded vision model' : 'model name'); if (Object.values(MODEL_DEFAULT).includes(S.model)) { S.model = ''; ctl.model.value = ''; } }
        if (f.k === 'apiKey') { S.keyIdx = 0; if (ctl.keysText) ctl.keysText.value = [v, ...S.keys].filter(Boolean).join('\n'); }
        persist(); refresh();
      };
      let w;
      if (f.t === 'check') {
        w = el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: !!S[f.k], onchange: e => upd(e.target.checked) }), el('span', { text: f.l }));
      } else {
        const cap = el('span', { text: f.l });
        let c;
        if (f.t === 'select') { c = el('select', { onchange: e => upd(e.target.value) }, ...f.o.map(o => el('option', { value: o[0], text: o[1] }))); c.value = S[f.k]; }
        else if (f.t === 'area') c = el('textarea', { placeholder: f.ph || '', oninput: e => upd(e.target.value), value: f.k === 'keysText' ? uiSafe().keysText : S[f.k] });
        else if (f.t === 'range') {
          const lab = () => cap.textContent = f.l + ': ' + S[f.k] + (f.u || '');
          c = el('input', { type: 'range', min: f.min, max: f.max, step: f.step, value: S[f.k], oninput: e => { upd(+e.target.value); lab(); } }); lab();
        } else {
          c = el('input', { type: f.t === 'password' ? 'password' : 'text', value: S[f.k], placeholder: f.k === 'model' ? (MODEL_DEFAULT[S.provider] || 'model name') : '', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', oninput: e => upd(e.target.value.trim()) });
          if (f.list) c.setAttribute('list', 'tl-langs');
        }
        ctl[f.k] = c;
        const hintTxt = () => (typeof f.h === 'function' ? f.h(S) : f.h);
        w = el('label', { class: 'f' }, cap, c, f.h ? el('small', { text: hintTxt() }) : null);
        /* NOTE: assign first, then call. The old one-liner `(f.h._set = s => {...})._set(S)`
           returned the *outer* arrow function (which takes no args and is not _set), so opening
           Settings threw "f.h._set._set is not a function" and the sheet never appeared. */
        if (typeof f.h === 'function') {
          f.h._set = () => { const n = w.querySelector('small'); if (n) n.textContent = hintTxt(); };
          f.h._set();
        }
      }
      if (f.show) vis.push({ w, show: f.show });
      body.append(w);
    }
  }
  /* Function-valued hints depend on the provider — re-render them whenever settings change. */
  const refreshBase = refresh;
  refresh = () => { refreshBase(); for (const [title, fields] of SCHEMA) for (const f of fields) if (f.h && typeof f.h === 'function' && f.h._set) f.h._set(S); };
  const out = el('div', { class: 'note hide' });
  /* "Loaded models": fetch the model list straight from the local server and fill in the Model
     field. Vision-capable names are marked with an eye; non-vision models cannot read pages. */
  const pickBtn = el('button', { class: 'btn', text: 'Use a loaded model', onclick: async () => {
    if (pickBtn.disabled) return;
    pickBtn.disabled = true; pickBtn.textContent = 'Loading…';
    out.classList.remove('hide'); out.textContent = 'Reading the model list from ' + (S.localBase || LOCAL_DEFAULT_BASE) + '…';
    try {
      localModelCache = { base: '', ids: [], at: 0 };
      const ids = await listLocalModels();
      out.textContent = '';
      out.append(el('div', { text: 'Loaded models on this computer (only 👁 vision models can read pages). Tap one to use it:' }));
      const wrap = el('div', { class: 'row gap' });
      for (const id of ids.slice(0, 12)) {
        wrap.append(el('button', { class: 'btn', style: VISION_HINT.test(id) ? '' : 'opacity:.55', text: (VISION_HINT.test(id) ? '👁 ' : '· ') + id, onclick: () => { S.model = id; ctl.model.value = id; persist(); toast('Using ' + id); } }));
      }
      out.append(wrap);
    } catch (e) {
      out.textContent = ((e && e.message) || 'Could not reach the local server.') + ' Start LM Studio (Server tab → Local Server, CORS on) or Ollama ("ollama serve"), then try again.';
    } finally { pickBtn.disabled = false; pickBtn.textContent = 'Use a loaded model'; }
  } });
  const test = el('button', { class: 'btn', text: 'Test connection', onclick: async () => {
    if (testingNow) return;
    testingNow = true; test.disabled = true; test.textContent = 'Testing...';
    const isLocal = S.provider === 'local';
    out.classList.remove('hide'); out.textContent = isLocal ? 'Contacting your local model… the first request can take a few minutes while the model loads into memory.' : S.provider === 'openrouter' ? 'Contacting OpenRouter… free models can be queued, this can take up to 5 min.' : 'Contacting Google… this can take up to 90 s.'; const t0 = Date.now();
    try {
      await withTimeout(callModel({ system: 'You are a connectivity test.', text: 'Reply with the single word OK.' }), netMsFor(S.provider) + 5000, 'No response from the AI service. Check that it is reachable and try again.');
      out.textContent = 'Connected in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s using ' + (modelName() || 'the auto-picked local model') + '. It works — open a chapter page and it will translate.';
    } catch (e) {
      out.textContent = e.kind === 'daily'
        ? 'All configured keys have used up their free quota for today. Add more free keys in "Backup API keys" above (one per line), or wait until the quota resets (midnight Pacific time).'
        : e.kind === 'rate'
        ? (S.provider === 'openrouter' ? 'OpenRouter says you are over the free limit right now. Wait a minute and test again, or add another free key above.' : 'Google says you are over the free limit right now. Wait a minute and test again, or switch the model to gemini-2.5-flash-lite.')
        : ((e && e.message) || 'Failed') + ' [tried: ' + chainNote() + ']';
    } finally { testingNow = false; test.disabled = false; test.textContent = 'Test connection'; }
  } });
  const clear = el('button', { class: 'btn', text: 'Clear saved translations', onclick: async () => { await idb.clear(); toast('Saved translations cleared'); } });
  const done = el('button', { class: 'btn pri', text: 'Done', onclick: closeSettings });
  const dl = el('datalist', { id: 'tl-langs' }, ...LANGS.map(l => el('option', { value: l })));
  ui.sheet = el('div', { class: 'sheet', onclick: e => { if (e.target === ui.sheet) closeSettings(); } },
    el('div', { class: 'card' }, el('h2', { text: 'ToonLens settings' }), body, out, el('div', { class: 'row gap' }, test, S.provider === 'local' ? pickBtn : null, clear), el('div', { class: 'row gap end2' }, done), dl));
  ui.root.appendChild(ui.sheet); refresh();
}

function closeSettings() {
  if (!ui.sheet) return;
  ui.sheet.remove(); ui.sheet = null; clearTimeout(ST.pt); saveSettings();
  applyLook(); syncPill();
  if (ST.view === 'reader') {
    rebuildIO();
    if (ST.dirtyTr) {
      /* Only wipe the on-screen state when something was actually *changed* in this session:
         closeSettings() also runs right after a page reload, where settings were merely loaded
         and the cached translations must be kept. */
      if (ST.pages.length) for (const p of ST.pages) { p.rec = null; p.ov.textContent = ''; p.status = 'idle'; p.tries = 0; p.rl = 0; chip(p); }
    } else if (ST.dirtyLook) ST.pages.forEach(p => p.rec && renderPage(p));
    schedule();
  } else if (ST.view === 'home') showHome();
  ST.dirtyTr = ST.dirtyLook = false;
}

function toast(msg, long) {
  if (!ui.toast) return;
  ui.toast.textContent = msg; ui.toast.classList.add('on');
  clearTimeout(ST.tt); ST.tt = setTimeout(() => ui.toast.classList.remove('on'), long ? 6500 : 2600);
}

/* ───────────────────────── UI shell + styles ───────────────────────── */

const CSS = `
:host{all:initial;display:block}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
.root{--bg:#0e0f12;--panel:#16181d;--raise:#1f232b;--line:#2b303a;--ink:#eef0f6;--mute:#9aa2b5;--acc:#8fb4ff;--accInk:#0a1226;--bad:#ff8f8f;
font:400 15px/1.4 -apple-system,"SF Pro Text",system-ui,sans-serif;color:var(--ink);-webkit-text-size-adjust:100%;color-scheme:dark}
button,input,select,textarea{font:inherit;color:inherit;margin:0}
button{cursor:pointer}
.hide{display:none!important}
.reader{background:#0b0c0f;min-height:100vh}
.pages{max-width:960px;margin:0 auto}
.pg{position:relative;display:block;width:100%;container-type:inline-size;background:#14161b;line-height:0;overflow:hidden}
.pg img{display:block;width:100%;height:auto;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
.pg.broken::after{content:"Image failed to load";display:grid;place-items:center;position:absolute;inset:0;color:var(--mute);font:14px/1.4 -apple-system,system-ui}
.ov{position:absolute;inset:0;pointer-events:none;transition:opacity .15s}
.orig .ov{opacity:0}
.bb{position:absolute;display:flex;align-items:center;justify-content:center;pointer-events:auto;border-radius:.9cqw;line-height:1.12}
.bb .tx{display:block;max-width:100%;text-align:center;font-family:var(--font);font-weight:var(--fw);overflow-wrap:break-word;-webkit-user-select:none;user-select:none}
.caps .tx{text-transform:uppercase}
.bb.sfx{width:auto;height:auto;padding:.5cqw 1.6cqw;border-radius:99px;background:rgba(10,10,14,.62);transform:translate(-50%,-50%)}
.bb.sfx .tx{color:#fff}
.bb.nocover .tx{color:#fff;-webkit-text-stroke:.55cqw #000;paint-order:stroke fill}
.st{position:absolute;left:8px;top:8px;z-index:3;display:flex;gap:6px;align-items:center;padding:5px 11px 5px 9px;border-radius:99px;border:1px solid var(--line);background:rgba(14,15,18,.84);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);font-size:12px;line-height:1.2}
.st[hidden]{display:none}
.st .dot{width:10px;height:10px;border-radius:50%;border:2px solid var(--acc);border-top-color:transparent;animation:sp .8s linear infinite}
.st.err{color:var(--bad)}
@keyframes sp{to{transform:rotate(1turn)}}
@media (prefers-reduced-motion:reduce){.st .dot{animation:none;border-top-color:var(--acc)}.hud,.peek,.toast{transition:none!important}}
.hud{position:fixed;left:0;right:0;top:0;z-index:20;display:flex;align-items:center;gap:2px;padding:calc(env(safe-area-inset-top) + 6px) 8px 8px;background:rgba(12,13,16,.9);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border-bottom:1px solid var(--line);transition:transform .2s ease}
.hud-off .hud{transform:translateY(-110%)}
.ttl{flex:1;min-width:0;padding:0 6px}
.ttl .t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ttl .s{font-size:12px;color:var(--mute)}
.ib{width:42px;height:42px;display:grid;place-items:center;border:0;border-radius:12px;background:transparent}
.ib:active,.ib.on{background:var(--raise)}
.ib.on{color:var(--acc)}
.ib svg{width:22px;height:22px}
.end{padding:36px 16px calc(env(safe-area-inset-bottom) + 56px);text-align:center;color:var(--mute)}
.end .row{justify-content:center;margin-top:14px}
.row{display:flex;gap:8px;flex-wrap:wrap}
.gap{margin-top:14px}
.btn{padding:11px 16px;border-radius:12px;border:1px solid var(--line);background:var(--raise);font-weight:600}
.btn.pri{background:var(--acc);border-color:var(--acc);color:var(--accInk)}
.pillwrap{position:fixed;right:14px;bottom:calc(env(safe-area-inset-bottom) + 84px);z-index:2147483000;display:flex;gap:6px}
.pill{display:flex;align-items:center;gap:8px;height:44px;padding:0 16px 0 14px;border:0;border-radius:22px;background:var(--acc);color:var(--accInk);font-weight:650;box-shadow:0 6px 22px rgba(0,0,0,.35)}
.pill b{font-weight:800;letter-spacing:-.02em}
.pillg{width:44px;height:44px;border:0;border-radius:22px;background:rgba(22,24,29,.94);color:var(--ink);display:grid;place-items:center;box-shadow:0 6px 22px rgba(0,0,0,.35)}
.pillg svg{width:22px;height:22px}
.toast{position:fixed;left:50%;top:calc(env(safe-area-inset-top) + 66px);z-index:40;max-width:min(92vw,520px);padding:10px 16px;border-radius:14px;background:rgba(31,35,43,.97);border:1px solid var(--line);transform:translate(-50%,-20px);opacity:0;pointer-events:none;transition:opacity .2s,transform .2s}
.toast.on{opacity:1;transform:translate(-50%,0)}
.peek{position:fixed;left:10px;right:10px;bottom:calc(env(safe-area-inset-bottom) + 12px);z-index:25;max-width:560px;margin:0 auto;padding:12px 14px;border-radius:16px;border:1px solid var(--line);background:rgba(22,24,29,.97);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);transform:translateY(150%);transition:transform .2s}
.peek.on{transform:none}
.peek .o{color:var(--mute);font-size:13px}
.peek .t{font-size:17px;font-weight:600;margin:4px 0 10px}
.auto{position:fixed;left:12px;bottom:calc(env(safe-area-inset-bottom) + 84px);z-index:22;display:flex;align-items:center;gap:0;padding:3px;border-radius:99px;background:rgba(22,24,29,.95);border:1px solid var(--line)}
.auto b{min-width:24px;text-align:center}
.auto .ib{width:38px;height:38px;border-radius:99px}
.sheet{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center}
.card{width:100%;max-width:640px;max-height:92vh;overflow:auto;-webkit-overflow-scrolling:touch;background:var(--panel);border-radius:22px 22px 0 0;border:1px solid var(--line);padding:18px 18px calc(env(safe-area-inset-bottom) + 24px)}
.card h2{font:700 21px/1.2 ui-rounded,-apple-system,system-ui;margin:0 0 2px}
.grp{margin:22px 0 4px;font-weight:600;color:var(--acc)}
.f{display:block;margin:12px 0}
.f>span{display:block;font-size:13px;color:var(--mute);margin-bottom:5px}
.f small{display:block;color:var(--mute);font-size:12px;margin-top:4px}
input[type=text],input[type=password],input[type=url],select,textarea{width:100%;padding:11px 12px;border-radius:12px;border:1px solid var(--line);background:var(--raise);font-size:16px}
textarea{min-height:78px;resize:vertical}
.chk{display:flex;gap:10px;align-items:center;margin:12px 0}
.chk input{width:20px;height:20px;accent-color:var(--acc)}
input[type=range]{width:100%;accent-color:var(--acc)}
.note{margin:14px 0;padding:12px 14px;border:1px solid var(--line);border-left:3px solid var(--acc);border-radius:10px;background:var(--panel);font-size:14px}
.end2{justify-content:flex-end}
.home{min-height:100vh;padding:calc(env(safe-area-inset-top) + 26px) 20px calc(env(safe-area-inset-bottom) + 30px);max-width:640px;margin:0 auto;background:#0e0f12}
.top{display:flex;align-items:center;justify-content:space-between}
.brand{font:800 38px/1 ui-rounded,"SF Pro Rounded",-apple-system,system-ui;letter-spacing:-.02em}
.lede{color:var(--mute);margin:12px 0 22px;max-width:34ch}
.url{display:flex;gap:8px}
.recent{margin-top:28px}
.recent h3{font-size:13px;color:var(--mute);font-weight:600;margin:0 0 6px}
.ri{display:block;width:100%;text-align:left;padding:12px 0;border:0;border-top:1px solid var(--line);background:none}
.ri b{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ri span{display:block;color:var(--mute);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meas{position:absolute;left:0;top:-99999px;visibility:hidden;pointer-events:none;font-family:var(--font);font-weight:var(--fw);line-height:1.12;text-align:center;overflow-wrap:break-word;padding:0;margin:0}
`;

function applyCSS(root, css) {
  try { const sh = new CSSStyleSheet(); sh.replaceSync(css); root.adoptedStyleSheets = [sh]; return; } catch (e) { /* fall back */ }
  root.appendChild(el('style', { text: css }));
}

function mountUI() {
  ui.host = el('div', { id: 'toonlens-host' });
  ui.host.style.cssText = 'display:block;';
  const sr = ui.host.attachShadow({ mode: 'open' });
  applyCSS(sr, CSS);
  ui.root = el('div', { class: 'root' });
  ui.toast = el('div', { class: 'toast', role: 'status' });
  ui.peek = el('div', { class: 'peek' });
  ui.speed = el('b', { text: '4' });
  ui.autobar = el('div', { class: 'auto hide' },
    iconBtn('minus', 'Slower', () => { S.scrollSpeed = clamp(S.scrollSpeed - 1, 1, 10); ui.speed.textContent = S.scrollSpeed; saveSettings(); }), ui.speed,
    iconBtn('plus', 'Faster', () => { S.scrollSpeed = clamp(S.scrollSpeed + 1, 1, 10); ui.speed.textContent = S.scrollSpeed; saveSettings(); }),
    iconBtn('pause', 'Stop', () => toggleAuto(false)));
  ui.pillWrap = el('div', { class: 'pillwrap hide' },
    el('button', { class: 'pill', onclick: startFromPage }, el('b', { text: '文A' }), el('span', { text: 'Translate' })),
    el('button', { class: 'pillg', 'aria-label': 'ToonLens settings', onclick: openSettings }, ico('sliders')));
  ui.root.append(ui.toast, ui.peek, ui.autobar, ui.pillWrap);
  sr.append(ui.root);
  (document.body || document.documentElement).appendChild(ui.host);
}

async function boot() {
  await loadSettings();
  mountUI(); applyLook();
  if (location.hash === '#toonlens') { showHome(); return; }
  const pend = await gmGet('pending', null);
  if (pend && Date.now() - pend.ts < 90000) { waitAndStart(); return; }
  if (pend) gmSet('pending', null);
  scanForChapter(0);
}

/* test hook (never set in the browser) */
if (globalThis.__TL_TEST__) Object.assign(globalThis.__TL_TEST__, { S, ST, ui, parseModelJSON, normItems, mergeItems, collectImages, findNav, buildSystem, buildUser, callModel, NET, apiPost, httpError, planSlices, openSettings, closeSettings, mountUI, applyLook, buildReader, buildPages, startReader, renderPage, fit, boot, TLError, sampleBg, edgeClean, trimToFill, paintOver, cleanTr, setCleanImg, dropClean });

boot();
})();
