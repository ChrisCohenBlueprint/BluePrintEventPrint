/* ─── The sandbox's control panel ─────────────────────────────────────────────
 *
 * Injected into the real floorplan page by scripts/preview-plan.js. The public
 * plan has no merge or split controls — those live in the admin console, behind
 * a login this harness deliberately cannot satisfy — so the same model calls
 * are put on screen here instead.
 *
 * The totals line at the top is the reason the panel exists: a split divides
 * exactly and a merge sums, so the hall's area and price must read the same
 * after any chain of operations as before it. It turns red the moment they
 * don't, which is a test anyone can run by clicking.
 */
(function () {
  'use strict';

  var sel = [];          // stand numbers picked on the plan, in click order
  var start = null;      // the totals when the hall was last reseeded
  var busy = false;

  function byNum(n) { return (window.__rows || []).find(function (r) { return r.boothNumber === n; }); }
  function fmt(n) { return Number(n || 0).toLocaleString(); }

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') e.className = attrs[k]; else e.setAttribute(k, attrs[k]);
    });
    if (text != null) e.textContent = text;
    return e;
  }

  function say(msg, bad) {
    var box = document.getElementById('pp-msg');
    box.textContent = msg || '';
    box.className = bad ? 'bad' : 'ok';
  }

  function op(name, args) {
    if (busy) return;
    busy = true;
    render();
    return window.__op(name, args).then(function (res) {
      busy = false;
      if (res && res.ok) {
        say(res.unsplit ? 'Split undone — the stand is back whole.' : 'Done.');
        sel = [];
      } else say((res && res.error) || 'Refused.', true);
      render();
    }).catch(function (e) { busy = false; say(String(e), true); render(); });
  }

  // ─── Picking stands on the plan ─────────────────────────────────────────────
  function wirePicking(svg) {
    svg.addEventListener('click', function (ev) {
      var el = ev.target.closest && ev.target.closest('[data-booth]');
      if (!el) return;
      // Ahead of the page's own handler: this is a workbench, not a shop.
      ev.preventDefault();
      ev.stopPropagation();
      var n = el.getAttribute('data-booth');
      var i = sel.indexOf(n);
      if (i > -1) sel.splice(i, 1); else sel.push(n);
      render();
    }, true);
  }

  /** Ring the stands that are currently picked. */
  function paintSelection() {
    var svg = document.querySelector('#svg-mount svg');
    if (!svg) return;
    Array.prototype.forEach.call(svg.querySelectorAll('[data-pp-ring]'), function (r) {
      if (r.parentNode) r.parentNode.removeChild(r);
    });
    sel.forEach(function (n) {
      var host = svg.querySelector('[data-booth="' + (window.CSS && CSS.escape ? CSS.escape(n) : n) + '"]');
      if (!host) return;
      var b; try { b = host.getBBox(); } catch (e) { return; }
      var m = host.transform && host.transform.baseVal;
      m = (m && m.numberOfItems) ? m.consolidate() : null;
      var box = { x: b.x, y: b.y, w: b.width, h: b.height };
      if (m) {
        var mx = m.matrix, xs = [], ys = [], X = [b.x, b.x + b.width], Y = [b.y, b.y + b.height];
        for (var i = 0; i < 2; i++) for (var j = 0; j < 2; j++) {
          xs.push(mx.a * X[i] + mx.c * Y[j] + mx.e);
          ys.push(mx.b * X[i] + mx.d * Y[j] + mx.f);
        }
        box = { x: Math.min.apply(null, xs), y: Math.min.apply(null, ys),
                w: Math.max.apply(null, xs) - Math.min.apply(null, xs),
                h: Math.max.apply(null, ys) - Math.min.apply(null, ys) };
      }
      var ring = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      ring.setAttribute('x', box.x); ring.setAttribute('y', box.y);
      ring.setAttribute('width', box.w); ring.setAttribute('height', box.h);
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke', '#e11d48');
      ring.setAttribute('stroke-width', '3');
      ring.setAttribute('data-pp-ring', n);
      ring.style.pointerEvents = 'none';
      svg.appendChild(ring);
    });
  }

  // ─── The panel ──────────────────────────────────────────────────────────────
  function render() {
    var t = window.__totals || { stands: 0, sqm: 0, price: 0, off: 0 };
    if (!start) start = { stands: t.stands, sqm: t.sqm, price: t.price };
    // Stands may come and go as blocks and cells are made; area and price may
    // NOT. Off-plan stands are excluded from both sides, so removing one moves
    // the totals honestly and everything else must leave them alone.
    var drift = (t.sqm - start.sqm) + (t.price - start.price);

    var tot = document.getElementById('pp-totals');
    tot.className = drift ? 'bad' : '';
    tot.innerHTML =
      '<b>' + fmt(t.sqm) + ' m²</b> · ' + fmt(t.price) + ' · ' + t.stands + ' stands' +
      (t.off ? ' · ' + t.off + ' off the plan' : '') +
      '<div class="sub">' + (drift
        ? 'CHANGED — started at ' + fmt(start.sqm) + ' m² / ' + fmt(start.price)
        : 'unchanged since the hall was loaded') + '</div>';

    var one = sel.length === 1 ? byNum(sel[0]) : null;
    var pick = document.getElementById('pp-sel');
    pick.textContent = sel.length
      ? sel.map(function (n) {
          var b = byNum(n);
          return n + (b && b.sqm ? ' (' + b.sqm + ')' : '');
        }).join(' + ')
      : 'none — click stands on the plan';

    var acts = document.getElementById('pp-acts');
    acts.innerHTML = '';
    var add = function (label, fn, cls, title) {
      var b = el('button', { class: cls || '', title: title || '' }, label);
      b.disabled = busy;
      b.onclick = fn;
      acts.appendChild(b);
    };

    if (sel.length >= 2) {
      var parent = sel.map(byNum).find(function (b) {
        return b && b.splitSnapshot && (b.splitSnapshot.created || []).length + 1 === sel.length
          && (b.splitSnapshot.created || []).every(function (c) { return sel.indexOf(c) > -1; });
      });
      add(parent ? '↩ Put ' + parent.boothNumber + ' back together' : '🔗 Merge these ' + sel.length,
          function () { op('merge', { boothNumbers: sel.slice() }); },
          parent ? 'good' : '',
          parent ? 'Every cell of one split is selected, so this undoes the split' : '');
    }
    if (one) {
      var composite = !!(one.mergeSnapshot || one.splitSnapshot);
      if (!one.splitSnapshot) {
        add('✂ Split in 2 ↕', function () { op('split', { boothNumber: one.boothNumber, parts: 2, axis: 'vertical' }); });
        add('✂ Split in 2 ↔', function () { op('split', { boothNumber: one.boothNumber, parts: 2, axis: 'horizontal' }); });
        add('✂ Split in 3 ↕', function () { op('split', { boothNumber: one.boothNumber, parts: 3, axis: 'vertical' }); });
      }
      add('✎ Re-carve…', function () {
        var spec = prompt('Sizes for the new stands, separated by spaces.\n' +
                          'They must add up to ' + one.sqm + '.', '');
        if (!spec) return;
        var sizes = spec.split(/[^0-9]+/).filter(Boolean).map(Number);
        if (sizes.length < 2) return say('Give at least two sizes.', true);
        op('carve', { boothNumber: one.boothNumber, axis: 'vertical',
                      parts: sizes.map(function (s, i) { return { number: one.boothNumber + '.' + (i + 1), sqm: s }; }) });
      }, '', 'Divide it into stands of sizes you choose');
      if (composite) {
        var next = one.splitSnapshot && (!one.mergeSnapshot
          || new Date(one.splitSnapshot.at || 0) >= new Date(one.mergeSnapshot.at || 0))
          ? 'split' : 'merge';
        add('↩ Reset (undoes the ' + next + ')', function () { op('reset', { boothNumber: one.boothNumber }); }, 'good',
            one.mergeSnapshot && one.splitSnapshot ? 'This stand carries both — a second Reset undoes the other' : '');
      }
      if (!composite && !one.splitFrom) {
        add('🗑 Remove from plan', function () { op('remove', { boothNumber: one.boothNumber }); }, 'bad');
      }
    }
    if (!sel.length) acts.appendChild(el('p', {}, 'Click a stand to act on it; click more to merge them.'));

    var gone = (window.__rows || []).filter(function (r) { return r.removed; });
    var off = document.getElementById('pp-off');
    off.innerHTML = '';
    if (gone.length) {
      off.appendChild(el('div', { class: 'hd' }, 'Off the plan (' + gone.length + ')'));
      gone.forEach(function (r) {
        var b = el('button', {}, '↩ Put ' + r.boothNumber + ' back');
        b.disabled = busy;
        b.onclick = function () { op('restore', { boothNumber: r.boothNumber }); };
        off.appendChild(b);
      });
    }
    paintSelection();
  }

  function mount() {
    var svg = document.querySelector('#svg-mount svg');
    if (!svg || !(window.__rows || []).length) return setTimeout(mount, 300);

    var css = el('style');
    css.textContent =
      '#pp{position:fixed;top:10px;right:10px;width:290px;max-height:92vh;overflow:auto;z-index:99999;' +
      'background:#fff;border:1px solid #d4d4d8;border-radius:10px;padding:13px;' +
      'box-shadow:0 8px 30px rgba(0,0,0,.16);font:13px/1.45 Raleway,system-ui,sans-serif;color:#18181b}' +
      '#pp h4{margin:0 0 8px;font-size:14px}' +
      '#pp .hd{margin:12px 0 4px;font-size:10.5px;font-weight:700;text-transform:uppercase;' +
      'letter-spacing:.07em;color:#71717a}' +
      '#pp-totals{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:8px 10px;font-size:14px}' +
      '#pp-totals.bad{background:#fef2f2;border-color:#fecaca}' +
      '#pp-totals .sub{font-size:10.5px;color:#4b5563;margin-top:3px;font-weight:600}' +
      '#pp-sel{font-size:12px;color:#3f3f46;word-break:break-word}' +
      '#pp button{width:100%;margin:3px 0;padding:7px 9px;border-radius:7px;cursor:pointer;' +
      'border:1px solid #d4d4d8;background:#fafafa;font:inherit;text-align:left}' +
      '#pp button:hover:not(:disabled){background:#f4f4f5}' +
      '#pp button:disabled{opacity:.5;cursor:default}' +
      '#pp button.good{background:rgba(16,185,129,.11);border-color:rgba(16,185,129,.35)}' +
      '#pp button.bad{background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.3);color:#b91c1c}' +
      '#pp-msg{font-size:11.5px;margin-top:8px;min-height:15px;color:#15803d}' +
      '#pp-msg.bad{color:#b91c1c}' +
      '#pp .note{font-size:10.5px;color:#71717a;margin:8px 0 0}';
    document.head.appendChild(css);

    var box = el('div', { id: 'pp' });
    box.innerHTML =
      '<h4>Floorplan sandbox</h4>' +
      '<div id="pp-totals"></div>' +
      '<div class="hd">Selected</div><div id="pp-sel"></div>' +
      '<div id="pp-acts"></div>' +
      '<div id="pp-msg"></div>' +
      '<div id="pp-off"></div>' +
      '<div class="hd">Start again</div>';
    document.body.appendChild(box);

    var re = el('button', {}, '⟳ Reload the hall from the artwork');
    re.onclick = function () {
      fetch('/preview/reseed', { method: 'POST' }).then(function () {
        sel = []; start = null;
        return window.__pull();
      }).then(function () { say('Hall reloaded.'); });
    };
    box.appendChild(re);
    box.appendChild(el('p', { class: 'note' },
      'The real server model, a stand-in database. Nothing here is saved, and nothing reaches the live site.'));

    // The analytics consent card sits over the bottom of the plan and has
    // nothing to consent to here. The page raises it on a delay of its own, so
    // it is put back down for a few seconds rather than once.
    var hideConsent = setInterval(function () {
      var banner = document.querySelector('#consent-bar');
      if (banner && !banner.classList.contains('hidden')) banner.classList.add('hidden');
    }, 400);
    setTimeout(function () { clearInterval(hideConsent); }, 8000);

    wirePicking(svg);
    window.__renderPanel = render;
    render();
  }

  window.__pull().then(mount);
})();
