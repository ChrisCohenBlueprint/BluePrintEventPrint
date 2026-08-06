#!/usr/bin/env node
/**
 * Read the printed booth NUMBERS (top-left) and SIZES (bottom-right) from the
 * LEX27 plan and merge them into booth_data.json.
 *
 * The plan's labels are outlined glyph paths, not text, and Illustrator rounds
 * each glyph instance slightly so exact-string matching fails. Instead each
 * glyph is normalised to a small occupancy grid (scale-invariant), glyphs are
 * clustered into digit classes by that shape, and the class→digit map is
 * bootstrapped from the SIZE labels: the printed size of a stand must be close
 * to its area-derived estimate, and the ~68 single-digit "9 m²" stands fix the
 * area→m² scale exactly. The same map then decodes the (larger) number glyphs.
 *
 *   node scripts/read_lex27_labels.js --dry     inspect, write nothing
 *   node scripts/read_lex27_labels.js           apply to booth_data.json
 */
const fs = require('fs');
const path = require('path');

const SVG = path.join(__dirname, '..', 'public', 'LEX27_Floorplan_Consolidated.svg');
const OUT = path.join(__dirname, '..', 'public', 'booth_data.json');
const DRY = process.argv.includes('--dry');
const RATE = 600;
const GW = 5, GH = 7;                                // occupancy grid
const MERGE = 3;                                     // hamming merge threshold

const svg = fs.readFileSync(SVG, 'utf8');

// ── path point walker (pen + bezier control points) ───────────────────────────
const TOKEN = /([MmZzLlHhVvCcSsQqTtAa])|([-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?)/g;
const ARITY = { M:2,m:2,L:2,l:2,H:1,h:1,V:1,v:1,C:6,c:6,S:4,s:4,Q:4,q:4,T:2,t:2,A:7,a:7 };
function points(d) {
  const toks = []; let mm; TOKEN.lastIndex = 0;
  while ((mm = TOKEN.exec(d)) !== null) toks.push(mm[1] || mm[2]);
  let x = 0, y = 0, sx = 0, sy = 0, cmd = null; const P = []; const add = () => P.push([x, y]);
  for (let i = 0; i < toks.length;) {
    const t = toks[i];
    if (/^[A-Za-z]$/.test(t)) { cmd = t; i++; if (cmd === 'Z' || cmd === 'z') { x = sx; y = sy; add(); } continue; }
    const need = ARITY[cmd] ?? 2; const v = [];
    while (i < toks.length && !/^[A-Za-z]$/.test(toks[i]) && v.length < need) v.push(parseFloat(toks[i++]));
    if (v.length < need) break;
    switch (cmd) {
      case 'M': x = v[0]; y = v[1]; sx = x; sy = y; cmd = 'L'; add(); break;
      case 'm': x += v[0]; y += v[1]; sx = x; sy = y; cmd = 'l'; add(); break;
      case 'L': x = v[0]; y = v[1]; add(); break;
      case 'l': x += v[0]; y += v[1]; add(); break;
      case 'H': x = v[0]; add(); break;   case 'h': x += v[0]; add(); break;
      case 'V': y = v[0]; add(); break;   case 'v': y += v[0]; add(); break;
      case 'C': P.push([v[0], v[1]], [v[2], v[3]]); x = v[4]; y = v[5]; add(); break;
      case 'c': P.push([x+v[0], y+v[1]], [x+v[2], y+v[3]]); x += v[4]; y += v[5]; add(); break;
      case 'S': P.push([v[0], v[1]]); x = v[2]; y = v[3]; add(); break;
      case 's': P.push([x+v[0], y+v[1]]); x += v[2]; y += v[3]; add(); break;
      default: break;
    }
  }
  return P;
}

// ── transforms (for booth visual bbox) ────────────────────────────────────────
const mul = (a, b) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
function PT(str) {
  let m = [1,0,0,1,0,0]; if (!str) return m;
  const re = /(translate|rotate|matrix|scale)\s*\(([^)]*)\)/g; let mt;
  while ((mt = re.exec(str))) {
    const op = mt[1], a = mt[2].split(/[ ,]+/).map(Number); let t;
    if (op === 'translate') t = [1,0,0,1,a[0]||0,a[1]||0];
    else if (op === 'scale') t = [a[0]||1,0,0,(a[1]??a[0])||1,0,0];
    else if (op === 'matrix') t = a;
    else if (op === 'rotate') { const r=(a[0]||0)*Math.PI/180,c=Math.cos(r),s=Math.sin(r),rot=[c,s,-s,c,0,0];
      t = a.length>=3 ? mul([1,0,0,1,a[1],a[2]], mul(rot,[1,0,0,1,-a[1],-a[2]])) : rot; }
    else t = [1,0,0,1,0,0];
    m = mul(m, t);
  }
  return m;
}
const ap = (m, x, y) => [m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5]];
const attr = (s, n) => { const r = s.match(new RegExp(n + '="([^"]*)"')); return r ? r[1] : null; };

// ── booths (raw geom for output + visual bbox for label assignment) ────────────
const booths = [];
for (const mm of svg.matchAll(/<rect\b([^>]*)\/?>/g)) {
  const a = mm[1], cls = (attr(a, 'class') || '').trim();
  if (!['cls-10', 'cls-7'].includes(cls)) continue;
  const x = +attr(a, 'x'), y = +attr(a, 'y'), w = +attr(a, 'width'), h = +attr(a, 'height');
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
  const M = PT(attr(a, 'transform'));
  const pts = [[x, y], [x+w, y], [x, y+h], [x+w, y+h]].map(p => ap(M, p[0], p[1]));
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const vx = Math.min(...xs), vy = Math.min(...ys), vw = Math.max(...xs)-vx, vh = Math.max(...ys)-vy;
  booths.push({ raw: { x, y, w, h }, vx, vy, vw, vh, area: w * h, numG: [], sizeG: [] });
}

// ── glyphs → grid descriptor, assign to booths ────────────────────────────────
function descriptor(P, x0, y0, w, h) {
  const cells = new Set();
  P.forEach(([px, py]) => {
    const gx = Math.min(GW-1, Math.floor((px - x0) / (w || 1) * GW));
    const gy = Math.min(GH-1, Math.floor((py - y0) / (h || 1) * GH));
    if (gx >= 0 && gy >= 0) cells.add(gy * GW + gx);
  });
  return cells;
}
const glyphs = [];
for (const m of svg.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)) {
  const P = points(m[1]); if (P.length < 3) continue;
  const xs = P.map(p => p[0]), ys = P.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const w = x1 - x0, h = y1 - y0;
  if (!(h >= 4 && h <= 12 && w <= 14)) continue;      // digit-sized only (skip h≈3 m² unit)
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  // Smallest containing booth owns the glyph: a label sits inside its own
  // (tight) stand, never a larger neighbour it happens to overlap.
  const hosts = booths.filter(b => cx >= b.vx-1 && cx <= b.vx+b.vw+1 && cy >= b.vy-1 && cy <= b.vy+b.vh+1);
  if (!hosts.length) continue;
  const host = hosts.reduce((a, b) => (b.vw * b.vh < a.vw * a.vh ? b : a));
  const g = { cx, cy, x0, h, cells: descriptor(P, x0, y0, w, h) };
  (h >= 6.5 ? host.numG : host.sizeG).push(g);
}

// ── cluster digit shapes across all glyphs (scale-invariant grid) ─────────────
const all = booths.flatMap(b => [...b.numG, ...b.sizeG]);
const ham = (a, b) => { let d = 0; a.forEach(c => { if (!b.has(c)) d++; }); b.forEach(c => { if (!a.has(c)) d++; }); return d; };
// Deterministic: bucket by EXACT grid first, then merge buckets into clusters
// largest-first (so a big, canonical digit bucket seeds each cluster and the
// result doesn't depend on glyph iteration order).
const byGrid = new Map();
for (const g of all) {
  const k = [...g.cells].sort((a, b) => a - b).join(',');
  if (!byGrid.has(k)) byGrid.set(k, { cells: g.cells, members: [] });
  byGrid.get(k).members.push(g);
}
const groups = [...byGrid.values()].sort((a, b) => b.members.length - a.members.length);
const clusters = [];
for (const grp of groups) {
  let best = -1, bd = 1e9;
  clusters.forEach((c, i) => { const d = ham(grp.cells, c.cells); if (d < bd) { bd = d; best = i; } });
  if (best > -1 && bd <= MERGE) clusters[best].members.push(...grp.members);
  else clusters.push({ cells: grp.cells, members: [...grp.members] });
}
clusters.forEach((c, i) => c.members.forEach(g => { g.cls = i; }));

// ── decode: bootstrap class→digit from SIZE labels ────────────────────────────
const seq = gs => gs.slice().sort((a, b) => a.cx - b.cx).map(g => g.cls);
// 1) calibrate area→m² from single-digit sizes: the most common single-glyph
//    size class is the "9 m²" stand; its area / 9 gives the divisor.
const singles = booths.filter(b => b.sizeG.length === 1);
const singleCls = {};
singles.forEach(b => { const c = b.sizeG[0].cls; (singleCls[c] = singleCls[c] || []).push(b.area); });
const nineCls = Object.entries(singleCls).sort((a, b) => b[1].length - a[1].length)[0];
const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
const DIV = avg(nineCls[1]) / 9;
const est = b => b.area / DIV;

// 2) vote class→digit per position, using the calibrated estimate.
const votes = {};                                   // class -> {digit: count}
const vote = (c, d) => { (votes[c] = votes[c] || {})[d] = (votes[c][d] || 0) + 1; };
booths.forEach(b => {
  const s = seq(b.sizeG); if (!s.length) return;
  const E = Math.round(est(b));
  const digs = String(E).padStart(s.length, '0').split('').map(Number);
  if (digs.length === s.length) s.forEach((c, i) => vote(c, digs[i]));
});
const map = {};                                     // class -> digit (majority)
Object.entries(votes).forEach(([c, d]) => { map[c] = +Object.entries(d).sort((a, b) => b[1] - a[1])[0][0]; });

const decode = (gs, maxDigits) => {
  const s = seq(gs);
  if (!s.length || s.length > maxDigits || s.some(c => map[c] == null)) return null;  // reject leaked/over-long runs
  return Number(s.map(c => map[c]).join(''));
};

// ── build output ──────────────────────────────────────────────────────────────
let numRead = 0, sizeRead = 0, sizeGood = 0;
const outliers = [];
const rows = booths.map(b => {
  const number = decode(b.numG, 4);
  let size = decode(b.sizeG, 3);
  const E = Math.round(est(b));
  if (number != null) numRead++;
  if (size != null) {
    sizeRead++;
    const o = Math.abs(size - E);
    if (o <= 2) sizeGood++;
    // A size wildly off its geometry estimate is a misread (stray/leaked glyph);
    // fall back to the geometry estimate rather than trust a bad OCR value.
    else { outliers.push({ number, size, E }); size = null; }
  }
  return { b, number, size, est: E };
});

// numbering: printed number where read, else a positional fallback (P###)
rows.sort((p, q) => (Math.abs(p.b.vy - q.b.vy) > 20 ? p.b.vy - q.b.vy : p.b.vx - q.b.vx));
const used = new Set(); let dupes = 0, fallbacks = 0;
const out = {};
rows.forEach((r, i) => {
  let id = r.number != null ? String(r.number) : null;
  if (id == null || used.has(id)) { if (id != null) dupes++; id = `P${String(i + 1).padStart(3, '0')}`; fallbacks++; }
  used.add(id);
  const sqm = r.size != null ? r.size : Math.max(1, r.est);
  out[`booth-${id}`] = {
    boothId: `booth-${id}`, status: 'available',
    x: r.b.raw.x, y: r.b.raw.y, w: r.b.raw.w, h: r.b.raw.h,
    sqm, price: sqm * RATE,
  };
});

// ── report ────────────────────────────────────────────────────────────────────
console.log(`booths: ${booths.length} | digit classes: ${clusters.length} | area→m² divisor: ${DIV.toFixed(1)}`);
console.log(`class→digit map: ${Object.entries(map).map(([c, d]) => `${c}:${d}`).join(' ')}`);
console.log(`numbers read: ${numRead}/${booths.length} | sizes read: ${sizeRead}/${booths.length} | sizes within ±2 of geometry: ${sizeGood}`);
console.log(`size misreads (rejected → geometry estimate used): ${outliers.length}`, outliers.slice(0, 6).map(o => `#${o.number}:${o.size}vs${o.E}`).join(' '));
console.log(`duplicate printed numbers: ${dupes} | positional fallbacks (unreadable/dup number): ${fallbacks}`);
// anchor spot-checks
const find = n => rows.find(r => r.number === n);
[[300,72],[508,54],[254,73],[251,55]].forEach(([n,sz])=>{const r=find(n);if(r)console.log(`  anchor ${n}: size read ${r.size} (expect ~${sz})`);});
console.log('sample:', rows.slice(0,6).map(r => `${r.number ?? '?'}(${r.size ?? '?'}m²)`).join(' '));

if (DRY) console.log('\n--dry: nothing written.');
else { fs.writeFileSync(OUT, JSON.stringify(out, null, 2)); console.log(`\nWrote ${Object.keys(out).length} stands -> ${path.relative(process.cwd(), OUT)}`); }
