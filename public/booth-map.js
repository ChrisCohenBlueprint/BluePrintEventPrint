/**
 * Maps the artwork in the floorplan SVG onto the booths the server knows about.
 *
 * Shared by the public floorplan and the admin dashboard. Both pages used to
 * walk the SVG independently and assign numbers by document order, which meant
 * their numbering silently disagreed with the server's the moment either
 * changed — and it had already diverged for most stands.
 *
 * Identity now comes from geometry: each server booth carries the position and
 * size it was extracted from, so a rectangle is matched to a booth by where it
 * sits rather than by when it appears in the file. Re-ordering, re-exporting or
 * renumbering the plan cannot break the mapping.
 *
 * One artwork rectangle can back several booths — the SVG draws some adjacent
 * stands as a single block. Those get transparent overlay rectangles inserted
 * directly after the artwork, so printed numbers drawn later in the document
 * still render above them.
 */
(function (global) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  // Sellable booth rects. LEX27 draws stands as .cls-10 (white) / .cls-7
  // (yellow); the older classes are kept so a previous plan still maps.
  var ARTWORK_SELECTOR = '.cls-10, .cls-7, .cls-13, .cls-11, .cls-14, .cls-9';

  function centre(g) { return { x: g.x + g.w / 2, y: g.y + g.h / 2 }; }

  // The element's VISUAL (post-transform) axis-aligned box, in the coordinate
  // space of its parent. getBBox() alone returns the LOCAL box (before the
  // element's own transform), so on the many rotated LEX27 stands it reports the
  // wrong position and swapped width/height — which mis-places and mis-fits the
  // exhibitor label. This applies the element's transform to the local box.
  function visualBox(el) {
    var b;
    try { b = el.getBBox(); } catch (e) { return null; }
    var list = el.transform && el.transform.baseVal;
    var m = (list && list.numberOfItems) ? list.consolidate() : null;
    if (!m) return { x: b.x, y: b.y, w: b.width, h: b.height };   // no transform
    m = m.matrix;
    var xs = [], ys = [], X = [b.x, b.x + b.width], Y = [b.y, b.y + b.height];
    for (var i = 0; i < 2; i++) for (var j = 0; j < 2; j++) {
      xs.push(m.a * X[i] + m.c * Y[j] + m.e);
      ys.push(m.b * X[i] + m.d * Y[j] + m.f);
    }
    var minx = Math.min.apply(null, xs), miny = Math.min.apply(null, ys);
    return { x: minx, y: miny, w: Math.max.apply(null, xs) - minx, h: Math.max.apply(null, ys) - miny };
  }

  function rectGeom(el) {
    var x = parseFloat(el.getAttribute('x'));
    var y = parseFloat(el.getAttribute('y'));
    var w = parseFloat(el.getAttribute('width'));
    var h = parseFloat(el.getAttribute('height'));
    if ([x, y, w, h].some(isNaN)) {
      try {
        var b = el.getBBox();
        return { x: b.x, y: b.y, w: b.width, h: b.height };
      } catch (e) { return null; }
    }
    return { x: x, y: y, w: w, h: h };
  }

  function sameGeom(a, b, tol) {
    tol = tol || 2;
    return Math.abs(a.x - b.x) < tol && Math.abs(a.y - b.y) < tol &&
           Math.abs(a.w - b.w) < tol && Math.abs(a.h - b.h) < tol;
  }

  function contains(outer, pt, pad) {
    pad = pad || 1;
    return pt.x >= outer.x - pad && pt.x <= outer.x + outer.w + pad &&
           pt.y >= outer.y - pad && pt.y <= outer.y + outer.h + pad;
  }

  /**
   * Attach every booth to the SVG, returning the count actually placed.
   *
   * @param svgDoc  the inlined <svg> element
   * @param booths  array of server booths, each with { boothNumber, geometry }
   * @param opts    { onTag(el, boothNumber) } called once per clickable element
   */
  function attach(svgDoc, booths, opts) {
    opts = opts || {};
    var placed = {};
    var unplaced = [];

    var artwork = Array.prototype.slice.call(svgDoc.querySelectorAll(ARTWORK_SELECTOR));
    var geoms = artwork.map(rectGeom);
    // Largest legitimate stand dimension, used to reject absurdly-large geometry
    // that has no artwork cell to clamp against.
    var MAX_DIM = 0;
    geoms.forEach(function (g) { if (g) MAX_DIM = Math.max(MAX_DIM, g.w, g.h); });
    MAX_DIM = MAX_DIM || 1000;

    // Work out the split groups up front. A split stand becomes several cells:
    // the secondary cells each carry splitFrom (their parent's number) + axis,
    // but the PRIMARY cell keeps the original number and — because the split
    // only tagged the new cells — has no split marker of its own. So a stand
    // that was split shows one outlined half (the secondaries) and one bare
    // half (the primary, leaning on the artwork's original box). Derive the
    // group from the secondaries: any number a secondary points at is itself a
    // split cell and must be outlined too. Doing it here also fixes stands that
    // were split before this logic existed, with no data migration.
    var splitAxisByPrimary = {};
    booths.forEach(function (b) {
      if (b.splitFrom) splitAxisByPrimary[b.splitFrom] = b.splitAxis || 'vertical';
    });

    booths.forEach(function (b) {
      var g = b.geometry;
      // Reject missing or non-positive geometry: a zero/negative rect renders
      // nothing and takes no clicks, yet would otherwise count as "placed" and
      // hide a real problem behind the all-clear.
      if (!g || typeof g.x !== 'number' || !(g.w > 0) || !(g.h > 0)) { unplaced.push(b); return; }
      var c = centre(g);

      // Prefer an artwork rectangle of the same size and place — that booth can
      // use the artwork itself, leaving printed text untouched above it.
      var exactIdx = -1, hostIdx = -1;
      for (var i = 0; i < artwork.length; i++) {
        var ag = geoms[i];
        if (!ag) continue;
        if (exactIdx === -1 && sameGeom(ag, g)) { exactIdx = i; }
        if (hostIdx === -1 && contains(ag, c)) { hostIdx = i; }
      }

      if (exactIdx > -1 && !artwork[exactIdx].hasAttribute('data-booth')) {
        var el = artwork[exactIdx];
        el.setAttribute('data-booth', b.boothNumber);
        placed[b.boothNumber] = el;
        if (opts.onTag) opts.onTag(el, b.boothNumber, b);
        return;
      }
      // Two booths claiming the exact same rectangle (a data duplicate): the
      // first won it above; warn so the overlap is diagnosable rather than a
      // silently unclickable stand.
      if (exactIdx > -1 && global.console) {
        console.warn('BoothMap: stand ' + b.boothNumber + ' overlaps an already-placed stand at the same geometry');
      }

      // Otherwise this booth is part of a block the artwork draws as one shape.
      // Insert a transparent hit area over just its share of that shape.
      var host = hostIdx > -1 ? artwork[hostIdx] : null;
      // Clamp a ballooned rect to the artwork cell it sits in, so corrupt
      // oversized geometry can't paint a giant opaque, click-swallowing block
      // over its neighbours. (The server now prevents ballooning, but the
      // client must not render corruption if it ever arrives.) A legitimate
      // split cell is a fraction of its host, so it is never clamped.
      var ox = g.x, oy = g.y, ow = g.w, oh = g.h;
      if (host) {
        var hb = geoms[hostIdx];
        if (ow > hb.w * 1.5 || oh > hb.h * 1.5) {
          ox = hb.x; oy = hb.y; ow = hb.w; oh = hb.h;
          if (global.console) console.warn('BoothMap: stand ' + b.boothNumber + ' has oversized geometry — clamped to its artwork cell');
        }
      } else if (ow > MAX_DIM * 1.5 || oh > MAX_DIM * 1.5) {
        // Absurdly large and no cell to clamp against — refuse to paint a giant
        // opaque, click-swallowing block. Surfaces in the unplaced warning.
        if (global.console) console.warn('BoothMap: stand ' + b.boothNumber + ' has oversized geometry with no artwork cell — skipped');
        unplaced.push(b);
        return;
      }
      var overlay = document.createElementNS(SVG_NS, 'rect');
      overlay.setAttribute('x', ox);
      overlay.setAttribute('y', oy);
      overlay.setAttribute('width', ow);
      overlay.setAttribute('height', oh);
      overlay.setAttribute('data-booth', b.boothNumber);
      overlay.setAttribute('data-overlay', '1');
      overlay.setAttribute('fill', 'transparent');

      // Is this cell part of a split stand — either a secondary (has splitFrom)
      // or the primary the secondaries point back at?
      var isPrimarySplit = Object.prototype.hasOwnProperty.call(splitAxisByPrimary, b.boothNumber);
      var isSplitCell = !!b.splitFrom || isPrimarySplit;
      var splitAxis = b.splitAxis || splitAxisByPrimary[b.boothNumber] || 'vertical';
      // A split overlay doubles as the mask hiding the artwork's stale baked
      // number/size, so its fill must stay opaque even when shortlisted.
      if (isSplitCell && overlay.classList) overlay.classList.add('booth-split-cell');

      // Split cells go to the very end of the SVG, ABOVE the artwork's baked-in
      // number and size for the original (now-divided) stand. The overlay's own
      // status fill (white when available) then hides those stale figures — the
      // original "128 / 64 m²" that a horizontal divider would otherwise be
      // drawn straight through — and the clean per-cell number and size are
      // redrawn on top. Non-split overlays keep their old position (just after
      // the host) so a genuine printed number still shows through above them.
      if (isSplitCell) svgDoc.appendChild(overlay);
      else if (host && host.parentNode) host.parentNode.insertBefore(overlay, host.nextSibling);
      else svgDoc.appendChild(overlay);

      // Draw every split cell as a complete four-sided box, bounding the cell's
      // own geometry exactly.
      //
      // This box is drawn ON TOP of the white masking overlay, so it — not the
      // artwork's original stroke — is the outline the eye sees. It therefore
      // has to trace the white fill's edge exactly on all four sides. An earlier
      // version snapped the outer edges to the host artwork's bbox to avoid
      // doubling the artwork stroke; but when the stored geometry sat slightly
      // OUTSIDE that bbox, the snapped box came up short of the fill, leaving a
      // white edge with no line on it — the missing top/bottom on a horizontal
      // split. Bounding the cell geometry itself guarantees a stroke on every
      // visible side; the shared split line, drawn by both neighbours, doubles
      // to the weight of a normal stand border.
      if (isSplitCell) {
        var x1 = g.x, y1 = g.y, x2 = g.x + g.w, y2 = g.y + g.h;
        var box = document.createElementNS(SVG_NS, 'rect');
        box.setAttribute('x', x1);         box.setAttribute('y', y1);
        box.setAttribute('width',  Math.max(0, x2 - x1));
        box.setAttribute('height', Math.max(0, y2 - y1));
        box.setAttribute('fill', 'none');
        // The artwork strokes every stand at .75, but a normal border in the
        // plan is where TWO neighbouring stands' edges overlap — so it reads
        // heavier than a single .75 line. This divider is one line, so at .75
        // it looked thinner than everything around it. 1.1 matches the weight
        // of a real (doubled) stand border. Verified against the artwork at the
        // zoom the plan is actually viewed.
        box.setAttribute('stroke', '#000');
        box.setAttribute('stroke-width', '1.1');
        box.setAttribute('stroke-linejoin', 'miter');
        box.setAttribute('data-split-box', b.boothNumber);
        box.style.pointerEvents = 'none';
        overlay.parentNode.insertBefore(box, overlay.nextSibling);

        // Every split cell — primary and secondary alike — gets its own number
        // top-left and size bottom-right, matching the plan's convention. The
        // overlay above masked the stale baked figures, so these are the only
        // ones now visible, and they carry each cell's real (divided) values.
        var makeText = function (x, y, str, anchor) {
          var t = document.createElementNS(SVG_NS, 'text');
          t.setAttribute('x', x);
          t.setAttribute('y', y);
          if (anchor) t.setAttribute('text-anchor', anchor);
          t.setAttribute('fill', '#111827');
          t.setAttribute('font-family', 'Raleway, sans-serif');
          t.setAttribute('font-weight', '700');
          t.style.pointerEvents = 'none';
          t.textContent = str;
          return t;
        };

        var num = makeText(x1 + 5, y1 + 14, b.displayNumber || b.boothNumber);
        num.setAttribute('font-size', '12px');
        num.setAttribute('data-split-label', b.boothNumber);
        overlay.parentNode.insertBefore(num, overlay.nextSibling);

        if (b.sqm) {
          var size = makeText(x2 - 4, y2 - 5, b.sqm, 'end');
          size.setAttribute('font-size', '9px');
          size.setAttribute('data-split-size', b.boothNumber);
          overlay.parentNode.insertBefore(size, overlay.nextSibling);
        }
      }

      placed[b.boothNumber] = overlay;
      if (opts.onTag) opts.onTag(overlay, b.boothNumber, b);
    });

    // Artwork rectangles with no matching booth are hall furniture — catering,
    // toilets, logo boxes. Make sure they never look interactive.
    artwork.forEach(function (el) {
      if (!el.hasAttribute('data-booth')) el.style.pointerEvents = 'none';
    });

    return { placed: placed, count: Object.keys(placed).length, unplaced: unplaced };
  }

  /**
   * Paint an exhibitor name inside a stand so it always fits — never truncated.
   *
   * The rules, in the order a person would apply them:
   *   1. Wrap the name across lines at spaces (most names are 2–3 words and
   *      naturally sit on 2–3 lines).
   *   2. If a single word is still wider than the stand, break it with a
   *      hyphen onto the next line.
   *   3. Only if it still won't fit top-to-bottom, step the font down — down to
   *      a floor, past which we stop shrinking and let it be, but we do NOT cut
   *      any characters off.
   *
   * @param textEl an empty <text> element already in the SVG (so it can be
   *               measured); its tspans are (re)built here.
   * @param str    the exhibitor name.
   * @param box    { x, y, w, h } of the stand, in SVG user units.
   * @param opts   { maxFont, minFont, family, weight, pad }.
   */
  function fitLabel(textEl, str, box, opts) {
    opts = opts || {};
    var maxFont = opts.maxFont || 14;
    // Shrink as far as needed so the name always fits — visitors can zoom, and
    // text spilling outside a stand looks far worse than tiny-but-contained text.
    var minFont = opts.minFont || 0.5;
    var family  = opts.family  || 'Raleway, sans-serif';
    var weight  = opts.weight  || '700';
    var pad     = opts.pad != null ? opts.pad : 6;
    var lineRatio = 1.15;

    var maxW = Math.max(1, box.w - pad * 2);
    var maxH = Math.max(1, box.h - pad * 2);
    var words = String(str).trim().split(/\s+/).filter(Boolean);

    textEl.setAttribute('text-anchor', 'middle');
    textEl.setAttribute('font-family', family);
    textEl.setAttribute('font-weight', weight);
    textEl.removeAttribute('dominant-baseline');

    // Measure a candidate string at the element's current font size.
    var meas = document.createElementNS(SVG_NS, 'text');
    meas.setAttribute('font-family', family);
    meas.setAttribute('font-weight', weight);
    meas.style.visibility = 'hidden';
    meas.style.pointerEvents = 'none';
    textEl.parentNode.appendChild(meas);
    function widthOf(s, fs) {
      meas.setAttribute('font-size', fs);
      meas.textContent = s;
      return meas.getComputedTextLength();
    }

    // Break one over-long word into hyphenated chunks that each fit maxW.
    function breakWord(word, fs) {
      var pieces = [], cur = '';
      for (var i = 0; i < word.length; i++) {
        var next = cur + word[i];
        if (cur && widthOf(next + '-', fs) > maxW) { pieces.push(cur + '-'); cur = word[i]; }
        else cur = next;
      }
      if (cur) pieces.push(cur);
      return pieces;
    }

    // Flow the words into lines at a given font size. In hyphenate mode an
    // over-long word is chopped with a trailing "-"; otherwise it simply takes
    // its own line (and may overflow at this size — the caller then shrinks the
    // font until it fits, which keeps names whole instead of hyphenating them).
    function layout(fs, hyphenate) {
      var lines = [], line = '';
      for (var w = 0; w < words.length; w++) {
        var word = words[w];
        if (widthOf(word, fs) > maxW) {          // too wide even alone
          if (line) { lines.push(line); line = ''; }
          if (hyphenate) {
            var pieces = breakWord(word, fs);
            for (var p = 0; p < pieces.length - 1; p++) lines.push(pieces[p]);
            line = pieces[pieces.length - 1];
          } else {
            lines.push(word);                    // own line; search shrinks to fit
          }
          continue;
        }
        var test = line ? line + ' ' + word : word;
        if (line && widthOf(test, fs) > maxW) { lines.push(line); line = word; }
        else line = test;
      }
      if (line) lines.push(line);
      return lines;
    }

    // Does every line fit the width at this font size?
    function fitsWidth(lines, fs) {
      for (var i = 0; i < lines.length; i++) {
        if (widthOf(lines[i], fs) > maxW) return false;
      }
      return true;
    }

    // Keep the WHOLE name on tidy lines: prefer shrinking the font so each word
    // fits on its own line (wrapping only at spaces) over chopping words with
    // hyphens — "Kline" should shrink, not become "Klin-e". Take the largest
    // such font that also fits the height. Only if a name still can't fit the
    // width even at the minimum (a single word longer than the box) do we fall
    // back to hyphenating. Never truncate — tiny text is fine, visitors zoom.
    // The measurement node is removed in a finally so an exception mid-measure
    // can't leak hidden <text> nodes.
    var chosen = null, chosenFont = minFont;
    try {
      for (var fs = maxFont; fs >= minFont; fs -= 0.5) {
        var lines = layout(fs, false);             // space-only wrapping, no hyphens
        chosen = lines; chosenFont = fs;           // remember the smallest tried
        var tooTall = lines.length * fs * lineRatio > maxH;
        if (!tooTall && fitsWidth(lines, fs)) break;   // whole name fits cleanly
      }
      // Only an unbreakable word wider than the box at the min size lands here.
      if (chosen && !fitsWidth(chosen, chosenFont)) {
        chosen = layout(minFont, true); chosenFont = minFont;
      }
    } finally {
      if (meas.parentNode) meas.parentNode.removeChild(meas);
    }
    if (!chosen) chosen = [String(str)];

    // Render the lines, vertically centred in the box.
    while (textEl.firstChild) textEl.removeChild(textEl.firstChild);
    textEl.setAttribute('font-size', chosenFont);
    var cx = box.x + box.w / 2;
    var lineH = chosenFont * lineRatio;
    var blockH = chosen.length * lineH;
    var firstBaseline = box.y + box.h / 2 - blockH / 2 + chosenFont * 0.82;
    for (var i = 0; i < chosen.length; i++) {
      var tspan = document.createElementNS(SVG_NS, 'tspan');
      tspan.setAttribute('x', cx);
      tspan.setAttribute('y', firstBaseline + i * lineH);
      tspan.textContent = chosen[i];
      textEl.appendChild(tspan);
    }
  }

  /**
   * Remove everything attach() added, so it can be re-run cleanly after a
   * structural change (split/merge/reset) — otherwise the map only reflects
   * such changes after a full page reload, and stale overlays/handlers linger.
   */
  /**
   * Draw an image centred inside a stand's box, scaled to fit and with its
   * aspect ratio kept. Same contract as fitLabel: the caller owns the element,
   * this only sizes and positions it.
   *
   * The padding is proportional rather than fixed, so a logo sits comfortably
   * inside a 9 m² stand and a 200 m² one alike.
   */
  function fitImage(imgEl, href, box, opts) {
    opts = opts || {};

    // The artwork prints its own name across some boxes ("NETWORKING LOUNGE"),
    // and a logo dropped in the middle lands on top of it. When the caller has
    // worked out a clear band, draw into that instead of the whole box.
    var target = (opts.band && opts.band.h > 0) ? opts.band : box;

    var pad = opts.pad != null ? opts.pad : Math.max(1, Math.min(target.w, target.h) * 0.12);
    var x = target.x + pad, y = target.y + pad;
    var w = target.w - pad * 2, h = target.h - pad * 2;

    // Clamp to the box it belongs to, whatever the band arithmetic produced: a
    // logo must never be drawn outside its own stand or area.
    if (x < box.x) { w -= (box.x - x); x = box.x; }
    if (y < box.y) { h -= (box.y - y); y = box.y; }
    w = Math.max(1, Math.min(w, box.x + box.w - x));
    h = Math.max(1, Math.min(h, box.y + box.h - y));

    imgEl.setAttribute('x', x);
    imgEl.setAttribute('y', y);
    imgEl.setAttribute('width',  w);
    imgEl.setAttribute('height', h);
    // "meet" scales down to fit and never crops — a cropped logo is worse than
    // a small one.
    imgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    if (imgEl.getAttribute('href') !== href) {
      imgEl.setAttribute('href', href);
      // Some renderers (and the SVG-as-image path the PNG download uses) still
      // read the xlink form.
      imgEl.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', href);
    }
  }

  /**
   * Draw each plan area's sponsor logo onto the artwork.
   *
   * The areas — lounges, theatres, conference rooms — are not stands and are
   * never bound by attach(): their fills sit outside ARTWORK_SELECTOR on
   * purpose, so a stand can never land on one. They are found here the same way
   * a stand is, by matching the artwork rectangle to stored geometry rather
   * than trusting an element id that a re-export would renumber.
   *
   * Returns how many areas could not be found, so a caller can retry once the
   * plan is actually laid out instead of leaving a sponsor unbranded.
   */
  /**
   * The tallest horizontal band inside a box that the artwork has NOT printed
   * across — where a sponsor's logo can go without landing on the lettering.
   *
   * Unioning every glyph in the box does not work: these areas also carry a
   * stand number in one corner and an m² figure in another, so the union covers
   * the whole box and leaves nowhere. What matters is how much WIDTH is taken
   * at a given height — the printed name spans most of the box, a corner number
   * spans very little. So each row is called blocked only when the glyphs on it
   * cover a real share of the width, and the tallest run of unblocked rows wins.
   *
   * The plan converts its text to outlines, so there is nothing to read and
   * every glyph has to be measured — ~2000 bboxes. Cached per area: the artwork
   * does not move between repaints, so this is paid once for the life of the
   * page.
   */
  var bandCache = {};
  var ROWS = 64;            // ~1.5 units per row on the smallest area — fine enough
  var BLOCKED_WIDTH = 0.25; // a row is "printed on" once glyphs cover this much of it

  function freeBandIn(svgDoc, box, cacheKey) {
    if (Object.prototype.hasOwnProperty.call(bandCache, cacheKey)) return bandCache[cacheKey];

    var marks = [];
    var glyphs = svgDoc.querySelectorAll('path, polygon');
    for (var i = 0; i < glyphs.length; i++) {
      var b = visualBox(glyphs[i]);
      if (!b || !(b.w > 0) || !(b.h > 0)) continue;
      // Fully inside, with slack for stroke overshoot. Anything merely
      // overlapping belongs to a neighbour, not to this area.
      if (b.x < box.x - 1 || b.y < box.y - 1) continue;
      if (b.x + b.w > box.x + box.w + 1 || b.y + b.h > box.y + box.h + 1) continue;
      // Skip a shape filling most of the area: that is a backing panel, not
      // lettering, and counting it would block every row.
      if (b.w * b.h > box.w * box.h * 0.75) continue;
      marks.push(b);
    }

    var band = null;
    if (marks.length) {
      var rowH = box.h / ROWS;
      var blocked = [];
      for (var r = 0; r < ROWS; r++) {
        var y = box.y + (r + 0.5) * rowH;
        // Merge the spans covering this row, so overlapping glyphs are not
        // double-counted into a false "blocked".
        var spans = [];
        for (var m = 0; m < marks.length; m++) {
          var g = marks[m];
          if (y >= g.y && y <= g.y + g.h) spans.push([g.x, g.x + g.w]);
        }
        spans.sort(function (p, q) { return p[0] - q[0]; });
        var covered = 0, curS = null, curE = null;
        for (var k = 0; k < spans.length; k++) {
          if (curE === null || spans[k][0] > curE) {
            if (curE !== null) covered += curE - curS;
            curS = spans[k][0]; curE = spans[k][1];
          } else if (spans[k][1] > curE) curE = spans[k][1];
        }
        if (curE !== null) covered += curE - curS;
        blocked.push(covered > box.w * BLOCKED_WIDTH);
      }

      // Every unbroken run of clear rows.
      var runs = [], runStart = -1;
      for (var t = 0; t <= ROWS; t++) {
        var free = t < ROWS && !blocked[t];
        if (free && runStart === -1) runStart = t;
        if (!free && runStart !== -1) { runs.push([runStart, t - runStart]); runStart = -1; }
      }

      // A band too thin to show a logo in is no better than the collision, so
      // those are discarded and the caller falls back to the whole box.
      var minRows = Math.max(5, box.h * 0.16) / rowH;
      var usable = runs.filter(function (r) { return r[1] >= minRows; });

      // Of the usable bands, take the LOWEST: the sponsor's mark belongs under
      // the area's printed name, reading as "NETWORKING LOUNGE, brought to you
      // by —". Falling back to the tallest keeps a logo on a box whose only
      // clear space happens to be above the lettering.
      if (usable.length) {
        var pick = usable[usable.length - 1];
        band = { x: box.x, y: box.y + pick[0] * rowH, w: box.w, h: pick[1] * rowH };
      }
    }

    bandCache[cacheKey] = band;
    return band;
  }

  /** The artwork rectangle an area occupies, or null if the plan has moved. */
  function areaHost(svgDoc, area) {
    var candidates = svgDoc.querySelectorAll('.cls-6, .cls-8');
    for (var i = 0; i < candidates.length; i++) {
      var g = rectGeom(candidates[i]);
      if (g && sameGeom(g, area.geometry, 2)) return candidates[i];
    }
    return null;
  }

  function paintAreaLogos(svgDoc, areas, prefix) {
    if (!svgDoc || !areas) return 0;
    var missed = 0;

    // Only the two blue fills the areas use — a tight net, so a stand-shaped
    // rectangle of the same size elsewhere can never be mistaken for an area.
    var candidates = Array.prototype.slice.call(svgDoc.querySelectorAll('.cls-6, .cls-8'));

    areas.forEach(function (a) {
      var id = prefix + a.key;
      var node = svgDoc.querySelector('[id="' + id + '"]');

      // Find and tag the area's rectangle FIRST, whether or not it has a logo.
      // An area with no sponsor yet is the one most worth clicking — it is the
      // opportunity — so tagging only the branded ones left exactly the wrong
      // half of the plan inert.
      var host = null;
      for (var i = 0; i < candidates.length; i++) {
        var g = rectGeom(candidates[i]);
        if (g && sameGeom(g, a.geometry, 2)) { host = candidates[i]; break; }
      }
      if (!host) { missed++; return; }
      host.setAttribute('data-area', a.key);

      if (!a.logo) { if (node && node.parentNode) node.parentNode.removeChild(node); return; }

      var box = visualBox(host);
      if (!box || !(box.w > 0) || !(box.h > 0)) { missed++; return; }

      if (!node) {
        node = document.createElementNS(SVG_NS, 'image');
        node.setAttribute('id', id);
        node.style.pointerEvents = 'none';
        // Immediately after the area's own rectangle, NOT appended at the end:
        // the printed lettering is drawn later in the document, so this leaves
        // the logo beneath it. Even where the two touch, the name stays legible
        // on top rather than being covered by the logo.
        host.parentNode.insertBefore(node, host.nextSibling);
      }
      fitImage(node, a.logo, box, { band: freeBandIn(svgDoc, box, a.key) });
    });

    return missed;
  }

  function clear(svgDoc) {
    var added = '[data-overlay],[data-split-box],[data-split-label],[data-split-size]';
    Array.prototype.forEach.call(svgDoc.querySelectorAll(added), function (n) {
      if (n.parentNode) n.parentNode.removeChild(n);
    });
    // Painted company / exhibitor name nodes.
    Array.prototype.forEach.call(svgDoc.querySelectorAll('text'), function (t) {
      var id = t.getAttribute('id') || '';
      if ((id.indexOf('text-booth-') === 0 || id.indexOf('admin-text-') === 0) && t.parentNode) {
        t.parentNode.removeChild(t);
      }
    });
    // …and the sponsor logos drawn over them, for the same reason.
    Array.prototype.forEach.call(svgDoc.querySelectorAll('image'), function (im) {
      var id = im.getAttribute('id') || '';
      if ((id.indexOf('logo-booth-') === 0 || id.indexOf('admin-logo-') === 0) && im.parentNode) {
        im.parentNode.removeChild(im);
      }
    });
    // Artwork rects tagged directly (exact matches) carry data-booth AND
    // hover/click listeners; clone-replace strips the listeners and we reset the
    // state classes, so a re-attach starts from a clean slate with no doubles.
    Array.prototype.forEach.call(svgDoc.querySelectorAll('[data-booth]:not([data-overlay])'), function (el) {
      var fresh = el.cloneNode(true);
      fresh.removeAttribute('data-booth');
      ['booth-interactive', 'booth-available', 'booth-sold', 'booth-held', 'booth-selected', 'booth-shortlisted']
        .forEach(function (c) { fresh.classList.remove(c); });
      if (el.parentNode) el.parentNode.replaceChild(fresh, el);
    });
  }

  /**
   * A cheap fingerprint of everything attach() BAKES INTO THE SVG — each booth's
   * number, rounded geometry, shown number and size. If it differs between two
   * broadcasts the map must be re-tagged; if it matches, only statuses changed
   * and a lightweight repaint suffices.
   *
   * displayNumber and sqm are part of it because a split cell's number and size
   * are painted here, once, by attach(). Fingerprinting geometry alone meant an
   * admin renaming a split cell (Tools → Shown Number changes displayNumber and
   * nothing else) produced an identical signature, so no re-tag ran and the plan
   * kept showing the old number until someone reloaded the page.
   */
  function signature(booths) {
    return booths.filter(function (b) { return b && b.geometry; })
      .map(function (b) {
        var g = b.geometry;
        return b.boothNumber + ':' + Math.round(g.x) + ',' + Math.round(g.y) + ',' + Math.round(g.w) + ',' + Math.round(g.h) +
               ':' + (b.displayNumber || '') + ':' + (b.sqm || 0);
      })
      .sort().join('|');
  }

  global.BoothMap = { attach: attach, clear: clear, signature: signature, rectGeom: rectGeom, fitLabel: fitLabel, fitImage: fitImage, paintAreaLogos: paintAreaLogos, areaHost: areaHost, visualBox: visualBox };
})(window);
