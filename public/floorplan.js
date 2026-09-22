// ─── BluePrint EventPrint — Public Floorplan ──────────────────────────────────
// Browse and enquire. Booking and holding are administrator actions and are no
// longer reachable from this page.

// ─── Storage ──────────────────────────────────────────────────────────────────
//
// Every read and write goes through here. `localStorage` is not a property you
// can simply touch: Safari with cookies blocked, and any browser with
// third-party storage restricted, THROW on the property access itself — not on
// the get. This page is iframed into the marketing site, so that is the normal
// case, not the edge case. The first line of this file used to be a bare
// localStorage.getItem(); the exception it threw was uncaught, so nothing after
// it ran and the visitor sat on "Loading floorplan…" forever.
//
// Falls back to an in-memory map: consent and the session id then last for the
// tab rather than for the visitor, which is the right trade — a browser that
// refuses storage is a browser asking not to be remembered.
const memStore = new Map();
const store = {
  get(k) {
    try { const v = window.localStorage.getItem(k); return v == null ? (memStore.has(k) ? memStore.get(k) : null) : v; }
    catch { return memStore.has(k) ? memStore.get(k) : null; }
  },
  set(k, v) {
    memStore.set(k, v);
    try { window.localStorage.setItem(k, v); } catch { /* memory copy already holds it */ }
  },
  remove(k) {
    memStore.delete(k);
    try { window.localStorage.removeItem(k); } catch { /* nothing to remove */ }
  },
};

// ─── Consent ──────────────────────────────────────────────────────────────────
// Behavioural events are not sent until the visitor accepts. Stand views still
// work; they simply are not recorded.
const CONSENT_KEY = 'bp_consent';
let consent = store.get(CONSENT_KEY);                     // 'granted' | 'denied' | null

const SESSION_KEY = 'bp_session';
function sessionId() {
  if (consent !== 'granted') return null;
  let s = store.get(SESSION_KEY);
  if (!s) {
    s = (crypto.randomUUID?.() || Math.random().toString(16).slice(2).repeat(2)).replace(/-/g, '').slice(0, 32);
    store.set(SESSION_KEY, s);
  }
  return s;
}

// The show this page is for, injected by the server (see send-page.js). Passed
// in the handshake so the socket joins the right event's rooms — without it a
// booking on one plan would appear on another's.
const SHOW = (window.__SHOW && window.__SHOW.slug) || '';
// What this event is CALLED. The page markup used to say "LEX 2026" in the
// title, the description, the header and the download filename, so North
// America's plan announced itself as Europe's and downloaded as
// "LEX-2026-Floorplan-….png". The show data is injected per request; use it.
const SHOW_NAME = (window.__SHOW && window.__SHOW.name) || 'Interactive Expo Floorplan';
// A filename-safe token for the download. The event id (LEX / LNA / LME) is
// already short and stable; the year comes from the clock, not from a literal
// that goes stale in January.
const SHOW_CODE = String((window.__SHOW && window.__SHOW.showId) || 'Floorplan').replace(/[^A-Za-z0-9-]+/g, '');
// `auth` is a FUNCTION, not an object. An object is evaluated once, at socket
// construction — before consent can have been given — and socket.io then
// replays that same frozen value on every reconnect. So a visitor who accepted
// consent and then moved from wifi to mobile data reconnected with
// sessionId:null, the server minted a fresh anonymous id, and one person became
// three unrelated sessions in the sales history. A function is called on every
// connection attempt, so the id in force right now is the one that is sent.
const socket = io({ auth: (cb) => cb({ sessionId: sessionId() }), query: { show: SHOW } });

/** Emit a tracking-only event, suppressed when consent has not been given. */
function emitTracked(event, payload) {
  if (consent !== 'granted') return;
  socket.emit(event, payload);
}

/**
 * Consent, including the case this page is actually deployed in.
 *
 * ── Host-page protocol (for whoever maintains the marketing site) ────────────
 * This page is embedded with ?embed=1, and in embed mode our own consent bar is
 * hidden so two cookie banners don't stack. That left `consent` null forever,
 * emitTracked() never fired, and booth:view / booth:click / plan:zoom were never
 * sent from the only place the plan is really used — so the sales heatmap was
 * empty for every real visitor. The host's banner has to tell us what the
 * visitor chose. Two equivalent ways, use either:
 *
 *   1. Query parameter, when the host already knows at iframe-build time:
 *        <iframe src="https://…/floorplan?embed=1&consent=granted">
 *      Accepted values: granted | denied (declined is taken as denied).
 *
 *   2. postMessage, for a choice made or changed after the frame is loaded:
 *        iframe.contentWindow.postMessage(
 *          { type: 'bp-consent', value: 'granted' }, 'https://<our-origin>');
 *      Send it again with 'declined' if the visitor withdraws consent; we stop
 *      sending behavioural events immediately and drop the stored session id.
 *      Safe to send before we have finished loading — post it on the iframe's
 *      load event, or simply post it on every banner change.
 *
 * Nothing else is accepted from the host: the message is ignored unless it is
 * that exact shape, so an unrelated postMessage on the page cannot turn
 * tracking on.
 */
function initConsent() {
  const bar = document.getElementById('consent-bar');

  const decide = (value) => {
    consent = value;
    store.set(CONSENT_KEY, value);
    bar.classList.add('hidden');
    if (value === 'granted') socket.emit('session:adopt', { sessionId: sessionId() });
    else store.remove(SESSION_KEY);
  };

  // The host's answer, however it arrived. Normalised because a cookie banner's
  // own vocabulary ('declined', 'denied') should not decide whether we listen.
  const adopt = (raw) => {
    const v = String(raw || '').toLowerCase();
    if (v !== 'granted' && v !== 'denied' && v !== 'declined') return false;
    decide(v === 'granted' ? 'granted' : 'denied');
    return true;
  };

  const fromQuery = new URLSearchParams(location.search).get('consent');
  const answered = adopt(fromQuery) || !!consent;
  if (!answered) bar.classList.remove('hidden');

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object' || d.type !== 'bp-consent') return;
    adopt(d.value);
  });

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

// Area unit label (m²/ft²), pushed from the server. A label only — no price or
// numeric conversion reaches the public client.
let UNIT = 'm²';

// Floorplan (title) sponsor: a brand colour that fills sponsored stands and
// shows as a "Sponsored" legend swatch. Pushed from the server on connect and
// whenever an admin changes it.
let sponsorColor = '', sponsorName = '';

// The exhibitor tag catalogue, pushed from the server. Booths carry tag KEYS;
// this resolves each to its label and colour, so an admin renaming or
// recolouring a tag repaints every open floorplan without a reload.
let tagCatalogue = [];
const tagByKey = (key) => tagCatalogue.find(t => t.key === key) || null;

// The country list, fetched once from /countries. Booths carry an ISO code;
// this resolves it to a name, a flag and the everyday names people search by
// ("USA", "Holland"), so the label can be corrected server-side without any
// stand having to be re-saved.
let countryList = [];
let countryByCode = new Map();
const countryOf = (code) => countryByCode.get(String(code || '').toUpperCase()) || null;

fetch('/countries', { cache: 'force-cache' })
  .then(r => r.ok ? r.json() : { countries: [] })
  .then(d => {
    countryList = Array.isArray(d.countries) ? d.countries : [];
    countryByCode = new Map(countryList.map(c => [c.code, c]));
    // The plan and the first broadcast may already have arrived — redraw the
    // filter's country dropdown and any open stand now that codes resolve.
    refreshFilterOptions();
    if (selectedId) renderPanel(selectedId);
  })
  .catch(() => { /* search still works on company + activity without it */ });

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
  const dl = document.getElementById('download-plan');
  if (dl) dl.onclick = downloadPlan;
}

/**
 * Bring a stand into view by PANNING THE MAP.
 *
 * This replaces el.scrollIntoView(), which was wrong in three separate ways on
 * an SVG rect inside a panzoom frame:
 *   • .fp-map-frame is overflow:hidden, so the browser scrolled it anyway and
 *     left a scrollTop/scrollLeft that panzoom knows nothing about — the plan
 *     ended up offset from its own transform, and "Reset View" (which only
 *     resets the transform) could never put it back.
 *   • scrollIntoView walks EVERY scrollable ancestor. Inside the marketing
 *     site's iframe that includes the host page, so a ?booth=412 link made the
 *     customer's own website jump.
 *   • It ignores zoom, so on a whole-hall view it "arrived" at a 4-pixel stand.
 *
 * Panning is done as a delta from the element's measured screen box, which is
 * the one reading that is already correct whatever the viewBox,
 * preserveAspectRatio letterboxing and current transform are doing. The zoom
 * target is worked out from BoothMap.visualBox — the stand's real footprint in
 * SVG units, post-rotation — so a 9 m² stand and a 200 m² one both end up a
 * sensible size on screen.
 */
function panToBooth(n) {
  if (!pz || !svgDoc) return;
  const el = standEl(n);
  if (!el) return;
  const fr = frame.getBoundingClientRect();
  if (!fr.width || !fr.height) return;

  // Everything is worked out from ONE measurement and then applied, rather than
  // zooming and re-measuring: panzoom writes its transform on the next animation
  // frame, so a getBoundingClientRect() taken straight after a zoom still
  // describes where the stand WAS — which panned the hall clean off the screen.
  const er = el.getBoundingClientRect();
  if (!er.width && !er.height) return;
  const t = pz.getTransform();
  // The stand's centre in the map's own untransformed coordinates.
  const localX = ((er.left + er.width / 2) - fr.left - t.x) / t.scale;
  const localY = ((er.top + er.height / 2) - fr.top - t.y) / t.scale;

  // Zoom IN when the stand is too small to read — never out. A visitor who has
  // zoomed into one aisle should not be thrown back to the whole hall because a
  // search matched. The stand's real footprint comes from BoothMap.visualBox,
  // which is post-rotation: most stands on this artwork are rotated, and the
  // untransformed box would give a target size for the wrong dimension.
  let scale = t.scale;
  const box = BoothMap.visualBox(el);
  const vb = svgDoc.viewBox && svgDoc.viewBox.baseVal;
  if (box && box.w > 0 && box.h > 0 && vb && vb.width > 0) {
    const sr = svgDoc.getBoundingClientRect();
    // preserveAspectRatio "meet" letterboxes, so the live scale is the SMALLER
    // of the two ratios, not whichever axis we happened to pick.
    const pxPerUnit = Math.min(sr.width / vb.width, sr.height / vb.height);
    if (pxPerUnit > 0) {
      const want = Math.min(fr.width, fr.height) * 0.3 / Math.max(box.w, box.h);
      const target = Math.max(t.scale, Math.min(8, t.scale * (want / pxPerUnit)));
      if (target > t.scale * 1.05) { scale = target; pz.zoomAbs(0, 0, scale); }
    }
  }

  // Put that point in the middle of the frame at whatever scale we settled on.
  pz.smoothMoveTo(fr.width / 2 - localX * scale, fr.height / 2 - localY * scale);
}

// Wire the collapse chevrons on the sponsorship + enquiry boxes. Each folds its
// body away (client-side only, per visitor) and rotates its chevron; the height
// cap between the two columns is re-evaluated so the layout stays tidy.
function wireCollapsers() {
  [['fp-sponsors', 'sp-collapse', 'sponsorship'], ['enquiry-card', 'eq-collapse', 'enquiry']]
    .forEach(([boxId, btnId, label]) => {
      const box = document.getElementById(boxId), btn = document.getElementById(btnId);
      if (!box || !btn) return;
      btn.addEventListener('click', () => {
        const collapsed = box.classList.toggle('collapsed');
        btn.setAttribute('aria-expanded', String(!collapsed));
        btn.title = (collapsed ? 'Show ' : 'Hide ') + label;
        // Folding sponsorship narrows the whole panel (see .sponsors-collapsed) so
        // the plan reclaims the space rather than leaving an empty column.
        if (boxId === 'fp-sponsors') {
          document.getElementById('fp-side').classList.toggle('sponsors-collapsed', collapsed);
        }
      });
    });
}

// ─── Load ─────────────────────────────────────────────────────────────────────

/**
 * The "this did not work" state, with a way out.
 *
 * The old handler caught only a thrown fetch. A 500 does not throw, so an error
 * page was injected as markup, querySelector('svg') returned null, and the next
 * line threw on a null — leaving the visitor an unstyled red line, no plan, and
 * no way forward but guessing at a reload. Built from DOM nodes rather than
 * markup so a server error body can never become page content.
 */
function showLoadError(detail) {
  const mount = document.getElementById('svg-mount');
  mount.replaceChildren();
  const box = document.createElement('div');
  box.className = 'load-error';
  box.setAttribute('role', 'alert');
  const h = document.createElement('h3');
  h.textContent = 'The floorplan could not be loaded';
  const p = document.createElement('p');
  p.textContent = 'This is usually a connection blip. Try again — nothing you have selected is lost.';
  const small = document.createElement('p');
  small.className = 'load-error-detail';
  small.textContent = detail || '';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'load-retry';
  btn.textContent = 'Try again';
  btn.onclick = () => { btn.disabled = true; load(); };
  box.append(h, p, btn);
  if (detail) box.append(small);
  mount.appendChild(box);
}

// The socket can connect and then say nothing — an authentication problem, a
// show with no stands, a broadcast that never fires. The plan renders, no stand
// is clickable, and the three stats sit on "—" with nothing to explain it. Say
// so rather than leaving the visitor clicking a dead map.
let stateWatchdog = null;
function armStateWatchdog() {
  clearTimeout(stateWatchdog);
  stateWatchdog = setTimeout(() => {
    if (stateReady) return;
    setBanner('The stands have not loaded yet, so nothing on the plan is clickable. Still trying…', 'warn');
  }, 8000);
}

/** The one-line strip under the toolbar used for connection + load trouble. */
function setBanner(text, kind) {
  const el = document.getElementById('fp-banner');
  if (!el) return;
  if (!text) { el.hidden = true; el.textContent = ''; return; }
  el.textContent = text;
  el.className = 'fp-banner' + (kind ? ' fp-banner-' + kind : '');
  el.hidden = false;
}

let collapsersWired = false;
async function load() {
  if (!collapsersWired) { collapsersWired = true; wireCollapsers(); }
  const mount = document.getElementById('svg-mount');
  mount.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'loading-state';
  loading.textContent = 'Loading floorplan…';
  mount.appendChild(loading);
  armStateWatchdog();
  try {
    // The artwork for THIS show — uploaded per event, falling back to the file
    // shipped with the app. The page's X-Show header decides which comes back.
    // The event is in the URL, not only in a header. Every event used to
    // request the same /floorplan.svg and rely on X-Show to distinguish them,
    // which any cache in between is entitled to ignore — and did: one event's
    // plan was served for another's for the five minutes it stayed cached.
    const svgRes = await fetch(`/floorplan.svg?show=${encodeURIComponent(SHOW)}`);
    // A 4xx/5xx does not throw. Checked BEFORE the body is used, or an error
    // page is injected as markup and every failure after it is a null-deref
    // with a misleading message.
    if (!svgRes.ok) throw new Error(`The plan could not be fetched (${svgRes.status}).`);
    const text = await svgRes.text();
    mount.innerHTML = text;
    svgDoc = mount.querySelector('svg');
    if (!svgDoc) throw new Error('The plan came back without any artwork in it.');
    svgDoc.setAttribute('width', '100%');
    svgDoc.setAttribute('height', '100%');
    svgReady = true;
    // A retry after a structural failure must rebuild the bindings, not skip
    // them because a previous attempt set the flag.
    tagged = false;
    tagBooths();

    lucide.createIcons();
    // A retry re-creates the plan under the old panzoom instance; dispose it
    // first or the page ends up with two sets of pointer handlers fighting.
    if (pz) { try { pz.dispose(); } catch { /* already gone */ } pz = null; }
    initPanZoom();
  } catch (e) {
    svgReady = false;
    showLoadError(e && e.message ? e.message : '');
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
  dropElementCache();      // attach() is about to build brand-new elements

  const list = Object.values(booths).filter(b => b.geometry);
  const res = BoothMap.attach(svgDoc, list, {
    unit: UNIT,   // printed on a split cell's size, the way the plan prints its own
    onTag(el, n) {
      el.classList.add('booth-interactive');
      el.addEventListener('mouseenter', e => showTooltip(e, n));
      el.addEventListener('mousemove',  e => moveTooltip(e));
      el.addEventListener('mouseleave', hideTooltip);
      addTapListener(el, () => { hideTooltip(); selectBooth(n); });

      // Keyboard and screen readers. Until this, the ONLY way to open a stand
      // without a mouse was to type a search term that matched exactly one
      // stand and press Enter — and a screen reader was told nothing at all,
      // because a bare <rect> has no role and no name. A stand is a button:
      // say so, give it a name, and let Enter and Space press it.
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'button');
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
        e.preventDefault();          // Space would otherwise scroll the page
        selectBooth(n);
      });
      // Focusing a stand with the keyboard has to bring it into view, the same
      // as clicking one does — by panning, never by scrolling (see panToBooth).
      el.addEventListener('focus', () => panToBooth(n));
      labelStand(el, n);
    },
  });

  if (res.unplaced.length) {
    console.warn(`${res.unplaced.length} stands could not be placed on the plan`);
  }

  Object.keys(booths).forEach(applyVisual);

  // attach() built brand-new elements, so the selection ring has to be put back
  // — applyVisual restores the status/shortlist/sponsor classes but not this
  // one. Without it, any re-tag (a split, a merge, or now a renumber) silently
  // dropped the highlight from the stand the visitor still has open.
  if (selectedId) {
    svgDoc.querySelector(`[data-booth="${CSS.escape(selectedId)}"]`)?.classList.add('booth-selected');
  }

  updateStatsStrip();
  paintAreas();          // a re-tag rebuilds the plan under them
  openDeepLink();
}

// The unit spoken rather than printed. "36 m²" is read as "36 m 2" by most
// screen readers, which is not a size.
const SPOKEN_UNIT = () => (UNIT === 'ft²' ? 'square feet' : 'square metres');

/**
 * The accessible name of a stand — what a screen reader announces, and what the
 * A–Z directory lists it under. Everything a sighted visitor gets from the
 * tooltip: which stand, whether it can be had, how big it is, and who is on it
 * when that is public.
 */
function standLabel(n) {
  const b = booths[n] || {};
  const bits = [`Stand ${shownN(n)}`, (STATUS_LABEL[b.status] || cap(b.status) || 'unknown').toLowerCase()];
  // Only a SOLD stand names its exhibitor — the same rule the panel and the
  // search follow, so a hold is never announced as a booking.
  if (b.status === 'sold' && b.company) bits.push(`taken by ${b.company}`);
  if (b.sqm) bits.push(`${b.sqm} ${SPOKEN_UNIT()}`);
  return bits.join(', ');
}

function labelStand(el, n) {
  const label = standLabel(n);
  if (el.getAttribute('aria-label') !== label) el.setAttribute('aria-label', label);
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
  // Panned, never scrolled: scrollIntoView on a rect inside the overflow:hidden
  // panzoom frame also scrolls the HOST page this plan is iframed into, so a
  // ?booth=412 link in a sales email made the customer's own website jump.
  panToBooth(n);
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────
const tooltip = document.getElementById('fp-tooltip');
function showTooltip(e, n) {
  const b = booths[n];
  if (!b) return;                       // stand was removed under a lingering handler
  document.getElementById('tt-label').textContent  = `Stand ${shownN(n)}`;
  document.getElementById('tt-status').textContent = STATUS_LABEL[b.status] || cap(b.status);
  document.getElementById('tt-price').textContent  = b.status === 'available' && b.sqm ? `${b.sqm} ${UNIT}` : '';
  tooltip.classList.remove('hidden');
  moveTooltip(e);
}
// Where the tooltip's coordinates are measured from, cached.
//
// Two fixes in one. getBoundingClientRect() forces a layout, and this ran on
// EVERY mousemove across a 6000-node plan; the box only changes when the window
// or the side panel does, so it is recomputed then instead.
//
// And it is measured from the tooltip's own offsetParent, which is the map
// PANEL, not the map frame. The frame starts below the toolbar, so subtracting
// the frame's top from a client coordinate and then using it as an offset
// inside the panel pushed the tooltip down by the toolbar's height — about 100
// pixels below the pointer it is meant to be labelling.
let anchorRect = null;
const anchorBox = () => {
  if (!anchorRect) anchorRect = (tooltip.offsetParent || frame).getBoundingClientRect();
  return anchorRect;
};
const dropFrameBox = () => { anchorRect = null; };
window.addEventListener('resize', dropFrameBox);
window.addEventListener('scroll', dropFrameBox, true);

function moveTooltip(e) {
  const r = anchorBox();
  tooltip.style.left = (e.clientX - r.left + 14) + 'px';
  tooltip.style.top  = (e.clientY - r.top - 10) + 'px';
}
function hideTooltip() { tooltip.classList.add('hidden'); }

// ─── Selection ────────────────────────────────────────────────────────────────
function selectBooth(n) {
  if (selectedArea) {
    svgDoc?.querySelectorAll('[data-area]').forEach(el => el.classList.remove('booth-selected'));
    selectedArea = null;
  }
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
    // block:'nearest' — 'start' scrolls every ancestor to put the panel at the
    // top, which inside the marketing site's iframe means scrolling the host
    // page. 'nearest' moves things only as far as it has to.
    setTimeout(() => document.getElementById('booth-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);
  }
}

// Captured once so the panel can be returned to its "Select a Stand" prompt if
// the stand a visitor had open is removed under them (an admin reset/merge).
const emptyPanelHTML = document.getElementById('booth-panel')?.innerHTML || '';
function hideSelection() {
  svgDoc?.querySelectorAll('.booth-selected').forEach(el => el.classList.remove('booth-selected'));
  const panel = document.getElementById('booth-panel');
  if (panel && emptyPanelHTML) { panel.innerHTML = emptyPanelHTML; if (window.lucide) lucide.createIcons(); }
  // The panel no longer shows any stand, so the "already showing this" marker
  // renderPanel() skips on has to go with it — otherwise re-opening the SAME
  // stand would be a no-op and the visitor would be left on the empty prompt.
  forgetRenderedPanel();
  hideSponsors();
}

// ─── Shortlist ────────────────────────────────────────────────────────────────
// A prospect interested in three adjacent stands should send one enquiry, not
// three.
function toggleShortlist(n) {
  const i = shortlist.indexOf(n);
  if (i > -1) shortlist.splice(i, 1);
  else if (shortlist.length < 25) shortlist.push(n);
  // Repaint the stand NOW. The green shortlist fill used to appear only when
  // the next state:full happened to arrive, so on a quiet plan adding a stand
  // changed nothing visible on the map at all — and now that broadcasts skip
  // unchanged stands it would never have appeared.
  applyVisual(n);
  renderShortlist();
  syncSponsorPanel();          // reveal / re-rank / hide sponsorship on commitment
  renderPanel(selectedId);
}

function renderShortlist() {
  const card = document.getElementById('enquiry-card');
  const box  = document.getElementById('eq-shortlist');
  const foot = document.getElementById('eq-footer');   // fixed Send button bar

  if (!shortlist.length && !sponsorShortlist.length && !areaShortlist.length) {
    card.classList.add('hidden'); if (foot) foot.hidden = true; box.innerHTML = ''; return;
  }
  if (!submitted) { card.classList.remove('hidden'); if (foot) foot.hidden = false; }

  const standChips = shortlist.map(n => `
    <button type="button" class="eq-chip" data-remove-booth="${esc(n)}" aria-label="Remove stand ${esc(shownN(n))}">
      Stand ${esc(shownN(n))} <span aria-hidden="true">×</span>
    </button>`).join('');

  const sponsorChips = sponsorShortlist.map(k => `
    <button type="button" class="eq-sponsor-chip" data-remove-sponsor="${esc(k)}" aria-label="Remove ${esc(sponsorCache[k]?.name || k)}">
      ${esc(sponsorCache[k]?.name || k)} <span aria-hidden="true">×</span>
    </button>`).join('');

  const areaChips = areaShortlist.map(k => `
    <button type="button" class="eq-sponsor-chip" data-remove-area="${esc(k)}" aria-label="Remove ${esc(areaByKey(k)?.label || k)}">
      ${esc(areaByKey(k)?.label || k)} <span aria-hidden="true">×</span>
    </button>`).join('');

  const parts = [];
  if (shortlist.length) parts.push(`${shortlist.length} stand${shortlist.length > 1 ? 's' : ''}`);
  if (areaShortlist.length) parts.push(`${areaShortlist.length} area${areaShortlist.length > 1 ? 's' : ''}`);
  if (sponsorShortlist.length) parts.push(`${sponsorShortlist.length} sponsorship option${sponsorShortlist.length > 1 ? 's' : ''}`);

  box.innerHTML = `
    <div class="eq-shortlist-lbl">Enquiring about ${parts.join(' + ')}</div>
    <div class="eq-chips">${standChips}</div>
    ${areaChips ? `<div class="eq-sponsor-chips">${areaChips}</div>` : ''}
    ${sponsorChips ? `<div class="eq-sponsor-chips">${sponsorChips}</div>` : ''}`;

  box.querySelectorAll('[data-remove-booth]').forEach(btn => {
    btn.onclick = () => toggleShortlist(btn.getAttribute('data-remove-booth'));
  });
  box.querySelectorAll('[data-remove-sponsor]').forEach(btn => {
    btn.onclick = () => toggleSponsor(btn.getAttribute('data-remove-sponsor'));
  });
  box.querySelectorAll('[data-remove-area]').forEach(btn => {
    btn.onclick = () => toggleAreaShortlist(btn.getAttribute('data-remove-area'));
  });
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

// matchSponsorHeight() used to live here: a hook that capped the sponsorship
// box's height so it ended level with the enquiry beside it. The selection
// column scrolls as one now, so nothing sets that cap and the function had
// become a no-op — one that six call sites and a resize listener still paid
// for, and that read as if it were doing something. Removed rather than kept
// "in case": the layout rule it enforced is in the stylesheet.

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
      // Not a literal year: this page serves three events and is still up
      // the January after. The show's own name, and next year from the clock.
      gone.textContent = `Sold out at ${SHOW_NAME} — register interest for ${new Date().getFullYear() + 1}`;
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

/**
 * Who has this stand, and what they do — the block shown when a visitor clicks
 * a taken stand.
 *
 * Only for a SOLD stand. A hold is a provisional deal, and the server withholds
 * the tags on a held stand for the same reason; naming the company on one would
 * announce a booking that has not been agreed.
 */
function exhibitorHTML(b, status) {
  if (status !== 'sold' || !b.company) return '';

  const chips = (b.tags || [])
    .map(tagByKey)
    .filter(Boolean)
    .slice(0, 3)
    .map(t => `<span class="tag-chip" style="background:${esc(t.color)};color:${esc(contrastText(t.color))}">${esc(t.label)}</span>`)
    .join('');

  const country = countryOf(b.country);

  return `
    <div class="stand-exhibitor">
      <div class="stand-exhibitor-lbl">Exhibitor</div>
      <div class="stand-exhibitor-name">${esc(b.company)}</div>
      ${country ? `<div class="stand-country"><span class="stand-flag">${esc(country.flag)}</span>${esc(country.name)}</div>` : ''}
      ${chips ? `<div class="stand-tags">${chips}</div>` : ''}
    </div>`;
}

// ─── Detail panel ─────────────────────────────────────────────────────────────

/**
 * Rebuild the panel's markup without throwing away the keyboard.
 *
 * innerHTML replaces every node, so whatever the visitor had focused — very
 * often "Add to enquiry", because that is the button they were on their way to
 * pressing — was destroyed. The panel re-rendered on every broadcast, so ANY
 * other visitor's action moved a keyboard user's focus back to the top of the
 * document mid-task. Focus is restored by element id, which survives a rebuild
 * because the ids are stable.
 */
function rebuildPanel(html, wire) {
  const panel = document.getElementById('booth-panel');
  const active = document.activeElement;
  const keepId = active && panel.contains(active) ? active.id : null;
  // A text field also loses its caret and its half-typed value, so carry those.
  const keepValue = keepId && 'value' in active ? active.value : null;
  const keepStart = keepId && active.selectionStart != null ? active.selectionStart : null;

  panel.innerHTML = html;
  if (wire) wire();
  lucide.createIcons();

  if (!keepId) return;
  const back = document.getElementById(keepId);
  if (!back) return;
  if (keepValue != null && 'value' in back) back.value = keepValue;
  back.focus();
  if (keepStart != null && back.setSelectionRange) {
    try { back.setSelectionRange(keepStart, keepStart); } catch { /* not a text input */ }
  }
}

/**
 * Everything the panel's MARKUP depends on.
 *
 * Deliberately excludes `viewers` and `interest`: those change constantly as
 * other people browse, and rebuilding the panel for them is exactly what was
 * stealing focus. They are written into their own spans in place instead — see
 * updateLiveStats().
 */
function panelSig(n) {
  const b = booths[n] || {};
  return [n, b.status, b.company || '', b.sqm || '', b.displayNumber || '',
          b.sponsored ? 1 : 0, shortlist.includes(n) ? 1 : 0, UNIT,
          (b.tags || []).join('+'), b.country || '', waitlisted.includes(n) ? 1 : 0,
          // The alternatives listed on a taken stand are drawn from what is
          // available elsewhere on the plan, so they are part of this panel.
          b.status === 'available' ? '' : alternativeKey(n)].join('|');
}
let shownPanelSig = '';

/**
 * Forget what the panel is showing.
 *
 * Anything that replaces the panel's contents WITHOUT going through
 * renderPanel() — the empty prompt, an area — has to call this, or re-opening
 * the same stand hits the "nothing changed" short-circuit and does nothing.
 */
function forgetRenderedPanel() {
  shownPanelSig = '';
  const panel = document.getElementById('booth-panel');
  if (panel) delete panel.dataset.booth;
}

/**
 * Available stands near a taken one, ranked.
 *
 * The taken-stand panel has promised "select an available stand and we'll
 * suggest alternatives" since it was written, and nothing ever suggested any.
 * Ranking is distance first — a customer who wanted 412 wants the aisle 412 is
 * on — with size similarity as a multiplier rather than a second sort key, so a
 * 9 m² shell two metres away does not beat a 100 m² stand one aisle over when
 * the stand they asked about was 100 m².
 */
function centreOf(g) { return { x: g.x + g.w / 2, y: g.y + g.h / 2 }; }

function alternativesFor(n, limit = 4) {
  const b = booths[n];
  if (!b || !b.geometry) return [];
  const c = centreOf(b.geometry);
  const want = b.sqm || 0;

  return Object.entries(booths)
    .filter(([k, x]) => k !== n && x && x.status === 'available' && x.geometry)
    .map(([k, x]) => {
      const d = Math.hypot(centreOf(x.geometry).x - c.x, centreOf(x.geometry).y - c.y);
      // 0 when the size matches, 1 when it is double or half, capped at 2 so a
      // wildly wrong size is penalised but never ranked below the whole hall.
      const gap = want ? Math.min(2, Math.abs((x.sqm || 0) - want) / want) : 0;
      return { n: k, sqm: x.sqm || 0, d, score: d * (1 + gap) };
    })
    .sort((p, q) => p.score - q.score)
    .slice(0, limit);
}

// Part of the panel signature: which alternatives would be listed. It is what
// stops the chips going stale when the stand one points at is sold.
function alternativeKey(n) {
  return alternativesFor(n).map(a => a.n).join(',');
}

/**
 * "Tell me if this becomes available" — the waiting list on a held or taken
 * stand.
 *
 * Sent down the EXISTING inquiry:submit pipeline rather than adding a server
 * surface: it is a lead like any other, and it lands in the same admin list
 * with the stand attached. See submitWaitlist() for the one thing the server
 * still needs.
 */
function waitlistHTML(n) {
  if (waitlisted.includes(n)) {
    return `<div class="wl-done" role="status"><i data-lucide="check-circle"></i>
      We'll email you if Stand ${esc(shownN(n))} becomes available.</div>`;
  }
  return `
    <div class="wl-box">
      <label class="wl-lbl" for="wl-email">Tell me if this becomes available</label>
      <div class="wl-row">
        <input type="email" id="wl-email" class="wl-input" placeholder="you@company.com"
               autocomplete="email" aria-describedby="wl-note">
        <button type="button" class="wl-btn" id="wl-submit">Notify me</button>
      </div>
      <div class="wl-err hidden" id="wl-err" role="alert"></div>
      <p class="wl-note" id="wl-note">Your email, nothing else. We'll only use it for this stand.</p>
    </div>`;
}

function renderPanel(n, opts) {
  if (!n) return;
  const force = !!(opts && opts.force);
  const panel = document.getElementById('booth-panel');
  const sig = panelSig(n);
  // A broadcast that changed nothing about THIS stand must not rebuild the
  // panel — see rebuildPanel() for what a rebuild costs a keyboard user.
  if (!force && sig === shownPanelSig && panel.dataset.booth === n) {
    updateLiveStats(n);
    return;
  }
  shownPanelSig = sig;

  const b = booths[n] || { status: 'sold' };
  panel.classList.remove('hidden');
  panel.dataset.booth = n;

  const status = b.status || 'sold';
  const inList = shortlist.includes(n);

  // Warm the recommendations in the background as soon as an available stand is
  // looked at — including the spend it would add to the current shortlist — so
  // they appear instantly if and when the buyer commits. They are only shown by
  // syncSponsorPanel() once a stand is actually added to the enquiry.
  if (status === 'available') preloadSponsorRecos(totalShortlistSqm() + (b.sqm || 0));
  syncSponsorPanel();

  if (status !== 'available') {
    const alts = alternativesFor(n);
    const altHTML = alts.length ? `
      <div class="stand-alts">
        <div class="stand-alts-lbl">Available nearby</div>
        <div class="stand-alt-chips">${alts.map(a => `
          <button type="button" class="alt-chip" data-alt="${esc(a.n)}"
                  aria-label="Open stand ${esc(shownN(a.n))}, ${esc(a.sqm || 0)} ${esc(SPOKEN_UNIT())}">
            <span class="alt-n">${esc(shownN(a.n))}</span>
            <span class="alt-sqm">${a.sqm ? esc(a.sqm) + ' ' + esc(UNIT) : ''}</span>
          </button>`).join('')}</div>
      </div>`
      : '<p class="stand-alt">Nothing is available close by right now — try the search, or add another stand to your enquiry.</p>';

    rebuildPanel(`
      <div class="stand-header">
        <div class="stand-id">Stand ${esc(shownN(n))}</div>
        <div class="stand-badge badge-${esc(status)}">${esc(STATUS_LABEL[status] || cap(status))}</div>
      </div>
      <div class="stand-stats">
        <div class="stand-stat"><span class="stand-stat-lbl">Size</span><span class="stand-stat-val">${b.sqm ? esc(b.sqm) + ' ' + esc(UNIT) : '—'}</span></div>
        <div class="stand-stat"><span class="stand-stat-lbl">Status</span><span class="stand-stat-val">${esc(STATUS_LABEL[status] || cap(status))}</span></div>
      </div>
      ${exhibitorHTML(b, status)}
      <div class="stand-taken-notice">
        <i data-lucide="lock" style="width:14px;height:14px"></i>
        ${status === 'held' ? 'This stand is currently on hold.' : 'This stand has been taken.'}
      </div>
      ${altHTML}
      ${waitlistHTML(n)}`, () => {
      document.querySelectorAll('#booth-panel [data-alt]').forEach(btn => {
        btn.onclick = () => {
          const k = btn.getAttribute('data-alt');
          selectBooth(k);
          panToBooth(k);
        };
      });
      const wl = document.getElementById('wl-submit');
      if (wl) wl.onclick = () => submitWaitlist(n);
      const wlIn = document.getElementById('wl-email');
      if (wlIn) wlIn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitWaitlist(n); }
      });
    });
    return;
  }

  rebuildPanel(`
    <div class="stand-header">
      <div class="stand-id">Stand ${esc(shownN(n))}</div>
      <div class="stand-badge badge-available">Available</div>
    </div>
    <div class="stand-stats">
      <div class="stand-stat"><span class="stand-stat-lbl">Size</span><span class="stand-stat-val">${b.sqm ? esc(b.sqm) + ' ' + esc(UNIT) : '—'}</span></div>
      <div class="stand-stat"><span class="stand-stat-lbl">Viewing now</span><span class="stand-stat-val" id="stand-viewers">${esc(b.viewers || 0)}</span></div>
      <div class="stand-stat"><span class="stand-stat-lbl">Interest</span><span class="stand-stat-val" id="stand-interest" style="color:var(--orange)">${esc(b.interest || 0)}</span></div>
    </div>
    <button type="button" class="btn-shortlist ${inList ? 'in-list' : ''}" id="shortlist-btn">
      <i data-lucide="${inList ? 'check' : 'plus'}"></i>
      ${inList ? 'Added to enquiry' : 'Add to enquiry'}
    </button>
    <p class="stand-hint">Add the stands you're interested in, then send us one enquiry.</p>`, () => {
    document.getElementById('shortlist-btn').onclick = () => toggleShortlist(n);
  });
}

/**
 * The two numbers that change as other people browse, written straight into
 * their spans. No rebuild, so nobody's focus or half-typed email is lost when a
 * stranger opens the same stand.
 */
function updateLiveStats(n) {
  if (document.getElementById('booth-panel').dataset.booth !== n) return;
  const b = booths[n] || {};
  const v = document.getElementById('stand-viewers');
  if (v) v.textContent = b.viewers || 0;
  const i = document.getElementById('stand-interest');
  if (i) i.textContent = b.interest || 0;
}

// Stands this visitor has asked to be told about, so the panel can say so
// rather than offering the form again.
const waitlisted = [];

/**
 * Send a waiting-list request as an ordinary enquiry.
 *
 * SERVER NOTE — what this needs that it does not have:
 *   inquiries.create() requires a contact NAME as well as an email, so a
 *   genuinely email-only request cannot be stored as-is. Until that changes we
 *   send the email's local part as the name and say plainly in the message that
 *   no name was given, so nobody in sales reads "j.smith" as a person's name.
 *   The clean fix is one of:
 *     • allow create() with a valid email and no name when a new
 *       `kind: 'waitlist'` flag is set, or
 *     • accept `source: 'waitlist'` and skip the name check for it.
 *   Either is a few lines in server/models/inquiries.js — owned by another
 *   agent, so it is reported rather than edited here.
 */
function submitWaitlist(n) {
  const input = document.getElementById('wl-email');
  const err   = document.getElementById('wl-err');
  const btn   = document.getElementById('wl-submit');
  if (!input || !btn) return;

  const email = input.value.trim();
  const fail = (msg) => {
    if (err) { err.textContent = msg; err.classList.remove('hidden'); }
    input.focus();
  };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail('Please enter a valid email address.');
  if (err) err.classList.add('hidden');

  btn.disabled = true;
  btn.textContent = 'Sending…';

  // `kind: 'waitlist'` is what lets this go in with no name: the server relaxes
  // that one rule for a waiting-list request and files the lead as a waitlist
  // rather than an enquiry, so sales can tell "wants this stand" from "wants to
  // hear if it frees up". Until that existed this sent the email's local part
  // as a first name, which put invented names on real leads.
  emitWithTimeout('inquiry:submit', {
    kind: 'waitlist',
    email,
    boothNumbers: [n],
    message: `Waiting list: tell me if Stand ${shownN(n)} becomes available. `
           + 'Submitted from the public floorplan with an email address only.',
  }, (res) => {
    btn.disabled = false;
    btn.textContent = 'Notify me';
    if (res && res.ok) {
      waitlisted.push(n);
      renderPanel(n, { force: true });
      return;
    }
    fail((res && res.errors && res.errors[0]) || 'That could not be sent. Please try again.');
  });
}

// ─── Enquiry submission ───────────────────────────────────────────────────────

/**
 * Emit with an acknowledgement DEADLINE.
 *
 * A socket.io ack that never arrives never arrives: there is no built-in
 * timeout on this code path, so if the server dies mid-request, or the
 * connection drops between the emit and the reply, the callback is simply never
 * called. The Send button sat on "Sending…", disabled, forever — the visitor's
 * enquiry looked like it was in flight when nothing was listening. Now the
 * callback always runs exactly once, with the server's verdict or with ours.
 */
function emitWithTimeout(event, payload, cb, ms = 12000) {
  let done = false;
  const finish = (res) => { if (done) return; done = true; clearTimeout(timer); cb(res); };
  const timer = setTimeout(() => finish({
    ok: false,
    errors: ['We did not hear back from the server. Check your connection and try again.'],
  }), ms);
  // An emit while offline is buffered by socket.io and may go nowhere; say so
  // rather than letting it sit in the queue behind a disabled button.
  if (!socket.connected) return finish({ ok: false, errors: ['You appear to be offline. Reconnect and try again.'] });
  socket.emit(event, payload, finish);
}

function initForm() {
  const form    = document.getElementById('enquiry-form');
  const errBox  = document.getElementById('eq-errors');
  const success = document.getElementById('eq-success');
  const submit  = document.getElementById('eq-submit');

  // Start again after a successful enquiry.
  //
  // The card was hidden permanently on success, but "Add to enquiry" carried on
  // toggling the shortlist underneath it with nothing to show for it — a
  // visitor who sent one enquiry and then found two more stands was clicking a
  // button that did nothing visible. Resetting is the honest answer.
  const again = document.getElementById('eq-again');
  if (again) {
    again.onclick = () => {
      submitted = false;
      shortlist.length = 0;
      sponsorShortlist.length = 0;
      areaShortlist.length = 0;
      // Only the selection is cleared — the visitor's own name, email and
      // company stay, because the second enquiry is from the same person.
      document.getElementById('eq-message').value = '';
      success.classList.add('hidden');
      form.classList.remove('hidden');
      document.getElementById('eq-shortlist').classList.remove('hidden');
      errBox.classList.add('hidden');
      if (svgDoc) svgDoc.querySelectorAll('.booth-shortlisted').forEach(el => el.classList.remove('booth-shortlisted'));
      renderShortlist();
      syncSponsorPanel();
      if (selectedId) renderPanel(selectedId, { force: true });
      document.getElementById('eq-first').focus();
    };
  }

  form.onsubmit = (e) => {
    e.preventDefault();
    errBox.classList.add('hidden');
    errBox.textContent = '';

    const payload = {
      firstName: document.getElementById('eq-first').value.trim(),
      lastName:  document.getElementById('eq-last').value.trim(),
      email:     document.getElementById('eq-email').value.trim(),
      phone:     document.getElementById('eq-phone').value.trim(),
      company:   document.getElementById('eq-company').value.trim(),
      jobTitle:  document.getElementById('eq-jobtitle').value.trim(),
      heardAbout: document.getElementById('eq-heard').value,
      message:   document.getElementById('eq-message').value.trim(),
      website:   document.getElementById('eq-website').value,   // honeypot
      boothNumbers: shortlist.slice(),
      sponsorKeys: sponsorShortlist.slice(),
      areaKeys: areaShortlist.slice(),
    };

    submit.disabled = true;
    submit.textContent = 'Sending…';

    // The server is authoritative on validation; this ack carries its verdict —
    // or, if none comes back in time, ours.
    emitWithTimeout('inquiry:submit', payload, (res) => {
      submit.disabled = false;
      submit.innerHTML = '<i data-lucide="send"></i> Send enquiry';
      lucide.createIcons();
      syncSendButton();       // still disabled if the reason was being offline

      if (res && res.ok) {
        submitted = true;
        form.classList.add('hidden');
        document.getElementById('eq-footer').hidden = true;   // hide the Send bar
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

// ─── Connection state ─────────────────────────────────────────────────────────
//
// Nothing used to notice a dropped socket. The "live viewers" badge kept its
// green dot and its last count while the page was talking to nobody, and Send
// stayed enabled so an enquiry could be typed out and fired into a closed
// connection. Both are now driven by the real connection state.
let everConnected = false;

function syncSendButton() {
  const submit = document.getElementById('eq-submit');
  if (!submit) return;
  const offline = !socket.connected;
  // Never re-enable a button that is mid-send; that is owned by the submit path.
  if (offline) {
    submit.disabled = true;
    submit.title = 'Reconnecting — your enquiry will be sendable again in a moment.';
  } else if (submit.title) {
    submit.disabled = false;
    submit.title = '';
  }
  const wl = document.getElementById('wl-submit');
  if (wl && !wl.textContent.includes('Sending')) wl.disabled = offline;
}

function setConnectionState(online) {
  const badge = document.getElementById('live-badge');
  if (badge) {
    badge.classList.toggle('offline', !online);
    badge.title = online ? '' : 'Disconnected — reconnecting';
    const label = document.getElementById('live-label');
    if (label) label.textContent = online ? 'live viewers' : 'reconnecting…';
  }
  syncSendButton();
}

socket.on('connect', () => {
  everConnected = true;
  setConnectionState(true);
  setBanner('');
  // The server mints a fresh session id on every new connection, so a granted
  // consent has to be re-asserted or this visitor's events after a reconnect
  // are filed under a stranger. The handshake `auth` function already carries
  // it; this covers a server that was restarted and has no memory of the id.
  if (consent === 'granted') socket.emit('session:adopt', { sessionId: sessionId() });
  armStateWatchdog();
});

socket.on('disconnect', (reason) => {
  setConnectionState(false);
  setBanner('Connection lost — the plan may be out of date. Reconnecting…', 'warn');
  if (reason === 'io server disconnect') socket.connect?.();   // not retried automatically
});

socket.on('connect_error', () => {
  setConnectionState(false);
  setBanner(everConnected
    ? 'Connection lost — the plan may be out of date. Reconnecting…'
    : 'Cannot reach the live plan. Stand availability may be out of date.', 'warn');
});

// ─── Socket events ────────────────────────────────────────────────────────────
let lastMapSig = '';

// What a stand LOOKS like. applyVisual() does three whole-tree querySelectors
// and, for a sold stand, a BoothMap.fitLabel() that measures the name at up to
// 18 font sizes — each measurement a forced synchronous layout of a 6000-node
// SVG. Running that for all ~250 stands on every broadcast is what made one
// visitor's hover freeze every other visitor's plan. The server now only
// broadcasts on real mutations; this makes sure that even then we repaint only
// the stands whose appearance actually changed.
const visualSig = (b) => [b.status, b.company || '', b.sponsored ? 1 : 0,
                          b.sponsorLogo || '', b.displayNumber || ''].join('|');
const lastVisual = {};

socket.on('state:full', (rows) => {
  const incoming = new Set(rows.map(b => b.boothNumber));
  // Which stands actually changed appearance, worked out BEFORE the merge while
  // the previous values are still readable.
  const dirty = [];
  rows.forEach(b => {
    const n = b.boothNumber;
    const sig = visualSig(b);
    if (lastVisual[n] !== sig) { lastVisual[n] = sig; dirty.push(n); }
    booths[n] = { ...(booths[n] || {}), ...b };
  });
  // Reconcile: drop booths the server no longer has (a merged secondary, a
  // reset cell). Left in place they'd keep rendering, stay clickable, and be
  // counted in the availability totals until a full reload.
  Object.keys(booths).forEach(n => {
    if (incoming.has(n)) return;
    delete booths[n];
    delete lastVisual[n];
  });
  if (selectedId && !booths[selectedId]) { selectedId = null; hideSelection(); }
  stateReady = true;
  clearTimeout(stateWatchdog);
  setBanner('');

  // A stand booked, released or re-tagged while the page is open changes both
  // what the filter dropdowns can offer and what the current filter matches.
  // Ahead of everything below: the first broadcast returns early once it has
  // tagged the map, and applyVisual paints the highlight from these matches.
  refreshFilterOptions();
  // applyFilter() recomputes the matches itself — computing them here as well
  // ran the whole booth scan twice on every single broadcast.
  applyFilter();
  renderDirectory();

  // First broadcast may arrive before the plan has finished downloading.
  if (!tagged) { tagBooths(); lastMapSig = BoothMap.signature(rows); return; }

  // A split/merge/reset changes the STRUCTURE (booths added/removed, geometry
  // moved), which one-shot tagging would never reflect without a reload. Detect
  // it via a structural fingerprint and re-tag the whole map; otherwise just
  // repaint the stands that changed.
  const sig = BoothMap.signature(rows);
  if (sig !== lastMapSig) { lastMapSig = sig; retagMap(); }
  else dirty.forEach(applyVisual);

  if (selectedId) renderPanel(selectedId);
  updateStatsStrip();
  renderSponsorLegend();   // a stand may have just been (un)flagged sponsored
});

// Presence only — how many people are looking at each stand right now.
//
// This used to ride along inside state:full, so every hover by every visitor
// re-ran the whole repaint above for everyone. It is now its own event, and it
// touches nothing but the numbers: no label re-fit, no panel rebuild, no filter
// recompute. See the SHARED SOCKET CONTRACT in server/sockets/index.js.
socket.on('viewers:map', (map) => {
  if (!map || typeof map !== 'object') return;
  Object.keys(booths).forEach(n => { booths[n].viewers = map[n] || 0; });
  if (selectedId) updateLiveStats(selectedId);
});

// Re-run the SVG↔booth mapping from a clean slate after a structural change.
function retagMap() {
  if (!svgDoc) return;
  BoothMap.clear(svgDoc);
  dropElementCache();      // clear() replaced every tagged node
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

// Area unit label pushed from the server (m²/ft²). Update the static labels and
// re-render the open panel + stats so the unit changes live.
socket.on('settings', (s) => {
  if (!s) return;
  // The colours this event's spaces are painted in, before anything is
  // painted. Only when the event actually carries the field: the unit and
  // currency handlers send partial settings, and applying an absent palette
  // stripped the event's colours every time an admin changed the unit.
  if ('palette' in s) { BoothPalette.apply(s.palette); updateAreaLegend(); }
  repaintLabels();
  if (!s.unit) return;
  UNIT = s.unit === 'ft' ? 'ft²' : 'm²';
  document.querySelectorAll('.unit-label').forEach(el => { el.textContent = UNIT; });
  // The size printed on a split cell carries the unit too.
  if (svgDoc) svgDoc.querySelectorAll('[data-split-size]').forEach((t) => {
    const b = booths[t.getAttribute('data-split-size')];
    if (b && b.sqm) t.textContent = b.sqm + UNIT;
  });
  if (selectedId) renderPanel(selectedId);
  // The unit is spoken in every stand's accessible name and printed in the
  // directory, so both follow it.
  if (svgDoc) svgDoc.querySelectorAll('[data-booth]').forEach(el => labelStand(el, el.getAttribute('data-booth')));
  directorySig = '';
  renderDirectory();
  updateStatsStrip();
});

// The plan's named areas (lounges, theatres, conference rooms) and the sponsor
// logo on each. Pushed on connect and whenever an admin changes one, so a logo
// appears on every open plan without a reload.
let planAreas = [];

function paintAreas() {
  if (!svgDoc || !planAreas.length) return;
  // A miss means the plan is not laid out yet; the same deferred repaint the
  // exhibitor names use will bring the logos in when it is.
  if (BoothMap.paintAreaLogos(svgDoc, planAreas, 'area-logo-')) labelsDeferred = true;
  wireAreas();
}

// Make each area clickable, once. These are sponsorable inventory — the VIP
// Lounge, a conference track — so a visitor who clicks one gets the same kind
// of answer a stand gives: who has it, or that it is available.
function wireAreas() {
  planAreas.forEach(a => {
    const host = BoothMap.areaHost(svgDoc, a);
    if (!host || host.dataset.areaWired === '1') return;
    host.dataset.areaWired = '1';
    host.classList.add('area-interactive');
    host.addEventListener('mouseenter', e => showAreaTooltip(e, a.key));
    host.addEventListener('mousemove', e => moveTooltip(e));
    host.addEventListener('mouseleave', hideTooltip);
    addTapListener(host, () => { hideTooltip(); selectArea(a.key); });
  });
}

const areaByKey = (key) => planAreas.find(a => a.key === key) || null;

function showAreaTooltip(e, key) {
  const a = areaByKey(key);
  if (!a) return;
  document.getElementById('tt-label').textContent  = a.label;
  document.getElementById('tt-status').textContent = a.status === 'taken' ? 'Sponsored' : 'Available to sponsor';
  document.getElementById('tt-price').textContent  = a.status === 'taken' ? (a.sponsor || '') : '';
  tooltip.classList.remove('hidden');
  moveTooltip(e);
}

// The area the visitor has open, if any. Mutually exclusive with a selected
// stand: the side panel shows one thing at a time.
let selectedArea = null;

function selectArea(key) {
  if (selectedId) { hideSelection(); selectedId = null; }
  svgDoc.querySelectorAll('[data-area]').forEach(el => el.classList.remove('booth-selected'));
  selectedArea = key;
  svgDoc.querySelector(`[data-area="${CSS.escape(key)}"]`)?.classList.add('booth-selected');
  renderAreaPanel(key);
}

/** Areas the visitor wants to enquire about, alongside the stand shortlist. */
let areaShortlist = [];

function toggleAreaShortlist(key) {
  const i = areaShortlist.indexOf(key);
  if (i > -1) areaShortlist.splice(i, 1);
  else if (areaShortlist.length < 10) areaShortlist.push(key);
  renderShortlist();
  renderAreaPanel(key);
}

function renderAreaPanel(key) {
  const a = areaByKey(key);
  if (!a) return;
  const panel = document.getElementById('booth-panel');
  panel.classList.remove('hidden');
  // An area has taken the panel over; whatever stand was in it is no longer
  // rendered, so renderPanel() must not think it still is.
  forgetRenderedPanel();
  document.getElementById('empty-state')?.classList.add('hidden');

  const taken = a.status === 'taken';
  const inList = areaShortlist.includes(key);

  panel.innerHTML = `
    <div class="stand-header">
      <div class="stand-id">${esc(a.label)}</div>
      <div class="stand-badge ${taken ? 'badge-sold' : 'badge-available'}">${taken ? 'Sponsored' : 'Available'}</div>
    </div>
    <div class="area-kind">${taken ? 'Sponsored area' : 'Sponsorship opportunity'}</div>
    ${taken ? `
      <div class="stand-exhibitor">
        <div class="stand-exhibitor-lbl">Sponsored by</div>
        <div class="stand-exhibitor-name">${esc(a.sponsor || 'Our sponsor')}</div>
        ${a.logo ? `<div class="area-logo-wrap"><img class="area-logo-img" src="${esc(a.logo)}" alt=""></div>` : ''}
      </div>
      <div class="stand-taken-notice">
        <i data-lucide="lock" style="width:14px;height:14px"></i>
        This area has been sponsored.
      </div>`
    : `
      <p class="area-blurb">This area is available to sponsor. Add it to your enquiry and our team will talk you through what it includes.</p>
      <button type="button" class="btn-shortlist ${inList ? 'in-list' : ''}" id="area-shortlist-btn">
        ${inList ? 'Added to enquiry' : 'Add to enquiry'}
      </button>`}
  `;
  document.getElementById('area-shortlist-btn')?.addEventListener('click', () => toggleAreaShortlist(key));
  lucide.createIcons();
  syncSponsorPanel();
}

// The artwork itself was replaced, re-read or removed — a re-issued drawing,
// or its printed names taken out after an import. Fetch it again and re-bind
// every stand, exactly as a first load does; the stands, the shortlist and the
// open panel are all state this page already holds and are left alone.
socket.on('floorplan:changed', () => {
  if (!svgDoc) return;         // still loading, or failed: load() will fetch the current one
  load();
});

// The legend's area swatches are only worth showing when the areas are being
// painted from the palette — otherwise they keep the plan's own fills, which
// the legend cannot promise to match.
function updateAreaLegend() {
  const on = !!(planAreas.length && window.BoothPalette && BoothPalette.paintsAreas());
  const open = document.getElementById('leg-area-open');
  const taken = document.getElementById('leg-area-taken');
  if (open) open.hidden = !on;
  if (taken) taken.hidden = !(on && planAreas.some(a => a.status === 'taken'));
}

socket.on('areas:catalogue', (list) => {
  planAreas = Array.isArray(list) ? list : [];
  updateAreaLegend();
  paintAreas();
});

socket.on('tags:catalogue', (list) => {
  tagCatalogue = Array.isArray(list) ? list : [];
  if (selectedId) renderPanel(selectedId);      // repaint an open stand's chips
  refreshFilterOptions();                       // a renamed activity relabels its option
  applyFilter();                                // a deleted one may unmatch stands
});

socket.on('floorplan-sponsor', (s) => {
  sponsorColor = (s && s.color) || '';
  sponsorName  = (s && s.name)  || '';
  renderSponsorLegend();
  // Repaint so sponsored stands pick up (or drop) the brand fill.
  if (tagged) Object.keys(booths).forEach(applyVisual);
});

// Show the "Sponsored" legend swatch only when there is actually a sponsor to
// explain: a brand colour is set AND at least one stand is flagged sponsored.
// With no sponsor it stays hidden, so the public plan shows no empty field.
function renderSponsorLegend() {
  const item = document.getElementById('leg-sponsored');
  if (!item) return;
  const anySponsored = Object.values(booths).some(b => b && b.sponsored);
  if (sponsorColor && anySponsored) {
    const dot = item.querySelector('.leg-dot');
    if (dot) { dot.style.background = sponsorColor; dot.style.borderColor = sponsorColor; }
    item.hidden = false;
  } else item.hidden = true;
}

// ─── Download / export ──────────────────────────────────────────────────────
// Snapshot the plan exactly as it stands right now — every stand's status colour
// and exhibitor name, plus the baked numbers, sizes and event branding — as a
// PNG, with a colour key and (if one is set) the floorplan sponsor along the
// bottom. Built by cloning the live SVG, baking the status fills inline (the
// standalone file carries none of the app's CSS), appending a footer band, then
// rasterising through a canvas. Coordinates are SVG user units.
// Read from the CSS variables rather than restated here, so the minimap and
// the legend show the same colours as the plan — including the per-event
// palette booth-palette.js applies from the artwork.
const STATUS_FILL = {
  get available() { return BoothPalette.fillFor('available'); },
  get sold()      { return BoothPalette.fillFor('sold'); },
  get held()      { return BoothPalette.fillFor('held'); },
};
const SVG_NS = 'http://www.w3.org/2000/svg';
// One stack for everything the export draws, so the plan's own numbers and the
// footer we add are set in the same face.
const FONT_STACK = "'Raleway', 'Helvetica Neue', Arial, sans-serif";

async function downloadPlan() {
  if (!svgDoc || !svgDoc.viewBox) return;
  const btn = document.getElementById('download-plan');
  if (btn) btn.disabled = true;
  try {
    const vb = svgDoc.viewBox.baseVal;
    const W = vb.width, H = vb.height;
    const hasSponsor = !!(sponsorName && sponsorColor);
    const footerH = hasSponsor ? 190 : 96;

    const clone = svgDoc.cloneNode(true);

    // Bake each stand's status/sponsor colour inline. An inline `!important`
    // beats the SVG's own .cls-* fills and any leftover state class, so the
    // standalone file shows the live statuses rather than the blank artwork.
    const live = svgDoc.querySelectorAll('[data-booth]');
    const cloned = clone.querySelectorAll('[data-booth]');
    live.forEach((el, i) => {
      const b = booths[el.getAttribute('data-booth')];
      const fill = (b && b.sponsored && sponsorColor) ? sponsorColor
                 : (STATUS_FILL[b && b.status] || '#ffffff');
      const c = cloned[i];
      if (!c) return;
      c.style.setProperty('fill', fill, 'important');
      c.classList && c.classList.remove('booth-selected', 'booth-shortlisted');
    });

    // Set the family on the clone so the export does not fall back to the
    // browser's default SERIF, which is what a standalone SVG with no CSS gets.
    //
    // Be clear about what this does and does not achieve. An SVG rasterised
    // through an <img> cannot fetch anything external — that is the same rule
    // that keeps the canvas untainted — so Raleway is NOT available here, and
    // the comment that used to sit at this line claiming the plan "matches the
    // one it was downloaded from" was wrong. What it actually gets is the first
    // LOCAL family in the stack, i.e. Helvetica Neue or Arial. That is an
    // accepted fallback, not an accident: embedding a base64 Raleway subset
    // would add ~40 KB of font to every export for a difference nobody reading
    // a stand number would notice. Europe's plan has no text to set at all —
    // its numbers were converted to outlines before it reached us.
    clone.querySelectorAll('text, tspan').forEach((t) => {
      t.style.setProperty('font-family', FONT_STACK);
    });

    // Grow the canvas downward for the footer band.
    clone.setAttribute('viewBox', `0 0 ${W} ${H + footerH}`);
    clone.setAttribute('width', W);
    clone.setAttribute('height', H + footerH);
    clone.removeAttribute('style');

    const add = (tag, attrs, text) => {
      const e = document.createElementNS(SVG_NS, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      if (text != null) e.textContent = text;
      clone.appendChild(e);
      return e;
    };
    const FONT = FONT_STACK;
    add('rect', { x: 0, y: H, width: W, height: footerH, fill: '#ffffff' });
    add('line', { x1: 40, y1: H + 1, x2: W - 40, y2: H + 1, stroke: '#e2e8f0', 'stroke-width': 2 });

    // Centred colour key.
    // Taken from the live palette, not restated, so the key matches the plan
    // it sits under — including an event drawn in its own colours.
    const keys = [[STATUS_FILL.available, 'Available', true],
                  [STATUS_FILL.sold, 'Taken'],
                  [STATUS_FILL.held, 'On Hold']];
    if (hasSponsor && Object.values(booths).some(b => b && b.sponsored)) keys.push([sponsorColor, 'Sponsored']);
    const itemW = (label) => 26 + Math.ceil(label.length * 9.5) + 44;
    const total = keys.reduce((s, k) => s + itemW(k[1]), 0);
    let kx = Math.max(44, (W - total) / 2);
    const ky = H + 46;
    keys.forEach(([col, label, bordered]) => {
      add('rect', { x: kx, y: ky - 15, width: 20, height: 20, rx: 3, fill: col,
        stroke: bordered ? '#94a3b8' : col, 'stroke-width': 1 });
      add('text', { x: kx + 28, y: ky + 1, 'font-family': FONT, 'font-size': 18, fill: '#334155' }, label);
      kx += itemW(label);
    });

    // Sponsor line along the very bottom, in the brand colour.
    if (hasSponsor) {
      add('text', { x: W / 2, y: H + 118, 'text-anchor': 'middle', 'font-family': FONT,
        'font-size': 15, 'letter-spacing': 3, fill: '#64748b' }, 'IN PARTNERSHIP WITH');
      add('text', { x: W / 2, y: H + 160, 'text-anchor': 'middle', 'font-family': FONT,
        'font-size': 34, 'font-weight': 800, fill: sponsorColor }, sponsorName.toUpperCase());
    }

    // Rasterise the self-contained SVG through an <img> onto a canvas. The SVG
    // still has no EXTERNAL refs (no foreignObject; sponsor logos are stored as
    // inline data: URIs precisely so they survive this path), so the canvas
    // stays untainted and toBlob works.
    const xml = new XMLSerializer().serializeToString(clone);
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('SVG render failed'));
      img.src = url;
    });
    const scale = 3000 / W;                       // ~3000px wide keeps numbers crisp
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(W * scale);
    canvas.height = Math.round((H + footerH) * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise((res, rej) =>
      canvas.toBlob(b => b ? res(b) : rej(new Error('encode failed')), 'image/png'));
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    // Named after the event this page is actually for. It used to be the
    // literal "LEX-2026", so North America's plan downloaded as Europe's.
    deliverPNG(blob, `${SHOW_CODE}-Floorplan-${stamp}.png`);
  } catch (e) {
    console.error('Floorplan download failed:', e);
    // Never alert(): this page runs inside the marketing site's iframe, and a
    // sandboxed frame without allow-modals silently discards alert() — so the
    // visitor got no message at all, only a button that appeared to do nothing.
    setBanner('The floorplan download could not be generated. Please try again.', 'warn');
    setTimeout(() => setBanner(''), 8000);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Hand the visitor the PNG.
 *
 * A programmatic <a download>.click() is inert in a sandboxed iframe without
 * allow-downloads — which is how this page is embedded — so the button
 * "worked", nothing was saved, and there was no error to see. So: try the
 * download, and if we are in a frame (where it may quietly fail) also offer a
 * real link the visitor can click themselves, which the browser treats as a
 * user gesture and a top-level navigation.
 */
function deliverPNG(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();

  const framed = window.self !== window.top;
  if (framed) {
    const box = document.getElementById('fp-banner');
    if (box) {
      box.replaceChildren();
      box.append('If the download did not start, ');
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'open the floorplan image';
      box.append(link, '.');
      box.className = 'fp-banner';
      box.hidden = false;
      // Long enough to click, and the object URL outlives it by a margin.
      setTimeout(() => { if (box.contains(link)) setBanner(''); }, 30000);
    }
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ─── Smart search ─────────────────────────────────────────────────────────────
//
// One filter, three ways in: free text, a country dropdown and a business
// activity dropdown. They AND together — "Germany" + "Base Oils" is the stands
// that are both — so the two dropdowns narrow a text search rather than
// replacing it.
//
// The country and activity a stand carries only reach the public client on a
// SOLD stand (see booths.toPublic), so a search can never reveal who is behind
// a provisional hold.
//
// Matching stands are lit; everything else fades. Nothing is hidden: a visitor
// searching for a competitor still has to see the hall around them, and hiding
// stands would leave holes in a plan whose whole value is being a map.

const filter = { q: '', country: '', activity: '' };

// boothNumbers currently matching, or null when no filter is active. null and
// "the empty set" are deliberately different: no filter paints nothing, while a
// filter that matches nothing fades the whole plan (and says so).
let filterMatches = null;

const filterActive = () => !!(filter.q || filter.country || filter.activity);

/** Every string a stand can be found by, lowercased once per search. */
function haystack(n, b) {
  const parts = [n, b.displayNumber || '', b.company || ''];
  const c = countryOf(b.country);
  if (c) parts.push(c.name, c.code, ...(c.aliases || []));
  (b.tags || []).forEach(k => { const t = tagByKey(k); if (t) parts.push(t.label); });
  return parts.filter(Boolean).join(' ␟ ').toLowerCase();
}

/**
 * Which stands match.
 *
 * Free text is split on whitespace and EVERY term must hit — so "germany base
 * oils" narrows rather than widens, which is what someone typing a second word
 * is asking for. A two-letter term also matches a country code exactly, so "de"
 * finds Germany without "de" matching every company with those letters in it.
 */
function computeMatches() {
  if (!filterActive()) return null;

  const terms = filter.q.toLowerCase().split(/\s+/).filter(Boolean);
  const found = new Set();

  Object.entries(booths).forEach(([n, b]) => {
    if (!b) return;
    if (filter.country && (b.country || '') !== filter.country) return;
    if (filter.activity && !(b.tags || []).includes(filter.activity)) return;

    if (terms.length) {
      const hay  = haystack(n, b);
      const code = (b.country || '').toLowerCase();
      const ok = terms.every(t => hay.includes(t) || (t.length === 2 && t === code));
      if (!ok) return;
    }
    found.add(n);
  });

  return found;
}

/** The lit/faded classes for one stand. Also called from applyVisual. */
function paintFilterOn(el, n) {
  const active = !!filterMatches;
  el.classList.toggle('booth-match', active && filterMatches.has(n));
  el.classList.toggle('booth-dim',   active && !filterMatches.has(n));
}

function paintFilter() {
  if (!svgDoc) return;
  svgDoc.querySelectorAll('[data-booth]').forEach(el => paintFilterOn(el, el.getAttribute('data-booth')));
  // The exhibitor names and sponsor logos are siblings of the stands, not
  // children, so they have to be faded separately or a dimmed stand keeps a
  // full-strength name or logo sitting on top of it.
  [['[id^="text-booth-"]', 'text-booth-'], ['[id^="logo-booth-"]', 'logo-booth-']]
    .forEach(([sel, prefix]) => svgDoc.querySelectorAll(sel).forEach(node => {
      const n = node.id.slice(prefix.length);
      node.classList.toggle('booth-dim', !!filterMatches && !filterMatches.has(n));
    }));
}

/** Recompute, repaint, and report the count. The single entry point. */
function applyFilter() {
  filterMatches = computeMatches();
  paintFilter();

  const box = document.getElementById('fps-count');
  const clear = document.getElementById('fps-clear');
  if (clear) clear.hidden = !filterActive();
  if (!box) return;

  if (!filterMatches) { box.hidden = true; box.textContent = ''; return; }
  const k = filterMatches.size;
  box.hidden = false;
  box.textContent = k === 0 ? 'No stands match' : `${k} stand${k === 1 ? '' : 's'}`;
  box.classList.toggle('fps-count-none', k === 0);
}

function clearFilter() {
  filter.q = filter.country = filter.activity = '';
  const input = document.getElementById('fps-input');
  if (input) input.value = '';
  const cSel = document.getElementById('fps-country');
  const aSel = document.getElementById('fps-activity');
  if (cSel) cSel.value = '';
  if (aSel) aSel.value = '';
  hideSuggestions();
  applyFilter();
}

/**
 * Rebuild the two dropdowns from what is actually ON the plan.
 *
 * Offering all 249 countries when eleven are represented would make the visitor
 * hunt through a list that is mostly dead ends; the counts do the same job as a
 * result preview. Rebuilt on every broadcast, so a stand booked while the page
 * is open adds its country to the list without a reload.
 */
function refreshFilterOptions() {
  const countryCounts = new Map();
  const activityCounts = new Map();

  Object.values(booths).forEach(b => {
    if (!b) return;
    if (b.country) countryCounts.set(b.country, (countryCounts.get(b.country) || 0) + 1);
    (b.tags || []).forEach(k => activityCounts.set(k, (activityCounts.get(k) || 0) + 1));
  });

  fillSelect('fps-country', 'All countries', filter.country,
    [...countryCounts.entries()]
      .map(([code, n]) => ({ value: code, label: `${countryOf(code)?.flag || ''} ${countryOf(code)?.name || code}`.trim(), n }))
      .sort((a, b) => a.label.localeCompare(b.label, 'en')));

  fillSelect('fps-activity', 'All activities', filter.activity,
    [...activityCounts.entries()]
      .map(([key, n]) => ({ value: key, label: tagByKey(key)?.label || key, n }))
      .filter(o => tagByKey(o.value))
      .sort((a, b) => a.label.localeCompare(b.label, 'en')));
}

// Signature of what each dropdown currently offers, so an unchanged list is
// left alone. Rebuilding on every broadcast would snap the menu shut under a
// visitor who had it open when any admin anywhere touched a stand.
const selectSig = {};

function fillSelect(id, allLabel, current, options) {
  const sel = document.getElementById(id);
  if (!sel) return;

  // Rebuild the OPTIONS only when they actually changed…
  const sig = options.map(o => `${o.value}:${o.label}:${o.n}`).join('|');
  if (selectSig[id] !== sig) {
    selectSig[id] = sig;
    sel.replaceChildren();
    const all = document.createElement('option');
    all.value = '';
    all.textContent = allLabel;
    sel.appendChild(all);
    options.forEach(o => {
      const el = document.createElement('option');
      el.value = o.value;
      el.textContent = `${o.label} (${o.n})`;
      sel.appendChild(el);
    });
  }

  // …but always sync the SELECTION, which changes without the list changing —
  // picking a country from the suggestions is exactly that case.
  //
  // A filter can also outlive the value it names (the last German stand was
  // released). Keep the selection if it still exists, otherwise drop the filter
  // rather than leave a select reading "All" while it is still being applied.
  if (!current) sel.value = '';
  else if (options.some(o => o.value === current)) sel.value = current;
  else { if (id === 'fps-country') filter.country = ''; else filter.activity = ''; sel.value = ''; }

  sel.disabled = options.length === 0;
}

// ── Suggestions ──────────────────────────────────────────────────────────────
// What the box offers as you type: the countries and activities on the plan,
// then the exhibitors themselves. Picking a country or activity moves the query
// into the matching dropdown, so the box is left free for the next term.

let suggestions = [];
let suggestIndex = -1;

function buildSuggestions(q) {
  const term = q.trim().toLowerCase();
  if (term.length < 2) return [];

  const out = [];
  const counts = { country: new Map(), activity: new Map() };
  const companies = [];

  Object.entries(booths).forEach(([n, b]) => {
    if (!b) return;
    if (b.country) counts.country.set(b.country, (counts.country.get(b.country) || 0) + 1);
    (b.tags || []).forEach(k => counts.activity.set(k, (counts.activity.get(k) || 0) + 1));
    if (b.company && b.company.toLowerCase().includes(term)) companies.push({ n, company: b.company });
  });

  counts.country.forEach((n, code) => {
    const c = countryOf(code);
    if (!c) return;
    const hit = c.name.toLowerCase().includes(term)
             || c.code.toLowerCase() === term
             || (c.aliases || []).some(a => a.toLowerCase().includes(term));
    if (hit) out.push({ kind: 'country', value: code, label: `${c.flag} ${c.name}`, meta: `${n} stand${n === 1 ? '' : 's'}` });
  });

  counts.activity.forEach((n, key) => {
    const t = tagByKey(key);
    if (t && t.label.toLowerCase().includes(term)) {
      out.push({ kind: 'activity', value: key, label: t.label, color: t.color, meta: `${n} stand${n === 1 ? '' : 's'}` });
    }
  });

  // Exhibitors: a name that STARTS with what was typed is what was meant more
  // often than one that merely contains it, so those come first.
  companies.sort((a, b) => {
    const sa = a.company.toLowerCase().startsWith(term) ? 0 : 1;
    const sb = b.company.toLowerCase().startsWith(term) ? 0 : 1;
    return sa - sb || a.company.localeCompare(b.company, 'en');
  });
  companies.slice(0, 6).forEach(c =>
    out.push({ kind: 'booth', value: c.n, label: c.company, meta: `Stand ${shownN(c.n)}` }));

  // A stand number typed straight in.
  Object.keys(booths).forEach(n => {
    if (out.length > 20) return;
    if (String(shownN(n)).toLowerCase() === term || n.toLowerCase() === term) {
      if (!out.some(o => o.kind === 'booth' && o.value === n)) {
        out.push({ kind: 'booth', value: n, label: `Stand ${shownN(n)}`, meta: booths[n]?.company || STATUS_LABEL[booths[n]?.status] || '' });
      }
    }
  });

  return out.slice(0, 8);
}

function renderSuggestions() {
  const box = document.getElementById('fps-suggest');
  const input = document.getElementById('fps-input');
  if (!box) return;

  box.replaceChildren();
  if (!suggestions.length) return hideSuggestions();

  suggestions.forEach((sg, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'fps-sg' + (i === suggestIndex ? ' active' : '');
    row.setAttribute('role', 'option');
    // An option a combobox can point AT. Without an id there is nothing for
    // aria-activedescendant to name, which is why arrow-key highlighting
    // announced nothing at all.
    row.id = `fps-opt-${i}`;
    row.setAttribute('aria-selected', i === suggestIndex ? 'true' : 'false');

    const kind = document.createElement('span');
    kind.className = `fps-sg-kind fps-sg-${sg.kind}`;
    kind.textContent = sg.kind === 'country' ? 'Country' : sg.kind === 'activity' ? 'Activity' : 'Exhibitor';
    if (sg.color) { kind.style.background = sg.color; kind.style.color = contrastText(sg.color); }

    const label = document.createElement('span');
    label.className = 'fps-sg-label';
    label.textContent = sg.label;

    const meta = document.createElement('span');
    meta.className = 'fps-sg-meta';
    meta.textContent = sg.meta || '';

    row.append(kind, label, meta);
    // mousedown, not click: the input's blur would otherwise close the list
    // before the click landed.
    row.addEventListener('mousedown', (e) => { e.preventDefault(); pickSuggestion(i); });
    box.appendChild(row);
  });

  box.classList.remove('hidden');
  if (input) {
    input.setAttribute('aria-expanded', 'true');
    // Focus stays in the text box; this is what tells a screen reader which
    // option the arrow keys have moved to.
    if (suggestIndex >= 0) input.setAttribute('aria-activedescendant', `fps-opt-${suggestIndex}`);
    else input.removeAttribute('aria-activedescendant');
  }
}

function hideSuggestions() {
  const box = document.getElementById('fps-suggest');
  const input = document.getElementById('fps-input');
  suggestions = [];
  suggestIndex = -1;
  if (box) { box.classList.add('hidden'); box.replaceChildren(); }
  if (input) {
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');   // it names a node that no longer exists
  }
}

function pickSuggestion(i) {
  const sg = suggestions[i];
  if (!sg) return;
  const input = document.getElementById('fps-input');

  if (sg.kind === 'booth') {
    // A named exhibitor is a destination, not a filter: open the stand and go
    // to it, and leave the plan lit so the visitor can see where it sits.
    filter.q = booths[sg.value]?.company || '';
    if (input) input.value = filter.q;
    hideSuggestions();
    applyFilter();
    selectBooth(sg.value);
    panToBooth(sg.value);
    return;
  }

  // A country or an activity belongs in its dropdown, which leaves the text box
  // empty for the next term — "Germany" then "additives" narrows twice.
  if (sg.kind === 'country')  filter.country  = sg.value;
  if (sg.kind === 'activity') filter.activity = sg.value;
  filter.q = '';
  if (input) input.value = '';
  hideSuggestions();
  refreshFilterOptions();
  applyFilter();
}

// ── Wiring ───────────────────────────────────────────────────────────────────
(function initSearch() {
  const input = document.getElementById('fps-input');
  const cSel  = document.getElementById('fps-country');
  const aSel  = document.getElementById('fps-activity');
  const clear = document.getElementById('fps-clear');
  if (!input) return;

  input.addEventListener('input', () => {
    filter.q = input.value.trim();
    suggestions = buildSuggestions(input.value);
    suggestIndex = -1;
    renderSuggestions();
    applyFilter();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!suggestions.length) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      suggestIndex = (suggestIndex + step + suggestions.length) % suggestions.length;
      renderSuggestions();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (suggestIndex >= 0) return pickSuggestion(suggestIndex);
      hideSuggestions();
      // One match and no suggestion chosen — go straight there, which is what
      // typing a full company name and pressing Enter is asking for.
      if (filterMatches && filterMatches.size === 1) {
        const n = [...filterMatches][0];
        selectBooth(n);
        panToBooth(n);
      }
      return;
    }
    if (e.key === 'Escape') {
      if (suggestions.length) { hideSuggestions(); return; }
      clearFilter();
    }
  });

  input.addEventListener('focus', () => {
    if (input.value.trim().length >= 2) {
      suggestions = buildSuggestions(input.value);
      renderSuggestions();
    }
  });
  input.addEventListener('blur', () => setTimeout(hideSuggestions, 120));

  cSel?.addEventListener('change', () => { filter.country  = cSel.value; applyFilter(); });
  aSel?.addEventListener('change', () => { filter.activity = aSel.value; applyFilter(); });
  clear?.addEventListener('click', () => { clearFilter(); input.focus(); });
})();

// ─── Deferred exhibitor names ────────────────────────────────────────────────
//
// A name is fitted to the stand's real box, which only exists once the plan has
// been laid out. When it hasn't — the page is in a hidden tab, iframed into a
// panel that is still collapsed, or the frame is momentarily zero-sized — every
// name is skipped.
//
// Nothing used to bring them back. The only thing that repainted was the next
// state broadcast, and on a quiet plan that may never come, so the names simply
// stayed missing until a reload that happened to be laid out in time — which is
// why they would reappear in a different browser or a fresh tab.
//
// So: remember that names were deferred, and repaint when the plan becomes
// measurable. Three signals, because no one of them covers every case —
// visibility (a hidden tab), a size change (a collapsed panel opening, which
// fires no visibility event), and the web font arriving.
let labelsDeferred = false;

// The ceiling on an exhibitor name's size, in SVG units.
//
// Keep this at 9. It was briefly raised to 20 on the theory that names were too
// small to read at a whole-hall view (they render at ~0.45 px per unit, so 9
// units is about 4px on screen, and most names sit exactly at the cap). The
// real cause of that report turned out to be a stale cached script, and at 20
// the names dominate the plan — they out-shout the stand numbers and the
// artwork's own lettering, and the hall stops reading as a map.
//
// If names ever genuinely need to be bigger, zoom is the answer, not this.
const LABEL_MAX_FONT = 9;


function repaintLabels() {
  if (!svgDoc || !tagged || !labelsDeferred) return;
  labelsDeferred = false;
  Object.keys(booths).forEach(applyVisual);
  paintAreas();
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) repaintLabels(); });
window.addEventListener('pageshow', repaintLabels);          // restored from the back/forward cache
// Refit unconditionally once the web font has settled, rather than trying to
// ask whether it is ready. document.fonts.check('600 9px Raleway') looks like
// the right question but is not: it answers "can this be rendered", and a
// FALLBACK counts — it returns true even when zero Raleway faces have loaded
// (verified in both Chrome and Edge), so the guard it was used for never once
// fired. A name measured against the fallback and then rendered in Raleway is
// fitted to the wrong metrics, so one forced pass here is the fix.
if (document.fonts) document.fonts.ready.then(() => {
  // The layouts cached during the fallback pass were fitted to the WRONG
  // metrics, so they have to go before the refit — a cache that outlived the
  // font would quietly reintroduce the very bug this pass exists to fix.
  BoothMap.clearLabelCache();
  labelsDeferred = true;
  repaintLabels();
});
// Fires once on observe and again on every resize, so a frame going from
// zero-sized to laid out is caught without polling. When nothing was deferred
// this is a no-op, so an ordinary window resize costs nothing.
if (window.ResizeObserver && frame) new ResizeObserver(() => {
  // The frame also moves and resizes without the WINDOW doing either — opening
  // a stand widens the side panel — so the cached frame box the tooltip is
  // positioned against has to be dropped here too, or the tooltip sits off the
  // pointer until the next window resize.
  dropFrameBox();
  repaintLabels();
}).observe(frame);

/**
 * Stand element lookup, memoised.
 *
 * Three querySelector() calls over the whole 6000-node plan, per stand, on
 * every repaint — the stand, its name node and its logo node. The elements only
 * change when attach()/clear() rebuilds them, so the cache is dropped there
 * (dropElementCache) rather than paid for on every pass.
 */
const elCache = new Map();
function standEl(n) {
  if (elCache.has(n)) {
    const hit = elCache.get(n);
    // A cached node that is no longer in the document is a re-tag we missed;
    // fall through and look it up again rather than painting a detached node.
    if (hit && hit.isConnected) return hit;
  }
  const el = svgDoc ? svgDoc.querySelector(`[data-booth="${CSS.escape(n)}"]`) : null;
  elCache.set(n, el);
  return el;
}
function dropElementCache() { elCache.clear(); }

function applyVisual(n) {
  const el = standEl(n);
  if (!el) return;

  const status = booths[n]?.status || 'sold';
  // What a screen reader announces has to follow what the stand shows; a stand
  // that sells while the page is open must not keep saying "available".
  labelStand(el, n);
  el.classList.remove('booth-available', 'booth-sold', 'booth-held', 'booth-sponsored');
  el.classList.add(`booth-${status}`);

  if (shortlist.includes(n)) el.classList.add('booth-shortlisted');
  else el.classList.remove('booth-shortlisted');

  // Search highlight. Set here as well as in paintFilter() because applyVisual
  // is what runs after a re-tag rebuilds the elements — without it, a split or
  // a merge would silently drop the lit-up stands while a filter was active.
  paintFilterOn(el, n);

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
  let textNode = svgDoc.getElementById(`text-booth-${n}`);
  let logoNode = svgDoc.getElementById(`logo-booth-${n}`);
  const company = booths[n]?.company;
  // A sponsor's logo, sent only for a stand flagged as sponsored. It REPLACES
  // the exhibitor name rather than sitting beside it: on a 9 m² stand there is
  // room for one or the other, and a logo already says the name.
  const logo = booths[n]?.sponsorLogo || null;
  const wantsName = status !== 'available' && company && !logo;

  // VISUAL box (post-transform): most LEX27 stands are rotated, so the local
  // getBBox would place the name off the stand and fit it to swapped
  // dimensions. Null means the stand isn't laid out yet — skip this frame.
  // Measured BEFORE either node is created: bailing out afterwards left an empty
  // <text> behind on every broadcast while the plan was off-screen.
  const vbox = (wantsName || logo) ? BoothMap.visualBox(el) : null;
  if ((wantsName || logo) && (!vbox || !(vbox.w > 0) || !(vbox.h > 0))) { labelsDeferred = true; return; }

  if (logo) {
    if (!logoNode) {
      logoNode = document.createElementNS('http://www.w3.org/2000/svg', 'image');
      logoNode.setAttribute('id', `logo-booth-${n}`);
      logoNode.style.pointerEvents = 'none';   // the stand underneath stays clickable
      el.parentNode.appendChild(logoNode);
    }
    BoothMap.fitImage(logoNode, logo, vbox);
    logoNode.classList.toggle('booth-dim', !!filterMatches && !filterMatches.has(n));
  } else if (logoNode) {
    logoNode.remove();
  }

  if (wantsName) {
    if (!textNode) {
      textNode = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      textNode.setAttribute('id', `text-booth-${n}`);
      textNode.setAttribute('fill', '#111827');
      textNode.style.pointerEvents = 'none';
      el.parentNode.appendChild(textNode);
    }
    // Wrap / hyphenate / shrink to fit — never truncate.
    BoothMap.fitLabel(textNode, company, vbox,
      { family: 'Raleway, sans-serif', weight: '600', maxFont: LABEL_MAX_FONT });
    // Keep the name legible on a dark brand fill (white text), dark ink otherwise.
    textNode.setAttribute('fill', sponsored ? contrastText(sponsorColor) : '#111827');
    // The name is a sibling of the stand, not a child, so fading the shape
    // would otherwise leave the company name at full strength over it.
    textNode.classList.toggle('booth-dim', !!filterMatches && !filterMatches.has(n));
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

// ─── Exhibitor directory / A–Z stand list ────────────────────────────────────
//
// Two jobs in one list, which is why it is one list.
//
//  1. Sales asked for a "who's exhibiting" page. It is the same data the plan
//     already holds, so a separate page would only be a second thing to keep in
//     step with the first.
//  2. It is the KEYBOARD and SCREEN-READER route to the hall. Every stand on
//     the plan now takes focus and answers Enter, but tabbing through 250
//     stands in artwork order is a route, not a usable one. This is a real
//     list, in the order a person would look something up in: exhibitors A–Z,
//     then the remaining stands by number.
//
// PUBLISHING RULE, unchanged: a stand that is only ON HOLD is never published.
// A hold is a provisional deal, so its company is not sent to this client at
// all (booths.toPublic withholds it) and even if it were, listing it here would
// announce a booking nobody has agreed to. Held stands appear in the stand list
// by number and status, with no name.

let directoryOpen = false;

function directoryRows() {
  const named = [];
  const unnamed = [];
  Object.entries(booths).forEach(([n, b]) => {
    if (!b) return;
    // Sold only — see the publishing rule above.
    if (b.status === 'sold' && b.company) {
      const c = countryOf(b.country);
      named.push({
        n,
        company: b.company,
        country: c ? `${c.flag} ${c.name}` : '',
        activity: (b.tags || []).map(k => tagByKey(k)?.label).filter(Boolean).join(', '),
        sqm: b.sqm || 0,
        status: b.status,
      });
    } else {
      unnamed.push({ n, company: '', country: '', activity: '', sqm: b.sqm || 0, status: b.status });
    }
  });

  named.sort((a, b) => a.company.localeCompare(b.company, 'en'));
  // Stand numbers are alphanumeric ("A12", "412"), so a numeric-aware collator
  // is what puts 9 before 10 instead of after 1.
  unnamed.sort((a, b) => String(shownN(a.n)).localeCompare(String(shownN(b.n)), 'en', { numeric: true }));
  return { named, unnamed };
}

// Rebuilt on every broadcast, but only the parts that changed: this list is
// ~250 rows and lives inside the same document as the plan.
let directorySig = '';

function renderDirectory() {
  const box = document.getElementById('directory-list');
  if (!box) return;
  const { named, unnamed } = directoryRows();

  const sig = named.map(r => `${r.n}|${r.company}|${r.country}|${r.activity}`).join(';')
            + '#' + unnamed.map(r => `${r.n}|${r.status}`).join(';');
  if (sig === directorySig) return;
  directorySig = sig;

  const countEl = document.getElementById('directory-count');
  if (countEl) {
    countEl.textContent = named.length
      ? `${named.length} exhibitor${named.length === 1 ? '' : 's'} announced`
      : 'No exhibitors announced yet';
  }

  const row = (r, withDetail) => `
    <li>
      <button type="button" class="dir-row" data-dir="${esc(r.n)}">
        <span class="dir-name">${esc(withDetail ? r.company : 'Stand ' + shownN(r.n))}</span>
        <span class="dir-meta">${esc(withDetail
          ? `Stand ${shownN(r.n)}${r.country ? ' · ' + r.country : ''}${r.activity ? ' · ' + r.activity : ''}`
          : `${STATUS_LABEL[r.status] || cap(r.status)}${r.sqm ? ' · ' + r.sqm + ' ' + UNIT : ''}`)}</span>
      </button>
    </li>`;

  box.innerHTML = `
    ${named.length ? `<h3 class="dir-head" id="dir-head-ex">Exhibitors A–Z</h3>
      <ul class="dir-ul" aria-labelledby="dir-head-ex">${named.map(r => row(r, true)).join('')}</ul>` : ''}
    <h3 class="dir-head" id="dir-head-st">All stands</h3>
    <ul class="dir-ul" aria-labelledby="dir-head-st">${unnamed.map(r => row(r, false)).join('')}</ul>`;

  box.querySelectorAll('[data-dir]').forEach(btn => {
    btn.onclick = () => {
      const n = btn.getAttribute('data-dir');
      selectBooth(n);
      panToBooth(n);
    };
  });
}

function toggleDirectory(open) {
  const panel = document.getElementById('fp-directory');
  const btn = document.getElementById('directory-toggle');
  if (!panel || !btn) return;
  directoryOpen = open == null ? !directoryOpen : !!open;
  // Anchored under the toolbar, measured at open time: the toolbar wraps to two
  // rows on a narrow screen, and a fixed offset covered the search box and the
  // very button that opens this panel.
  const bar = document.querySelector('.fp-map-toolbar');
  if (bar) panel.style.top = bar.offsetHeight + 'px';
  panel.hidden = !directoryOpen;
  btn.setAttribute('aria-expanded', String(directoryOpen));
  if (directoryOpen) {
    renderDirectory();
    document.getElementById('directory-list')?.querySelector('button')?.focus();
  } else {
    btn.focus();
  }
}

(function initDirectory() {
  const btn = document.getElementById('directory-toggle');
  if (btn) btn.onclick = () => toggleDirectory();
  const close = document.getElementById('directory-close');
  if (close) close.onclick = () => toggleDirectory(false);
  // The first thing in the tab order: a keyboard user reaches the list without
  // passing through the toolbar, and a screen reader is offered it immediately.
  const skip = document.getElementById('skip-to-list');
  if (skip) skip.onclick = () => toggleDirectory(true);
  // Escape closes it, the same as the search suggestions — a panel that can
  // only be dismissed with a mouse is not a keyboard route.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && directoryOpen) toggleDirectory(false);
  });
})();

// ─── The event this page is for ──────────────────────────────────────────────
// The markup used to say "LEX 2026" in the title, the description and the
// header, so North America's plan introduced itself as Europe's. The show is
// injected per request; the page takes its identity from that.
(function applyShowIdentity() {
  document.title = `${SHOW_NAME} Floorplan | Interactive Expo Map`;
  const sub = document.getElementById('show-name');
  if (sub) sub.textContent = `${SHOW_NAME} — Interactive Expo Floorplan`;
  const desc = document.querySelector('meta[name="description"]');
  if (desc) {
    desc.setAttribute('content',
      `Browse available exhibition stands at ${SHOW_NAME}. Select any white space to view size and make an enquiry.`);
  }
})();

initConsent();
initForm();
loadSponsors();
load();
