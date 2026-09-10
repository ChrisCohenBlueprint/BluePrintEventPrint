/* ─── The colours a stand is painted in, per event ────────────────────────────
 *
 * booth-colours.css defines the app's own palette as CSS variables. This
 * overrides those variables with the colours THIS event's plan is drawn in, so
 * a stand keeps the colour its designer chose rather than the hall being
 * repainted in another event's palette.
 *
 * North America's plan draws sold stands light blue (#689abb), empty stands
 * near-white and sponsored areas burgundy. Painting them in Europe's yellow
 * made the plan stop looking like the plan that was signed off.
 *
 * ON HOLD is deliberately NOT taken from the artwork. A hold is a state the app
 * owns — it starts and expires here — so it stays the app's orange on every
 * event, and stays the one colour that means the same thing everywhere.
 *
 * Loaded by both the public floorplan and the admin plan, because a stand that
 * is one colour for a visitor and another for the person selling it is worse
 * than either colour.
 */
(function (global) {
  // The colours an event's artwork can set. ON HOLD is deliberately absent: a
  // hold starts and expires in the app, not in the drawing, so it keeps one
  // meaning everywhere.
  var FROM_ARTWORK = { available: '--booth-available', sold: '--booth-sold', sponsored: '--booth-sponsored' };

  // Every status that can be asked for. `held` belongs here even though no
  // artwork sets it — leaving it out made fillFor('held') fall through to the
  // available colour, and the downloaded plan painted every held stand white.
  var VARS = {
    available: FROM_ARTWORK.available, sold: FROM_ARTWORK.sold,
    sponsored: FROM_ARTWORK.sponsored, held: '--booth-held',
  };

  function applyPalette(palette) {
    var root = document.documentElement;
    Object.keys(FROM_ARTWORK).forEach(function (k) {
      var v = palette && palette[k];
      // A missing colour restores the app's own, rather than leaving whatever
      // the previously viewed event happened to set.
      if (v) root.style.setProperty(FROM_ARTWORK[k], v);
      else root.style.removeProperty(FROM_ARTWORK[k]);
    });
    return palette || null;
  }

  /** The colour a stand of this status is actually painted, palette applied. */
  function fillFor(status) {
    // An unknown status must not quietly become "available" — that is how a
    // held stand ended up white on a downloaded plan.
    if (!VARS[status]) return '#ffffff';
    var v = getComputedStyle(document.documentElement).getPropertyValue(VARS[status]);
    return (v || '').trim() || '#ffffff';
  }

  global.BoothPalette = { apply: applyPalette, fillFor: fillFor };
})(window);
