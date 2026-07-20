#!/usr/bin/env node
/**
 * Extract booths from the floorplan SVG.
 *
 * The plan follows a fixed convention, and this relies on it rather than on
 * hardcoded CSS class names:
 *
 *   booth number   -> top-left of the stand
 *   booth size     -> bottom-right of the stand
 *   exhibitor name -> centre
 *
 * A rectangle is a stand if it carries a number label AND a size label. That one
 * rule fixes three faults in the previous class-based approach:
 *
 *   1. Rectangles spanning two stands. The SVG holds one rect covering stands
 *      410+509 plus a second rect over 410 alone, stacked on the same pixels, so
 *      the pair reported as a single 59 m² stand. Two number labels inside one
 *      rect means two stands, and it gets split.
 *   2. Zero-area slivers. One rect measures 100.6 x 0.1 and was counted as an
 *      available stand — an invisible phantom inflating availability.
 *   3. Stands drawn in an off-white class. Three real stands used cls-8/cls-9
 *      instead of cls-13, so they rendered white but were never clickable.
 *
 * The previous version documented this convention in its header but the code
 * that used it (findSqmBox) was never called.
 *
 * Status comes from fill colour. Area is still estimated from geometry — the
 * printed size is outlined text and needs OCR to read directly.
 *
 *   node scripts/extract_booths.js [--report]
 */
const fs = require('fs');
const path = require('path');
const { glyphBoxes, clusterLabels, rects } = require('./svg-paths');

const SVG_PATH = path.join(__dirname, '..', 'public', 'LEX26_Floorplan_Web-Format_57.svg');
const OUT_PATH = path.join(__dirname, '..', 'public', 'booth_data.json');

// Calibrated against printed sizes: the rect covering two 30 m² stands measures
// 16836 units², i.e. 59.5 m² at this divisor — within ~2% of the printed 60.
const UNITS_PER_SQM = 283;
const PRICE_PER_SQM = 600;

const AVAILABLE_FILLS = ['#fff', '#ffffff', '#fbfbf7', '#fafbfb'];
const TAKEN_FILLS     = ['#fcdf6d'];

// Facility boxes — catering points and toilets. They are drawn in a near-white
// fill and carry pictogram glyphs that the label detector reads as a number and
// a size, so colour and labels alone are not enough to exclude them.
const FACILITY_CLASSES = new Set(['cls-9', 'cls-17']);

const MIN_STAND_AREA = 500;   // units²; below this a rect is a line or artefact

function classFills(svg) {
  const style = /<style>([\s\S]*?)<\/style>/.exec(svg);
  const map = {};
  if (!style) return map;
  for (const b of style[1].matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const fill = /fill:\s*([^;]+)/.exec(b[2]);
    if (!fill) continue;
    for (const sel of b[1].split(',')) {
      const name = sel.trim().replace(/^\./, '');
      if (name) map[name] = fill[1].trim().toLowerCase();
    }
  }
  return map;
}

function labelsFor(rect, glyphs) {
  const { x, y, w, h } = rect;
  const inside = glyphs.filter(p =>
    p.cx >= x - 1 && p.cx <= x + w + 1 && p.cy >= y - 1 && p.cy <= y + h + 1);

  const band = Math.min(h * 0.35, 18);
  return {
    numbers: clusterLabels(inside.filter(p => p.cx < x + w * 0.6 && p.cy < y + band)),
    sizes:   clusterLabels(inside.filter(p => p.cx > x + w * 0.5 && p.cy > y + h - band)),
  };
}

/**
 * Divide a rect carrying several number labels into one cell per label.
 *
 * The split axis follows the labels themselves: stands side by side have number
 * labels that differ mainly in x, stacked stands differ mainly in y. Splitting
 * everything horizontally would cut vertically-stacked pairs the wrong way.
 */
function splitByLabels(rect, numberLabels) {
  const n = numberLabels.length;
  const xs = numberLabels.map(l => l.x0);
  const ys = numberLabels.map(l => l.y0);
  const spreadX = Math.max(...xs) - Math.min(...xs);
  const spreadY = Math.max(...ys) - Math.min(...ys);
  const vertical = spreadY > spreadX;

  const ordered = numberLabels.slice().sort((a, b) => vertical ? a.y0 - b.y0 : a.x0 - b.x0);
  return ordered.map((_, i) => vertical
    ? { ...rect, y: rect.y + i * (rect.h / n), h: rect.h / n, _split: `${i + 1} of ${n} (stacked)` }
    : { ...rect, x: rect.x + i * (rect.w / n), w: rect.w / n, _split: `${i + 1} of ${n} (side by side)` });
}

function main() {
  const svg    = fs.readFileSync(SVG_PATH, 'utf8');
  const fills  = classFills(svg);
  const glyphs = glyphBoxes(svg);
  const all    = rects(svg);

  const stats = { scanned: 0, noLabels: 0, tooSmall: 0, split: 0, facilities: 0 };
  const candidates = [];

  for (const r of all) {
    stats.scanned++;
    const cls = (r.cls || '').split(/\s+/)[0];
    if (FACILITY_CLASSES.has(cls)) { stats.facilities++; continue; }

    const fill    = (fills[cls] || '').toLowerCase();
    const isAvail = AVAILABLE_FILLS.includes(fill);
    const isTaken = TAKEN_FILLS.includes(fill);
    if (!isAvail && !isTaken) continue;

    if (r.w * r.h < MIN_STAND_AREA) { stats.tooSmall++; continue; }

    const { numbers, sizes } = labelsFor(r, glyphs);
    if (!numbers.length || !sizes.length) { stats.noLabels++; continue; }

    const parts = numbers.length > 1 ? (stats.split++, splitByLabels(r, numbers)) : [r];
    for (const p of parts) candidates.push({ ...p, status: isAvail ? 'available' : 'sold' });
  }

  // A multi-label rect has already been replaced by its parts above, so no
  // general "drop anything containing something smaller" pass is needed — and
  // that pass was wrong: the SVG nests some genuinely separate stands, so it
  // silently deleted real ones (730 Mixtron, 910, half of 420).
  //
  // What remains are vertically-stacked combined rects. The label split misses
  // those, because the lower stand's number sits mid-rect rather than in the
  // top band. Where a rect fully contains another and the two share three
  // edges, the leftover strip is unambiguous, so trim the container down to it.
  const EDGE = 2;
  const trimmed = candidates.map(a => {
    const inner = candidates.find(b => b !== a &&
      b.x >= a.x - EDGE && b.y >= a.y - EDGE &&
      b.x + b.w <= a.x + a.w + EDGE && b.y + b.h <= a.y + a.h + EDGE &&
      b.w * b.h < a.w * a.h * 0.95);
    if (!inner) return a;

    const sameLeft  = Math.abs(inner.x - a.x) < EDGE;
    const sameWidth = Math.abs(inner.w - a.w) < EDGE;
    const sameTop   = Math.abs(inner.y - a.y) < EDGE;
    const sameHeight= Math.abs(inner.h - a.h) < EDGE;

    // stacked: same left edge and width, differing height -> keep the strip below
    if (sameLeft && sameWidth && !sameHeight) {
      stats.trimmed++;
      return { ...a, y: inner.y + inner.h, h: a.h - inner.h, _trim: 'below' };
    }
    // side by side: same top edge and height, differing width -> keep the strip right
    if (sameTop && sameHeight && !sameWidth) {
      stats.trimmed++;
      return { ...a, x: inner.x + inner.w, w: a.w - inner.w, _trim: 'right' };
    }
    return a;
  }).filter(r => r.w * r.h >= MIN_STAND_AREA);

  const uncontained = trimmed;

  // Coincident duplicates do still need removing. Where the SVG carried both a
  // combined rect and a standalone rect for one of its halves, splitting the
  // combined one reproduces that half exactly, so the stand appears twice.
  const TOL = 2;
  const kept = [];
  let duplicates = 0;
  for (const r of uncontained) {
    const dup = kept.find(k =>
      Math.abs(k.x - r.x) < TOL && Math.abs(k.y - r.y) < TOL &&
      Math.abs(k.w - r.w) < TOL && Math.abs(k.h - r.h) < TOL);
    if (dup) { duplicates++; continue; }
    kept.push(r);
  }
  stats.duplicates = duplicates;

  // Reading order — banded top-to-bottom, then left-to-right. Stable across
  // re-runs, unlike raw SVG document order.
  kept.sort((a, b) => Math.round(a.y / 40) - Math.round(b.y / 40) || a.x - b.x);

  const out = {};
  kept.forEach((r, i) => {
    const id  = `booth-${String(i + 1).padStart(3, '0')}`;
    const sqm = Math.max(4, Math.round((r.w * r.h) / UNITS_PER_SQM));
    out[id] = {
      boothId: id,
      status: r.status,
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.w), h: Math.round(r.h),
      sqm,
      price: sqm * PRICE_PER_SQM,
    };
  });

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));

  const avail = kept.filter(r => r.status === 'available').length;
  console.log(`Scanned ${stats.scanned} rects`);
  console.log(`  skipped, no number/size label : ${stats.noLabels}   (logos, catering, toilets)`);
  console.log(`  skipped, below min area       : ${stats.tooSmall}   (slivers)`);
  console.log(`  rects split by label count    : ${stats.split}`);
  console.log(`  skipped, facility boxes        : ${stats.facilities}   (catering, toilets)`);
  console.log(`  coincident duplicates dropped : ${stats.duplicates}`);
  console.log(`\nStands written: ${kept.length}  (${avail} available, ${kept.length - avail} taken)`);
  console.log(`  -> ${OUT_PATH}`);

  if (process.argv.includes('--report')) {
    console.log('\nAvailable stands:');
    for (const r of kept.filter(x => x.status === 'available')) {
      console.log(`  ${String(Math.round(r.w)).padStart(4)} x ${String(Math.round(r.h)).padStart(4)}` +
                  ` = ${String(Math.round(r.w * r.h / UNITS_PER_SQM)).padStart(3)} m2` +
                  (r._split ? `   (split ${r._split})` : ''));
    }
  }
}

main();
