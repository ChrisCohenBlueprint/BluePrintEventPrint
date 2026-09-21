/**
 * Read the stands out of a floorplan SVG that meets specification BEC-FP-01.
 *
 * This is the payoff for the spec. When a plan arrives with LIVE TEXT, every
 * stand can be read exactly: the number is text, the area is text, and the
 * shape is a rect. Nothing is guessed, so there is no OCR here and no digit
 * map to bootstrap — those exist in the Europe rescue only because that
 * artwork arrived with its text flattened to outlines, and that is a rescue,
 * not the design.
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
 *
 * It also has to hold for the next DRAWING TOOL. Illustrator, Inkscape, Figma
 * and a hand-edited file each write the same plan differently — quoting
 * attributes either way, positioning text by x/y rather than a transform,
 * rotating with matrix() instead of rotate(90), nesting everything inside
 * transformed groups, and colouring by attribute rather than by CSS class.
 * Reading only Illustrator's dialect did not fail loudly; it silently lost
 * stands, mispositioned rounded ones, imported every stand as sold, and told
 * the organiser their designer had converted the text to outlines when the
 * text was right there. Everything below is deliberately dialect-agnostic.
 */

// ─── Transforms ───────────────────────────────────────────────────────────────
// A 2×3 affine matrix [a b c d e f], as SVG writes it. Everything a plan can do
// to place a shape — translate, scale, rotate by any angle, an explicit
// matrix(), and the same again on every enclosing <g> — composes into one of
// these, so the reader never has to special-case a drawing tool's favourite
// spelling. (Only rotate(90) written one exact way used to be handled, so a
// plan that rotated with matrix() or grouped its stands placed every shape in
// the wrong coordinate space, where no label could ever be matched to it.)
const IDENTITY = [1, 0, 0, 1, 0, 0];

const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

const applyPoint = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

const isIdentity = (m) => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;

/** Parse an SVG transform list into a single matrix. Unknown functions are skipped. */
function parseTransform(str) {
  let m = IDENTITY;
  if (!str) return m;
  for (const t of String(str).matchAll(/([a-zA-Z]+)\s*\(([^)]*)\)/g)) {
    const n = t[2].split(/[\s,]+/).map(parseFloat).filter(v => Number.isFinite(v));
    const rad = (d) => (d * Math.PI) / 180;
    switch (t[1].toLowerCase()) {
      case 'translate': m = mul(m, [1, 0, 0, 1, n[0] || 0, n[1] || 0]); break;
      case 'scale':     m = mul(m, [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0]); break;
      case 'matrix':    if (n.length === 6) m = mul(m, n); break;
      case 'rotate': {
        const a = rad(n[0] || 0), c = Math.cos(a), s = Math.sin(a);
        // rotate(angle cx cy) is a rotation about a point, which is three
        // operations. Written out, because a plan that uses it and a plan that
        // writes the equivalent translate/rotate/translate must read the same.
        if (n.length >= 3) m = mul(m, [1, 0, 0, 1, n[1], n[2]]);
        m = mul(m, [c, s, -s, c, 0, 0]);
        if (n.length >= 3) m = mul(m, [1, 0, 0, 1, -n[1], -n[2]]);
        break;
      }
      default: break;   // skewX/skewY: no plan places a stand with one
    }
  }
  return m;
}

/** The axis-aligned box a transformed rectangle occupies. */
function transformRect(m, r) {
  if (isIdentity(m)) return { x: r.x, y: r.y, w: r.w, h: r.h };
  const pts = [
    applyPoint(m, r.x, r.y), applyPoint(m, r.x + r.w, r.y),
    applyPoint(m, r.x, r.y + r.h), applyPoint(m, r.x + r.w, r.y + r.h),
  ];
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys),
           w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

// ─── Attributes ───────────────────────────────────────────────────────────────
/**
 * One attribute off an element's attribute string.
 *
 * The leading boundary is not a nicety. Without it `x=` matches inside `rx=`,
 * so every rounded rectangle on a plan took its CORNER RADIUS as its position
 * and landed at the top-left of the drawing, where no label could reach it.
 * Both quoting styles are accepted because only one drawing tool in three
 * writes double quotes.
 */
function attr(attrs, name) {
  const re = new RegExp(`(?:^|[\\s;])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = re.exec(attrs || '');
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[2];
}

const numAttr = (attrs, name) => {
  const v = attr(attrs, name);
  if (v == null) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The fill and stroke an element states on ITSELF, by inline style and by
 * presentation attribute, kept apart.
 *
 * Read at all because a plan that colours its stands with `fill="#fffcf8"` or
 * `style="fill:#fffcf8"` — which is what Inkscape, Figma and a hand-edited file
 * all produce — yielded a null fill through the CSS-class-only reader. Every
 * such stand then fell through to "everything else", and the whole plan
 * imported as SOLD.
 *
 * Kept apart because CSS cascade order decides which wins: an inline style beats
 * a class, and a class beats a presentation attribute. Collapsing the two would
 * let a leftover `fill="none"` override the class that actually paints a stand.
 */
function ownPaint(attrs) {
  const style = attr(attrs, 'style') || '';
  const fromStyle = (prop) => {
    const m = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`, 'i').exec(style);
    return m ? m[1].trim().toLowerCase() : null;
  };
  const plain = (name) => {
    const v = attr(attrs, name);
    return v ? v.trim().toLowerCase() : null;
  };
  return { styleFill: fromStyle('fill'), styleStroke: fromStyle('stroke'),
           attrFill: plain('fill'), attrStroke: plain('stroke') };
}

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
  const map = {};
  for (const style of svg.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
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
  }
  return map;
}

// A handful of colour keywords a plan realistically uses for empty space. Only
// these are resolved: the point is to recognise "this stand is drawn white",
// not to ship a CSS colour table.
const NAMED = { white: '#ffffff', black: '#000000', none: null, transparent: null };

/** How light a colour is, 0 (black) to 1 (white). */
function lightness(colour) {
  if (!colour) return null;
  const c = String(colour).trim().toLowerCase();
  if (c in NAMED) { if (!NAMED[c]) return null; return lightness(NAMED[c]); }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(c);
  let r, g, b;
  if (rgb) {
    [r, g, b] = rgb.slice(1, 4).map(v => parseFloat(v) / 255);
  } else {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = h.split('').map(ch => ch + ch).join('');
    [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
  }
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// ─── Walking the document ─────────────────────────────────────────────────────
/**
 * Rects and text runs, each with the transform of every group it sits inside
 * already applied.
 *
 * One pass rather than two independent regex sweeps, because a group's
 * transform belongs to whatever is inside it and that can only be known by
 * walking the file in order. Exports commonly wrap the whole plan in one
 * translated <g>; read without it, every shape sits a few hundred units away
 * from its own label and the plan reads as empty.
 */
const WALK = /<g\b([^>]*?)(\/?)>|<\/g\s*>|<rect\b([^>]*?)\/?>|<text\b([^>]*?)>([\s\S]*?)<\/text\s*>/g;

function readShapes(svg) {
  const rects = [];
  const texts = [];
  const stack = [IDENTITY];
  const here = () => stack[stack.length - 1];

  for (const m of svg.matchAll(WALK)) {
    if (m[0][1] === '/') { if (stack.length > 1) stack.pop(); continue; }      // </g>

    if (m[0].startsWith('<g')) {
      const t = parseTransform(attr(m[1], 'transform'));
      // A self-closing <g/> opens nothing, so it must not push a level the
      // matching </g> that never comes would have to pop.
      if (m[2] !== '/') stack.push(mul(here(), t));
      continue;
    }

    if (m[0].startsWith('<rect')) {
      const a = m[3];
      const x = numAttr(a, 'x'), y = numAttr(a, 'y');
      const w = numAttr(a, 'width'), h = numAttr(a, 'height');
      if (x == null || y == null || !w || !h) continue;
      // As authored. This is what the page reports for the element when it
      // binds a stand to its shape — it reads the x/y/width/height attributes
      // and does NOT apply the element's own transform — so it is what must be
      // stored.
      const raw = { x, y, w, h };
      // Where the shape actually appears, which is the space the text labels
      // are positioned in and the only space they can be matched in.
      const vis = transformRect(mul(here(), parseTransform(attr(a, 'transform'))), raw);
      rects.push({ cls: attr(a, 'class') || '', ...vis, raw, paint: ownPaint(a) });
      continue;
    }

    // <text>
    const attrs = m[4], body = m[5];
    const own = parseTransform(attr(attrs, 'transform'));
    const matrix = mul(here(), own);
    // Where the run starts. A transform-positioned run (Illustrator) puts the
    // origin in the transform; an x/y-positioned run (Inkscape, Figma, anything
    // hand-edited) puts it in the attributes, on the <text> or on its first
    // <tspan>. Reading only the first spelling skipped every label in the
    // second, and the organiser was then told their plan had been converted to
    // outlines — which blamed the designer for text that was right there.
    const firstSpan = /<tspan\b([^>]*)>/.exec(body);
    const ax = numAttr(attrs, 'x') ?? (firstSpan ? numAttr(firstSpan[1], 'x') : null);
    const ay = numAttr(attrs, 'y') ?? (firstSpan ? numAttr(firstSpan[1], 'y') : null);
    // No position anywhere and no transform = nothing that can be placed on the
    // plan. Dropped rather than parked at the origin, where it would attach
    // itself to whichever stand happens to be drawn there.
    if (ax == null && ay == null && isIdentity(matrix)) continue;
    const p = applyPoint(matrix, ax || 0, ay || 0);

    const text = flattenText(body);
    if (!text) continue;
    texts.push({ cls: attr(attrs, 'class') || '', x: p.x, y: p.y, text,
                 transform: attr(attrs, 'transform') || '' });
  }

  return { rects, texts };
}

/**
 * XML entities, decoded.
 *
 * Left encoded, "Barentz &amp; Co" is stored as the exhibitor's name and then
 * drawn, searched and put in front of a client exactly like that.
 */
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, n) =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[n]);
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

/**
 * The readable string a <text> element's body amounts to.
 *
 * Shared with stripExhibitorNames so a name matched here is matched there:
 * the two comparing differently is how a name stayed printed on the plan.
 */
function flattenText(body) {
  // Multi-line labels are tspans on different baselines. Joining them
  // blind gives "NetworkingLounge", so a change of baseline becomes a space.
  let out = body;
  const spans = [...body.matchAll(/<tspan([^>]*)>([\s\S]*?)<\/tspan>/g)];
  if (spans.length) {
    let lastY = null;
    out = spans.map(sp => {
      const y = attr(sp[1], 'y');
      const brk = lastY !== null && y !== null && y !== lastY ? ' ' : '';
      lastY = y;
      return brk + sp[2];
    }).join('');
  }
  return repairMojibake(decodeEntities(out.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim());
}

/** Rectangles, in the space they actually appear in. */
const readRects = (svg) => readShapes(svg).rects;

/**
 * The runs that can carry a label.
 *
 * The "\u00b2" of an area label is drawn as a separate, scaled text run. It is
 * tempting to skip everything carrying a scale(), but scale() is also how some
 * exporters size ordinary display text — a plan's own "Floorplan Sponsor" title
 * is scaled — so the test is the shape of the content: a lone digit, set
 * smaller. A real label is never that.
 */
const labelRuns = (texts) => texts.filter(t => !(/scale\(/.test(t.transform) && /^\d$/.test(t.text)));

/** Text runs, flattened across tspans and placed however the plan placed them. */
const readTexts = (svg) => labelRuns(readShapes(svg).texts);

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
  const { rects, texts: allTexts } = readShapes(svg);
  const texts = labelRuns(allTexts);
  const warnings = [];

  const numbers = texts.filter(t => NUMBER.test(t.text));
  const areas = texts.filter(t => AREA.test(t.text));
  const others = texts.filter(t => !NUMBER.test(t.text) && !AREA.test(t.text));

  if (!numbers.length) {
    // Say what was actually seen. The old message asserted the text had been
    // converted to outlines whatever the reason, which on a plan whose text was
    // simply positioned by x/y put the blame on the designer for artwork that
    // was correct — and sent the organiser back to them for a file they already
    // had.
    const why = !allTexts.length
      ? 'No live text of any kind was found — the text has probably been converted to outlines.'
      : `${allTexts.length} text runs were found, but none of them reads as a stand number ` +
        `(expected something like 142, 1249 or P014).`;
    return { stands: [], unit: null, unitsPerArea: null, fills: [], printedNames: [],
             rects: rects.length, texts: allTexts.length, warnings: [why] };
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

  // Cascade order: an inline style beats the plan's own CSS class, which beats a
  // presentation attribute. All three are read, because which one a plan uses
  // is a property of the tool that drew it and nothing else.
  const paintOf = (r) => {
    const cls = palette[r.cls] || {};
    return { fill:   r.paint.styleFill   || cls.fill   || r.paint.attrFill   || null,
             stroke: r.paint.styleStroke || cls.stroke || r.paint.attrStroke || null };
  };

  const stands = [];
  const claimed = new Set();
  for (const [r, n] of standOf) {
    claimed.add(n);
    const a = areaFor.get(r);
    const name = nameFor.get(r);
    const paint = paintOf(r);
    stands.push({
      number: n.text,
      printedArea: a ? parseInt(AREA.exec(a.text)[1].replace(/,/g, ''), 10) : null,
      geometry: { x: +r.raw.x.toFixed(2), y: +r.raw.y.toFixed(2),
                  w: +r.raw.w.toFixed(2), h: +r.raw.h.toFixed(2) },
      visual: { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.w.toFixed(2), h: +r.h.toFixed(2) },
      exhibitor: name ? name.text : null,
      fillClass: r.cls,
      fill: paint.fill,
      stroke: paint.stroke,
      // Carried onto the stand so the IMPORT can refuse a plan whose colours it
      // could not read, rather than the reader deciding that on its own — a
      // preview must still show what it found.
      fillUnknown: !paint.fill,
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
           unreadableFills: stands.filter(s => s.fillUnknown).length,
           rects: rects.length, texts: allTexts.length, warnings };
}



/**
 * Work out what each stand IS from the colour the plan drew it in.
 *
 * Nothing here is a hardcoded colour. Everything is relative to the plan:
 *
 *   available — the near-white group, AND anything whose colour could not be
 *               read at all. A plan draws empty space pale; it is the one
 *               convention that holds across every floorplan seen so far, and
 *               it is what Europe uses too.
 *   held      — a stand outlined differently to every other stand. A designer
 *               changes a stroke and adds a glow to make something stand out,
 *               and a reserved stand is the thing worth standing out.
 *   sponsored — a dark fill used by only a handful of shapes. The ordinary
 *               sold colour is used dozens of times; a colour used three times
 *               is marking something particular, which on these plans is the
 *               lounges and conference tracks.
 *   sold      — everything else.
 *
 * An unreadable colour defaults to AVAILABLE, not sold. The two failures are
 * not symmetrical: a stand wrongly available is offered to a buyer and
 * corrected in a click, while a stand wrongly sold is invisible to sales and
 * stays unsold all show. A plan whose colours could not be read at all used to
 * import every stand as sold, which is the second failure 260 times over —
 * the import refuses outright on that now (see booths.importFromArtwork).
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
    if (!g.fill) g.status = 'available';                        // unreadable — see the header
    else if (light !== null && light > 0.9) g.status = 'available';
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
    const n = unknown.reduce((acc, g) => acc + g.count, 0);
    warnings.push(`${n} stands have no fill colour this reader can see, so their status could not be read from the plan; they are treated as available. Check the plan's colours before selling from it.`);
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
    // Compare on the same flattened, decoded, repaired text the extractor read,
    // so a name split across tspans, entity-encoded or re-encoded still matches.
    if (!wanted.has(flattenText(body))) return whole;
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
    // A group with no fill has no colour to offer — it is the reader failing to
    // read one, and painting the app in `null` would blank the plan.
    const g = (fills || []).filter(f => f.fill).filter(test).sort((a, b) => b.count - a.count)[0];
    return g ? g.fill : null;
  };
  return {
    available: pick(f => f.status === 'available'),
    sold: pick(f => f.status === 'sold' && !f.sponsored),
    sponsored: pick(f => f.sponsored),
  };
}

module.exports = { extractStands, paletteOf, readRects, readTexts, readShapes,
                   repairMojibake, decodeEntities, stripExhibitorNames, parseTransform };
