#!/usr/bin/env node
/**
 * Validate a supplied floorplan SVG against docs/floorplan-artwork-spec.html.
 *
 * Run this on every file a designer sends, before accepting it. Failures name
 * the clause so the report can be forwarded as-is.
 *
 *   node scripts/validate-artwork.js path/to/plan.svg [--schedule path/to/stands.csv]
 */
const fs = require('fs');
const path = require('path');
const { glyphBoxes, clusterLabels, rects, pathBBox } = require('./svg-paths');

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/validate-artwork.js <plan.svg> [--schedule <stands.csv>]');
  process.exit(2);
}
const schedIdx = process.argv.indexOf('--schedule');
const schedule = schedIdx > -1 ? process.argv[schedIdx + 1] : null;

const svg = fs.readFileSync(file, 'utf8');

const results = [];
const pass = (clause, name, detail = '') => results.push({ ok: true,  clause, name, detail });
const fail = (clause, name, detail = '') => results.push({ ok: false, clause, name, detail });

const STAND_FILLS = { '#ffffff': 'available', '#fff': 'available', '#fcdf6d': 'taken' };

function classFills() {
  const style = /<style>([\s\S]*?)<\/style>/.exec(svg);
  const map = {};
  if (!style) return map;
  for (const b of style[1].matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const f = /fill:\s*([^;]+)/.exec(b[2]);
    if (!f) continue;
    for (const sel of b[1].split(',')) {
      const n = sel.trim().replace(/^\./, '');
      if (n) map[n] = f[1].trim().toLowerCase();
    }
  }
  return map;
}

// ─── R1: text must be live ────────────────────────────────────────────────────
const textCount = (svg.match(/<text[\s>]/g) || []).length;
const pathCount = (svg.match(/<path[\s>]/g) || []).length;
textCount > 0
  ? pass('R1', 'Text is live', `${textCount} text elements`)
  : fail('R1', 'Text is live',
         `0 text elements and ${pathCount} paths — text has been converted to outlines. ` +
         `Stand numbers are unrecoverable. This alone makes the file unusable.`);

// ─── R2: no rasterised drawing content ────────────────────────────────────────
const images = [...svg.matchAll(/<image\b([^>]*?)(?:\/>|>)/g)];
const bigImages = images.filter(m => {
  const w = /width="([\d.]+)"/.exec(m[1]);
  const s = /scale\(\.?([\d.]+)\)/.exec(m[1]);
  const eff = w ? parseFloat(w[1]) * (s ? parseFloat('.' + s[1].replace('.', '')) || 1 : 1) : 0;
  return eff > 400;   // larger than any plausible logo once scaled
});
bigImages.length === 0
  ? pass('R2', 'No rasterised drawing content', `${images.length} images, all logo-sized`)
  : fail('R2', 'No rasterised drawing content', `${bigImages.length} large embedded images`);

// ─── Collect stand shapes ─────────────────────────────────────────────────────
const fills  = classFills();
const glyphs = glyphBoxes(svg);
const all    = rects(svg);
const stands = all.filter(r => {
  const f = fills[(r.cls || '').split(/\s+/)[0]];
  return f && STAND_FILLS[f];
});

// ─── R4: one shape per stand ──────────────────────────────────────────────────
function numberLabels(r) {
  const inside = glyphs.filter(p =>
    p.cx >= r.x - 1 && p.cx <= r.x + r.w + 1 && p.cy >= r.y - 1 && p.cy <= r.y + r.h + 1);
  const band = Math.min(r.h * 0.35, 18);
  return clusterLabels(inside.filter(p => p.cx < r.x + r.w * 0.6 && p.cy < r.y + band));
}
const multi = stands.filter(r => numberLabels(r).length > 1);
multi.length === 0
  ? pass('R4', 'One shape per stand')
  : fail('R4', 'One shape per stand',
         `${multi.length} shapes contain more than one stand number: ` +
         multi.slice(0, 5).map(r => `${Math.round(r.w)}x${Math.round(r.h)}@(${Math.round(r.x)},${Math.round(r.y)})`).join(', '));

// ─── R5: no overlapping stands ────────────────────────────────────────────────
const overlaps = [];
for (let i = 0; i < stands.length; i++) {
  for (let j = i + 1; j < stands.length; j++) {
    const a = stands[i], b = stands[j];
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (ox > 1 && oy > 1) overlaps.push([a, b]);
  }
}
overlaps.length === 0
  ? pass('R5', 'No overlapping stand shapes')
  : fail('R5', 'No overlapping stand shapes',
         `${overlaps.length} overlapping pairs, first at (${Math.round(overlaps[0][0].x)},${Math.round(overlaps[0][0].y)})`);

// ─── R6: no slivers ───────────────────────────────────────────────────────────
const MIN = 8;   // drawing units; adjust per scale
const slivers = stands.filter(r => r.w < MIN || r.h < MIN);
slivers.length === 0
  ? pass('R6', 'No sliver or zero-area shapes')
  : fail('R6', 'No sliver or zero-area shapes',
         slivers.map(r => `${r.w.toFixed(1)}x${r.h.toFixed(1)}@(${Math.round(r.x)},${Math.round(r.y)})`).join(', '));

// ─── R10: every stand carries a number and an area label ──────────────────────
function areaLabels(r) {
  const inside = glyphs.filter(p =>
    p.cx >= r.x - 1 && p.cx <= r.x + r.w + 1 && p.cy >= r.y - 1 && p.cy <= r.y + r.h + 1);
  const band = Math.min(r.h * 0.35, 18);
  return clusterLabels(inside.filter(p => p.cx > r.x + r.w * 0.5 && p.cy > r.y + r.h - band));
}
const unlabelled = stands.filter(r => !numberLabels(r).length || !areaLabels(r).length);
unlabelled.length === 0
  ? pass('R10', 'Every stand has a number and an area label', `${stands.length} stands`)
  : fail('R10', 'Every stand has a number and an area label',
         `${unlabelled.length} of ${stands.length} stands missing a label`);

// ─── R12: exact fills only ────────────────────────────────────────────────────
// Near-white means every channel is high — not merely a hex string starting
// with 'f', which would wrongly flag the correct taken colour #fcdf6d.
function channels(hex) {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/.test(h)) return null;
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}
const nearWhite = Object.entries(fills).filter(([, f]) => {
  if (['#fff', '#ffffff'].includes(f)) return false;
  const c = channels(f);
  return c && c.every(v => v >= 0xE8);   // visually white but not exactly white
});
nearWhite.length === 0
  ? pass('R12', 'Exact fills only')
  : fail('R12', 'Exact fills only',
         `near-white variants present: ${nearWhite.map(([c, f]) => `${c}=${f}`).join(', ')} — ` +
         `these are indistinguishable from available stands`);

// ─── R15: companion schedule ──────────────────────────────────────────────────
if (schedule && fs.existsSync(schedule)) {
  const rows = fs.readFileSync(schedule, 'utf8').trim().split(/\r?\n/);
  const header = (rows[0] || '').toLowerCase();
  const need = ['stand_number', 'area_sqm', 'status'];
  const missing = need.filter(c => !header.includes(c));
  const count = rows.length - 1;

  missing.length === 0
    ? pass('R15', 'Schedule has required columns')
    : fail('R15', 'Schedule has required columns', `missing: ${missing.join(', ')}`);

  count === stands.length
    ? pass('R15', 'Schedule row count matches drawing', `${count} stands`)
    : fail('R15', 'Schedule row count matches drawing',
           `schedule has ${count} rows, drawing has ${stands.length} stand shapes`);

  const nums = rows.slice(1).map(r => r.split(',')[0].trim()).filter(Boolean);
  const dupes = nums.filter((n, i) => nums.indexOf(n) !== i);
  dupes.length === 0
    ? pass('R11', 'Stand numbers unique')
    : fail('R11', 'Stand numbers unique', `duplicates: ${[...new Set(dupes)].join(', ')}`);
} else {
  fail('R15', 'Companion stand schedule supplied',
       schedule ? `not found: ${schedule}` : 'no --schedule given; the schedule is mandatory');
}

// ─── Report ───────────────────────────────────────────────────────────────────
console.log(`\nArtwork validation — ${path.basename(file)}`);
console.log(`Specification BEC-FP-01 issue 1.0\n`);

for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  [${r.clause}] ${r.name}`);
  if (r.detail) console.log(`        ${r.detail}`);
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log(`\nFile REJECTED. Clauses to correct: ${[...new Set(failed.map(f => f.clause))].join(', ')}`);
  console.log(`Specification: docs/floorplan-artwork-spec.html`);
}
process.exit(failed.length ? 1 : 0);
