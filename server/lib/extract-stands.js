/**
 * Read the stands out of a floorplan SVG that meets specification BEC-FP-01.
 *
 * This is the payoff for the spec. When a plan arrives with LIVE TEXT, every
 * stand can be read exactly: the number is text, the area is text, and the
 * shape is a rect. Nothing is guessed, so there is no OCR here and no digit
 * map to bootstrap — those exist in scripts/read_lex27_labels.js only because
 * the Europe artwork arrived with its text flattened to outlines, and that is
 * a rescue, not the design.
 *
 * Nothing in this file names an event. Everything event-specific is measured
 * from the file itself:
 *
 *   - the unit ("ft" or "m") comes from the area labels the plan prints
 *   - the drawing scale is CALIBRATED against those labels rather than
 *     hardcoded, because a constant measured on one plan (LEX's 283 units per
 *     m²) is wrong on every other plan; North America's coordinate space is
 *     three times smaller than Europe's
 *   - which shapes are stands follows from carrying a number, not from fill
 *     colours or class names, which mean different things in different exports
 *
 * That is what makes this hold for the next event, and the one after.
 */

/** Rectangles, with Illustrator's rotate(90) form resolved to plain x/y/w/h. */
function readRects(svg) {
  const out = [];
  for (const m of svg.matchAll(/<rect([^>]*?)\/?>/g)) {
    const a = m[1];
    const num = (n) => {
      const r = new RegExp(`${n}="([^"]+)"`).exec(a);
      return r ? parseFloat(r[1]) : null;
    };
    let x = num('x'), y = num('y'), w = num('width'), h = num('height');
    if (x == null || y == null || !w || !h) continue;

    // Rotated stands are written about a translated origin; resolve them so
    // every rect that follows is in one coordinate space.
    const t = /transform="translate\(([-\d.]+)[\s,]+([-\d.]+)\)\s*rotate\(90\)"/.exec(a);
    if (t) {
      const nx = parseFloat(t[1]) - (y + h);
      const ny = parseFloat(t[2]) + x;
      x = nx; y = ny; [w, h] = [h, w];
    }
    out.push({ cls: (/class="([^"]+)"/.exec(a) || [])[1] || '', x, y, w, h });
  }
  return out;
}

/**
 * Repair text that was written as UTF-8 and then re-encoded as if it were
 * Latin-1 — "Klüber" arriving as "KlÃ¼ber". Common in exports that pass
 * through several tools, and safe to undo: the repair is only kept when the
 * result round-trips back to the original bytes.
 */
function repairMojibake(s) {
  if (!/[ÃÂ]/.test(s)) return s;
  try {
    const fixed = Buffer.from(s, 'latin1').toString('utf8');
    if (Buffer.from(fixed, 'utf8').toString('latin1') === s && !/�/.test(fixed)) return fixed;
  } catch { /* leave it alone */ }
  return s;
}

/** Text runs, positioned by their transform and flattened across tspans. */
function readTexts(svg) {
  const out = [];
  const re = /<text([^>]*?)>([\s\S]*?)<\/text>/g;
  for (const m of svg.matchAll(re)) {
    const attrs = m[1];
    const t = /transform="translate\(([-\d.]+)[\s,]+([-\d.]+)\)([^"]*)"/.exec(attrs);
    if (!t) continue;
    // A trailing scale() marks the superscript of a unit ("²"), never a label.
    if (/scale\(/.test(t[3])) continue;
    // Multi-line labels are tspans on different baselines. Joining them
    // blind gives "NetworkingLounge", so a change of baseline becomes a space.
    let body = m[2];
    const spans = [...body.matchAll(/<tspan([^>]*)>([\s\S]*?)<\/tspan>/g)];
    if (spans.length) {
      let lastY = null;
      body = spans.map(sp => {
        const y = (/\by="([-\d.]+)"/.exec(sp[1]) || [])[1] ?? null;
        const brk = lastY !== null && y !== null && y !== lastY ? ' ' : '';
        lastY = y;
        return brk + sp[2];
      }).join('');
    }
    const text = repairMojibake(body.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
    if (!text) continue;
    out.push({ cls: (/class="([^"]+)"/.exec(attrs) || [])[1] || '', x: +t[1], y: +t[2], text });
  }
  return out;
}

const NUMBER = /^[A-Z]{0,2}\d{2,5}[A-Z]?$/;          // 142, 1249, P014, A12
const AREA   = /^([\d,]+)\s*(ft|m|sqm|sqft)$/i;      // "200ft" — the ² is separate

/**
 * Pull the stands out of a floorplan.
 *
 * Returns the stands with their number, printed area, geometry and any
 * exhibitor name printed inside them, plus the calibration and anything the
 * reader could not account for. It reports; it does not write.
 */
function extractStands(svg) {
  const rects = readRects(svg);
  const texts = readTexts(svg);
  const warnings = [];

  const numbers = texts.filter(t => NUMBER.test(t.text));
  const areas = texts.filter(t => AREA.test(t.text));
  const others = texts.filter(t => !NUMBER.test(t.text) && !AREA.test(t.text));

  if (!numbers.length) {
    return { stands: [], unit: null, unitsPerArea: null, rects: rects.length,
             warnings: ['No stand numbers found as live text. Has the text been converted to outlines?'] };
  }

  // A label belongs to a stand when it sits inside it. The tolerance is kept
  // tight on purpose: stands butt directly against each other, so a generous
  // margin lets a number leak into its neighbour and steal the shape from the
  // stand it actually labels — the number printed a stand's width away wins
  // simply by appearing earlier in the file.
  const T = 0.5;
  const inside = (t, r) =>
    t.x >= r.x - T && t.x <= r.x + r.w + T && t.y >= r.y - T && t.y <= r.y + r.h + T;

  // The unit is whatever the plan prints; ft² and m² are never mixed.
  const units = [...new Set(areas.map(a => AREA.exec(a.text)[2].toLowerCase().replace('sq', '')))];
  if (units.length > 1) warnings.push(`Mixed area units in one plan: ${units.join(', ')}.`);
  const unit = units[0] === 'ft' ? 'sqft' : units[0] === 'm' ? 'sqm' : null;

  const area = (r) => r.w * r.h;
  const smallestAround = (t, pool) => {
    let best = null;
    for (const r of pool) if (inside(t, r) && (!best || area(r) < area(best))) best = r;
    return best;
  };

  // A shape is a stand because it carries a number, not because of its fill —
  // class names and colours mean different things in different exports, and
  // the number is the thing every plan agrees on.
  const standOf = new Map();
  const collisions = [];
  for (const n of numbers) {
    const r = smallestAround(n, rects);
    if (!r) continue;
    if (standOf.has(r)) { collisions.push(`${standOf.get(r).text}/${n.text}`); continue; }
    standOf.set(r, n);
  }
  if (collisions.length) {
    warnings.push(`${collisions.length} shapes carry two stand numbers (${collisions.join(', ')}) — usually a stale label left under a newer one. Only the first is kept; the artwork needs correcting.`);
  }

  const standRects = [...standOf.keys()];
  const takeFor = (pool) => {
    const claimedLabel = new Set();
    const byRect = new Map();
    for (const t of pool) {
      const r = smallestAround(t, standRects);
      // One label belongs to one stand, so a name cannot be copied onto every
      // shape that happens to overlap it.
      if (r && !byRect.has(r) && !claimedLabel.has(t)) { byRect.set(r, t); claimedLabel.add(t); }
    }
    return byRect;
  };
  const areaFor = takeFor(areas);
  const nameFor = takeFor(others);

  const stands = [];
  const claimed = new Set();
  for (const [r, n] of standOf) {
    claimed.add(n);
    const a = areaFor.get(r);
    const name = nameFor.get(r);
    stands.push({
      number: n.text,
      printedArea: a ? parseInt(AREA.exec(a.text)[1].replace(/,/g, ''), 10) : null,
      geometry: { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.w.toFixed(2), h: +r.h.toFixed(2) },
      exhibitor: name ? name.text : null,
      fillClass: r.cls,
    });
  }

  const orphans = numbers.filter(n => !claimed.has(n));
  if (orphans.length) {
    warnings.push(`${orphans.length} stand numbers sit outside any shape: ${orphans.slice(0, 6).map(o => o.text).join(', ')}.`);
  }

  // Calibrate drawing units against the printed areas. The median is used so
  // a handful of feature areas drawn larger than their sellable space cannot
  // drag the scale for every ordinary stand.
  const withArea = stands.filter(s => s.printedArea > 0);
  let unitsPerArea = null;
  if (withArea.length >= 5) {
    const ratios = withArea
      .map(s => (s.geometry.w * s.geometry.h) / s.printedArea)
      .sort((p, q) => p - q);
    unitsPerArea = ratios[Math.floor(ratios.length / 2)];
  } else {
    warnings.push('Too few printed areas to calibrate the drawing scale.');
  }

  // Every stand gets an area: printed where the plan says so, derived where it
  // does not, and the two are compared so a disagreement is reported and not
  // quietly averaged away.
  const disagree = [];
  for (const s of stands) {
    const derived = unitsPerArea
      ? Math.round((s.geometry.w * s.geometry.h) / unitsPerArea)
      : null;
    s.derivedArea = derived;
    s.area = s.printedArea != null ? s.printedArea : derived;
    s.areaSource = s.printedArea != null ? 'printed' : 'derived';
    if (s.printedArea != null && derived != null &&
        Math.abs(derived - s.printedArea) / s.printedArea > 0.05) {
      disagree.push(s.number);
    }
  }
  if (disagree.length) {
    warnings.push(`${disagree.length} stands are drawn a different size to their printed area (${disagree.slice(0, 8).join(', ')}) — usually feature areas whose shape is larger than the space sold. The printed area is kept.`);
  }

  const noArea = stands.filter(s => s.printedArea == null).length;
  if (noArea) warnings.push(`${noArea} stands print no area; theirs is derived from the drawing.`);

  return { stands, unit, unitsPerArea, rects: rects.length, texts: texts.length, warnings };
}

module.exports = { extractStands, readRects, readTexts, repairMojibake };
