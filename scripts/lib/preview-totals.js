/* ─── The sandbox's totals strip ──────────────────────────────────────────────
 *
 * Injected into the real admin console by scripts/preview-plan.js. It adds no
 * controls — the console's own merge, split, reset and remove are what is being
 * tried — only the one reading the console does not show:
 *
 *   a split divides exactly and a merge sums, so the hall's area and list price
 *   must read the SAME after any chain of operations as before it.
 *
 * Green while they hold, red the moment they move. That is the conservation the
 * test suite asserts, made checkable by clicking. Stands COUNT may change freely
 * — that is what merging and splitting do — and a stand taken off the plan
 * leaves the totals honestly, which is why it is reported separately.
 */
(function () {
  'use strict';

  var start = null;
  function fmt(n) { return Number(n || 0).toLocaleString(); }

  function render() {
    var t = window.__totals;
    if (!t) return;
    if (!start) start = { sqm: t.sqm, price: t.price, stands: t.stands };
    var bar = document.getElementById('pv-bar');
    if (!bar) return;
    var drift = (t.sqm - start.sqm) + (t.price - start.price) + t.off * 0;
    // A removal is the one thing that MAY move the totals, so it is measured
    // against the hall as it now stands rather than reported as a fault.
    var expected = t.off > 0;
    bar.className = drift && !expected ? 'bad' : (drift ? 'warn' : '');
    bar.innerHTML =
      '<span class="tag">SANDBOX</span>' +
      '<b>' + fmt(t.sqm) + ' m²</b> · ' + fmt(t.price) + ' · ' + t.stands + ' stands' +
      (t.off ? ' · <i>' + t.off + ' off the plan</i>' : '') +
      '<span class="sub">' + (drift
        ? (expected ? 'changed by what was taken off the plan — started at ' + fmt(start.sqm) + ' m²'
                    : 'AREA OR PRICE MOVED — started at ' + fmt(start.sqm) + ' m² / ' + fmt(start.price))
        : 'area and price unchanged since the hall was loaded') + '</span>' +
      '<button id="pv-reseed">⟳ Reload the hall</button>';
    document.getElementById('pv-reseed').onclick = function () {
      fetch('/preview/reseed', { method: 'POST' })
        .then(function () { start = null; return window.__pull(); });
    };
  }

  function mount() {
    if (!document.body) return setTimeout(mount, 100);
    var css = document.createElement('style');
    css.textContent =
      // Along the TOP. At the bottom it covered the console's own toasts — the
      // one carrying the Undo after a stand is taken off the plan, which is
      // precisely the thing this sandbox exists to let someone try.
      '#pv-bar{position:fixed;left:0;right:0;top:0;z-index:99999;display:flex;align-items:center;gap:10px;' +
      'padding:7px 14px;background:#ecfdf5;border-bottom:2px solid #10b981;' +
      'font:13px/1.3 Raleway,system-ui,sans-serif;color:#064e3b}' +
      '#pv-bar.warn{background:#fffbeb;border-bottom-color:#f59e0b;color:#78350f}' +
      '#pv-bar.bad{background:#fef2f2;border-bottom-color:#ef4444;color:#7f1d1d}' +
      '#pv-bar .tag{font-size:10px;font-weight:800;letter-spacing:.09em;background:#064e3b;color:#fff;' +
      'padding:3px 7px;border-radius:4px}' +
      '#pv-bar.warn .tag{background:#78350f} #pv-bar.bad .tag{background:#7f1d1d}' +
      '#pv-bar .sub{font-size:11px;opacity:.85;margin-left:auto}' +
      '#pv-bar i{font-style:normal;opacity:.8}' +
      '#pv-bar button{margin-left:10px;padding:5px 10px;border-radius:6px;cursor:pointer;' +
      'border:1px solid currentColor;background:transparent;color:inherit;font:inherit}' +
      'body{padding-top:40px}';
    document.head.appendChild(css);
    var bar = document.createElement('div');
    bar.id = 'pv-bar';
    document.body.appendChild(bar);
    window.__renderTotals = render;
    render();
  }

  mount();
})();
