const nc = require('canvas');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const cv = nc.createCanvas(800, 1600), cx = cv.getContext('2d');
cx.fillStyle = '#9aa0a6'; cx.fillRect(0, 0, 800, 1600);
cx.fillStyle = '#f7f4ee'; cx.beginPath(); cx.arc(400, 400, 180, 0, 7); cx.fill();
cx.strokeStyle = '#111'; cx.lineWidth = 6; cx.stroke();
cx.fillStyle = '#111'; cx.font = '30px sans-serif';
cx.fillText('안녕하세요 친구', 280, 380); cx.fillText('반갑습니다', 300, 430);

const SW = 1000, SH = 2000; const sc = nc.createCanvas(SW, SH), sx = sc.getContext('2d');
sx.drawImage(cv, 0, 0, SW, SH);
const pm = (x1, y1, x2, y2) => [Math.round(y1 / 1600 * 1000), Math.round(x1 / 800 * 1000), Math.round(y2 / 1600 * 1000), Math.round(x2 / 800 * 1000)];
const ob = pm(215, 215, 585, 585); // model boxed the whole bubble incl. outline

function sampleBg(ctx, cw, ch, y1, x1, y2, x2) {
  const X1 = clamp(Math.round(x1 / 1000 * cw), 0, cw - 2), X2 = clamp(Math.round(x2 / 1000 * cw), X1 + 1, cw);
  const Y1 = clamp(Math.round(y1 / 1000 * ch), 0, ch - 2), Y2 = clamp(Math.round(y2 / 1000 * ch), Y1 + 1, ch);
  const bw = X2 - X1, bh = Y2 - Y1; let d; try { d = ctx.getImageData(X1, Y1, bw, bh).data; } catch (e) { return null; }
  const t = Math.max(1, Math.round(Math.min(bw, bh) * 0.1)), R = [], Gc = [], B = [];
  const push = (x, y) => { const i = (y * bw + x) * 4; R.push(d[i]); Gc.push(d[i + 1]); B.push(d[i + 2]); };
  for (let y = 0; y < bh; y++) { if (y < t || y >= bh - t) { for (let x = 0; x < bw; x += 2) push(x, y); } else { for (let x = 0; x < t; x++) push(x, y); for (let x = bw - t; x < bw; x++) push(x, y); } }
  const med = a => Uint8Array.from(a).sort()[a.length >> 1];
  const c = [med(R), med(Gc), med(B)], lm = c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
  let dev = 0; for (let i = 0; i < R.length; i++) dev += Math.abs(R[i] * 0.299 + Gc[i] * 0.587 + B[i] * 0.114 - lm);
  let sd = 0; for (let i = 0; i < R.length; i++) sd += Math.abs(R[i] - c[0]) + Math.abs(Gc[i] - c[1]) + Math.abs(B[i] - c[2]);
  return { c, busy: R.length ? dev / R.length > 26 : false, spread: R.length ? sd / (R.length * 3) : 0 };
}
function edgeClean(d, bw, bh, t, c) {
  const near = i => Math.abs(d[i] - c[0]) <= 34 && Math.abs(d[i + 1] - c[1]) <= 34 && Math.abs(d[i + 2] - c[2]) <= 34;
  const rows = []; for (let y = 0; y < bh; y++) if (y < t || y >= bh - t) rows.push(y);
  let ok = 0, tot = 0;
  for (const y of rows) { const rs = y * bw * 4; let hits = 0, n = 0;
    for (let x = 0; x < bw; x += 2) { const i = rs + x * 4; if (d[i + 3] > 200) { n++; if (near(i)) hits++; } }
    if (n >= 4) { tot++; if (hits / n >= 0.6) ok++; } }
  return tot >= 2 ? ok / tot >= 0.5 : true;
}
function trimToFill(ctx, cw, ch, b) {
  let [y1, x1, y2, x2] = b;
  for (let i = 0; i < 4; i++) {
    const X1 = clamp(Math.round(x1 / 1000 * cw), 0, cw - 2), X2 = clamp(Math.round(x2 / 1000 * cw), X1 + 1, cw);
    const Y1 = clamp(Math.round(y1 / 1000 * ch), 0, ch - 2), Y2 = clamp(Math.round(y2 / 1000 * ch), Y1 + 1, ch);
    const bw = X2 - X1, bh = Y2 - Y1; if (bw < 6 || bh < 6) return null;
    let d; try { d = ctx.getImageData(X1, Y1, bw, bh).data; } catch (e) { return null; }
    const t = Math.max(1, Math.round(Math.min(bw, bh) * 0.1));
    const bg = sampleBg(ctx, cw, ch, y1, x1, y2, x2);
    if (!bg) return null;
    console.log('iter', i, 'box', [y1, x1, y2, x2].map(v => Math.round(v)), 'bg', bg.c, 'clean?', edgeClean(d, bw, bh, t, bg.c));
    if (edgeClean(d, bw, bh, t, bg.c)) return [y1, x1, y2, x2];
    const my = clamp(Math.round(t * 1.7), 1, 18), mx = clamp(Math.round(t * 1.7), 1, 18);
    if ((y2 - y1) - 2 * my < 12 || (x2 - x1) - 2 * mx < 20) return [y1, x1, y2, x2];
    y1 += my / ch * 1000; y2 -= my / ch * 1000; x1 += mx / cw * 1000; x2 -= mx / cw * 1000;
  }
  return [y1, x1, y2, x2];
}
const tr = trimToFill(sx, SW, SH, ob.slice());
console.log('final trimmed:', tr.map(v => Math.round(v)));
const py1 = Math.round(tr[0] / 1000 * 1600), py2 = Math.round(tr[2] / 1000 * 1600);
const px1 = Math.round(tr[1] / 1000 * 800), px2 = Math.round(tr[3] / 1000 * 800);
console.log('page px box:', px1, py1, px2, py2);
const dd = cx.getImageData(px1, py1, px2 - px1, py2 - py1).data;
let dark = 0; for (let i = 0; i < dd.length; i += 4) if (dd[i] < 80 && dd[i + 1] < 80 && dd[i + 2] < 80) dark++;
console.log('dark glyph px remaining inside trimmed box:', dark);
