/* ─── The colours a space is painted in, per event ────────────────────────────
 *
 * booth-colours.css defines the app's own palette as CSS variables. This
 * overrides those variables with the colours THIS event uses, so a stand keeps
 * the colour its designer chose — or the colour an admin picked at upload —
 * rather than the hall being repainted in another event's palette.
 *
 * North America's plan draws sold stands light blue (#689abb), empty stands
 * near-white and sponsored areas burgundy. Painting them in Europe's yellow
 * made the plan stop looking like the plan that was signed off.
 *
 * Two sources, and they differ in one way that matters:
 *
 *   artwork — read off the plan by an import. Sets the stand colours only.
 *             ON HOLD stays the app's orange (a hold starts and expires here,
 *             not in the drawing), and the sponsorable areas keep exactly the
 *             fill the designer gave them.
 *   admin   — chosen in the Settings colour picker. Any of the five colours,
 *             including on hold and the two area colours; a colour left unset
 *             means the app's own. This is the only source that PAINTS the
 *             areas, because it is the only one where somebody decided to.
 *
 * Loaded by both the public floorplan and the admin plan, because a stand that
 * is one colour for a visitor and another for the person selling it is worse
 * than either colour.
 */
(function (global) {
  // Every colour a palette can carry, and the variable it drives.
  var VARS = {
    available: '--booth-available',
    sold:      '--booth-sold',
    held:      '--booth-held',
    sponsored: '--area-open',     // a sponsorable area still open (its old name, kept for stored rows)
    areaTaken: '--area-taken',    // a sponsorable area a sponsor has taken
  };
  // `held` came from nowhere but the app until the picker existed, and a
  // palette read off a plan still never sets it: the server leaves it null,
  // and this ignores it on any reading that somehow carries one.
  var ADMIN_ONLY = { held: true };

  var current = null;

  function applyPalette(palette) {
    var root = document.documentElement;
    var admin = !!(palette && palette.source === 'admin');
    Object.keys(VARS).forEach(function (k) {
      var v = palette && palette[k];
      if (ADMIN_ONLY[k] && !admin) v = null;
      // A missing colour restores the app's own, rather than leaving whatever
      // the previously viewed event happened to set.
      if (v) root.style.setProperty(VARS[k], v);
      else root.style.removeProperty(VARS[k]);
    });
    // The area variables are always set (the legend and the export key read
    // them), but the areas on the plan are only REPAINTED from them when an
    // admin chose the colours. With the class absent the plan's own fills show
    // through, as they always have — see the header.
    var paintsAreas = admin && !!(palette.sponsored || palette.areaTaken);
    root.classList.toggle('has-area-palette', paintsAreas);
    current = palette || null;
    return current;
  }

  /** The colour a space of this status is actually painted, palette applied. */
  function fillFor(status) {
    // An unknown status must not quietly become "available" — that is how a
    // held stand ended up white on a downloaded plan.
    var name = VARS[status] || (status === 'area' ? VARS.sponsored : null);
    if (!name) return '#ffffff';
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v || '').trim() || '#ffffff';
  }

  /** Whether the areas on the plan are being painted from the palette. */
  function paintsAreas() {
    return document.documentElement.classList.contains('has-area-palette');
  }

  global.BoothPalette = { apply: applyPalette, fillFor: fillFor, paintsAreas: paintsAreas,
                          get current() { return current; } };
})(window);
