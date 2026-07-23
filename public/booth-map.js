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

      var host = hostIdx > -1 ? artwork[hostIdx] : null;
      if (host && host.parentNode) host.parentNode.insertBefore(overlay, host.nextSibling);
      else svgDoc.appendChild(overlay);

      // Is this cell part of a split stand — either a secondary (has splitFrom)
      // or the primary the secondaries point back at?
      var isPrimarySplit = Object.prototype.hasOwnProperty.call(splitAxisByPrimary, b.boothNumber);
      var isSplitCell = !!b.splitFrom || isPrimarySplit;
      var splitAxis = b.splitAxis || splitAxisByPrimary[b.boothNumber] || 'vertical';

      // Draw every split cell as a complete four-sided box so both halves are
      // fully outlined, not just the one that happened to carry the split tag.
      //
      // Each edge is snapped to the host artwork's real bounds where the cell
      // meets the original stand's boundary, and left at the cell's own split
      // line where it meets a sibling. Snapping matters because the stored
      // geometry can sit a fraction off the artwork's own 0.75pt stroke: an
      // outer edge drawn to the geometry would poke past or gap the existing
      // outline, while a shared outer edge drawn to the host bbox lands
      // exactly on it (same position, same weight — no doubling).
      if (isSplitCell) {
        var hb = (host && host.getBBox) ? host.getBBox() : { x: g.x, y: g.y, width: g.w, height: g.h };
        var x1, y1, x2, y2;
        if (splitAxis === 'horizontal') {
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

        // Only the secondary cells get a fresh top-left number; the primary
        // still carries the artwork's original printed number, so adding one
        // would duplicate it.
        if (b.splitFrom) {
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
