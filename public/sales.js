// ─── BluePrint EventPrint — Sales dashboard ───────────────────────────────────
// The sub-admin surface for the sales team. A rep browses what is still on the
// table (remaining sponsorship, available stands), gathers a selection, and
// turns it into a bespoke printed proposal for one client.
//
// Everything here reads and writes /api/sales/*, which the server scopes to the
// signed-in rep. This file never assumes it can see another rep's work.
(function () {
  'use strict';

  const $  = (id) => document.getElementById(id);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // ── State ───────────────────────────────────────────────────────────────────
  const state = {
    me: null,
    sponsors: [],          // remaining catalogue
    booths: [],            // available stands
    menus: [],             // this rep's proposals
    pickedSponsors: new Set(),
    pickedBooths: new Set(),
    tier: 'all',
    size: 'all',
    sponsorQ: '',
    standQ: '',
    editing: null,         // the menu being edited, or null
    dirty: false,
  };

  // ── Helpers ─────────────────────────────────────────────────────────────────
  // These lived here AND in admin.js, and the copies had drifted: this one knew
  // that a 401 means "your session ended, go and sign in" and the admin's did
  // not. There is one copy now, in lib/ui.js, loaded before this file.
  //
  // Text nodes only — nothing from the database is ever written as HTML, so a
  // package name or client note containing markup can't inject into the page.
  const { el, money, api, withPending, confirmDialog } = window.UI;
  const toast = (msg, kind = '') => window.UI.toast(msg, kind, { id: 'toast', cls: 'toast' });

  // The unit comes from the show, not from this file: LNA measures in square
  // feet while LEX measures in square metres, and a proposal that says otherwise
  // is wrong in front of a client. (The currency lives in UI.setCurrency for the
  // same reason.) Defaults match what this page printed before, so a show that
  // has set neither is unchanged.
  let AREA_UNIT = 'm²';

  const area = (n) => (n == null ? '—' : `${Number(n).toLocaleString('en-GB', { maximumFractionDigits: 1 })} ${AREA_UNIT}`);

  /**
   * The size bands the Stands filter offers.
   *
   * These used to be 12 and 30 with "Under 12 m²" written into the HTML — on a
   * show configured in square feet that read as nonsense and filtered nothing
   * the rep expected, because a 200 ft² stand is not "over 30". The square-foot
   * band edges are the same physical sizes, rounded to numbers a rep would say
   * out loud.
   */
  const SIZE_BANDS = {
    'm²':  { small: 12,  large: 30 },
    'ft²': { small: 130, large: 320 },
  };
  const bands = () => SIZE_BANDS[AREA_UNIT] || SIZE_BANDS['m²'];

  /** Re-label the size chips for whichever unit this show uses. */
  function renderSizeFilterLabels() {
    const b = bands();
    const text = {
      all: 'Any size',
      s: `Under ${b.small} ${AREA_UNIT}`,
      m: `${b.small}–${b.large} ${AREA_UNIT}`,
      l: `Over ${b.large} ${AREA_UNIT}`,
    };
    $$('#size-filters .chip').forEach(chip => {
      const t = text[chip.dataset.size];
      if (t) chip.textContent = t;
    });
  }

  // ── Navigation ──────────────────────────────────────────────────────────────
  const TITLES = {
    inventory: 'Remaining sponsorship',
    stands:    'Available stands',
    proposals: 'My proposals',
  };

  function showSection(name) {
    $$('.nav-link').forEach(l => {
      const on = l.dataset.section === name;
      l.classList.toggle('active', on);
      l.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $$('.admin-section').forEach(s => s.classList.toggle('active', s.id === `section-${name}`));
    $('section-title').textContent = TITLES[name] || name;
  }

  // Click AND Enter/Space: these are tabs, not text. With a click handler alone
  // the whole dashboard was unreachable without a mouse.
  $$('.nav-link').forEach(link => {
    link.addEventListener('click', () => showSection(link.dataset.section));
    link.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showSection(link.dataset.section); }
    });
  });

  // ── Selection basket ────────────────────────────────────────────────────────
  function pickedTotal() { return state.pickedSponsors.size + state.pickedBooths.size; }

  function renderBasket() {
    const n = pickedTotal();
    $('basket-count').textContent = n;
    $('sales-basket').classList.toggle('has-items', n > 0);
  }

  function togglePick(set, key, cardEl) {
    if (set.has(key)) set.delete(key); else set.add(key);
    if (cardEl) cardEl.classList.toggle('picked', set.has(key));
    renderBasket();
    // Keep an open proposal in step with the basket, so ticking a package while
    // the editor is open updates the "Included" list immediately.
    if (state.editing) syncEditorFromBasket();
  }

  $('basket-clear').addEventListener('click', () => {
    state.pickedSponsors.clear();
    state.pickedBooths.clear();
    $$('.pick-card.picked').forEach(c => c.classList.remove('picked'));
    renderBasket();
    if (state.editing) syncEditorFromBasket();
  });

  $('basket-build').addEventListener('click', () => {
    if (!pickedTotal()) return toast('Pick at least one package or stand first.', 'warn');
    openEditor(null);
  });

  // ── Sponsorship ─────────────────────────────────────────────────────────────
  function sponsorMatches(s) {
    if (state.tier !== 'all' && s.tier !== state.tier) return false;
    if (!state.sponsorQ) return true;
    const hay = `${s.name} ${s.blurb || ''} ${(s.perks || []).join(' ')}`.toLowerCase();
    return hay.includes(state.sponsorQ);
  }

  function sponsorCard(s) {
    const card = el('div', `pick-card tier-${s.tier || 'silver'}`);
    if (state.pickedSponsors.has(s.key)) card.classList.add('picked');
    card.dataset.key = s.key;

    const head = el('div', 'pick-head');
    head.append(el('span', `tier-badge tier-${s.tier || 'silver'}`, (s.tier || 'silver').toUpperCase()));
    if (s.availability) head.append(el('span', 'pick-avail', s.availability));
    card.append(head);

    card.append(el('h4', 'pick-title', s.name || s.key));
    if (s.blurb) card.append(el('p', 'pick-blurb', s.blurb));

    if ((s.perks || []).length) {
      const ul = el('ul', 'pick-perks');
      s.perks.slice(0, 4).forEach(p => ul.append(el('li', null, p)));
      if (s.perks.length > 4) ul.append(el('li', 'more', `+${s.perks.length - 4} more`));
      card.append(ul);
    }

    const foot = el('div', 'pick-foot');
    // Internal price — reps pitch from this; the client document hides it
    // unless the rep explicitly opts in on that proposal.
    foot.append(el('span', 'pick-price', s.price == null ? 'Price on application' : money(s.price)));
    foot.append(el('span', 'pick-tick'));
    card.append(foot);

    card.addEventListener('click', () => togglePick(state.pickedSponsors, s.key, card));
    return card;
  }

  function renderSponsors() {
    const list = state.sponsors.filter(sponsorMatches);
    const grid = $('sponsor-grid');
    grid.replaceChildren(...list.map(sponsorCard));
    $('sponsor-count').textContent =
      `${list.length} of ${state.sponsors.length} available`;
    $('sponsor-empty').classList.toggle('hidden', state.sponsors.length > 0);
  }

  // ── Stands ──────────────────────────────────────────────────────────────────
  function standMatches(b) {
    const size = Number(b.sqm) || 0;
    const { small, large } = bands();
    if (state.size === 's' && !(size < small)) return false;
    if (state.size === 'm' && !(size >= small && size <= large)) return false;
    if (state.size === 'l' && !(size > large)) return false;
    if (!state.standQ) return true;
    return `${b.boothNumber} ${b.displayNumber || ''}`.toLowerCase().includes(state.standQ);
  }

  function standCard(b) {
    const card = el('div', 'pick-card stand-card');
    if (state.pickedBooths.has(b.boothNumber)) card.classList.add('picked');
    card.dataset.key = b.boothNumber;

    card.append(el('div', 'stand-num', b.displayNumber || b.boothNumber));
    card.append(el('div', 'stand-sqm', area(b.sqm)));

    const foot = el('div', 'pick-foot');
    foot.append(el('span', 'pick-price', b.listPrice == null ? '—' : money(b.listPrice)));
    foot.append(el('span', 'pick-tick'));
    card.append(foot);

    card.addEventListener('click', () => togglePick(state.pickedBooths, b.boothNumber, card));
    return card;
  }

  function renderStands() {
    const list = state.booths.filter(standMatches);
    const grid = $('stand-grid');
    grid.replaceChildren(...list.map(standCard));
    $('stand-count').textContent = `${list.length} of ${state.booths.length} available`;
    $('stand-empty').classList.toggle('hidden', state.booths.length > 0);
  }

  // ── Filters ─────────────────────────────────────────────────────────────────
  $('sponsor-search').addEventListener('input', (e) => {
    state.sponsorQ = e.target.value.trim().toLowerCase();
    renderSponsors();
  });
  $('stand-search').addEventListener('input', (e) => {
    state.standQ = e.target.value.trim().toLowerCase();
    renderStands();
  });
  $$('#tier-filters .chip').forEach(chip => chip.addEventListener('click', () => {
    state.tier = chip.dataset.tier;
    $$('#tier-filters .chip').forEach(c => c.classList.toggle('active', c === chip));
    renderSponsors();
  }));
  $$('#size-filters .chip').forEach(chip => chip.addEventListener('click', () => {
    state.size = chip.dataset.size;
    $$('#size-filters .chip').forEach(c => c.classList.toggle('active', c === chip));
    renderStands();
  }));

  // ── Proposals list ──────────────────────────────────────────────────────────
  function proposalRow(m) {
    const row = el('div', 'prop-row');

    const main = el('div', 'prop-main');
    main.append(el('div', 'prop-ref', m.ref));
    main.append(el('div', 'prop-title', m.title || 'Untitled proposal'));
    const who = [m.clientName, m.clientCompany].filter(Boolean).join(' · ');
    main.append(el('div', 'prop-client', who || 'No client set'));
    row.append(main);

    const counts = el('div', 'prop-counts');
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    counts.append(el('span', 'pill', plural((m.sponsorKeys || []).length, 'package', 'packages')));
    counts.append(el('span', 'pill', plural((m.boothNumbers || []).length, 'stand', 'stands')));
    if ((m.custom || []).length) counts.append(el('span', 'pill', `${m.custom.length} bespoke`));
    if (m.showPrices) counts.append(el('span', 'pill priced', 'prices shown'));
    if (m.showPlan !== false && (m.boothNumbers || []).length) counts.append(el('span', 'pill', 'floorplan'));
    row.append(counts);

    const when = el('div', 'prop-when',
      m.updatedAt ? new Date(m.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
    row.append(when);

    const actions = el('div', 'prop-actions');

    const edit = el('button', 'admin-btn', 'Edit');
    edit.addEventListener('click', () => openEditor(m));
    actions.append(edit);

    const copy = el('button', 'admin-btn', 'Duplicate');
    copy.addEventListener('click', (e) => withPending(e.currentTarget, async () => {
      try {
        await api(`/api/sales/menus/${m._id}/duplicate`, { method: 'POST' });
        await loadMenus();
        toast('Proposal duplicated.', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    }));
    actions.append(copy);

    const pdf = el('button', 'admin-btn success', 'PDF');
    pdf.addEventListener('click', () => openPrint(m._id));
    actions.append(pdf);

    row.append(actions);
    return row;
  }

  function renderMenus() {
    const list = $('prop-list');
    list.replaceChildren(...state.menus.map(proposalRow));
    $('prop-count').textContent = `${state.menus.length} saved`;
    $('prop-empty').classList.toggle('hidden', state.menus.length > 0);
    const badge = $('prop-badge');
    badge.textContent = state.menus.length;
    badge.classList.toggle('hidden', state.menus.length === 0);
  }

  // The print view is a separate authenticated page that opens its own print
  // dialog — the rep saves it as a PDF and emails that file to the client.
  // Nothing about the proposal is ever published to a public URL.
  function openPrint(id) {
    // The event has to be in the URL. Without it the print page was served with
    // no show, so it sent no X-Show header and resolved the DEFAULT event —
    // which is how a North America proposal came out carrying Europe's hall.
    const slug = (window.__SHOW && window.__SHOW.slug) || '';
    const url = slug ? `/sales/${encodeURIComponent(slug)}/menu/${id}/print`
                     : `/sales/menu/${id}/print`;
    window.open(url, '_blank', 'noopener');
  }

  // ── Editor drawer ───────────────────────────────────────────────────────────
  function markDirty() {
    state.dirty = true;
    $('save-state').textContent = 'Unsaved changes';
    $('save-state').className = 'save-state dirty';
  }

  ['f-title', 'f-client', 'f-company', 'f-email', 'f-intro'].forEach(id =>
    $(id).addEventListener('input', markDirty));
  $('f-prices').addEventListener('change', markDirty);
  $('f-plan').addEventListener('change', markDirty);

  function openEditor(menu) {
    state.editing = menu || { _id: null, ref: 'New', title: '', clientName: '', clientCompany: '',
                              clientEmail: '', intro: '', sponsorKeys: [], boothNumbers: [],
                              custom: [], showPrices: false, showPlan: true };

    // Editing an existing proposal loads ITS selection into the basket, so the
    // cards on the inventory tabs reflect what this proposal already contains.
    if (menu) {
      state.pickedSponsors = new Set(menu.sponsorKeys || []);
      state.pickedBooths   = new Set(menu.boothNumbers || []);
      renderSponsors(); renderStands(); renderBasket();
    }

    $('drawer-ref').textContent = state.editing.ref || 'New';
    $('drawer-heading').textContent = menu ? 'Edit proposal' : 'New proposal';
    $('f-title').value   = state.editing.title || '';
    $('f-client').value  = state.editing.clientName || '';
    $('f-company').value = state.editing.clientCompany || '';
    $('f-email').value   = state.editing.clientEmail || '';
    $('f-intro').value   = state.editing.intro || '';
    $('f-prices').checked = state.editing.showPrices === true;
    // Opt-OUT, so a proposal drafted before this existed (no field at all) shows
    // the box ticked, matching what its PDF will actually contain.
    $('f-plan').checked = state.editing.showPlan !== false;
    $('drawer-delete').classList.toggle('hidden', !menu);
    $('drawer-print').classList.toggle('hidden', !menu);

    renderCustom(state.editing.custom || []);
    syncEditorFromBasket();

    state.dirty = false;
    $('save-state').textContent = menu ? '' : 'Not saved yet';
    $('save-state').className = 'save-state';

    $('drawer').classList.remove('hidden');
    $('drawer-scrim').classList.remove('hidden');
    lucide.createIcons();
  }

  function closeEditor() {
    if (state.dirty && !confirm('You have unsaved changes. Close anyway?')) return;
    state.editing = null;
    state.dirty = false;
    $('drawer').classList.add('hidden');
    $('drawer-scrim').classList.add('hidden');
  }

  $('drawer-close').addEventListener('click', closeEditor);
  $('drawer-scrim').addEventListener('click', closeEditor);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('drawer').classList.contains('hidden')) closeEditor();
  });

  /** Redraw the "Included" list from the current basket. */
  function syncEditorFromBasket() {
    const wrap = $('drawer-items');
    const rows = [];

    state.pickedSponsors.forEach(key => {
      const s = state.sponsors.find(x => x.key === key);
      const row = el('div', 'item-row');
      row.append(el('span', 'item-kind', 'Sponsorship'));
      row.append(el('span', 'item-name', s ? s.name : key));
      const rm = el('button', 'icon-btn', '×');
      rm.title = 'Remove';
      rm.addEventListener('click', () => {
        state.pickedSponsors.delete(key);
        $$(`#sponsor-grid .pick-card[data-key="${CSS.escape(key)}"]`).forEach(c => c.classList.remove('picked'));
        renderBasket(); syncEditorFromBasket(); markDirty();
      });
      row.append(rm);
      rows.push(row);
    });

    state.pickedBooths.forEach(num => {
      const b = state.booths.find(x => x.boothNumber === num);
      const row = el('div', 'item-row');
      row.append(el('span', 'item-kind', 'Stand'));
      row.append(el('span', 'item-name', `${b?.displayNumber || num}${b ? ` · ${area(b.sqm)}` : ''}`));
      const rm = el('button', 'icon-btn', '×');
      rm.title = 'Remove';
      rm.addEventListener('click', () => {
        state.pickedBooths.delete(num);
        $$(`#stand-grid .pick-card[data-key="${CSS.escape(num)}"]`).forEach(c => c.classList.remove('picked'));
        renderBasket(); syncEditorFromBasket(); markDirty();
      });
      row.append(rm);
      rows.push(row);
    });

    if (!rows.length) rows.push(el('p', 'hint', 'Nothing selected yet — tick packages or stands on the other tabs.'));
    wrap.replaceChildren(...rows);
    $('drawer-tally').textContent = `${pickedTotal()} item${pickedTotal() === 1 ? '' : 's'}`;
  }

  // ── Bespoke line items ──────────────────────────────────────────────────────
  function customRow(item = { title: '', detail: '', price: null }) {
    const row = el('div', 'custom-row');

    const t = el('input'); t.type = 'text'; t.className = 'admin-input c-title';
    t.placeholder = 'Line item'; t.value = item.title || '';

    const d = el('input'); d.type = 'text'; d.className = 'admin-input c-detail';
    d.placeholder = 'Detail (optional)'; d.value = item.detail || '';

    const p = el('input'); p.type = 'number'; p.className = 'admin-input c-price';
    p.placeholder = window.UI.currency().trim(); p.min = '0'; p.value = item.price == null ? '' : item.price;

    const rm = el('button', 'icon-btn', '×');
    rm.title = 'Remove line';
    rm.addEventListener('click', () => { row.remove(); markDirty(); });

    [t, d, p].forEach(i => i.addEventListener('input', markDirty));
    row.append(t, d, p, rm);
    return row;
  }

  function renderCustom(items) {
    $('custom-items').replaceChildren(...items.map(customRow));
  }

  function readCustom() {
    return $$('#custom-items .custom-row').map(r => ({
      title:  r.querySelector('.c-title').value.trim(),
      detail: r.querySelector('.c-detail').value.trim(),
      price:  r.querySelector('.c-price').value === '' ? null : Number(r.querySelector('.c-price').value),
    })).filter(i => i.title);
  }

  $('custom-add').addEventListener('click', () => {
    $('custom-items').append(customRow());
    markDirty();
  });

  // ── Save / delete ───────────────────────────────────────────────────────────
  function readForm() {
    return {
      title:         $('f-title').value.trim(),
      clientName:    $('f-client').value.trim(),
      clientCompany: $('f-company').value.trim(),
      clientEmail:   $('f-email').value.trim(),
      intro:         $('f-intro').value.trim(),
      sponsorKeys:   [...state.pickedSponsors],
      boothNumbers:  [...state.pickedBooths],
      custom:        readCustom(),
      showPrices:    $('f-prices').checked,
      showPlan:      $('f-plan').checked,
    };
  }

  async function save({ silent = false } = {}) {
    const body = readForm();
    const btn = $('drawer-save');
    if (btn.dataset.pending === '1') return null;   // an impatient second click
    btn.dataset.pending = '1';
    btn.disabled = true;
    try {
      const saved = state.editing?._id
        ? await api(`/api/sales/menus/${state.editing._id}`, { method: 'PATCH', body: JSON.stringify(body) })
        : await api('/api/sales/menus', { method: 'POST', body: JSON.stringify(body) });

      state.editing = saved;
      $('drawer-ref').textContent = saved.ref;
      $('drawer-heading').textContent = 'Edit proposal';
      $('drawer-delete').classList.remove('hidden');
      $('drawer-print').classList.remove('hidden');
      state.dirty = false;
      $('save-state').textContent = 'Saved';
      $('save-state').className = 'save-state ok';
      await loadMenus();
      if (!silent) toast(`Saved ${saved.ref}.`, 'ok');
      return saved;
    } catch (e) {
      toast(e.message, 'err');
      return null;
    } finally {
      delete btn.dataset.pending;
      btn.disabled = false;
    }
  }

  $('drawer-save').addEventListener('click', () => save());

  // Printing always saves first, so the PDF can never be generated from a stale
  // copy of a proposal the rep just edited.
  $('drawer-print').addEventListener('click', async () => {
    const saved = state.dirty || !state.editing?._id ? await save({ silent: true }) : state.editing;
    if (saved?._id) openPrint(saved._id);
  });

  $('drawer-delete').addEventListener('click', (e) => withPending(e.currentTarget, async () => {
    if (!state.editing?._id) return;
    if (!await confirmDialog(
      `Delete proposal ${state.editing.ref}${state.editing.title ? ` — "${state.editing.title}"` : ''}?\n\nThis cannot be undone.`,
      { title: 'Delete this proposal', confirmLabel: 'Delete it', danger: true })) return;
    try {
      await api(`/api/sales/menus/${state.editing._id}`, { method: 'DELETE' });
      state.dirty = false;
      closeEditor();
      await loadMenus();
      toast('Proposal deleted.', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }));

  $('prop-new').addEventListener('click', () => {
    state.pickedSponsors.clear();
    state.pickedBooths.clear();
    $$('.pick-card.picked').forEach(c => c.classList.remove('picked'));
    renderBasket();
    openEditor(null);
  });

  // Sign out is a POST — a GET that clears the session would let any page log
  // the rep out with an <img> tag.
  $('nav-signout').addEventListener('click', async (e) => {
    e.preventDefault();
    try { await fetch('/logout', { method: 'POST' }); } catch {}
    location.href = '/login';
  });

  // ── Load ────────────────────────────────────────────────────────────────────
  async function loadMenus() {
    state.menus = await api('/api/sales/menus');
    renderMenus();
  }

  /**
   * Which event this rep is selling.
   *
   * The admin console has had this for a while; the sales dashboard had no
   * switcher and no show at all, so a rep could only ever see whichever event
   * the deployment happened to call the default. Same design as the admin's:
   * each event is a separate URL, so switching is a navigation rather than
   * swapping the data underneath a live page.
   */
  async function initShowSwitcher() {
    const wrap = $('nav-show');
    const sel = $('show-switch');
    if (!wrap || !sel) return;

    let list = [];
    try { list = await api('/api/sales/shows'); } catch { list = []; }

    const here = (window.__SHOW && window.__SHOW.slug) || '';
    // Always shown, even with one event: naming the event you are quoting for
    // is worth the row on its own, and a rep who cannot see it has no way to
    // notice they are pricing the wrong hall.
    if (!list.length) {
      list = [{ slug: here, name: (window.__SHOW && window.__SHOW.name) || here || 'This event' }];
    }

    sel.replaceChildren(...list.map(sh => {
      const o = el('option', null, sh.name || sh.showId);
      o.value = sh.slug;
      return o;
    }));
    sel.value = here;
    // A slug that is not among the options would render the select BLANK, which
    // reads as broken and hides which event is open. Name something rather than
    // nothing.
    if (sel.selectedIndex < 0) sel.selectedIndex = 0;
    wrap.classList.remove('hidden');

    sel.addEventListener('change', () => {
      if (state.dirty && !window.confirm('You have unsaved changes to this proposal. Switch event anyway?')) {
        sel.value = here;
        return;
      }
      location.href = `/sales/${sel.value}`;
    });
  }

  async function init() {
    renderSizeFilterLabels();
    initShowSwitcher();
    try {
      const [me, cat] = await Promise.all([
        api('/api/sales/me'),
        api('/api/sales/catalogue'),
      ]);
      state.me = me;
      $('nav-username').textContent = me.name || me.user;
      // Only an admin or the owner previewing this dashboard gets a way back.
      $('nav-back-admin').classList.toggle('hidden', !me.isAdmin);

      window.UI.setCurrency(cat.currencySymbol);
      if (cat.unit) AREA_UNIT = cat.unit === 'ft' ? 'ft²' : 'm²';
      renderSizeFilterLabels();

      state.sponsors = cat.sponsors || [];
      state.booths   = cat.booths || [];
      renderSponsors();
      renderStands();
      renderBasket();
      await loadMenus();
      lucide.createIcons();
    } catch (e) {
      // A failure here leaves the dashboard blank; say why rather than showing
      // an empty page that looks like "there is nothing to sell".
      toast(`Could not load your dashboard: ${e.message}`, 'err');
    }
  }

  init();
})();
