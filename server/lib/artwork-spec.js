const { glyphBoxes, clusterLabels, rects, pathBBox } = require('../../scripts/svg-paths');
const { extractStands } = require('./extract-stands');

/**
 * Check a floorplan SVG against specification BEC-FP-01.
 *
 * Extracted from scripts/validate-artwork.js so the same checks run on an
 * upload as on a file a designer emails. There is one implementation, so the
 * report an admin sees and the report forwarded to a designer cannot disagree.
 *
 * This is a REPORT, never a gate. The plan currently running Europe scores 3/8
 * against this spec — text outlined, overlapping shapes, unlabelled stands — so
 * a hard reject would refuse the artwork of a live show. What the spec is for
 * is telling a designer precisely what to correct, in clause numbers they can
 * act on.
 */
const SPEC = 'BEC-FP-01 issue 1.1';

function validate(svg, { scheduleText = null } = {}) {
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
// Two ways in, and which one applies is a property of the file.
//
// A plan with LIVE TEXT is read by the same extractor the import uses, so the
// shapes judged here are exactly the shapes that would become stands — whatever
// colours the designer used. The fill table below was measured on Europe's
// plan and knows only its yellow and white; on North America's light blue it
// found no stands at all, and every geometry clause passed on an empty set.
//
// A plan whose text has been outlined has nothing for the extractor to read,
// so the old route stays: stand-coloured rectangles, with numbers guessed from
// glyph outlines. That is a rescue, and the report says so in R1.
const fills  = classFills();
const glyphs = glyphBoxes(svg);
const all    = rects(svg);
let read = null;
try { read = extractStands(svg); } catch (e) { read = null; }
const live = !!(read && read.stands.length);
const stands = live
  ? read.stands.map(s => ({ x: s.visual.x, y: s.visual.y, w: s.visual.w, h: s.visual.h, number: s.number }))
  : all.filter(r => {
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
if (live) {
  const c = read.issues.collisions;
  c.length === 0
    ? pass('R4', 'One shape per stand', `${stands.length} stands, one number each`)
    : fail('R4', 'One shape per stand',
           `${c.length} shapes carry two stand numbers: ${c.slice(0, 8).join(', ')} — usually a stale label left under a newer one`);
} else {
  const multi = stands.filter(r => numberLabels(r).length > 1);
  multi.length === 0
    ? pass('R4', 'One shape per stand')
    : fail('R4', 'One shape per stand',
           `${multi.length} shapes contain more than one stand number: ` +
           multi.slice(0, 5).map(r => `${Math.round(r.w)}x${Math.round(r.h)}@(${Math.round(r.x)},${Math.round(r.y)})`).join(', '));
}

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
if (live) {
  // Every extracted stand has a number by construction; what can be missing is
  // the printed area, and what can be astray is a number outside every shape.
  const noArea = read.issues.noArea, astray = read.issues.orphans;
  const detail = [];
  if (noArea.length) detail.push(`${noArea.length} stands print no area (${noArea.slice(0, 8).join(', ')})`);
  if (astray.length) detail.push(`${astray.length} stand numbers sit outside any shape (${astray.slice(0, 8).join(', ')})`);
  detail.length === 0
    ? pass('R10', 'Every stand has a number and an area label', `${stands.length} stands`)
    : fail('R10', 'Every stand has a number and an area label', detail.join('; '));

  // A number is the stand's identity: printed twice, neither stand can be sold.
  const rep = read.issues.repeated;
  rep.length === 0
    ? pass('R11', 'Stand numbers unique')
    : fail('R11', 'Stand numbers unique', `printed on two shapes: ${rep.slice(0, 8).join(', ')}`);
} else {
  const unlabelled = stands.filter(r => !numberLabels(r).length || !areaLabels(r).length);
  unlabelled.length === 0
    ? pass('R10', 'Every stand has a number and an area label', `${stands.length} stands`)
    : fail('R10', 'Every stand has a number and an area label',
           `${unlabelled.length} of ${stands.length} stands missing a label`);
}

// ─── R12: exact fills only ────────────────────────────────────────────────────
// Near-white means every channel is high — not merely a hex string starting
// with 'f', which would wrongly flag the correct taken colour #fcdf6d.
function channels(hex) {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/.test(h)) return null;
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}
const isNearWhite = (f) => {
  if (['#fff', '#ffffff'].includes(f)) return false;
  const c = channels(f);
  return !!(c && c.every(v => v >= 0xE8));   // visually white but not exactly white
};
if (live) {
  // Colours are the plan's own to choose (the app is told what each means at
  // upload), so what R12 asks of a live-text plan is that each MEANING has one
  // flat fill. Two different near-whites on stands is the failure: a reader —
  // or a person — cannot tell which of them is the empty stand.
  const standFills = read.fills.filter(f => f.fill && !f.sponsored).map(f => f.fill);
  const whites = [...new Set(standFills.filter(isNearWhite).concat(standFills.filter(f => ['#fff', '#ffffff'].includes(f))))];
  const unread = read.unreadableFills;
  if (unread * 2 > read.stands.length) {
    fail('R12', 'One flat fill per meaning',
         `${unread} of ${read.stands.length} stands have no readable fill — gradients, patterns or transparency on the stand shapes`);
  } else if (whites.length > 1) {
    fail('R12', 'One flat fill per meaning',
         `${whites.length} different near-white fills on stands (${whites.join(', ')}) — only one of them can mean "available"`);
  } else {
    pass('R12', 'One flat fill per meaning', read.fills.map(f => `${f.fill}=${f.sponsored ? 'area' : f.status}`).join(', '));
  }
} else {
  const nearWhite = Object.entries(fills).filter(([, f]) => isNearWhite(f));
  nearWhite.length === 0
    ? pass('R12', 'Exact fills only')
    : fail('R12', 'Exact fills only',
           `near-white variants present: ${nearWhite.map(([c, f]) => `${c}=${f}`).join(', ')} — ` +
           `these are indistinguishable from available stands`);
}

// ─── R15: companion schedule ──────────────────────────────────────────────────
if (scheduleText) {
  const rows = String(scheduleText).trim().split(/\r?\n/);
  const header = (rows[0] || '').toLowerCase();
  const need = ['stand_number', 'area_sqm', 'status'];
  const missing = need.filter(c => !header.includes(c));
  const count = rows.length - 1;
  missing.length === 0
    ? pass('R15', 'Schedule has required columns')
    : fail('R15', 'Schedule has required columns', `missing: ${missing.join(', ')}`);
  Math.abs(count - stands.length) <= 2
    ? pass('R15', 'Schedule row count matches drawing', `${count} stands`)
    : fail('R15', 'Schedule row count matches drawing',
           `${count} schedule rows vs ${stands.length} stand shapes`);
  const numbers = rows.slice(1).map(r => (r.split(',')[0] || '').trim()).filter(Boolean);
  const dupes = numbers.filter((n, i) => numbers.indexOf(n) !== i);
  dupes.length === 0
    ? pass('R11', 'Stand numbers unique')
    : fail('R11', 'Stand numbers unique', `duplicates: ${[...new Set(dupes)].join(', ')}`);
} else {
  fail('R15', 'Companion stand schedule supplied', 'no schedule supplied; the schedule is mandatory');
}

  return {
    results,
    passed: results.filter(r => r.ok).length,
    total: results.length,
    failedClauses: [...new Set(results.filter(r => !r.ok).map(r => r.clause))],
  };
}

module.exports = { validate, SPEC };
