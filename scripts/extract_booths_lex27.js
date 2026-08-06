#!/usr/bin/env node
/**
 * Extract booths from the LEX27 consolidated floorplan.
 *
 * Unlike the LEX26 extractor (which inferred stands from number+size label
 * pairs), this plan is a clean template: every sellable stand is a <rect> in a
 * known fill class, so booth identity comes straight from the class.
 *
 *   cls-10  #fff      white sellable booth
 *   cls-7   #f4d131   pre-highlighted booth (still sellable)
 *   cls-8 / cls-6     feature areas (lounges / conference) — NOT sellable
 *
 * Rects carry rotation/translation transforms, so each stand's true footprint
 * is the axis-aligned bounding box of its four corners after the transform.
 *
 *   node scripts/extract_booths_lex27.js            -> writes booth_data.json
 *   node scripts/extract_booths_lex27.js --dry      -> preview only
 *   node scripts/extract_booths_lex27.js --divisor N -> set units²-per-m²
 */
const fs = require('fs');
const path = require('path');

const SVG_PATH = path.join(__dirname, '..', 'public', 'LEX27_Floorplan_Consolidated.svg');
const OUT_PATH = path.join(__dirname, '..', 'public', 'booth_data.json');

const DRY = process.argv.includes('--dry');
const divIdx = process.argv.indexOf('--divisor');
// Units² per m². Calibrated so a standard small booth reads ~9 m²; adjust with
// --divisor once a real printed size is known.
const DIVISOR = divIdx > -1 ? Number(process.argv[divIdx + 1]) : 181;
const RATE = 600;                                   // €/m², matches config.ratePerSqm
const BOOTH_CLASSES = ['cls-10', 'cls-7'];          // sellable fills only

// ── transform maths ───────────────────────────────────────────────────────────
const mul = (a, b) => [
  a[0]*b[0] + a[2]*b[1],       a[1]*b[0] + a[3]*b[1],
  a[0]*b[2] + a[2]*b[3],       a[1]*b[2] + a[3]*b[3],
  a[0]*b[4] + a[2]*b[5] + a[4], a[1]*b[4] + a[3]*b[5] + a[5],
];
function parseTransform(str) {
  let m = [1, 0, 0, 1, 0, 0];
  if (!str) return m;
  const re = /(translate|rotate|matrix|scale)\s*\(([^)]*)\)/g;
  let mt;
  while ((mt = re.exec(str))) {
    const op = mt[1];
    const a = mt[2].split(/[ ,]+/).map(Number);
    let t;
    if (op === 'translate') t = [1, 0, 0, 1, a[0] || 0, a[1] || 0];
    else if (op === 'scale') t = [a[0] || 1, 0, 0, (a[1] ?? a[0]) || 1, 0, 0];
    else if (op === 'matrix') t = a;
    else if (op === 'rotate') {
      const r = (a[0] || 0) * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
      const rot = [cos, sin, -sin, cos, 0, 0];
      t = a.length >= 3
        ? mul([1, 0, 0, 1, a[1], a[2]], mul(rot, [1, 0, 0, 1, -a[1], -a[2]]))
        : rot;
    } else t = [1, 0, 0, 1, 0, 0];
    m = mul(m, t);
  }
  return m;
}
const apply = (m, x, y) => [m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]];

function bboxAfter(x, y, w, h, m) {
  const pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([px, py]) => apply(m, px, py));
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

// ── extract ───────────────────────────────────────────────────────────────────
const svg = fs.readFileSync(SVG_PATH, 'utf8');
const rectRe = /<rect\b([^>]*)\/?>/g;
const attr = (s, n) => { const m = s.match(new RegExp(n + '="([^"]*)"')); return m ? m[1] : null; };

const booths = [];
let mm;
while ((mm = rectRe.exec(svg))) {
  const a = mm[1];
  const cls = (attr(a, 'class') || '').trim();
  if (!BOOTH_CLASSES.includes(cls)) continue;
  const x = parseFloat(attr(a, 'x')), y = parseFloat(attr(a, 'y'));
  const w = parseFloat(attr(a, 'width')), h = parseFloat(attr(a, 'height'));
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
  // Store the RAW rect attributes as geometry — that is exactly what the client's
  // rectGeom() reads (getBBox returns the local, pre-transform box), and raw
  // coords are unique across all stands, so every booth exact-matches its rect.
  // The transform is used only to derive the VISUAL centre for reading order.
  const vis = bboxAfter(x, y, w, h, parseTransform(attr(a, 'transform')));
  booths.push({ x, y, w, h, cls, vcx: vis.x + vis.w / 2, vcy: vis.y + vis.h / 2 });
}

// Reading order by VISUAL position: top-to-bottom, then left-to-right (band the
// y so a row groups). Area is rotation-invariant, so sqm is unaffected.
booths.sort((p, q) => (Math.abs(p.vcy - q.vcy) > 20 ? p.vcy - q.vcy : p.vcx - q.vcx));

const out = {};
booths.forEach((b, i) => {
  const id = `booth-${String(i + 1).padStart(3, '0')}`;
  const sqm = Math.max(1, Math.round((b.w * b.h) / DIVISOR));
  out[id] = {
    boothId: id,
    status: 'available',
    x: Math.round(b.x * 100) / 100, y: Math.round(b.y * 100) / 100,
    w: Math.round(b.w * 100) / 100, h: Math.round(b.h * 100) / 100,
    sqm, price: sqm * RATE,
  };
});

// ── report ────────────────────────────────────────────────────────────────────
const sqms = booths.map(b => Math.max(1, Math.round((b.w * b.h) / DIVISOR)));
const tally = {};
sqms.forEach(s => { tally[s] = (tally[s] || 0) + 1; });
console.log(`Extracted ${booths.length} sellable stands (divisor ${DIVISOR})`);
console.log(`Footprint px range: w ${Math.round(Math.min(...booths.map(b=>b.w)))}..${Math.round(Math.max(...booths.map(b=>b.w)))}, ` +
            `h ${Math.round(Math.min(...booths.map(b=>b.h)))}..${Math.round(Math.max(...booths.map(b=>b.h)))}`);
console.log('m² distribution:', Object.entries(tally).sort((a,b)=>Number(a[0])-Number(b[0])).map(([s,n])=>`${s}m²×${n}`).join('  '));
console.log('total m²:', sqms.reduce((a, b) => a + b, 0));

if (DRY) { console.log('\n--dry: nothing written.'); }
else { fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2)); console.log(`\nWrote ${Object.keys(out).length} stands -> ${path.relative(process.cwd(), OUT_PATH)}`); }
