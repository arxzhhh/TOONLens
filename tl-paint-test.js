const fs = require('fs');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const nodeCanvas = require('canvas');

const SRC = fs.readFileSync('ToonLens.user.js', 'utf8').replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, '');

function makeWin() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.com/', runScripts: 'outside-only' });
  const w = dom.window;
  // real canvas support for the window
  const origCreate = w.document.createElement.bind(w.document);
  w.document.createElement = function (tag, ...a) {
    if (String(tag).toLowerCase() === 'canvas') return nodeCanvas.createCanvas(300, 150);
    return origCreate(tag, ...a);
  };
  w.Blob = class Blob { constructor(parts, opts) { this._buf = Buffer.concat(parts.map(p => p instanceof Buffer ? p : Buffer.from(String(p)))); this.size = this._buf.length; this.type = (opts||{}).type || ''; } };
  nodeCanvas.Canvas.prototype.toBlob = function (cb, type, q) { cb(new w.Blob([this.toBuffer(type || 'image/png')], { type: type || 'image/png' })); };
  vm.createContext(w);
  w.__TL_TEST__ = {};
  w.eval(SRC);
  return w;
}

const w = makeWin();
const T = w.__TL_TEST__;
let fails = 0;
const ok = (name, cond, extra='') => { console.log((cond?'PASS':'FAIL')+' '+name+(extra?' — '+extra:'')); if(!cond) fails++; };

ok('hooks exported', ['sampleBg','edgeClean','trimToFill','paintOver','cleanTr'].every(k => typeof T[k] === 'function'));

// ---- cleanTr ----
ok('cleanTr strips markdown', T.cleanTr('**I *really*** mean it_') === 'I really mean it', JSON.stringify(T.cleanTr('**I *really*** mean it_')));
ok('cleanTr unwraps quotes', T.cleanTr('"Get out!"') === 'Get out!', JSON.stringify(T.cleanTr('"Get out!"')));
ok('cleanTr keeps inner quotes', T.cleanTr('He said "no" to me') === 'He said "no" to me');
ok('cleanTr removes emoji', T.cleanTr('Run! \u{1F3C3}\u{1F4A8} now') === 'Run! now', JSON.stringify(T.cleanTr('Run! \u{1F3C3}\u{1F4A8} now')));
ok('cleanTr collapses nbsp/newlines', T.cleanTr('a\u00a0b\n\n c') === 'a b c');
ok('cleanTr no emphasis chars remain', !/[*_~]/.test(T.cleanTr('*emphasis* ~strike~ _under_')));

// ---- synthetic page: white bubble on gray bg with black "text" ----
const W = 800, H = 1600;
const cv = nodeCanvas.createCanvas(W, H);
const cx = cv.getContext('2d');
cx.fillStyle = '#9aa0a6'; cx.fillRect(0, 0, W, H);
cx.fillStyle = '#f7f4ee'; cx.beginPath(); cx.arc(400, 400, 180, 0, 7); cx.fill();
cx.strokeStyle = '#111'; cx.lineWidth = 6; cx.stroke();
cx.fillStyle = '#111'; cx.font = '30px sans-serif';
cx.fillText('\uc548\ub155\ud558\uc138\uc694 \uce5c\uad6c', 280, 380);
cx.fillText('\ubc18\uac11\uc2b5\ub2c8\ub2e4', 300, 430);

// sampleBg/paint boxes are in the slice space the model sees: width 1000, height scaled to keep
// aspect ratio — exactly what drawSlice/planSlices produce for a page. Real webtoon pages are
// wider than they are tall once sliced, so mirror that here.
const SW = 1000, SH = Math.round(1000 * H / W);   // 2000
const sc = nodeCanvas.createCanvas(SW, SH);
const sx2 = sc.getContext('2d');
sx2.drawImage(cv, 0, 0, SW, SH);
const px = (x1,y1,x2,y2) => [Math.round(y1/H*1000), Math.round(x1/W*1000), Math.round(y2/H*1000), Math.round(x2/W*1000)];
// NOTE: the synthetic page is portrait (800x1600) like a real webtoon slice; sampleBg/trimToFill
// take permille boxes in that same space. Glyph box with generous fill-only margins:
const box = px(300, 375, 500, 435);   // hugs glyphs
const bg = T.sampleBg(sx2, SW, SH, ...box);
ok('sampleBg finds bubble fill', bg && Math.abs(bg.c[0]-247)<20 && bg.c[1]>230, JSON.stringify(bg && bg.c));
ok('sampleBg reports numeric spread', bg && typeof bg.spread === 'number');

const dText = sx2.getImageData(Math.round(box[1]/1000*SW), Math.round(box[0]/1000*SH), Math.round((box[3]-box[1])/1000*SW), Math.round((box[2]-box[0])/1000*SH)).data;
const t1 = Math.max(1, Math.round(Math.min(dText.width,dText.height)*0.1));
ok('edgeClean true for glyph-hugging box', T.edgeClean(dText, dText.width, dText.height, t1, bg.c) === true);

const ob = px(215, 215, 585, 585);    // includes outline ring
const od = sx2.getImageData(Math.round(ob[1]/1000*SW), Math.round(ob[0]/1000*SH), Math.round((ob[3]-ob[1])/1000*SW), Math.round((ob[2]-ob[0])/1000*SH)).data;
const ot = Math.max(1, Math.round(Math.min(od.width,od.height)*0.1));
// the fill reference is the BUBBLE FILL (what trimToFill samples from top/bottom bands and what
// paintOver re-samples) — not sampleBg of an outline-inclusive box, which mixes in page bg
ok('edgeClean false for outline-inclusive box', T.edgeClean(od, od.width, od.height, ot, [247,244,238]) === false);

const trimmed = T.trimToFill(sx2, SW, SH, ob.slice());
ok('trimToFill shrinks away from outline', Array.isArray(trimmed) && (trimmed[2]-trimmed[0]) < (ob[2]-ob[0]) && (trimmed[3]-trimmed[1]) < (ob[3]-ob[1]), JSON.stringify(trimmed));

// ---- paintOver erases glyphs (full-page coords, as translatePage now passes them) ----
T.paintOver(cx, W, { kind:'speech', sx:290, sy:345, sw:220, sh:100, x:280/W, w:240/W, y:350/H, h:105/H, bg:bg.c, spread:bg.spread });
const after = cx.getImageData(300, 370, 180, 70).data;
let dark = 0; for (let i=0;i<after.length;i+=4) if (after[i]<80&&after[i+1]<80&&after[i+2]<80) dark++;
ok('paintOver removes original ink', dark === 0, 'dark px left: '+dark);
let devSum=0; const mid=after[0]; for(let i=0;i<after.length;i+=4) devSum+=Math.abs(after[i]-mid);
ok('flat bubble stays smooth after inpaint', devSum/(after.length/4) < 12, 'mean dev '+(devSum/(after.length/4)).toFixed(2));

// sfx items must never be painted over
const before = cx.getImageData(600, 900, 60, 40).data.slice();
cx.fillStyle = '#111'; cx.fillRect(600, 900, 60, 40);
T.paintOver(cx, W, { kind:'sfx', sx:600, sy:900, sw:60, sh:40, x:0.75, w:0.075, y:0.5625, h:0.025, bg:[247,244,238], spread:0 });
const keep = cx.getImageData(600, 900, 60, 40).data;
let kept = 0; for (let i=0;i<keep.length;i+=4) if (keep[i]<80) kept++;
ok('paintOver skips sfx', kept > 1000, 'kept dark px: '+kept);

console.log(fails ? 'TOTAL FAILS: '+fails : 'ALL PAINT TESTS PASSED');
process.exit(fails?1:0);
