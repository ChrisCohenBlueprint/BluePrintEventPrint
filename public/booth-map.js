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

      var host = hostIdx > -1 ? artwork[hostIdx] : null;
      if (host && host.parentNode) host.parentNode.insertBefore(overlay, host.nextSibling);
      else svgDoc.appendChild(overlay);

      // A stand created by splitting has no printed number of its own, so draw
      // the dividing line between it and its neighbour, plus its number in the
      // top-left (the convention the artwork uses for every other stand).
      //
      // Only the divider is drawn — NOT a full box. The artwork already draws
      // the outer boundary of the original stand, so stroking a whole rectangle
      // here doubles that outer edge and, because the stored geometry doesn't
      // sit exactly on the artwork's own stroke, the second rectangle pokes out
      // past it. A single internal line sits cleanly between the two cells.
      if (b.splitFrom) {
        // Draw the cell as a complete box so it reads exactly like every other
        // stand — outline on all four sides, not just the divider.
        //
        // Each edge is snapped to the host artwork's real bounds where the cell
        // meets the original stand's boundary, and left at the cell's own split
        // line where it meets a sibling. Snapping matters because the stored
        // geometry can sit a fraction off the artwork's own 0.75pt stroke: an
        // outer edge drawn to the geometry would poke past or gap the existing
        // outline, while a shared outer edge drawn to the host bbox lands
        // exactly on it (same position, same weight — no doubling).
        var hb = (host && host.getBBox) ? host.getBBox() : { x: g.x, y: g.y, width: g.w, height: g.h };
        var x1, y1, x2, y2;
        if (b.splitAxis === 'horizontal') {
          // Stacked: top/bottom are split lines, left/right are the stand's sides.
          x1 = hb.x;                       x2 = hb.x + hb.width;
          y1 = Math.max(g.y, hb.y);        y2 = Math.min(g.y + g.h, hb.y + hb.height);
        } else {
          // Side by side (default): left/right are split lines, top/bottom the sides.
          x1 = Math.max(g.x, hb.x);        x2 = Math.min(g.x + g.w, hb.x + hb.width);
          y1 = hb.y;                       y2 = hb.y + hb.height;
        }
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

        var label = document.createElementNS(SVG_NS, 'text');
        label.setAttribute('x', g.x + 5);
        label.setAttribute('y', g.y + 14);
        label.setAttribute('fill', '#111827');
        label.setAttribute('font-size', '12px');
        label.setAttribute('font-family', 'Raleway, sans-serif');
        label.setAttribute('font-weight', '700');
        label.setAttribute('data-split-label', b.boothNumber);
        label.style.pointerEvents = 'none';
        label.textContent = b.boothNumber;
        overlay.parentNode.insertBefore(label, overlay.nextSibling);
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

  global.BoothMap = { attach: attach, rectGeom: rectGeom };
})(window);
