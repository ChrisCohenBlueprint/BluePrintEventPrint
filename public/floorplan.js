// ─── BluePrint EventPrint — Public Floorplan ──────────────────────────────────
// Browse and enquire. Booking and holding are administrator actions and are no
// longer reachable from this page.

// ─── Consent ──────────────────────────────────────────────────────────────────
// Behavioural events are not sent until the visitor accepts. Stand views still
// work; they simply are not recorded.
const CONSENT_KEY = 'bp_consent';
let consent = localStorage.getItem(CONSENT_KEY);          // 'granted' | 'denied' | null

const SESSION_KEY = 'bp_session';
function sessionId() {
  if (consent !== 'granted') return null;
  let s = localStorage.getItem(SESSION_KEY);
  if (!s) {
    s = (crypto.randomUUID?.() || Math.random().toString(16).slice(2).repeat(2)).replace(/-/g, '').slice(0, 32);
    localStorage.setItem(SESSION_KEY, s);
  }
  return s;
}

const socket = io({ auth: { sessionId: sessionId() } });

/** Emit a tracking-only event, suppressed when consent has not been given. */
function emitTracked(event, payload) {
  if (consent !== 'granted') return;
  socket.emit(event, payload);
}

function initConsent() {
  const bar = document.getElementById('consent-bar');
  if (!consent) bar.classList.remove('hidden');

  const decide = (value) => {
    consent = value;
    localStorage.setItem(CONSENT_KEY, value);
    bar.classList.add('hidden');
    if (value === 'granted') socket.emit('session:adopt', { sessionId: sessionId() });
    else localStorage.removeItem(SESSION_KEY);
  };
  document.getElementById('consent-accept').onclick  = () => decide('granted');
  document.getElementById('consent-decline').onclick = () => decide('denied');
}

// ─── State ────────────────────────────────────────────────────────────────────
let booths      = {};      // boothNumber → booth
let selectedId  = null;
let shortlist   = [];      // boothNumbers the visitor wants to enquire about

// The number to SHOW for a stand — the admin-set override if present, else the
// real identity. Identity (n / boothNumber) stays the key for lookups + emits.
const shownN = (n) => (booths[n] && booths[n].displayNumber) || n;

// Floorplan (title) sponsor: a brand colour that fills sponsored stands and
// shows as a "Sponsored" legend swatch. Pushed from the server on connect and
// whenever an admin changes it.
let sponsorColor = '', sponsorName = '';

// Readable text colour for a given background — dark ink on light brands, white
// on dark ones (WCAG relative-luminance threshold).
function contrastText(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '#111827';
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.4 ? '#111827' : '#ffffff';
}
let svgDoc      = null;
let submitted   = false;
let svgReady    = false;
let stateReady  = false;
let tagged      = false;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : '';

const STATUS_LABEL = { available: 'Available', held: 'On Hold', sold: 'Taken' };

// ─── Zoom / Pan ───────────────────────────────────────────────────────────────
const frame = document.getElementById('map-frame');
const inner = document.getElementById('map-inner');
let pz;

function initPanZoom() {
  pz = panzoom(inner, {
    maxZoom: 8, minZoom: 0.3, bounds: true, boundsPadding: 0.1,
    zoomDoubleClickSpeed: 1,
  });

  // Which parts of the hall people navigate toward, before they click anything.
  let zoomTimer = null;
  pz.on('zoom', () => {
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => {
      const t = pz.getTransform();
      emitTracked('plan:zoom', { level: Number(t.scale.toFixed(2)), cx: Math.round(t.x), cy: Math.round(t.y) });
    }, 700);
  });

  const zoomBy = (f) => {
    const r = frame.getBoundingClientRect();
    pz.smoothZoom(r.width / 2, r.height / 2, f);
  };
  document.getElementById('zoom-in').onclick  = () => zoomBy(1.5);
  document.getElementById('zoom-out').onclick = () => zoomBy(0.66);
  document.getElementById('zoom-reset').onclick = () => { pz.moveTo(0, 0); pz.zoomAbs(0, 0, 1); };
}

// ─── Load ─────────────────────────────────────────────────────────────────────
async function load() {
  const mount = document.getElementById('svg-mount');
  try {
    const svgRes = await fetch('/LEX26_Floorplan_Web-Format_57.svg');
    mount.innerHTML = await svgRes.text();
    svgDoc = mount.querySelector('svg');
    svgDoc.setAttribute('width', '100%');
    svgDoc.setAttribute('height', '100%');
    svgReady = true;
    tagBooths();

    lucide.createIcons();
    initPanZoom();
  } catch (e) {
    mount.innerHTML = '<p style="color:#dc2626;padding:20px">Floorplan could not be loaded. Please refresh.</p>';
  }
}

// Fires callback only when the pointer barely moved, so panning never selects.
function addTapListener(el, callback) {
  let sx = 0, sy = 0;
  el.addEventListener('pointerdown', e => { sx = e.clientX; sy = e.clientY; });
  el.addEventListener('pointerup', e => {
    if (Math.abs(e.clientX - sx) < 10 && Math.abs(e.clientY - sy) < 10) {
      e.stopPropagation();
      callback();
    }
  });
}

/**
 * Bind every server booth to a shape on the plan.
 *
 * Runs once both the SVG and the first state broadcast have arrived, in either
 * order — the 2.1 MB plan usually finishes downloading after the socket
 * connects, so neither can be assumed to be ready first.
 *
 * Identity comes from BoothMap's geometry matching. The old approach numbered
 * rectangles by their order in the file, which disagreed with the server for
 * most stands and broke completely whenever the plan was re-exported.
 */
function tagBooths() {
  if (!svgReady || !stateReady || tagged) return;
  tagged = true;

  const list = Object.values(booths).filter(b => b.geometry);
  const res = BoothMap.attach(svgDoc, list, {
    onTag(el, n) {
      el.classList.add('booth-interactive');
      el.addEventListener('mouseenter', e => showTooltip(e, n));
      el.addEventListener('mousemove',  e => moveTooltip(e));
      el.addEventListener('mouseleave', hideTooltip);
      addTapListener(el, () => { hideTooltip(); selectBooth(n); });
    },
  });

  if (res.unplaced.length) {
    console.warn(`${res.unplaced.length} stands could not be placed on the plan`);
  }

  Object.keys(booths).forEach(applyVisual);
  updateStatsStrip();
  openDeepLink();
}

// ─── Deep link: /floorplan?booth=412 ──────────────────────────────────────────
// Lets sales send a customer straight to a stand, and gives campaign traffic a
// trackable entry point.
let deepLinkDone = false;
function openDeepLink() {
  if (deepLinkDone) return;             // only on first tag — not on every re-tag
  const n = new URLSearchParams(location.search).get('booth');
  if (!n || !booths[n]) return;
  deepLinkDone = true;
  selectBooth(n);
  const el = svgDoc.querySelector(`[data-booth="${CSS.escape(n)}"]`);
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────
const tooltip = document.getElementById('fp-tooltip');
function showTooltip(e, n) {
  const b = booths[n];
  if (!b) return;                       // stand was removed under a lingering handler
  document.getElementById('tt-label').textContent  = `Stand ${shownN(n)}`;
  document.getElementById('tt-status').textContent = STATUS_LABEL[b.status] || cap(b.status);
  document.getElementById('tt-price').textContent  = b.status === 'available' && b.sqm ? `${b.sqm} m²` : '';
  tooltip.classList.remove('hidden');
  moveTooltip(e);
}
function moveTooltip(e) {
  const r = frame.getBoundingClientRect();
  tooltip.style.left = (e.clientX - r.left + 14) + 'px';
  tooltip.style.top  = (e.clientY - r.top - 10) + 'px';
}
function hideTooltip() { tooltip.classList.add('hidden'); }

// ─── Selection ────────────────────────────────────────────────────────────────
function selectBooth(n) {
  if (selectedId) {
    svgDoc.querySelector(`[data-booth="${CSS.escape(selectedId)}"]`)?.classList.remove('booth-selected');
  }
  selectedId = n;
  svgDoc.querySelector(`[data-booth="${CSS.escape(n)}"]`)?.classList.add('booth-selected');

  // Location is no longer derived from the browser timezone — the server
  // resolves it from the request, which is both accurate and unspoofable.
  emitTracked('booth:view',  { boothNumber: n });
  emitTracked('booth:click', { boothNumber: n });

  renderPanel(n);

  if (window.matchMedia('(pointer: coarse)').matches) {
    setTimeout(() => document.getElementById('booth-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
  }
}

// Captured once so the panel can be returned to its "Select a Stand" prompt if
// the stand a visitor had open is removed under them (an admin reset/merge).
const emptyPanelHTML = document.getElementById('booth-panel')?.innerHTML || '';
function hideSelection() {
  svgDoc?.querySelectorAll('.booth-selected').forEach(el => el.classList.remove('booth-selected'));
  const panel = document.getElementById('booth-panel');
  if (panel && emptyPanelHTML) { panel.innerHTML = emptyPanelHTML; if (window.lucide) lucide.createIcons(); }
  hideSponsors();
}

// ─── Shortlist ────────────────────────────────────────────────────────────────
// A prospect interested in three adjacent stands should send one enquiry, not
// three.
function toggleShortlist(n) {
  const i = shortlist.indexOf(n);
  if (i > -1) shortlist.splice(i, 1);
  else if (shortlist.length < 25) shortlist.push(n);
  renderShortlist();
  syncSponsorPanel();          // reveal / re-rank / hide sponsorship on commitment
  renderPanel(selectedId);
}

function renderShortlist() {
  const card = document.getElementById('enquiry-card');
  const box  = document.getElementById('eq-shortlist');

  if (!shortlist.length && !sponsorShortlist.length) { card.classList.add('hidden'); box.innerHTML = ''; return; }
  if (!submitted) card.classList.remove('hidden');

  const standChips = shortlist.map(n => `
    <button type="button" class="eq-chip" data-remove-booth="${esc(n)}" aria-label="Remove stand ${esc(shownN(n))}">
      Stand ${esc(shownN(n))} <span aria-hidden="true">×</span>
    </button>`).join('');

  const sponsorChips = sponsorShortlist.map(k => `
    <button type="button" class="eq-sponsor-chip" data-remove-sponsor="${esc(k)}" aria-label="Remove ${esc(sponsorCache[k]?.name || k)}">
      ${esc(sponsorCache[k]?.name || k)} <span aria-hidden="true">×</span>
    </button>`).join('');

  const parts = [];
  if (shortlist.length) parts.push(`${shortlist.length} stand${shortlist.length > 1 ? 's' : ''}`);
  if (sponsorShortlist.length) parts.push(`${sponsorShortlist.length} sponsorship option${sponsorShortlist.length > 1 ? 's' : ''}`);

  box.innerHTML = `
    <div class="eq-shortlist-lbl">Enquiring about ${parts.join(' + ')}</div>
    <div class="eq-chips">${standChips}</div>
    ${sponsorChips ? `<div class="eq-sponsor-chips">${sponsorChips}</div>` : ''}`;

  box.querySelectorAll('[data-remove-booth]').forEach(btn => {
    btn.onclick = () => toggleShortlist(btn.getAttribute('data-remove-booth'));
  });
  box.querySelectorAll('[data-remove-sponsor]').forEach(btn => {
    btn.onclick = () => toggleSponsor(btn.getAttribute('data-remove-sponsor'));
  });
  matchSponsorHeight();   // the enquiry column height changed; re-level the columns
}

// ─── Recommended sponsorship ────────────────────────────────────────────────
// Recommendations are ranked server-side by fit to the buyer's floor spend, and
// prices are never sent to the browser (sales cover cost during follow-up).
//
// They are fetched in the background as soon as a stand is looked at, but only
// revealed once the buyer commits — i.e. adds a stand to their enquiry. Showing
// it earlier pitches to someone who hasn't decided; showing it on commitment
// reaches someone who has, and the preload makes it appear instantly.
let sponsorShortlist = [];        // sponsor keys the buyer added
let sponsorCache = {};            // key → sponsor, for chip labels
let currentSponsorList = [];      // the list currently rendered, for re-render
let sponsorShowToken = 0;         // guards against stale async renders
let shownRecoSqm = null;          // the spend the visible recommendations are for

const recosCache = {};            // sqm → resolved list
const recosInflight = {};         // sqm → in-flight promise

// Below this width the panel stacks: enquiry first, sponsors compact below.
// Must match the CSS breakpoint.
const WIDE_BREAKPOINT = 1200;

function totalShortlistSqm() {
  return shortlist.reduce((sum, n) => sum + (booths[n]?.sqm || 0), 0);
}

function fetchRecos(sqm) {
  sqm = Number(sqm) || 0;
  if (sqm <= 0) return Promise.resolve([]);
  if (recosCache[sqm]) return Promise.resolve(recosCache[sqm]);
  if (!recosInflight[sqm]) {
    recosInflight[sqm] = fetch(`/sponsors/recommend?sqm=${encodeURIComponent(sqm)}`)
      .then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(d => (recosCache[sqm] = d.sponsors || []))
      // On a transient failure return an empty list for THIS attempt but do NOT
      // cache it — otherwise one network blip would leave that spend permanently
      // showing "no options". The next open retries.
      .catch(() => [])
      .finally(() => { delete recosInflight[sqm]; });
  }
  return recosInflight[sqm];
}

// Warm the cache silently — no UI change.
function preloadSponsorRecos(sqm) { fetchRecos(sqm); }

function updatePanelWidth() {
  const side = document.getElementById('fp-side');
  const showing = !document.getElementById('fp-sponsors').classList.contains('hidden');
  side.classList.toggle('has-selection', showing);
}

// Cap the sponsorship column to the enquiry column's height so the two end on
// the same line rather than the sponsorship list being cut off early. Below the
// wide-panel breakpoint the columns stack, so the cap is removed.
function matchSponsorHeight() {
  const sponsors = document.getElementById('fp-sponsors');
  const col = document.querySelector('.fp-enquiry-col');
  if (!sponsors || !col) return;
  if (window.innerWidth <= WIDE_BREAKPOINT) { sponsors.style.maxHeight = ''; return; }
  // Measure on the next frame so the enquiry column has settled after any
  // shortlist or form change.
  requestAnimationFrame(() => {
    const h = col.offsetHeight;
    if (h > 0) sponsors.style.maxHeight = h + 'px';
  });
}
window.addEventListener('resize', matchSponsorHeight);

// Reveal the panel for a given spend. Renders instantly if preloaded.
async function showSponsorRecos(sqm) {
  sqm = Number(sqm) || 0;
  const panel = document.getElementById('fp-sponsors');
  const box = document.getElementById('sponsor-recos');
  const token = ++sponsorShowToken;
  panel.classList.remove('hidden');
  updatePanelWidth();

  if (recosCache[sqm]) { renderSponsors(recosCache[sqm]); return; }
  box.innerHTML = '<div class="sponsor-recos-empty">Finding the best fit…</div>';
  const list = await fetchRecos(sqm);
  if (token === sponsorShowToken) renderSponsors(list);
}

function hideSponsors() {
  document.getElementById('fp-sponsors').classList.add('hidden');
  updatePanelWidth();
}

// Keep the sponsorship panel in step with the enquiry: shown once at least one
// stand is committed, hidden otherwise, and re-ranked when the total spend
// changes.
function syncSponsorPanel() {
  if (!shortlist.length) { hideSponsors(); shownRecoSqm = null; return; }
  const total = totalShortlistSqm();
  if (total !== shownRecoSqm) { shownRecoSqm = total; showSponsorRecos(total); }
  else { document.getElementById('fp-sponsors').classList.remove('hidden'); updatePanelWidth(); }
}

function renderSponsors(list) {
  currentSponsorList = list;
  // A package can sell out while someone has it shortlisted. Drop it rather
  // than sending an enquiry for something that is no longer available.
  for (const s of list) {
    if (!s.soldOut) continue;
    const i = sponsorShortlist.indexOf(s.key);
    if (i > -1) sponsorShortlist.splice(i, 1);
  }
  const box = document.getElementById('sponsor-recos');
  box.replaceChildren();
  if (!list.length) { box.innerHTML = '<div class="sponsor-recos-empty">No sponsorship options available.</div>'; return; }

  // On a tight screen the columns stack and the enquiry comes first, so the
  // sponsor cards start collapsed to a compact header — tap to open one. Added
  // options stay open so their remove control is reachable.
  const compact = window.innerWidth <= WIDE_BREAKPOINT;

  list.forEach(s => {
    sponsorCache[s.key] = s;
    const inList = sponsorShortlist.includes(s.key);

    const card = document.createElement('div');
    card.className = `sponsor-card tier-${esc(s.tier || 'silver')}${s.soldOut ? ' sold-out' : ''}`;
    const collapsed = compact && !inList;
    if (collapsed) card.classList.add('collapsed');

    // Header — always visible, toggles the body open/closed.
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'sc-head';
    const name = document.createElement('div'); name.className = 'sc-name'; name.textContent = s.name;
    const right = document.createElement('div'); right.className = 'sc-head-right';
    if (inList) { const chk = document.createElement('span'); chk.className = 'sc-added-dot'; right.appendChild(chk); }
    if (s.soldOut) {
      const badge = document.createElement('span'); badge.className = 'sc-soldout'; badge.textContent = 'Sold out';
      right.appendChild(badge);
    }
    const tier = document.createElement('span'); tier.className = 'sc-tier'; tier.textContent = s.tier || '';
    const chev = document.createElement('i'); chev.className = 'sc-chevron'; chev.setAttribute('data-lucide', 'chevron-down');
    right.append(tier, chev);
    head.append(name, right);
    head.onclick = () => {
      card.classList.toggle('collapsed');
      matchSponsorHeight();
    };
    card.appendChild(head);

    // Body — collapsible.
    const body = document.createElement('div');
    body.className = 'sc-body';

    if (s.availability) {
      const av = document.createElement('div'); av.className = 'sc-avail'; av.textContent = s.availability;
      body.appendChild(av);
    }
    if (s.blurb) {
      const bl = document.createElement('div'); bl.className = 'sc-blurb'; bl.textContent = s.blurb;
      body.appendChild(bl);
    }

    // Media: video takes precedence over image if both are set.
    if (s.video || s.image) {
      const media = document.createElement('div'); media.className = 'sc-media';
      if (s.video) {
        const v = document.createElement('video');
        v.src = s.video; v.controls = true; v.preload = 'metadata'; v.playsInline = true;
        media.appendChild(v);
      } else {
        const img = document.createElement('img');
        img.src = s.image; img.alt = s.name; img.loading = 'lazy';
        img.onerror = () => media.remove();
        media.appendChild(img);
      }
      body.appendChild(media);
    }

    if (Array.isArray(s.perks) && s.perks.length) {
      const ul = document.createElement('ul'); ul.className = 'sc-perks';
      s.perks.slice(0, 5).forEach(p => { const li = document.createElement('li'); li.textContent = p; ul.appendChild(li); });
      body.appendChild(ul);
    }

    if (s.soldOut) {
      // Kept on the plan deliberately: seeing a package gone is what makes the
      // next one feel scarce. It just can't be added to an enquiry.
      const gone = document.createElement('div');
      gone.className = 'sc-soldout-note';
      gone.textContent = 'Sold out for 2026 — register interest for next year';
      body.appendChild(gone);
    } else {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = `sc-add ${inList ? 'in-list' : ''}`;
      add.innerHTML = `<i data-lucide="${inList ? 'check' : 'plus'}"></i> ${inList ? 'Added to enquiry' : 'Add to enquiry'}`;
      add.onclick = () => toggleSponsor(s.key);
      body.appendChild(add);
    }

    card.appendChild(body);
    box.appendChild(card);
  });
  lucide.createIcons();
  matchSponsorHeight();
}

function toggleSponsor(key) {
  const i = sponsorShortlist.indexOf(key);
  if (i > -1) sponsorShortlist.splice(i, 1);           // removing is always allowed
  // A sold-out package can't be ADDED, but one already on the shortlist can
  // still be removed (it may have sold out while shortlisted).
  else if (!sponsorCache[key]?.soldOut && sponsorShortlist.length < 25) sponsorShortlist.push(key);
  renderShortlist();
  renderSponsors(currentSponsorList);   // refresh the Added/Add button states
}

// ─── Detail panel ─────────────────────────────────────────────────────────────
function renderPanel(n) {
  if (!n) return;
  const b     = booths[n] || { status: 'sold' };
  const panel = document.getElementById('booth-panel');
  panel.classList.remove('hidden');

  const status = b.status || 'sold';
  const inList = shortlist.includes(n);

  // Warm the recommendations in the background as soon as an available stand is
  // looked at — including the spend it would add to the current shortlist — so
  // they appear instantly if and when the buyer commits. They are only shown by
  // syncSponsorPanel() once a stand is actually added to the enquiry.
  if (status === 'available') preloadSponsorRecos(totalShortlistSqm() + (b.sqm || 0));
  syncSponsorPanel();

  if (status !== 'available') {
    panel.innerHTML = `
      <div class="stand-header">
        <div class="stand-id">Stand ${esc(shownN(n))}</div>
        <div class="stand-badge badge-${esc(status)}">${esc(STATUS_LABEL[status] || cap(status))}</div>
      </div>
      <div class="stand-stats">
        <div class="stand-stat"><span class="stand-stat-lbl">Size</span><span class="stand-stat-val">${b.sqm ? esc(b.sqm) + ' m²' : '—'}</span></div>
        <div class="stand-stat"><span class="stand-stat-lbl">Status</span><span class="stand-stat-val">${esc(STATUS_LABEL[status] || cap(status))}</span></div>
      </div>
      <div class="stand-taken-notice">
        <i data-lucide="lock" style="width:14px;height:14px"></i>
        ${status === 'held' ? 'This stand is currently on hold.' : 'This stand has been taken.'}
      </div>
      <p class="stand-alt">Interested in something nearby? Select an available stand and we'll suggest alternatives.</p>`;
    lucide.createIcons();
    return;
  }

  panel.innerHTML = `
    <div class="stand-header">
      <div class="stand-id">Stand ${esc(n)}</div>
      <div class="stand-badge badge-available">Available</div>
    </div>
    <div class="stand-stats">
      <div class="stand-stat"><span class="stand-stat-lbl">Size</span><span class="stand-stat-val">${b.sqm ? esc(b.sqm) + ' m²' : '—'}</span></div>
      <div class="stand-stat"><span class="stand-stat-lbl">Viewing now</span><span class="stand-stat-val">${esc(b.viewers || 0)}</span></div>
      <div class="stand-stat"><span class="stand-stat-lbl">Interest</span><span class="stand-stat-val" style="color:var(--orange)">${esc(b.interest || 0)}</span></div>
    </div>
    <button type="button" class="btn-shortlist ${inList ? 'in-list' : ''}" id="shortlist-btn">
      <i data-lucide="${inList ? 'check' : 'plus'}"></i>
      ${inList ? 'Added to enquiry' : 'Add to enquiry'}
    </button>
    <p class="stand-hint">Add the stands you're interested in, then send us one enquiry.</p>`;

  document.getElementById('shortlist-btn').onclick = () => toggleShortlist(n);
  lucide.createIcons();
}

// ─── Enquiry submission ───────────────────────────────────────────────────────
function initForm() {
  const form    = document.getElementById('enquiry-form');
  const errBox  = document.getElementById('eq-errors');
  const success = document.getElementById('eq-success');
  const submit  = document.getElementById('eq-submit');

  form.onsubmit = (e) => {
    e.preventDefault();
    errBox.classList.add('hidden');
    errBox.textContent = '';

    const payload = {
      name:    document.getElementById('eq-contact').value.trim(),
      email:   document.getElementById('eq-email').value.trim(),
      company: document.getElementById('eq-company').value.trim(),
      phone:   document.getElementById('eq-phone').value.trim(),
      message: document.getElementById('eq-message').value.trim(),
      website: document.getElementById('eq-website').value,   // honeypot
      boothNumbers: shortlist.slice(),
      sponsorKeys: sponsorShortlist.slice(),
    };

    submit.disabled = true;
    submit.textContent = 'Sending…';

    // The server is authoritative on validation; this ack carries its verdict.
    socket.emit('inquiry:submit', payload, (res) => {
      submit.disabled = false;
      submit.innerHTML = '<i data-lucide="send"></i> Send enquiry';
      lucide.createIcons();

      if (res && res.ok) {
        submitted = true;
        form.classList.add('hidden');
        document.getElementById('eq-shortlist').classList.add('hidden');
        success.classList.remove('hidden');
        lucide.createIcons();
        return;
      }
      const errors = (res && res.errors) || ['Something went wrong. Please try again.'];
      errBox.innerHTML = errors.map(x => `<div>${esc(x)}</div>`).join('');
      errBox.classList.remove('hidden');
    });
  };
}

// ─── Socket events ────────────────────────────────────────────────────────────
let lastMapSig = '';
socket.on('state:full', (rows) => {
  const incoming = new Set(rows.map(b => b.boothNumber));
  rows.forEach(b => {
    const n = b.boothNumber;
    booths[n] = { ...(booths[n] || {}), ...b };
  });
  // Reconcile: drop booths the server no longer has (a merged secondary, a
  // reset cell). Left in place they'd keep rendering, stay clickable, and be
  // counted in the availability totals until a full reload.
  Object.keys(booths).forEach(n => { if (!incoming.has(n)) delete booths[n]; });
  if (selectedId && !booths[selectedId]) { selectedId = null; hideSelection(); }
  stateReady = true;

  // First broadcast may arrive before the plan has finished downloading.
  if (!tagged) { tagBooths(); lastMapSig = BoothMap.signature(rows); return; }

  // A split/merge/reset changes the STRUCTURE (booths added/removed, geometry
  // moved), which one-shot tagging would never reflect without a reload. Detect
  // it via a structural fingerprint and re-tag the whole map; otherwise just
  // repaint statuses.
  const sig = BoothMap.signature(rows);
  if (sig !== lastMapSig) { lastMapSig = sig; retagMap(); }
  else rows.forEach(b => applyVisual(b.boothNumber));

  if (selectedId) renderPanel(selectedId);
  updateStatsStrip();
});

// Re-run the SVG↔booth mapping from a clean slate after a structural change.
function retagMap() {
  if (!svgDoc) return;
  BoothMap.clear(svgDoc);
  tagged = false;
  tagBooths();   // re-attaches overlays/handlers and repaints every booth
}

socket.on('stats:updated', (stats) => {
  if (stats.availableBooths != null) document.getElementById('avail-count').textContent = stats.availableBooths;
  if (stats.availSqm != null) document.getElementById('avail-sqm').textContent = stats.availSqm.toLocaleString();
  updateStatsStrip();
});

socket.on('viewers:count', (n) => {
  document.getElementById('viewer-count').textContent = n;
});

socket.on('error:action', ({ message }) => console.warn(message));

socket.on('floorplan-sponsor', (s) => {
  sponsorColor = (s && s.color) || '';
  sponsorName  = (s && s.name)  || '';
  renderSponsorLegend();
  // Repaint so sponsored stands pick up (or drop) the brand fill.
  if (tagged) Object.keys(booths).forEach(applyVisual);
});

// Show/hide the "Sponsored" legend swatch and colour it to match the brand.
function renderSponsorLegend() {
  const item = document.getElementById('leg-sponsored');
  if (!item) return;
  if (sponsorColor) {
    const dot = item.querySelector('.leg-dot');
    if (dot) { dot.style.background = sponsorColor; dot.style.borderColor = sponsorColor; }
    item.hidden = false;
  } else item.hidden = true;
}

function applyVisual(n) {
  const el = svgDoc?.querySelector(`[data-booth="${CSS.escape(n)}"]`);
  if (!el) return;

  const status = booths[n]?.status || 'sold';
  el.classList.remove('booth-available', 'booth-sold', 'booth-held');
  el.classList.add(`booth-${status}`);

  if (shortlist.includes(n)) el.classList.add('booth-shortlisted');
  else el.classList.remove('booth-shortlisted');

  // Floorplan-sponsor fill: a sponsored stand is painted in the brand colour,
  // overriding its status fill. Cleared inline when unsponsored so the status
  // class shows through again.
  const sponsored = booths[n]?.sponsored && sponsorColor;
  el.classList.toggle('booth-sponsored', !!sponsored);
  // The status fills are `!important`; an inline `important` property beats them.
  if (sponsored) el.style.setProperty('fill', sponsorColor, 'important');
  else el.style.removeProperty('fill');

  // Exhibitor name painted onto the stand, as before. textContent, never
  // innerHTML — the value reaches here from the public enquiry form.
  let textNode = svgDoc.querySelector(`#text-booth-${CSS.escape(n)}`);
  const company = booths[n]?.company;

  if (status !== 'available' && company) {
    if (!textNode) {
      textNode = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      textNode.setAttribute('id', `text-booth-${n}`);
      textNode.setAttribute('fill', '#111827');
      textNode.style.pointerEvents = 'none';
      el.parentNode.appendChild(textNode);
    }
    // getBBox throws if the element isn't rendered/laid out yet. Mirror the
    // admin guard: skip labelling this frame rather than letting it throw.
    let bbox;
    try { bbox = el.getBBox(); } catch { return; }
    // Wrap / hyphenate / shrink to fit — never truncate.
    // Match the weight/size of the artwork's baked-in exhibitor labels (e.g.
    // NYNAS), which are lighter and a touch smaller than the previous 700/14px
    // default — otherwise our live names looked bolder and larger than the plan.
    BoothMap.fitLabel(textNode, company, { x: bbox.x, y: bbox.y, w: bbox.width, h: bbox.height },
      { family: 'Raleway, sans-serif', weight: '600', maxFont: 12 });
    // Keep the name legible on a dark brand fill (white text), dark ink otherwise.
    textNode.setAttribute('fill', sponsored ? contrastText(sponsorColor) : '#111827');
  } else if (textNode) {
    textNode.remove();
  }
}

function updateStatsStrip() {
  const all   = Object.values(booths);
  const avail = all.filter(b => b.status === 'available');
  const resv  = all.filter(b => b.status === 'held');
  document.getElementById('stat-avail').textContent = avail.length;
  document.getElementById('stat-sqm').textContent   = avail.reduce((s, b) => s + (b.sqm || 0), 0).toLocaleString();
  document.getElementById('stat-held').textContent  = resv.length;
}

// ─── Sponsor strip ────────────────────────────────────────────────────────────
// Driven entirely by /sponsors/sponsors.json so logos can be added, removed or
// reordered by editing that file and dropping an image alongside it. Built with
// DOM nodes rather than markup, so a stray character in a sponsor name cannot
// become executable.
async function loadSponsors() {
  const strip = document.getElementById('sponsor-strip');
  try {
    // Managed from the admin Sponsors page, so logos change without a deploy.
    const res = await fetch('/partners', { cache: 'no-cache' });
    if (!res.ok) return;
    const cfg = await res.json();
    const list = Array.isArray(cfg.partners) ? cfg.partners.filter(s => s && s.image) : [];
    if (!list.length) return;                       // no sponsors: strip stays hidden

    document.getElementById('sponsor-heading').textContent = cfg.heading || 'In partnership with';

    const box = document.getElementById('sponsor-logos');
    box.replaceChildren();
    for (const s of list) {
      const img = document.createElement('img');
      img.src = s.image;
      img.alt = s.alt || s.name || 'Sponsor';
      img.loading = 'lazy';
      // A missing file shouldn't leave a broken-image icon on a customer page.
      img.onerror = () => wrapper.remove();

      const wrapper = s.url ? document.createElement('a') : document.createElement('span');
      if (s.url) {
        wrapper.href = s.url;
        wrapper.target = '_blank';
        wrapper.rel = 'noopener noreferrer';
        wrapper.title = s.name || '';
      }
      wrapper.appendChild(img);
      box.appendChild(wrapper);
    }
    strip.classList.remove('hidden');
  } catch {
    /* strip simply stays hidden */
  }
}

initConsent();
initForm();
loadSponsors();
load();
