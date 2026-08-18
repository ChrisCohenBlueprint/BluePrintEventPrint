// ─── BluePrint EventPrint — printable client proposal ─────────────────────────
// Renders one saved menu as a clean document the rep prints to PDF and emails
// to the client. This page is behind the sales login like the rest of /sales —
// the client is sent the resulting FILE, never a link to here.
//
// The server resolves the proposal against live inventory, so anything that
// sold or was withdrawn since drafting arrives flagged and is presented as
// no longer available rather than quietly offered.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // Text nodes only — a package name, client note or bespoke line is author
  // content and is never written to the page as HTML.
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const money = (n) => (n == null || !Number.isFinite(Number(n)))
    ? 'On application'
    : '€' + Number(n).toLocaleString('en-GB', { maximumFractionDigits: 0 });

  const area = (n) => (n == null ? '—' : `${Number(n).toLocaleString('en-GB', { maximumFractionDigits: 1 })} m²`);

  const longDate = (d) => new Date(d).toLocaleDateString('en-GB',
    { day: 'numeric', month: 'long', year: 'numeric' });

  // The proposal id is the last path segment of /sales/menu/:id/print.
  const id = location.pathname.split('/').filter(Boolean)[2] || '';

  function fail(msg) {
    $('load-state').textContent = msg;
    $('load-state').classList.add('error');
  }

  function renderSponsors(items, showPrices) {
    if (!items.length) return;
    const wrap = $('sponsor-list');

    items.forEach(s => {
      const card = el('div', `p-item${s.unavailable ? ' unavailable' : ''}`);

      const head = el('div', 'p-item-head');
      head.append(el('h3', null, s.name));
      if (s.tier) head.append(el('span', `p-tier t-${s.tier}`, s.tier.toUpperCase()));
      // Say plainly when something can no longer be bought, rather than
      // dropping it — the client may have asked about it by name.
      if (s.unavailable) head.append(el('span', 'p-gone', s.soldOut ? 'Now sold' : 'No longer available'));
      card.append(head);

      if (s.availability) card.append(el('div', 'p-avail', s.availability));
      if (s.blurb) card.append(el('p', 'p-blurb', s.blurb));

      if ((s.perks || []).length) {
        const ul = el('ul', 'p-perks');
        s.perks.forEach(p => ul.append(el('li', null, p)));
        card.append(ul);
      }

      if (showPrices) card.append(el('div', 'p-price', money(s.price)));
      wrap.append(card);
    });

    $('block-sponsors').hidden = false;
  }

  function renderBooths(items, showPrices) {
    if (!items.length) return;
    const body = $('booth-list');

    items.forEach(b => {
      const tr = el('tr', b.unavailable ? 'unavailable' : null);
      const label = b.displayNumber || b.boothNumber;
      tr.append(el('td', 'stand-cell',
        b.unavailable ? `${label} — no longer available` : label));
      tr.append(el('td', null, area(b.sqm)));
      if (showPrices) tr.append(el('td', 'col-price', money(b.price)));
      body.append(tr);
    });

    if (showPrices) document.querySelectorAll('.col-price[hidden]').forEach(c => (c.hidden = false));
    $('block-booths').hidden = false;
  }

  function renderCustom(items, showPrices) {
    if (!items.length) return;
    const wrap = $('custom-list');

    items.forEach(c => {
      const row = el('div', 'p-item');
      const head = el('div', 'p-item-head');
      head.append(el('h3', null, c.title));
      row.append(head);
      if (c.detail) row.append(el('p', 'p-blurb', c.detail));
      if (showPrices) row.append(el('div', 'p-price', money(c.price)));
      wrap.append(row);
    });

    $('block-custom').hidden = false;
  }

  /**
   * Draw the floorplan with the proposed stands marked.
   *
   * The artwork is the same file the public floorplan serves, and stands are
   * mapped onto it with the same BoothMap.attach() — identity comes from
   * geometry, so a stand highlighted here is provably the stand the client will
   * find on the website. Nothing about the plan is hand-maintained for print.
   *
   * A failure here must never cost the rep their proposal: the figure is hidden
   * and the rest of the document prints as before.
   */
  async function renderPlan(plan) {
    // Nothing to point at — every stand in the proposal has gone since drafting,
    // or none was resolvable. A plan with no marks would just puzzle the client;
    // the stands table already says which are no longer available. Checked before
    // the artwork is fetched, so a pointless figure costs no download either.
    if (!plan || !plan.booths || !plan.booths.length) return;
    if (!(plan.highlight || []).length) return;

    const mount = $('plan-mount');
    let svgDoc;
    try {
      const res = await fetch(plan.svg, { headers: { Accept: 'image/svg+xml' } });
      if (!res.ok) throw new Error(`artwork ${res.status}`);
      mount.innerHTML = await res.text();
      svgDoc = mount.querySelector('svg');
      if (!svgDoc) throw new Error('no <svg> in the artwork');
    } catch (e) {
      console.warn('Floorplan figure skipped:', e.message);
      return;
    }

    // Scale to the column; the viewBox keeps the aspect ratio.
    svgDoc.removeAttribute('width');
    svgDoc.removeAttribute('height');
    svgDoc.classList.add('plan-svg');

    // Reveal the section BEFORE anything measures the artwork. `hidden` resolves
    // to display:none, and inside that subtree getBBox() reports a zero-size box
    // — every badge below would be skipped by its own size guard, and the figure
    // would print highlighted but unlabelled.
    $('block-plan').hidden = false;

    const mine = new Set(plan.highlight || []);

    BoothMap.attach(svgDoc, plan.booths, {
      onTag(el, n, b) {
        // The SAME class names the public floorplan uses, resolved by the same
        // shared stylesheet — so a stand is the identical colour whether the
        // client is looking at this PDF or at the website. Availability must
        // never appear to differ between the two.
        el.classList.add(b.status === 'sold' ? 'booth-sold'
                       : b.status === 'held' ? 'booth-held'
                       : 'booth-available');
      },
    });

    // Mark each proposed stand.
    //
    // MARKER decides how. Both keep the mark INSIDE the stand's own footprint —
    // the earlier pill was sized to its text, so on a small stand it spilled over
    // the neighbours and made a tidy plan look cluttered.
    //   'outline' — a rose ring around the stand, the same cue the admin search
    //               uses to pick a stand out of the hall.
    //   'dot'     — a rose disc centred in the stand.
    //   'both'    — the ring shows the exact footprint, the disc catches the eye
    //               from across a full page.
    const MARKER = 'both';

    // Web fonts must be settled before anything is measured, or a label is sized
    // against the fallback face.
    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch { /* measure with whatever is loaded */ }
    }

    const SVG_NS = 'http://www.w3.org/2000/svg';
    let marked = 0;

    mine.forEach(n => {
      const el = svgDoc.querySelector(`[data-booth="${CSS.escape(n)}"]`);
      if (!el) return;
      // The stand's post-transform box — many stands in the artwork are rotated,
      // and the untransformed box would put the mark off the stand.
      const box = BoothMap.visualBox(el);
      if (!box || !(box.w > 0) || !(box.h > 0)) return;

      if (MARKER !== 'dot') el.classList.add('plan-marked');

      if (MARKER !== 'outline') {
        const dot = document.createElementNS(SVG_NS, 'circle');
        dot.setAttribute('class', 'plan-dot');
        dot.setAttribute('cx', box.x + box.w / 2);
        dot.setAttribute('cy', box.y + box.h / 2);
        // Sized to the stand so it never bleeds past its edges, with a floor and
        // a ceiling so it stays visible on a 9 m² stand and doesn't become a
        // blob on a 200 m² one.
        dot.setAttribute('r', Math.max(6, Math.min(14, Math.min(box.w, box.h) * 0.28)));
        svgDoc.appendChild(dot);
      }

      marked++;
    });

    // The caption counts what was actually DRAWN, not what was requested, so it
    // can never promise a mark the client cannot find.
    if (!marked) { $('block-plan').hidden = true; return; }
    $('plan-lede').textContent = marked === 1
      ? 'The stand set out in this proposal is marked below.'
      : `The ${marked} stands set out in this proposal are marked below.`;
  }

  async function load() {
    if (!id) return fail('No proposal specified.');

    let res;
    try {
      res = await fetch(`/api/sales/menus/${encodeURIComponent(id)}/print`,
        { headers: { Accept: 'application/json' } });
    } catch {
      return fail('Could not reach the server. Check your connection and reload.');
    }

    if (res.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); return; }
    if (!res.ok) {
      let msg = `Could not load this proposal (${res.status}).`;
      try { const d = await res.json(); if (d && d.error) msg = d.error; } catch {}
      return fail(msg);
    }

    const d = await res.json();

    // ── Header ──
    $('brand-show').textContent = d.showId || '';
    $('doc-ref').textContent = d.ref || '';
    $('doc-date').textContent = longDate(d.updatedAt || d.createdAt || Date.now());
    $('doc-title').textContent = d.title || 'Sponsorship & Stand Proposal';
    document.title = `${d.ref || 'Proposal'} — ${d.client?.company || d.client?.name || 'Proposal'}`;

    // A brand colour is only applied when the show has a floorplan sponsor set;
    // the server has already validated it as a hex colour.
    if (d.floorplanSponsor && d.floorplanSponsor.color) {
      $('brand-mark').style.background = d.floorplanSponsor.color;
    }

    const forWho = [d.client?.name, d.client?.company].filter(Boolean).join(' · ');
    $('doc-for').textContent = forWho ? `Prepared for ${forWho}` : '';

    if (d.intro) { $('doc-intro').textContent = d.intro; $('doc-intro').hidden = false; }

    // ── Body ──
    renderSponsors(d.sponsors || [], d.showPrices);
    renderBooths(d.booths || [], d.showPrices);
    renderCustom(d.custom || [], d.showPrices);

    if (d.showPrices && d.total != null) {
      $('total-value').textContent = money(d.total);
      $('totals').hidden = false;
    }

    // One honest line if the selection has gone stale, so the rep notices before
    // sending — the flagged rows above say which.
    const gone = [...(d.sponsors || []), ...(d.booths || [])].filter(i => i.unavailable).length;
    if (gone) {
      $('withdrawn-note').textContent =
        `${gone} item${gone === 1 ? ' is' : 's are'} no longer available and ${gone === 1 ? 'is' : 'are'} marked above. ` +
        `Edit the proposal to remove ${gone === 1 ? 'it' : 'them'} before sending.`;
      $('withdrawn-note').hidden = false;
      $('tb-note').textContent = `⚠ ${gone} item${gone === 1 ? '' : 's'} in this proposal ${gone === 1 ? 'is' : 'are'} no longer available.`;
      $('tb-note').classList.add('warn');
    }

    // ── Footer ──
    $('foot-name').textContent  = d.preparedBy?.name || '';
    $('foot-email').textContent = d.preparedBy?.email || '';

    $('load-state').hidden = true;
    $('sheet').hidden = false;

    // Drawn LAST and only once the sheet is visible: fitLabel measures text with
    // getComputedTextLength(), which returns 0 inside a hidden subtree — the
    // numbers would size themselves against a zero-width box. Awaited so the
    // figure is complete before a rep can reach the print dialog.
    if (d.plan) {
      try { await renderPlan(d.plan); }
      catch (e) { console.warn('Floorplan figure failed:', e); }
    }
  }

  $('tb-print').addEventListener('click', () => window.print());

  load();
})();
