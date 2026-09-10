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

/**
 * class -> {fill, stroke}, read from the plan's own <style> block.
 *
 * The colours are how a plan says what a stand IS. Reading them is not a
 * nicety: on North America's plan white means empty, light blue means sold,
 * burgundy marks a sponsored area, and a red stroke with a glow marks a stand
 * on hold. Inferring status from whether a name happens to be printed instead
 * got 79 stands sold where the artwork plainly said 70.
 */
function readPalette(svg) {
  const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(svg);
  const map = {};
  if (!style) return map;
  for (const block of style[1].matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const fill = /fill:\s*([^;]+)/.exec(block[2]);
    const stroke = /stroke:\s*([^;]+)/.exec(block[2]);
    for (const sel of block[1].split(',')) {
      const name = sel.trim().replace(/^\./, '');
      if (!name) continue;
      map[name] = map[name] || {};
      if (fill) map[name].fill = fill[1].trim().toLowerCase();
      if (stroke) map[name].stroke = stroke[1].trim().toLowerCase();
    }
  }
  return map;
}

/** How light a colour is, 0 (black) to 1 (white). */
function lightness(hex) {
  if (!hex) return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

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
    // As authored. This is what the page reports for the element when it binds
    // a stand to its shape — it reads the x/y/width/height attributes and does
    // NOT apply the element's own transform — so it is what must be stored.
    const raw = { x, y, w, h };

    const t = /transform="translate\(([-\d.]+)[\s,]+([-\d.]+)\)\s*rotate\(90\)"/.exec(a);
    if (t) {
      const nx = parseFloat(t[1]) - (y + h);
      const ny = parseFloat(t[2]) + x;
      x = nx; y = ny; [w, h] = [h, w];
    }
    // x/y/w/h are now where the shape actually appears, which is the space the
    // text labels are positioned in and the only space they can be matched in.
    out.push({ cls: (/class="([^"]+)"/.exec(a) || [])[1] || '', x, y, w, h, raw });
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
    // The "²" of an area label is drawn as a separate, scaled text run. It is
    // tempting to skip everything carrying a scale(), but scale() is also how
    // this exporter sizes ordinary display text — the plan's own "Floorplan
    // Sponsor" title is scaled — so the test is the shape of the content: a
    // lone digit, set smaller. A real label is never that.
    const isSuperscript = /scale\(/.test(t[3]) &&
      /^\d$/.test(m[2].replace(/<[^>]+>/g, '').trim());
    if (isSuperscript) continue;
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
  const printedNames = [];
  const palette = readPalette(svg);
  const rects = readRects(svg);
  const texts = readTexts(svg);
  const warnings = [];

  const numbers = texts.filter(t => NUMBER.test(t.text));
  const areas = texts.filter(t => AREA.test(t.text));
  const others = texts.filter(t => !NUMBER.test(t.text) && !AREA.test(t.text));

  if (!numbers.length) {
    return { stands: [], unit: null, unitsPerArea: null, printedNames: [], rects: rects.length,
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
      geometry: { x: +r.raw.x.toFixed(2), y: +r.raw.y.toFixed(2),
                  w: +r.raw.w.toFixed(2), h: +r.raw.h.toFixed(2) },
      visual: { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.w.toFixed(2), h: +r.h.toFixed(2) },
      exhibitor: name ? name.text : null,
      fillClass: r.cls,
      fill: (palette[r.cls] || {}).fill || null,
      stroke: (palette[r.cls] || {}).stroke || null,
    });
  }

  // A stand number is the identity of a stand: it is the key it is stored
  // under and the way sales refer to it. Two shapes printed with the same
  // number cannot both be that stand, and passing both on would abort the
  // import partway through and leave the event half-filled.
  const byNumber = new Map();
  const repeated = [];
  const dropped = [];
  for (const st of stands.splice(0)) {
    if (byNumber.has(st.number)) {
      const first = byNumber.get(st.number);
      repeated.push(`${st.number} (${first.printedArea ?? '?'} and ${st.printedArea ?? '?'})`);
      dropped.push(st);
      continue;
    }
    byNumber.set(st.number, st);
    stands.push(st);
  }
  if (dropped.length) {
    // Their names are still printed on the plan. If they are not taken out
    // they stay there for good, because no stand of ours will ever draw over
    // them — "Barentz" sat on the plan exactly this way.
    for (const d of dropped) if (d.exhibitor) printedNames.push(d.exhibitor);
  }
  if (repeated.length) {
    warnings.push(`${repeated.length} stand numbers are printed on two different shapes — ${repeated.join(', ')}. Only the first is kept; the artwork needs correcting before these stands can be sold.`);
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
      .map(s => (s.visual.w * s.visual.h) / s.printedArea)
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
      ? Math.round((s.visual.w * s.visual.h) / unitsPerArea)
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

  const fills = statusFromColour(stands, warnings);
  for (const st of stands) if (st.exhibitor) printedNames.push(st.exhibitor);

  return { stands, unit, unitsPerArea, fills, printedNames,
           rects: rects.length, texts: texts.length, warnings };
}



/**
 * Work out what each stand IS from the colour the plan drew it in.
 *
 * Nothing here is a hardcoded colour. Everything is relative to the plan:
 *
 *   available — the near-white group. A plan draws empty space pale; it is the
 *               one convention that holds across every floorplan seen so far,
 *               and it is what Europe uses too.
 *   held      — a stand outlined differently to every other stand. A designer
 *               changes a stroke and adds a glow to make something stand out,
 *               and a reserved stand is the thing worth standing out.
 *   sponsored — a dark fill used by only a handful of shapes. The ordinary
 *               sold colour is used dozens of times; a colour used three times
 *               is marking something particular, which on these plans is the
 *               lounges and conference tracks.
 *   sold      — everything else.
 *
 * The groups are returned alongside so the mapping is visible and can be
 * corrected, rather than being a silent guess buried in an import.
 */
function statusFromColour(stands, warnings) {
  const groups = new Map();
  for (const s of stands) {
    const key = `${s.fill || '?'}|${s.stroke || '?'}`;
    if (!groups.has(key)) {
      groups.set(key, { fill: s.fill, stroke: s.stroke, count: 0, stands: [] });
    }
    const g = groups.get(key);
    g.count++; g.stands.push(s);
  }

  const all = [...groups.values()];
  if (!all.length) return [];

  // The stroke nearly every stand shares. A stand that departs from it has
  // been marked deliberately.
  const strokeTally = new Map();
  for (const g of all) strokeTally.set(g.stroke, (strokeTally.get(g.stroke) || 0) + g.count);
  const commonStroke = [...strokeTally.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const biggest = all.reduce((a, b) => (b.count > a.count ? b : a));

  for (const g of all) {
    const light = lightness(g.fill);
    if (light !== null && light > 0.9) g.status = 'available';
    else if (g.stroke !== commonStroke) g.status = 'held';
    else g.status = 'sold';

    // A dark fill used by only a few shapes is marking something particular.
    g.sponsored = g.status === 'sold' && g !== biggest &&
                  g.count <= Math.max(6, stands.length * 0.1) &&
                  light !== null && light < 0.5;
  }

  for (const g of all) {
    for (const s of g.stands) { s.status = g.status; s.sponsored = g.sponsored; }
  }

  const unknown = all.filter(g => !g.fill);
  if (unknown.length) {
    warnings.push(`${unknown.reduce((n, g) => n + g.count, 0)} stands have no fill colour, so their status could not be read; they are treated as sold.`);
  }

  return all.map(g => ({
    fill: g.fill, stroke: g.stroke, count: g.count,
    status: g.status, sponsored: g.sponsored,
    example: (g.stands.find(s => s.exhibitor) || g.stands[0]).exhibitor || null,
  })).sort((a, b) => b.count - a.count);
}

/**
 * Remove the exhibitor names the artwork has printed inside its stands.
 *
 * Names belong in the database, not in the drawing. A name baked into the
 * artwork is wrong the moment a stand changes hands, and fixing it means
 * asking the designer for a new export — whereas a name we hold is searchable,
 * dims with the rest when the smart search filters, takes the contrast colour
 * a sponsor's fill needs, and is redrawn the instant sales change it.
 *
 * Only the names go. Stand numbers and printed areas stay exactly as drawn:
 * those are properties of the hall and do not change as stands are sold, and
 * the Europe plan shows its numbers the same way.
 *
 * `names` is the text runs the extractor attributed to stands, so nothing is
 * matched by guesswork — a room label like "ENTRANCE" or "Dining Area" that
 * sits outside every stand is never touched.
 */
function stripExhibitorNames(svg, names) {
  const wanted = new Set(names.filter(Boolean).map(n => n.trim()));
  if (!wanted.size) return { svg, removed: 0 };

  let removed = 0;
  const out = svg.replace(/<text([^>]*?)>([\s\S]*?)<\/text>/g, (whole, attrs, body) => {
    // Compare on the same flattened, repaired text the extractor read, so a
    // name split across tspans and re-encoded still matches.
    let flat = body;
    const spans = [...body.matchAll(/<tspan([^>]*)>([\s\S]*?)<\/tspan>/g)];
    if (spans.length) {
      let lastY = null;
      flat = spans.map(sp => {
        const y = (/\by="([-\d.]+)"/.exec(sp[1]) || [])[1] ?? null;
        const brk = lastY !== null && y !== null && y !== lastY ? ' ' : '';
        lastY = y;
        return brk + sp[2];
      }).join('');
    }
    flat = repairMojibake(flat.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
    if (!wanted.has(flat)) return whole;
    removed++;
    return '';
  });
  return { svg: out, removed };
}


/**
 * The colours this plan uses for each state, ready to paint the app in.
 *
 * Taken straight from the groups the fills were read into, so the app shows a
 * stand in the colour the designer drew it in rather than repainting the whole
 * hall in another event's palette.
 */
function paletteOf(fills) {
  const pick = (test) => {
    const g = fills.filter(test).sort((a, b) => b.count - a.count)[0];
    return g ? g.fill : null;
  };
  return {
    available: pick(f => f.status === 'available'),
    sold: pick(f => f.status === 'sold' && !f.sponsored),
    sponsored: pick(f => f.sponsored),
  };
}

module.exports = { extractStands, paletteOf, readRects, readTexts, repairMojibake, stripExhibitorNames };
