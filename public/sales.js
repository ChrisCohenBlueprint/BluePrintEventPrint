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
  // Text nodes only — nothing from the database is ever written as HTML, so a
  // package name or client note containing markup can't inject into the page.
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const money = (n) => (n == null || !Number.isFinite(Number(n)))
    ? '—'
    : '€' + Number(n).toLocaleString('en-GB', { maximumFractionDigits: 0 });

  const area = (n) => (n == null ? '—' : `${Number(n).toLocaleString('en-GB', { maximumFractionDigits: 1 })} m²`);

  let toastTimer = null;
  function toast(msg, kind = '') {
    const t = $('toast');
    t.textContent = msg;
    t.className = `toast ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
  }

  /**
   * Fetch wrapper that treats an auth failure as an auth failure.
   *
   * A 401 means the 12h session expired mid-session; bouncing to the login page
   * is the only useful response. A 403 means the account isn't allowed here at
   * all, which is a different message — silently retrying either would just
   * render an empty dashboard with no explanation.
   */
  async function api(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (res.status === 401) { location.href = '/login?next=' + encodeURIComponent('/sales'); throw new Error('signed out'); }
    let data = null;
    try { data = await res.json(); } catch { /* empty body is fine on a 200 */ }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }

  // ── Navigation ──────────────────────────────────────────────────────────────
  const TITLES = {
    inventory: 'Remaining sponsorship',
    stands:    'Available stands',
    proposals: 'My proposals',
  };

  function showSection(name) {
    $$('.nav-link').forEach(l => l.classList.toggle('active', l.dataset.section === name));
    $$('.admin-section').forEach(s => s.classList.toggle('active', s.id === `section-${name}`));
    $('section-title').textContent = TITLES[name] || name;
  }

  $$('.nav-link').forEach(link =>
    link.addEventListener('click', () => showSection(link.dataset.section)));

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
    const sqm = Number(b.sqm) || 0;
    if (state.size === 's' && !(sqm < 12)) return false;
    if (state.size === 'm' && !(sqm >= 12 && sqm <= 30)) return false;
    if (state.size === 'l' && !(sqm > 30)) return false;
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
    copy.addEventListener('click', async () => {
      try {
        await api(`/api/sales/menus/${m._id}/duplicate`, { method: 'POST' });
        await loadMenus();
        toast('Proposal duplicated.', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });
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
  function openPrint(id) { window.open(`/sales/menu/${id}/print`, '_blank', 'noopener'); }

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
    p.placeholder = '€'; p.min = '0'; p.value = item.price == null ? '' : item.price;

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

  $('drawer-delete').addEventListener('click', async () => {
    if (!state.editing?._id) return;
    if (!confirm(`Delete proposal ${state.editing.ref}? This cannot be undone.`)) return;
    try {
      await api(`/api/sales/menus/${state.editing._id}`, { method: 'DELETE' });
      state.dirty = false;
      closeEditor();
      await loadMenus();
      toast('Proposal deleted.', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });

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

  async function init() {
    try {
      const [me, cat] = await Promise.all([
        api('/api/sales/me'),
        api('/api/sales/catalogue'),
      ]);
      state.me = me;
      $('nav-username').textContent = me.name || me.user;
      // Only an admin or the owner previewing this dashboard gets a way back.
      $('nav-back-admin').classList.toggle('hidden', !me.isAdmin);

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
