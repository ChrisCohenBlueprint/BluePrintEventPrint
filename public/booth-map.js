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
  var ARTWORK_SELECTOR = '.cls-13, .cls-11, .cls-14, .cls-8, .cls-9';

  function centre(g) { return { x: g.x + g.w / 2, y: g.y + g.h / 2 }; }

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
      if (!g || typeof g.x !== 'number') { unplaced.push(b); return; }
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

      // Otherwise this booth is part of a block the artwork draws as one shape.
      // Insert a transparent hit area over just its share of that shape.
      var overlay = document.createElementNS(SVG_NS, 'rect');
      overlay.setAttribute('x', g.x);
      overlay.setAttribute('y', g.y);
      overlay.setAttribute('width', g.w);
      overlay.setAttribute('height', g.h);
      overlay.setAttribute('data-booth', b.boothNumber);
      overlay.setAttribute('data-overlay', '1');
      overlay.setAttribute('fill', 'transparent');

      // Is this cell part of a split stand — either a secondary (has splitFrom)
      // or the primary the secondaries point back at?
      var isPrimarySplit = Object.prototype.hasOwnProperty.call(splitAxisByPrimary, b.boothNumber);
      var isSplitCell = !!b.splitFrom || isPrimarySplit;
      var splitAxis = b.splitAxis || splitAxisByPrimary[b.boothNumber] || 'vertical';

      var host = hostIdx > -1 ? artwork[hostIdx] : null;
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

        var num = makeText(x1 + 5, y1 + 14, b.boothNumber);
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
    var minFont = opts.minFont || 6;
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

    // Flow the words into lines at a given font size.
    function layout(fs) {
      var lines = [], line = '';
      for (var w = 0; w < words.length; w++) {
        var word = words[w];
        if (widthOf(word, fs) > maxW) {          // too wide even alone → hyphenate
          if (line) { lines.push(line); line = ''; }
          var pieces = breakWord(word, fs);
          for (var p = 0; p < pieces.length - 1; p++) lines.push(pieces[p]);
          line = pieces[pieces.length - 1];
          continue;
        }
        var test = line ? line + ' ' + word : word;
        if (line && widthOf(test, fs) > maxW) { lines.push(line); line = word; }
        else line = test;
      }
      if (line) lines.push(line);
      return lines;
    }

    // Largest font from max→min whose wrapped block fits the height; if none
    // fits we keep the minimum (still every character, just tighter).
    var chosen = null, chosenFont = minFont;
    for (var fs = maxFont; fs >= minFont; fs -= 0.5) {
      var lines = layout(fs);
      if (lines.length * fs * lineRatio <= maxH) { chosen = lines; chosenFont = fs; break; }
      chosen = lines; chosenFont = fs;             // remember the smallest tried
    }

    textEl.parentNode.removeChild(meas);
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

  global.BoothMap = { attach: attach, rectGeom: rectGeom, fitLabel: fitLabel };
})(window);
