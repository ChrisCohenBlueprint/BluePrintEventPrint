/**
 * Minimal SVG path bounding-box parser.
 *
 * The floorplan's text is converted to outlines, so every printed number is a
 * cluster of <path> glyphs rather than a <text> node. To locate a label we need
 * each glyph's real bounding box.
 *
 * The export uses an absolute M followed by relative h/v/c/l/s, so reading the
 * raw numbers out of the d attribute gives nonsense — the deltas have to be
 * accumulated. Curve control points are ignored; the pen positions bound a glyph
 * closely enough to cluster on.
 */

const TOKEN = /([MmZzLlHhVvCcSsQqTtAa])|([-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?)/g;

const ARITY = {
  M: 2, m: 2, L: 2, l: 2, H: 1, h: 1, V: 1, v: 1,
  C: 6, c: 6, S: 4, s: 4, Q: 4, q: 4, T: 2, t: 2, A: 7, a: 7,
};

function pathBBox(d) {
  const toks = [];
  let m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(d)) !== null) toks.push(m[1] || m[2]);

  let x = 0, y = 0, sx = 0, sy = 0, cmd = null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const mark = () => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };

  for (let i = 0; i < toks.length;) {
    const t = toks[i];
    if (/^[A-Za-z]$/.test(t)) {
      cmd = t; i++;
      if (cmd === 'Z' || cmd === 'z') { x = sx; y = sy; mark(); }
      continue;
    }
    const need = ARITY[cmd] ?? 2;
    const v = [];
    while (i < toks.length && !/^[A-Za-z]$/.test(toks[i]) && v.length < need) v.push(parseFloat(toks[i++]));
    if (v.length < need) break;

    switch (cmd) {
      case 'M': x = v[0]; y = v[1]; sx = x; sy = y; cmd = 'L'; break;
      case 'm': x += v[0]; y += v[1]; sx = x; sy = y; cmd = 'l'; break;
      case 'L': x = v[0]; y = v[1]; break;
      case 'l': x += v[0]; y += v[1]; break;
      case 'H': x = v[0]; break;
      case 'h': x += v[0]; break;
      case 'V': y = v[0]; break;
      case 'v': y += v[0]; break;
      case 'C': x = v[4]; y = v[5]; break;
      case 'c': x += v[4]; y += v[5]; break;
      case 'S': case 'Q': x = v[2]; y = v[3]; break;
      case 's': case 'q': x += v[2]; y += v[3]; break;
      case 'T': x = v[0]; y = v[1]; break;
      case 't': x += v[0]; y += v[1]; break;
      case 'A': x = v[5]; y = v[6]; break;
      case 'a': x += v[5]; y += v[6]; break;
      default: break;
    }
    mark();
  }

  if (minX === Infinity) return null;
  return { x0: minX, y0: minY, x1: maxX, y1: maxY, w: maxX - minX, h: maxY - minY,
           cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

/** Every glyph-sized path in the document. */
function glyphBoxes(svg, { minH = 3, maxH = 12, maxW = 14 } = {}) {
  const out = [];
  const re = /<path\b[^>]*\sd="([^"]+)"/g;
  let m;
  while ((m = re.exec(svg)) !== null) {
    const b = pathBBox(m[1]);
    if (b && b.h >= minH && b.h <= maxH && b.w <= maxW) out.push(b);
  }
  return out;
}

/** Group glyphs sitting on a shared baseline into label runs. */
function clusterLabels(glyphs, { yTol = 4, xGap = 6 } = {}) {
  if (!glyphs.length) return [];
  const sorted = glyphs.slice().sort((a, b) =>
    Math.round(a.cy / 4) - Math.round(b.cy / 4) || a.cx - b.cx);

  const groups = [];
  let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i], prev = cur[cur.length - 1];
    if (Math.abs(p.cy - prev.cy) < yTol && (p.x0 - prev.x1) < xGap) cur.push(p);
    else { groups.push(cur); cur = [p]; }
  }
  groups.push(cur);
  return groups.map(g => ({
    glyphs: g,
    x0: Math.min(...g.map(p => p.x0)), x1: Math.max(...g.map(p => p.x1)),
    y0: Math.min(...g.map(p => p.y0)), y1: Math.max(...g.map(p => p.y1)),
  }));
}

/** All <rect> elements with class and geometry. */
function rects(svg) {
  const out = [];
  const re = /<rect\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(svg)) !== null) {
    const a = m[1];
    const cls = /class="([^"]+)"/.exec(a);
    const num = (k) => {
      const r = new RegExp(`\\b${k}="([-\\d.]+)"`).exec(a);
      return r ? parseFloat(r[1]) : null;
    };
    const x = num('x'), y = num('y'), w = num('width'), h = num('height');
    if ([x, y, w, h].some(v => v === null)) continue;
    out.push({ cls: cls ? cls[1] : null, x, y, w, h });
  }
  return out;
}

module.exports = { pathBBox, glyphBoxes, clusterLabels, rects };
