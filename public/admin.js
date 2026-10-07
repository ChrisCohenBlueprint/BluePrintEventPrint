// ─── BluePrint EventPrint — Admin Dashboard JS ────────────────────────────────
// See floorplan.js — the show is injected by the server and carried in the
// handshake so this admin joins the right event's rooms.
const SHOW = (window.__SHOW && window.__SHOW.slug) || '';
const socket = io({ query: { show: SHOW } });

// Shared helpers — one copy, in public/lib/ui.js, loaded before this file.
// They used to exist here AND in sales.js, and the copies had drifted: sales.js
// knew a 401 meant "your session ended", this file did not and rendered an
// empty dashboard instead; sales.js had a working money(), this file called one
// that was never defined anywhere.
const { esc, cap, money, api, emitAck, withPending, askSecret, confirmDialog, askFields, askText, dialogOpen } = window.UI;

// Show who is signed in. currentRole gates team management — only the owner may
// add/remove members or reset a colleague's password/2FA (the server enforces
// this too; hiding the controls just avoids showing buttons that would 403).
let currentUser = null;
let currentRole = null;

/**
 * Confirm the session is still ours, and act on it if it is not.
 *
 * There was no 401 handling anywhere on this page. An expired 12h cookie
 * rendered "No enquiries yet", an empty team table and "No events yet" — an
 * expired session presented as a genuinely empty event, which is about the most
 * misleading thing the console could have said. Worse, after a socket reconnect
 * the server downgrades an unauthenticated socket to the PUBLIC projection, so
 * companies, prices and notes quietly disappeared from a page that still looked
 * signed in, and every action toasted "Administrator access required" with no
 * way out of it.
 *
 * api() turns the 401 into the redirect. A rep who has somehow landed here is
 * sent to their own dashboard instead — bouncing them to /login would loop,
 * because they ARE signed in.
 */
async function checkSession({ quiet = false } = {}) {
  try {
    const u = await api('/api/me');          // 401 → api() redirects to /login
    currentUser = u.user;
    currentRole = u.role;
    document.getElementById('nav-username').textContent = u.user;
    if (u.home && u.home !== '/admin') { location.href = u.home; return false; }
    return true;
  } catch (e) {
    // api() has already navigated away on a 401; anything else is a genuine
    // network problem, and saying so beats a blank dashboard.
    if (!quiet) adminToast(`Could not confirm your sign-in: ${e.message}`, 'error');
    return false;
  }
}

checkSession({ quiet: true }).then(ok => {
  if (ok && document.getElementById('section-team')?.classList.contains('active')) loadTeam();
});

// A reconnect is the moment the session is re-checked by the server, so it is
// the moment to find out whether we still have one. Without this the page went
// on drawing an admin console over public data.
let wasConnected = false;
socket.on('connect', () => {
  if (wasConnected) checkSession();          // a genuine re-connect, not the first
  wasConnected = true;
});

// Sign out via POST — a GET logout can be triggered cross-site to force an
// admin out. Falls back to the (now inert) /logout link if the POST fails.
document.getElementById('nav-signout')?.addEventListener('click', (e) => {
  e.preventDefault();
  fetch('/logout', { method: 'POST' }).catch(() => {}).finally(() => { location.href = '/login'; });
});

// Prime the sponsor catalogue so lead detail can name sponsorship interests
// without waiting for the Sponsors tab to be opened.
let sponsorAdminCache = [];
api('/api/sponsors').then(list => { sponsorAdminCache = list || []; }).catch(() => {});

// Who an enquiry can be forwarded to, plus the manager who is copied. Built
// from the real accounts now, so a rep created in the Team tab appears here.
let salesTeamCache = { team: [], manager: null };
function loadSalesTeam() {
  return api('/api/sales-team')
    .then(d => { if (d) salesTeamCache = d; })
    .catch(() => { /* the Send-to list simply stays as it was */ });
}
loadSalesTeam();

/**
 * Forward a lead. The server records the send and fires the notification
 * webhook if one is configured; it also returns a composed email, which we open
 * in the default mail client so this works today without a mail server.
 */
async function sendLead(id, name, btn) {
  if (!name) return adminToast('Choose a salesperson first.', 'error');
  const original = btn.innerHTML;
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const d = await api(`/api/inquiries/${encodeURIComponent(id)}/send`, {
      method: 'POST', body: JSON.stringify({ name }),
    });

    // Open a pre-addressed email so it can be sent immediately. cc may be empty
    // when no owner account carries an email — send to the assignee alone
    // rather than addressing a copy to nobody.
    const mailto = `mailto:${encodeURIComponent(d.to)}`
      + (d.cc ? `?cc=${encodeURIComponent(d.cc)}&` : '?')
      + `subject=${encodeURIComponent(d.subject)}`
      + `&body=${encodeURIComponent(d.body)}`;
    window.location.href = mailto;

    const copied = d.cc && salesTeamCache.manager?.name ? ` (copying ${salesTeamCache.manager.name})` : '';
    adminToast(d.webhook
      ? `Sent to ${name}${copied}. Your email client has also opened a copy.`
      : `Email to ${name} opened${copied}. Send it from your mail client.`, 'ok');
    loadLeads();
  } catch (e) {
    adminToast(e.message || 'Could not send.', 'error');
  } finally {
    btn.disabled = false; btn.innerHTML = original; lucide.createIcons();
  }
}

let booths = {};  // live state
// Stands taken off the plan. Held apart from `booths` because every table,
// total, dropdown and panel in this console reads that one — a stand that is
// not on the plan belongs in none of them. The map still gets these, because
// the artwork goes on drawing their rectangles and something has to paint hall
// floor over them. See BoothMap.sharedEdges.
let removedBooths = {};
let svgDoc = null;
let selectedAdminId = null;

// ─── Section Navigation ───────────────────────────────────────────────────────
const sectionTitles = {
  overview: 'Overview',
  floorplan: 'Floorplan',
  bookings: 'Bookings',
  leads: 'Leads',
  analytics: 'Analytics',
  sponsors: 'Sponsors',
  tools: 'Tools',
  team: 'Team',
  log: 'Activity Log',
  // Settings lives outside the <ul>, and its key was simply never added here —
  // so opening it put the literal word "undefined" in the page heading.
  settings: 'Settings',
};

function showAdminSection(sec) {
  document.querySelectorAll('.nav-link').forEach(l => {
    const on = l.dataset.section === sec;
    l.classList.toggle('active', on);
    l.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
  document.getElementById(`section-${sec}`)?.classList.add('active');
  // cap() as the fallback, so a section added to the markup without a title
  // here reads as its own name rather than "undefined" — which is what
  // Settings did for as long as it has existed.
  document.getElementById('section-title').textContent = sectionTitles[sec] || cap(sec);

  if (sec === 'floorplan' && !svgDoc) loadAdminSVG();
  if (sec === 'bookings') renderBookingsTable();
  if (sec === 'tools') { populateToolDropdowns(); loadShows(); loadHistory(); }
  if (sec === 'settings') { loadPlans(); loadMakeCard(); }
  if (sec === 'leads') { loadLeads(); fetchMakeHook(); }
  if (sec === 'analytics') loadAnalytics();
  if (sec === 'sponsors') loadSponsorsAdmin();
  if (sec === 'team') { loadTeam(); fillRoster(); syncRoleFields(); }
  if (sec === 'log') loadAuditLog();
}

document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', () => showAdminSection(link.dataset.section));
  // Click alone made the whole console mouse-only: these are <li> and <div>,
  // which take neither focus nor Enter on their own.
  link.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showAdminSection(link.dataset.section); }
  });
});

// ─── Zoom / Pan (Admin Map) ───────────────────────────────────────────────────
const aFrame = document.getElementById('admin-map-frame');
const aInner = document.getElementById('admin-map-inner');

let pzAdmin;
// Once per page. The pan/zoom lives on the frame around the plan, which a new
// drawing does not replace, so a second call only stacked a second panzoom and
// a second set of button and search listeners on top of the first — every
// zoom click then zoomed twice.
function initAdminPanZoom() {
  if (pzAdmin) return;
  pzAdmin = panzoom(aInner, {
    maxZoom: 8,
    minZoom: 0.3,
    bounds: true,
    boundsPadding: 0.1,
    zoomDoubleClickSpeed: 1
  });

  document.getElementById('admin-zoom-in').addEventListener('click', () => {
    const r = aFrame.getBoundingClientRect();
    pzAdmin.smoothZoom(r.width / 2, r.height / 2, 1.5);
  });
  document.getElementById('admin-zoom-out').addEventListener('click', () => {
    const r = aFrame.getBoundingClientRect();
    pzAdmin.smoothZoom(r.width / 2, r.height / 2, 0.66);
  });
  document.getElementById('admin-zoom-reset').addEventListener('click', () => {
    pzAdmin.moveTo(0, 0);
    pzAdmin.zoomAbs(0, 0, 1);
  });

  // Floorplan search — jump straight to a booth by number.
  const fpSearch = document.getElementById('admin-fp-search');
  if (fpSearch) {
    fpSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runAdminBoothSearch(); }
    });
    fpSearch.addEventListener('change', runAdminBoothSearch);   // datalist pick
  }

  wireMultiBar();
}

// Wire the floating multi-select action bar once — guarded on its own, so it
// can never stack duplicate listeners whoever calls it.
let multiWired = false;
function wireMultiBar() {
  if (multiWired) return;
  multiWired = true;
  document.getElementById('multi-clear')?.addEventListener('click', clearMultiSelect);
  document.getElementById('multi-consolidate')?.addEventListener('click', consolidateMultiSelect);
  document.getElementById('multi-restore')?.addEventListener('click', restoreMultiSelect);
}

async function consolidateMultiSelect() {
  const ids = [...multiSel];
  if (ids.length < 2) return;
  const btn = document.getElementById('multi-consolidate');
  // Merging reshapes the plan and destroys the other stands' identities, and it
  // was doing so the instant the button was pressed with nothing asked.
  const area = ids.reduce((a, n) => a + (booths[n]?.sqm || 0), 0);
  // Selecting every cell of one split and merging them is that split being
  // undone, and the server treats it as such — the original stand comes back
  // with its own number and box rather than a block wearing a cell's label. Say
  // so, because "merge" and "the stand you had comes back" are different
  // promises.
  const parent = ids.map(n => booths[n]).find(b => b && b.splitSnapshot
    && (b.splitSnapshot.created || []).length + 1 === ids.length
    && (b.splitSnapshot.created || []).every(c => ids.includes(c)));
  if (!await confirmDialog(
    parent
      ? `Put stand ${shownN(parent.boothNumber)} back together?\n\n` +
        `You have selected every cell of its split, so this undoes the split: the stand returns whole, at its original number and size, and the cells go.`
      : `Merge ${ids.map(n => shownN(n)).join(', ')} into one stand of about ${area} ${UNIT}?\n\n` +
        'The other stand numbers disappear from the plan, the table and every dropdown. ' +
        'Tools → Reset undoes it.',
    { title: parent ? `Put stand ${shownN(parent.boothNumber)} back together` : `Merge ${ids.length} stands`,
      confirmLabel: parent ? 'Put it back' : 'Merge them' })) return;
  if (btn) btn.disabled = true;
  socket.emit('booth:consolidate-many', { boothNumbers: ids }, (res) => {
    if (btn) btn.disabled = false;
    if (res && res.ok) {
      adminToast(`${ids.length} stands merged into ${res.primary}.`, 'ok');
      clearMultiSelect();
      if (res.primary) { selectAdminBooth(res.primary); nameMergedStand(res.primary); }
    } else {
      adminToast((res && res.error) || 'Could not consolidate those stands.', 'error');
    }
  });
}

// A merged block keeps the top-left stand's number, which is rarely what the
// admin wants it called — so the name is asked for as the last step of the
// merge rather than left to a separate trip through the Shown Number tool.
// Leaving it as offered (or cancelling) keeps the number it already has. Asked
// in the console's own dialog, like the other questions on this panel.
async function nameMergedStand(primary) {
  const current = shownN(primary);
  const name = await askText(`The stands are merged into stand ${current}. Keep that number, or give the merged stand the one to show.`,
    { title: 'Number the merged stand', name: 'number', label: 'Number to show', value: current, maxLength: 20,
      confirmLabel: 'Use this number' });
  if (name === null) return;
  const displayNumber = name.trim();
  if (!displayNumber || displayNumber === current) return;
  socket.emit('booth:set-number', { boothNumber: primary, displayNumber }, (res) => {
    if (res && res.ok) adminToast(`Merged stand now shown as ${displayNumber}.`, 'ok');
    else adminToast((res && res.error) || 'Could not rename the merged stand.', 'error');
  });
}

// Fill the search autocomplete with every booth (number + company), so a couple
// of keystrokes surface the stand. Re-run whenever state changes.
function populateAdminSearchList() {
  const dl = document.getElementById('admin-fp-booths');
  if (!dl) return;
  dl.innerHTML = Object.values(booths)
    .sort((a, b) => String(shownB(a)).localeCompare(String(shownB(b)), undefined, { numeric: true }))
    .map((b) => {
      const co = dealOf(b).company ? ` — ${esc(dealOf(b).company)}` : '';
      return `<option value="${esc(b.boothNumber)}" label="Stand ${esc(shownB(b))}${co}"></option>`;
    }).join('');
}

// Resolve a typed query (booth id OR shown/display number) to a booth id.
function findAdminBooth(q) {
  q = String(q).trim();
  if (!q) return null;
  if (booths[q]) return q;                       // exact id
  const lc = q.toLowerCase();
  const hit = Object.values(booths).find((b) =>
    String(b.boothNumber).toLowerCase() === lc ||
    String(b.displayNumber || '').toLowerCase() === lc);
  return hit ? hit.boothNumber : null;
}

// Zoom + centre the plan on a booth. Computed directly from the current
// transform (invert pan/zoom → booth centre in content space → set scale and
// translate it to the frame centre) rather than via moveBy, which was flinging
// the plan off-screen. bounds:true may keep an edge stand slightly off-centre.
function focusAdminBooth(n) {
  const el = svgDoc?.querySelector(`[data-booth="${CSS.escape(n)}"]`);
  if (!el || !pzAdmin) return false;
  const t = pzAdmin.getTransform();
  if (!t || !t.scale) return false;
  const f = aFrame.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const cx = (r.left + r.width / 2 - f.left - t.x) / t.scale;   // booth centre in content space
  const cy = (r.top  + r.height / 2 - f.top  - t.y) / t.scale;
  const S = 2.5;                                                // target zoom
  // Aim for the centre of the SCREEN (clamped into the map frame), not the
  // centre of the frame: the frame sits right of the left nav, so its own centre
  // reads as off to the right. Landing the stand mid-viewport looks centred.
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const targetSx = clamp(window.innerWidth  / 2, f.left, f.right);
  const targetSy = clamp(window.innerHeight / 2, f.top,  f.bottom);
  pzAdmin.zoomAbs(0, 0, S);                                     // set the scale…
  pzAdmin.moveTo(targetSx - f.left - cx * S, targetSy - f.top - cy * S);   // …place it at screen centre
  return true;
}

function runAdminBoothSearch() {
  const input = document.getElementById('admin-fp-search');
  const v = input.value.trim();
  if (!v) return;
  const n = findAdminBooth(v);
  if (!n) { adminToast(`No booth matching "${v}".`, 'error'); return; }
  selectAdminBooth(n);   // clears prior search hit + sets the selection
  focusAdminBooth(n);
  searchHitId = n;       // remembered, so a re-tag can put the highlight back
  // Flag the found stand with a pulsing highlight so it's obvious which box it
  // is. Remove + reflow + re-add so the pulse restarts even on a repeat search.
  const el = svgDoc?.querySelector(`[data-booth="${CSS.escape(n)}"]`);
  if (el) {
    el.classList.remove('booth-search-hit', 'booth-search-held');
    void el.getBoundingClientRect();
    el.classList.add('booth-search-hit');
  }
}

// The stand the last search found, until another is selected. A re-tag — any
// split, merge or renumber, by anyone — rebuilds the stands and BoothMap.clear
// strips the highlight, so the found stand went back to looking like every
// other one until the admin searched again.
let searchHitId = null;

// ─── Load Admin SVG ───────────────────────────────────────────────────────────
let adminSvgReady = false;
let adminTagged = false;

/**
 * Fetch the plan — once, however many times it is asked for.
 *
 * Opening the Floorplan tab started a load whenever the plan was not there
 * yet, so a double-click on the nav, or leaving the tab and coming back while
 * the plan was still on its way, ran two. The second replaced the drawing with
 * a fresh UNTAGGED copy while the console still believed the plan was tagged,
 * and set up pan/zoom a second time: a plan whose stands answered no clicks,
 * under buttons that zoomed twice, until a reload. Now everyone who asks waits
 * for the one load in flight.
 */
let adminSvgLoad = null;
function loadAdminSVG() {
  if (!adminSvgLoad) adminSvgLoad = fetchAdminSVG().finally(() => { adminSvgLoad = null; });
  return adminSvgLoad;
}

/** Resolves once the plan is on the page — or has failed, and the tab says why. */
function adminPlanReady() {
  return svgDoc ? Promise.resolve() : loadAdminSVG();
}

async function fetchAdminSVG() {
  const mount = document.getElementById('admin-svg-mount');
  try {
    // The artwork for THIS show — uploaded per event, falling back to the file
    // shipped with the app. The page's X-Show header decides which comes back.
    // The event is in the URL, not only in a header. Every event used to
    // request the same /floorplan.svg and rely on X-Show to distinguish them,
    // which any cache in between is entitled to ignore — and did: one event's
    // plan was served for another's for the five minutes it stayed cached.
    const svgRes = await fetch(`/floorplan.svg?show=${encodeURIComponent(SHOW)}`);
    // The response was used unconditionally. A 401 hands back the login page's
    // HTML, which has no <svg> in it, so the next line threw and the whole tab
    // read "Failed to load" — the one message that rules out the actual cause.
    if (svgRes.status === 401) {
      location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
      return;
    }
    if (!svgRes.ok) throw new Error(`the server answered ${svgRes.status}`);
    mount.innerHTML = await svgRes.text();
    svgDoc = mount.querySelector('svg');
    if (!svgDoc) throw new Error('that response was not an SVG');
    svgDoc.setAttribute('width', '100%');
    svgDoc.setAttribute('height', '100%');
    adminSvgReady = true;
    // A drawing straight off the server carries no stands, whatever was true
    // of the one before it.
    adminTagged = false;
    tagAdminBooths();
    lucide.createIcons();
    initAdminPanZoom();
  } catch (e) {
    mount.replaceChildren(Object.assign(document.createElement('p'), {
      style: 'color:#f87171;padding:20px',
      textContent: `Could not load this event's floorplan — ${e.message}.`,
    }));
  }
}

function addAdminTap(el, callback) {
  let startX, startY;
  el.addEventListener('pointerdown', e => { startX = e.clientX; startY = e.clientY; });
  el.addEventListener('pointerup', e => {
    if (Math.abs(e.clientX - startX) < 10 && Math.abs(e.clientY - startY) < 10) {
      e.stopPropagation();
      callback(e);
    }
  });
}

// Identity comes from booth geometry via the shared BoothMap, exactly as on the
// public page. The old version numbered rectangles by document order, which
// disagreed with the server for most stands — so the admin floorplan tab showed
// the wrong company on the wrong stand, or nothing at all.
function tagAdminBooths() {
  if (!adminSvgReady || !Object.keys(booths).length || adminTagged) return;
  adminTagged = true;

  BoothMap.attach(svgDoc, Object.values(booths).concat(Object.values(removedBooths)).filter(b => b.geometry), {
    unit: UNIT,   // printed on a split cell's size, the way the plan prints its own
    onTag(el, id) {
      el.classList.add('booth-interactive');
      applyAdminVisual(el, booths[id]?.status || 'sold');
      el.addEventListener('mouseenter', e => showAdminTooltip(e, id));
      el.addEventListener('mousemove', e => moveAdminTooltip(e));
      el.addEventListener('mouseleave', () => hideAdminTooltip());
      addAdminTap(el, (e) => { if (e && e.shiftKey) toggleMultiSelect(id); else selectAdminBooth(id); });
    },
  });

  // attach() replaced the elements, so the selection and multi-select rings have
  // to be re-applied — applyAdminVisual covers status/sponsor fills but not
  // these. Otherwise a re-tag (split, merge, or now a renumber) cleared a
  // shift-selection the admin was midway through building.
  if (selectedAdminId) multiEl(selectedAdminId)?.classList.add('booth-selected');
  if (multiSel.size) renderMultiSelect();
  // And the stand a search found keeps its highlight — held still, not
  // pulsing again: the re-tag was somebody's change, not a new search.
  if (searchHitId) multiEl(searchHitId)?.classList.add('booth-search-hit', 'booth-search-held');

  paintAdminAreas();   // a re-tag rebuilds the plan under the area logos
}

// ─── Deferred exhibitor names ────────────────────────────────────────────────
//
// A name is fitted to the stand's real box, which exists only once the plan has
// been laid out — and on this page the plan spends most of its life inside a
// hidden tab. Repainting while it is hidden skips every name, and a re-tag
// (a split, a merge, a renumber) clears the existing ones first, so a
// structural change made from another tab could leave the plan wearing no names
// at all when the admin next opened it.
//
// The old comment said it "repaints on next broadcast", but a broadcast only
// happens when someone changes something — on a quiet plan the names stayed
// missing until a reload that happened to be laid out in time.
let adminLabelsDeferred = false;

// Matches the public plan's ceiling — see the note there, including why it is
// not larger. A stand must look the same on both surfaces.
const LABEL_MAX_FONT = 9;


function repaintAdminLabels() {
  if (!svgDoc || !adminTagged || !adminLabelsDeferred) return;
  adminLabelsDeferred = false;
  Object.values(booths).forEach(b => {
    const el = svgDoc.querySelector(`[data-booth="${CSS.escape(b.boothNumber)}"]`);
    if (el) applyAdminVisual(el, b.status);
  });
  paintAdminAreas();
}

// The plan's named areas and their sponsor logos — the admin sees the same
// thing the public does, so a logo can be checked in place before anyone else
// sees it.
let planAreas = [];

function paintAdminAreas() {
  if (!svgDoc || !planAreas.length) return;
  if (BoothMap.paintAreaLogos(svgDoc, planAreas, 'admin-area-logo-')) adminLabelsDeferred = true;
  wireAdminAreas();
  if (selectedAreaKey) renderAdminAreaPanel(selectedAreaKey);   // live edits from elsewhere
}

// Clicking a lounge on the plan edits that lounge. Before this the only way in
// was Tools → Sponsored Areas, which is not where anyone looks when they can
// see the thing they want to change.
function wireAdminAreas() {
  planAreas.forEach(a => {
    const host = BoothMap.areaHost(svgDoc, a);
    if (!host || host.dataset.areaWired === '1') return;
    host.dataset.areaWired = '1';
    host.classList.add('area-interactive-admin');
    addAdminTap(host, () => selectAdminArea(a.key));
  });
}

let selectedAreaKey = null;

function selectAdminArea(key) {
  // The stand panel and the area panel share a slot, so opening one closes the
  // other rather than stacking two editors over each other.
  if (selectedAdminId) {
    multiEl(selectedAdminId)?.classList.remove('booth-selected');
    selectedAdminId = null;
  }
  document.getElementById('admin-booth-action')?.classList.add('hidden');
  svgDoc.querySelectorAll('[data-area]').forEach(el => el.classList.remove('booth-selected'));
  selectedAreaKey = key;
  svgDoc.querySelector(`[data-area="${CSS.escape(key)}"]`)?.classList.add('booth-selected');
  renderAdminAreaPanel(key);
}

function renderAdminAreaPanel(key) {
  const a = planAreas.find(x => x.key === key);
  const panel = document.getElementById('admin-area-action');
  if (!a || !panel) return;
  panel.classList.remove('hidden');

  document.getElementById('ara-name').textContent = a.label;
  const badge = document.getElementById('ara-status-badge');
  const taken = a.status === 'taken';
  badge.textContent = taken ? 'Sponsored' : 'Available';
  badge.className = `aba-badge ${taken ? 'badge-sold' : 'badge-available'}`;

  const body = document.getElementById('ara-body');
  body.replaceChildren(areaEditor(a));
}

socket.on('areas:catalogue', (list) => {
  planAreas = Array.isArray(list) ? list : [];
  ensureSponsorCache().then(() => { paintAdminAreas(); renderAreaCards(); });
});

// The "sells as" dropdown lists the sponsorship catalogue, which otherwise only
// loads when the Sponsors tab is opened. Fetched once, so an admin who goes
// straight to Tools still gets a populated list.
let sponsorCacheLoad = null;
function ensureSponsorCache() {
  if (sponsorAdminCache.length) return Promise.resolve();
  if (!sponsorCacheLoad) {
    sponsorCacheLoad = api('/api/sponsors')
      .then(rows => { if (!sponsorAdminCache.length) sponsorAdminCache = rows || []; })
      .catch(() => { /* the dropdown just shows "not linked" */ });
  }
  return sponsorCacheLoad;
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) repaintAdminLabels(); });
window.addEventListener('pageshow', repaintAdminLabels);
// Forced, not conditional — see the note on the public plan: asking
// document.fonts whether Raleway is ready returns true even when it is not
// loaded, because a fallback satisfies the question.
if (document.fonts) document.fonts.ready.then(() => { adminLabelsDeferred = true; repaintAdminLabels(); });
// The frame going from zero-sized to laid out is what happens when the
// Floorplan tab is opened, and it fires no visibility event.
if (window.ResizeObserver && aFrame) new ResizeObserver(repaintAdminLabels).observe(aFrame);

function applyAdminVisual(el, status) {
  el.classList.remove('booth-available', 'booth-sold', 'booth-held', 'booth-sponsored');
  el.classList.add(`booth-${status}`);

  const id = el.getAttribute('data-booth');
  // Sponsor fill — brand colour overrides the status fill for a sponsored stand.
  const sponsored = booths[id]?.sponsored && sponsorColor;
  el.classList.toggle('booth-sponsored', !!sponsored);
  // The status fills are `!important`; an inline `important` property beats them.
  if (sponsored) el.style.setProperty('fill', sponsorColor, 'important');
  else el.style.removeProperty('fill');

  let textNode = svgDoc.querySelector(`[id="admin-text-${id}"]`);
  let logoNode = svgDoc.querySelector(`[id="admin-logo-${id}"]`);
  const company = dealOf(booths[id]).company;
  // The sponsor's logo replaces the exhibitor name — same rule as the public
  // plan, so a stand looks the same on both.
  const logo = (booths[id]?.sponsored && booths[id]?.sponsorLogo) || null;

  if (logo) {
    if (!logoNode) {
      logoNode = document.createElementNS('http://www.w3.org/2000/svg', 'image');
      logoNode.setAttribute('id', `admin-logo-${id}`);
      logoNode.style.pointerEvents = 'none';   // the stand underneath stays clickable
      el.parentNode.appendChild(logoNode);
    }
    try {
      const box = BoothMap.visualBox(el);
      if (!box || !(box.w > 0) || !(box.h > 0)) throw new Error('not laid out');
      BoothMap.fitImage(logoNode, logo, box);
    } catch { adminLabelsDeferred = true; }
  } else if (logoNode) {
    logoNode.remove();
  }

  if (status !== 'available' && company && !logo) {
    if (!textNode) {
      textNode = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      textNode.setAttribute('id', `admin-text-${id}`);
      textNode.setAttribute('fill', '#111827');
      textNode.style.pointerEvents = 'none';
      el.parentNode.appendChild(textNode);
    }
    // VISUAL box (post-transform): most LEX27 stands are rotated, so the local
    // getBBox mis-places the name and fits it to swapped dimensions. Guarded so
    // an un-rendered stand (hidden tab) can't abort the whole update loop.
    try {
      const vbox = BoothMap.visualBox(el);
      if (!vbox || !(vbox.w > 0) || !(vbox.h > 0)) throw new Error('not laid out');
      // Wrap / hyphenate / shrink to fit — never truncate. Same weight/size as
      // the public plan so a stand looks identical on both.
      BoothMap.fitLabel(textNode, company, vbox,
        { family: 'Raleway, sans-serif', weight: '600', maxFont: LABEL_MAX_FONT });
      textNode.setAttribute('fill', sponsored ? contrastText(sponsorColor) : '#111827');
    } catch {
      // Not laid out — the Floorplan tab is hidden, or the panel has no size
      // yet. Book a repaint rather than waiting for a broadcast that may never
      // come; see repaintAdminLabels.
      adminLabelsDeferred = true;
    }
  } else if (textNode) {
    textNode.remove();
  }
}

// ─── Admin Tooltip ────────────────────────────────────────────────────────────
const adminTooltip = document.getElementById('admin-tooltip');
function showAdminTooltip(e, id) {
  const b = booths[id];
  document.getElementById('att-label').textContent = `Stand ${shownB(b) || id}`;
  document.getElementById('att-status').textContent = cap(b?.status || 'unknown');
  document.getElementById('att-price').textContent = (b && b.listPrice != null) ? money(b.listPrice) : '';
  const hold = document.getElementById('att-hold');
  if (hold) {
    const left = b && b.status === 'held' ? holdLeft(id) : null;
    hold.textContent = left ? `Hold ${left.text}` : '';
    hold.classList.toggle('urgent', !!(left && left.urgent));
  }
  adminTooltip.classList.remove('hidden');
  moveAdminTooltip(e);
}
function moveAdminTooltip(e) {
  const r = aFrame.getBoundingClientRect();
  adminTooltip.style.left = (e.clientX - r.left + 14) + 'px';
  adminTooltip.style.top = (e.clientY - r.top - 10) + 'px';
}
function hideAdminTooltip() { adminTooltip.classList.add('hidden'); }

// ─── Admin Select Booth ───────────────────────────────────────────────────────
function selectAdminBooth(id) {
  // Asked for before the plan has arrived — a link in the Activity Log is often
  // the first thing to open the Floorplan tab — this threw on the missing
  // drawing. It waits for the plan instead, then selects.
  if (!svgDoc) {
    adminPlanReady().then(() => { if (svgDoc && booths[id]) selectAdminBooth(id); });
    return;
  }
  clearMultiSelect();                              // a plain click abandons any shift-selection
  if (splitUI.id && splitUI.id !== id) exitSplitMode();   // …and a half-placed divider on another stand
  if (selectedAreaKey) {
    svgDoc.querySelectorAll('[data-area]').forEach(el => el.classList.remove('booth-selected'));
    selectedAreaKey = null;
    document.getElementById('admin-area-action')?.classList.add('hidden');
  }
  if (selectedAdminId) {
    svgDoc.querySelector(`[data-booth="${CSS.escape(selectedAdminId)}"]`)?.classList.remove('booth-selected');
  }
  // Drop any lingering search highlight when the selection changes (e.g. a click
  // elsewhere), so only the current search hit ever pulses.
  svgDoc.querySelectorAll('.booth-search-hit').forEach((e) => e.classList.remove('booth-search-hit', 'booth-search-held'));
  searchHitId = null;
  selectedAdminId = id;
  svgDoc.querySelector(`[data-booth="${CSS.escape(id)}"]`)?.classList.add('booth-selected');
  renderAdminBoothAction(id);
}

/* ---- Shift-click multi-select + N-way consolidate --------------------- */
const multiSel = new Set();

function multiEl(id) { return svgDoc.querySelector(`[data-booth="${CSS.escape(id)}"]`); }

function toggleMultiSelect(id) {
  if (!id || !booths[id]) return;
  if (splitUI.id) exitSplitMode();                 // one thing at a time on the plan
  // Seed the set with the current single selection so shift-clicking a second
  // stand grows the pair the admin already had focused.
  if (!multiSel.size && selectedAdminId && selectedAdminId !== id) multiSel.add(selectedAdminId);
  if (multiSel.has(id)) multiSel.delete(id);
  else multiSel.add(id);
  // Clear the single-selection chrome — we're in multi mode now.
  if (selectedAdminId) { multiEl(selectedAdminId)?.classList.remove('booth-selected'); selectedAdminId = null; }
  renderMultiSelect();
}

function renderMultiSelect() {
  svgDoc.querySelectorAll('.booth-multi').forEach((e) => e.classList.remove('booth-multi'));
  multiSel.forEach((id) => multiEl(id)?.classList.add('booth-multi'));
  const bar = document.getElementById('multi-bar');
  const count = document.getElementById('multi-count');
  if (count) count.textContent = String(multiSel.size);
  if (bar) bar.hidden = multiSel.size < 2;
}

function clearMultiSelect() {
  if (!multiSel.size) { const b = document.getElementById('multi-bar'); if (b) b.hidden = true; return; }
  multiSel.forEach((id) => multiEl(id)?.classList.remove('booth-multi'));
  multiSel.clear();
  renderMultiSelect();
}

/* ---- Reset from the plan: undo a split or a merge where it was made ------ */
//
// Reset used to live only in Tools, behind a dropdown of every stand, so a
// split made with two clicks on the plan took a hunt through a list to undo.
// The stand panel now offers it on any composite stand, and the shift-select
// bar undoes several at once.
//
// What "reset" acts on depends on which piece was clicked. A merged block and
// a split PARENT carry the snapshot and are reset directly. A split CELL is
// only a fragment: undoing it means restoring its parent, which removes every
// sibling too — so the cell's reset targets the parent. A cell whose parent
// has no snapshot (a leftover from before snapshots existed) is just removed.
// A stand may carry a merge AND a split — merged then divided, or divided then
// merged with what is next to it. The server undoes the LATER one and leaves
// the other for a second reset, so the button has to name the same step, or it
// promises an un-merge and performs an un-split. Mirrors booths.splitIsLatest.
const shapeStamp = (snap) => (snap ? (snap.at ? new Date(snap.at).getTime() : 0) : -1);
const splitIsLatest = (b) => !!(b && b.splitSnapshot) && shapeStamp(b.splitSnapshot) >= shapeStamp(b.mergeSnapshot);

function resetTargetOf(b) {
  if (!b) return null;
  const more = !!(b.mergeSnapshot && b.splitSnapshot);   // a second reset follows this one
  if (b.splitSnapshot && splitIsLatest(b)) return { target: b.boothNumber, kind: 'unsplit', more };
  if (b.mergeSnapshot) return { target: b.boothNumber, kind: 'unmerge', more };
  if (b.splitSnapshot) return { target: b.boothNumber, kind: 'unsplit', more };
  if (b.splitFrom) {
    const parent = booths[b.splitFrom];
    if (parent && parent.splitSnapshot && (parent.splitSnapshot.created || []).includes(b.boothNumber)) {
      return { target: b.boothNumber === parent.boothNumber ? b.boothNumber : parent.boothNumber, kind: 'unsplit', via: b.boothNumber };
    }
    return { target: b.boothNumber, kind: 'remove-cell' };
  }
  return null;
}

function resetDescription(r) {
  // One step per reset, so say which step, and say when there is another
  // behind it — otherwise a stand that was merged and then split looks as if
  // the reset only half worked.
  const then = r.more ? ' (a second Reset undoes the step before it)' : '';
  if (r.kind === 'unmerge') return `un-merge stand ${shownN(r.target)} back into its original stands${then}`;
  if (r.kind === 'unsplit') return `undo the split of stand ${shownN(r.target)} — its cells are removed and the whole stand comes back${then}`;
  return `remove the leftover cell ${shownN(r.target)}`;
}

/**
 * The stand a successful reset actually changed. Asked of a split cell, the
 * server undoes its parent's split and says which parent (`parent`) — so
 * that, not the cell that was asked about and is now gone, is the stand to
 * name and to open.
 */
const resetLanded = (asked, res) => (res && res.type === 'unsplit' && res.parent) || asked;

function resetToastFor(boothNumber, res) {
  const n = resetLanded(boothNumber, res);
  return res.type === 'unmerge' ? `Stand ${shownN(n)} un-merged — restored ${(res.restored || []).join(', ') || 'originals'}.`
       : res.type === 'unsplit' ? `Stand ${shownN(n)} un-split — removed ${(res.removed || []).join(', ')}.`
       : `Removed leftover cell ${shownN(n)}.`;
}

async function resetFromPanel(n) {
  const r = resetTargetOf(booths[n]);
  if (!r) return adminToast('That stand was not merged or split.', 'error');
  // The styled dialog every other action on this panel uses. This one alone
  // still called the browser's confirm(), which arrives unstyled, with the
  // origin in the title bar, and reads as something the page did not mean to
  // do — on the one action whose wording has to be read carefully, because a
  // stand carrying both a merge and a split undoes only one of them here.
  if (!await confirmDialog(`This will ${resetDescription(r)}.`,
      { title: `Reset stand ${shownN(r.target)}`, confirmLabel: 'Reset it' })) return;
  socket.emit('booth:reset', { boothNumber: r.target }, (res) => {
    if (res && res.ok) {
      adminToast(resetToastFor(r.target, res), 'ok');
      // A leftover cell is gone once reset, so its panel closes here, under
      // the toast that says why — not a moment later when the broadcast finds
      // the stand missing and has to explain it all over again. Otherwise the
      // panel moves to the stand the server says it changed.
      const landed = resetLanded(r.target, res);
      if (res.type === 'remove-cell') closeStandPanel();
      else if (booths[landed]) selectAdminBooth(landed);
      else closeStandPanel();
    }
    else adminToast((res && res.error) || 'Reset failed.', 'error');
  });
}

// Every selected stand resolved to what its reset acts on, de-duplicated —
// selecting both halves of one split resets that split once, not twice (the
// second would be refused as "not merged or split" after the first succeeded).
async function restoreMultiSelect() {
  const seen = new Set(), targets = [];
  let skipped = 0;
  multiSel.forEach((id) => {
    const r = resetTargetOf(booths[id]);
    if (!r) { skipped++; return; }
    if (seen.has(r.target)) return;
    seen.add(r.target); targets.push(r);
  });
  if (!targets.length) return adminToast('None of the selected stands was merged or split.', 'error');
  const lines = targets.map(r => `• ${resetDescription(r)}`).join('\n');
  const note = skipped ? `\n\n(${skipped} selected stand${skipped === 1 ? ' was' : 's were'} not merged or split and will be left alone.)` : '';
  // The styled dialog, as everywhere else on this bar — see resetFromPanel.
  if (!await confirmDialog(`${lines}${note}`,
      { title: `Reset ${targets.length} stand${targets.length === 1 ? '' : 's'}`, confirmLabel: 'Reset them' })) return;

  const btn = document.getElementById('multi-restore');
  if (btn) btn.disabled = true;
  // One at a time, in order: each reset changes the plan the next one acts
  // on, and the server re-tags the map after every success.
  const done = [], failed = [];
  const next = (i) => {
    if (i >= targets.length) {
      if (btn) btn.disabled = false;
      clearMultiSelect();
      if (done.length) adminToast(`Restored ${done.map(shownN).join(', ')}.`, failed.length ? 'error' : 'ok');
      if (failed.length) adminToast(failed.join(' '), 'error');
      return;
    }
    const r = targets[i];
    socket.emit('booth:reset', { boothNumber: r.target }, (res) => {
      if (res && res.ok) done.push(resetLanded(r.target, res));
      else failed.push((res && res.error) || `Could not reset ${shownN(r.target)}.`);
      next(i + 1);
    });
  };
  next(0);
}

// A split cell prints its size with the unit; when the unit changes after the
// plan was drawn, the printed figures follow without a re-tag.
function relabelSplitSizes() {
  if (!svgDoc) return;
  svgDoc.querySelectorAll('[data-split-size]').forEach((t) => {
    const b = booths[t.getAttribute('data-split-size')];
    if (b && b.sqm) t.textContent = b.sqm + UNIT;
  });
}

/* ---- The stand number, edited in the panel itself -------------------------- */
//
// Changing what a stand is called meant Tools → Shown Number: pick the stand
// from a list of every stand, type, save. The panel already has the stand in
// front of the admin, so its title is now the place to do it: click the
// number or the pencil, type, Enter. Escape or clicking away abandons the
// edit; saving an empty box puts the stand's own number back. The identity
// (boothNumber) never changes — this is the shown number, as in Tools.
function renderPanelNumber(b) {
  const btn = document.getElementById('aba-id');
  if (!btn) return;
  btn.replaceChildren();
  btn.append(`Stand ${shownB(b)}`);
  if (b.displayNumber && b.displayNumber !== b.boothNumber) {
    const small = document.createElement('small');
    small.textContent = `(${b.boothNumber})`;
    btn.append(small);
  }
  panelNumberEdit(false);
}

function panelNumberEdit(on) {
  const btn = document.getElementById('aba-id'), input = document.getElementById('aba-id-input'), pencil = document.getElementById('aba-id-edit');
  if (!btn || !input) return;
  btn.hidden = on; input.hidden = !on; if (pencil) pencil.hidden = on;
  if (on) {
    const b = booths[selectedAdminId];
    input.value = (b && (b.displayNumber || b.boothNumber)) || '';
    input.dataset.for = selectedAdminId || '';
    input.focus(); input.select();
  }
}

function savePanelNumber() {
  const input = document.getElementById('aba-id-input');
  const boothNumber = input.dataset.for;
  const b = booths[boothNumber];
  if (!b) return panelNumberEdit(false);
  const value = input.value.trim();
  const current = b.displayNumber || '';
  // Typing the stand's own number, or nothing, means "no shown number".
  const displayNumber = value === b.boothNumber ? '' : value;
  if (displayNumber === current) return panelNumberEdit(false);
  input.disabled = true;
  socket.emit('booth:set-number', { boothNumber, displayNumber }, (res) => {
    input.disabled = false;
    if (res && res.ok) {
      adminToast(res.cleared ? `Stand ${boothNumber} shows its own number again.` : `Stand ${boothNumber} now shown as ${res.value}.`, 'ok');
      panelNumberEdit(false);            // the state broadcast repaints the title
    } else {
      adminToast((res && res.error) || 'Could not change the number.', 'error');
      input.focus(); input.select();     // keep what was typed so it can be fixed
    }
  });
}

(function wirePanelNumber() {
  const btn = document.getElementById('aba-id'), input = document.getElementById('aba-id-input'), pencil = document.getElementById('aba-id-edit');
  if (!btn || !input) return;
  btn.addEventListener('click', () => { if (selectedAdminId) panelNumberEdit(true); });
  pencil?.addEventListener('click', () => { if (selectedAdminId) panelNumberEdit(true); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); savePanelNumber(); }
    else if (e.key === 'Escape') { e.preventDefault(); panelNumberEdit(false); }
  });
  // Clicking away saves what was typed, as a spreadsheet cell does — unless
  // the box was left untouched, in which case nothing is sent.
  input.addEventListener('blur', () => { if (!input.hidden && !input.disabled) savePanelNumber(); });
})();

// Commercial fields now live under `assignment` on the booth document.
const dealOf = (b) => (b && b.assignment) || {};

/* ---- Drag-to-split: one divider across a stand, two cells, live sizes ---- */
//
// The admin presses Split on a stand, a divider appears across its middle, and
// dragging it moves the split point with both sizes updating as whole m². The
// server carves the geometry in the same proportion, so the line lands on the
// plan where it was dragged. One divider makes exactly two stands; a third
// part is a second split of one of the halves.
const splitUI = { id: null, axis: 'vertical', first: 0, total: 0, g: null, group: null, parts: null, dragging: false };
const SPLIT_NS = 'http://www.w3.org/2000/svg';

// Mirrors the server's rules for booth:split, so the button is only offered
// where the split would be accepted: available, unsold, not already a merge or
// a split parent, and big enough to leave 1 m² on each side.
function canSplitOnMap(b) {
  // A merged block may be divided — the merge is kept and Reset unwinds the two
  // in turn. A stand already split may not: re-carving one is the custom split.
  return !!b && b.status === 'available' && !dealOf(b).company
      && !b.splitSnapshot && !!b.geometry && (b.sqm || 0) >= 2;
}

function enterSplitMode(id) {
  const b = booths[id];
  if (!svgDoc || !canSplitOnMap(b)) return;
  if (splitUI.id) exitSplitMode();
  clearMultiSelect();
  const g = b.geometry;
  splitUI.id = id;
  splitUI.g = g;
  splitUI.total = Math.round(b.sqm);
  splitUI.first = Math.max(1, Math.min(splitUI.total - 1, Math.floor(splitUI.total / 2)));
  // Default to the direction that leaves the squarer cells: a wide stand is
  // cut left/right, a tall one top/bottom.
  splitUI.axis = g.w >= g.h ? 'vertical' : 'horizontal';
  buildSplitPreview();
  const bar = document.getElementById('split-bar');
  if (bar) bar.hidden = false;
  const idEl = document.getElementById('split-bar-id');
  if (idEl) idEl.textContent = shownN(id);
  renderSplitPreview();
}

function exitSplitMode() {
  if (splitUI.group && splitUI.group.parentNode) splitUI.group.parentNode.removeChild(splitUI.group);
  splitUI.group = null; splitUI.parts = null; splitUI.id = null; splitUI.g = null; splitUI.dragging = false;
  const bar = document.getElementById('split-bar');
  if (bar) bar.hidden = true;
}

function setSplitAxis(axis) {
  if (!splitUI.id) return;
  splitUI.axis = axis === 'horizontal' ? 'horizontal' : 'vertical';
  renderSplitPreview();
}

function setSplitFirst(first) {
  if (!splitUI.id) return;
  splitUI.first = Math.max(1, Math.min(splitUI.total - 1, Math.round(first)));
  renderSplitPreview();
}

// Build the preview once per split; renderSplitPreview() moves the pieces.
// Appended at the very end of the SVG so it sits above every stand overlay
// and split box, which are themselves appended last.
function buildSplitPreview() {
  const mk = (tag, cls) => { const el = document.createElementNS(SPLIT_NS, tag); if (cls) el.setAttribute('class', cls); return el; };
  const group = mk('g'); group.id = 'split-preview';
  const cellA = mk('rect', 'split-cell'), cellB = mk('rect', 'split-cell');
  cellA.setAttribute('fill', 'rgba(56,189,248,0.22)');
  cellB.setAttribute('fill', 'rgba(16,185,129,0.22)');
  const line = mk('line', 'split-line');
  line.setAttribute('stroke', '#f43f5e');
  line.setAttribute('stroke-linecap', 'round');
  const handle = mk('rect', 'split-handle');
  const textA = mk('text'), textB = mk('text');
  [textA, textB].forEach(t => { t.setAttribute('text-anchor', 'middle'); t.setAttribute('dominant-baseline', 'central'); t.setAttribute('fill', '#0f172a'); });
  group.append(cellA, cellB, line, textA, textB, handle);
  svgDoc.appendChild(group);
  splitUI.group = group;
  splitUI.parts = { cellA, cellB, line, handle, textA, textB };

  // Pointer events drive the drag; the plain mouse/touch events are stopped
  // here so panzoom (listening on the map frame) doesn't pan the plan too.
  handle.addEventListener('mousedown', e => e.stopPropagation());
  handle.addEventListener('touchstart', e => { e.stopPropagation(); }, { passive: true });
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    splitUI.dragging = true;
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}
    splitFromPointer(e);
  });
  handle.addEventListener('pointermove', (e) => { if (splitUI.dragging) splitFromPointer(e); });
  const stop = () => { splitUI.dragging = false; };
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
  handle.addEventListener('lostpointercapture', stop);
}

// Where along the stand the pointer is, as a share of its area. Measured
// against the stand's own on-screen box, so pan and zoom fall out naturally.
function splitFromPointer(e) {
  const el = multiEl(splitUI.id);
  if (!el) return;
  const r = el.getBoundingClientRect();
  const frac = splitUI.axis === 'vertical' ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
  if (!Number.isFinite(frac)) return;
  setSplitFirst(frac * splitUI.total);
}

function renderSplitPreview() {
  const P = splitUI.parts, g = splitUI.g;
  if (!P || !g) return;
  const vertical = splitUI.axis === 'vertical';
  const frac = splitUI.first / splitUI.total;
  const len = vertical ? g.w : g.h;
  const a = len * frac;
  const shorter = Math.min(g.w, g.h);
  const sw = Math.max(1, Math.min(4, shorter * 0.05));       // divider stroke
  const hw = Math.max(8, Math.min(24, shorter * 0.3));       // grab width around it
  const setRect = (el, x, y, w, h) => { el.setAttribute('x', x); el.setAttribute('y', y); el.setAttribute('width', Math.max(0, w)); el.setAttribute('height', Math.max(0, h)); };

  if (vertical) {
    setRect(P.cellA, g.x, g.y, a, g.h);
    setRect(P.cellB, g.x + a, g.y, g.w - a, g.h);
    P.line.setAttribute('x1', g.x + a); P.line.setAttribute('x2', g.x + a);
    P.line.setAttribute('y1', g.y);     P.line.setAttribute('y2', g.y + g.h);
    setRect(P.handle, g.x + a - hw / 2, g.y, hw, g.h);
  } else {
    setRect(P.cellA, g.x, g.y, g.w, a);
    setRect(P.cellB, g.x, g.y + a, g.w, g.h - a);
    P.line.setAttribute('x1', g.x);     P.line.setAttribute('x2', g.x + g.w);
    P.line.setAttribute('y1', g.y + a); P.line.setAttribute('y2', g.y + a);
    setRect(P.handle, g.x, g.y + a - hw / 2, g.w, hw);
  }
  P.line.setAttribute('stroke-width', sw);
  P.handle.setAttribute('class', 'split-handle ' + (vertical ? 'vertical' : 'horizontal'));

  // Each cell's size sits in its centre, sized to fit that cell — a thin
  // sliver gets a small figure rather than one spilling over the line.
  const second = splitUI.total - splitUI.first;
  const label = (t, str, x, y, w, h) => {
    t.textContent = str;
    t.setAttribute('x', x); t.setAttribute('y', y);
    const fs = Math.max(4, Math.min(12, w / (0.62 * str.length), h / 1.6));
    t.setAttribute('font-size', fs);
  };
  if (vertical) {
    label(P.textA, `${splitUI.first} ${UNIT}`, g.x + a / 2, g.y + g.h / 2, a, g.h);
    label(P.textB, `${second} ${UNIT}`, g.x + a + (g.w - a) / 2, g.y + g.h / 2, g.w - a, g.h);
  } else {
    label(P.textA, `${splitUI.first} ${UNIT}`, g.x + g.w / 2, g.y + a / 2, g.w, a);
    label(P.textB, `${second} ${UNIT}`, g.x + g.w / 2, g.y + a + (g.h - a) / 2, g.w, g.h - a);
  }

  const aEl = document.getElementById('split-bar-a'), bEl = document.getElementById('split-bar-b');
  if (aEl) aEl.textContent = `${splitUI.first} ${UNIT}`;
  if (bEl) bEl.textContent = `${second} ${UNIT}`;
  document.getElementById('split-bar-vertical')?.classList.toggle('active', vertical);
  document.getElementById('split-bar-horizontal')?.classList.toggle('active', !vertical);
}

function applySplit() {
  if (!splitUI.id) return;
  const { id, axis, first, total } = splitUI;
  const btn = document.getElementById('split-bar-apply');
  if (btn) btn.disabled = true;
  socket.emit('booth:split', { boothNumber: id, parts: 2, axis, firstSqm: first }, (res) => {
    if (btn) btn.disabled = false;
    if (res && res.ok) {
      adminToast(`Stand ${shownN(id)} split into ${first} + ${total - first} ${UNIT} — added ${(res.created || []).join(', ')}.`, 'ok');
      exitSplitMode();
    } else {
      adminToast((res && res.error) || 'Could not split that stand.', 'error');
    }
  });
}

// Bar buttons and keys. Wired once; the bar is a fixed part of the page.
(function wireSplitBar() {
  document.getElementById('split-bar-vertical')?.addEventListener('click', () => setSplitAxis('vertical'));
  document.getElementById('split-bar-horizontal')?.addEventListener('click', () => setSplitAxis('horizontal'));
  document.getElementById('split-bar-apply')?.addEventListener('click', applySplit);
  document.getElementById('split-bar-cancel')?.addEventListener('click', exitSplitMode);
  document.addEventListener('keydown', (e) => {
    if (!splitUI.id || keyForDialog(e)) return;   // a dialog's keys are the dialog's
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return;
    const vertical = splitUI.axis === 'vertical';
    const back = vertical ? 'ArrowLeft' : 'ArrowUp', fwd = vertical ? 'ArrowRight' : 'ArrowDown';
    if (e.key === 'Enter' && tag === 'BUTTON') return;   // the focused button already handles Enter
    if (e.key === 'Escape') { e.preventDefault(); exitSplitMode(); }
    else if (e.key === back) { e.preventDefault(); setSplitFirst(splitUI.first - 1); }
    else if (e.key === fwd)  { e.preventDefault(); setSplitFirst(splitUI.first + 1); }
    else if (e.key === 'Enter') { e.preventDefault(); applySplit(); }
  });
})();

/* ---- Closing a panel, and the two keys worth having ------------------- */
//
// The stand panel had no close control of any kind. Once open it could only be
// REPLACED — by clicking another stand — so it sat over the plan covering the
// corner of the hall you were trying to look at, and the only way out was a
// reload.
function closeStandPanel() {
  if (selectedAdminId) {
    multiEl(selectedAdminId)?.classList.remove('booth-selected');
    selectedAdminId = null;
  }
  document.getElementById('admin-booth-action')?.classList.add('hidden');
}

function closeAreaPanel() {
  if (selectedAreaKey && svgDoc) {
    svgDoc.querySelectorAll('[data-area]').forEach(el => el.classList.remove('booth-selected'));
  }
  selectedAreaKey = null;
  document.getElementById('admin-area-action')?.classList.add('hidden');
}

document.getElementById('aba-close')?.addEventListener('click', closeStandPanel);
document.getElementById('ara-close')?.addEventListener('click', closeAreaPanel);

/**
 * Keys pressed in a dialog are the dialog's. Escape pressed to cancel a
 * confirm also closed the stand panel behind it: the keystroke bubbles up to
 * the page, and the dialog's focused BUTTON did not look like typing to the
 * check below.
 */
const keyForDialog = (e) => dialogOpen() || !!(e.target && e.target.closest && e.target.closest('dialog'));

document.addEventListener('keydown', (e) => {
  if (keyForDialog(e)) return;
  // Split mode owns Escape while a divider is placed — see wireSplitBar above.
  if (splitUI.id) return;
  const tag = (e.target && e.target.tagName) || '';
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
                 (e.target && e.target.isContentEditable);

  if (e.key === 'Escape' && !typing) {
    // Whichever panel is open; they share a slot and are mutually exclusive.
    if (!document.getElementById('admin-booth-action')?.classList.contains('hidden')) {
      e.preventDefault(); closeStandPanel();
    } else if (!document.getElementById('admin-area-action')?.classList.contains('hidden')) {
      e.preventDefault(); closeAreaPanel();
    } else if (multiSel.size) {
      e.preventDefault(); clearMultiSelect();
    }
    return;
  }

  // "/" jumps to the stand search, the way it does in every tool that has one.
  // Finding a stand on a 270-stand plan was a mouse trip to a small box.
  if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
    const box = document.getElementById('admin-fp-search');
    if (!box) return;
    e.preventDefault();
    showAdminSection('floorplan');
    setTimeout(() => { box.focus(); box.select(); }, 40);
  }
});

// Show-level settings pushed from the server: area unit (m²/ft², a label only)
// and the rate. All update live via the 'settings' socket event.
let UNIT = 'm²', RATE = null;
// The show's currency symbol, pushed from its settings. '€' until told otherwise,
// so a show that has never set one prints exactly as it always did.
let CUR = '€';
let CURRENCY = 'EUR';
let recoveryRequired = false;   // failsafe: destructive actions need the recovery key

// The number to SHOW for a stand: the admin-set override if present, else the
// real identity. Identity (boothNumber) is what all lookups/emits still use.
const shownB = (b) => (b && b.displayNumber) || (b && b.boothNumber) || '';
const shownN = (n) => shownB(booths[n]) || n;

// Floorplan (title) sponsor — brand colour that fills sponsored stands. Pushed
// from the server on connect and whenever it changes.
let sponsorColor = '', sponsorName = '';
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

/**
 * The stand panel, drawn for the stand just selected.
 *
 * It used to be drawn ONLY here, at the click, while the broadcasts that
 * followed repainted its tags and buttons and nothing else. Production
 * acknowledges an action ~80 ms before the state that reflects it arrives, so
 * the panel went on showing the stand as it was at the click: Mark Sold and it
 * still read "Available", a merge showed one stand's size for the whole block,
 * a split the whole stand's size for one cell. Now every broadcast redraws the
 * open panel from the live stand — see refreshStandPanel — except whatever is
 * being typed into it, which belongs to the person typing.
 */
function renderAdminBoothAction(n) {
  const b = booths[n];
  if (!b) return;
  const panel = document.getElementById('admin-booth-action');
  panel.classList.remove('hidden');

  paintStandPanel(b, { fresh: true });
  fillDealFields(b);          // a fresh selection starts from what is stored

  // Click history is no longer a 20-entry array on the booth; it comes from the
  // activity stream, so it survives restarts and is not capped.
  const clickList = document.getElementById('aba-click-list');
  clickList.textContent = 'Loading…';
  api(`/api/booths/${encodeURIComponent(n)}/activity?limit=20`)
    .then(rows => {
      if (selectedAdminId !== n) return;      // another stand was opened meanwhile
      clickList.replaceChildren();
      if (!rows.length) { clickList.textContent = 'No activity yet.'; return; }
      rows.forEach(r => {
        const div = document.createElement('div');
        const country = r.context?.country ? ` · ${r.context.country}` : '';
        div.textContent = `${new Date(r.ts).toLocaleString('en-GB')} — ${r.type}${country}`;
        clickList.appendChild(div);
      });
    })
    .catch(() => { if (selectedAdminId === n) clickList.textContent = 'Could not load activity.'; });

  document.getElementById('aba-export').onclick  = () => exportSingleCSV(n);
}

/** Everything on the panel that is READ off the stand rather than typed into it. */
function paintStandPanel(b, { fresh = false } = {}) {
  const n = b.boothNumber;
  const d = dealOf(b);
  // The title follows a rename from anywhere (this panel, Tools, another
  // admin) — unless the number is being typed here right now, in which case
  // the admin's keystrokes are not thrown away for a broadcast.
  const numberInput = document.getElementById('aba-id-input');
  if (fresh || !numberInput || numberInput.hidden) renderPanelNumber(b);
  document.getElementById('aba-status').textContent  = cap(b.status);
  document.getElementById('aba-sqm').textContent     = `${b.sqm} ${UNIT}`;
  document.getElementById('aba-price').textContent   = `${CUR}${(b.listPrice || 0).toLocaleString()}`;
  document.getElementById('aba-company').textContent = d.company || '—';
  document.getElementById('aba-viewers').textContent = b.viewers || 0;
  document.getElementById('aba-clicks').textContent  = b.clicks || 0;

  renderStandActions(n);
  renderBoothSponsor(n);
  renderHoldPanel(n);   // the clock on a held stand, and the way to extend it
  renderBoothTags(n);
}

/** On a broadcast: the open panel, brought in line with the stand as it now is. */
function refreshStandPanel() {
  const b = booths[selectedAdminId];
  if (!b || document.getElementById('admin-booth-action')?.classList.contains('hidden')) return;
  paintStandPanel(b);
  syncDealFields(b);
}

// ── The deal fields: what is typed is the person's, the rest is the stand's ──
//
// They were filled once, when the stand was clicked, and Save sent BOTH every
// time. So a note saved after a colleague had changed the price put the old
// price back; and with the panel left open across a release and a fresh
// booking, the new exhibitor's booking was written with the old one's price.
//
// The form now remembers what it was filled with. A field nobody has typed in
// follows every broadcast; one that has been typed in is left alone. Save
// sends only the fields that were typed in, and names the exhibitor the form
// was filled for — the server refuses it if the stand has changed hands since.
const dealForm = { booth: null, price: '', notes: '', company: null };

const dealEls = () => ({
  price: document.getElementById('aba-actual-price'),
  notes: document.getElementById('aba-notes'),
  save:  document.getElementById('aba-save-deal'),
  note:  document.getElementById('aba-deal-note'),
});
const priceText = (v) => (v == null ? '' : String(v));
const notesText = (v) => (v == null ? '' : String(v));

function fillDealFields(b) {
  const d = dealOf(b);
  const f = dealEls();
  dealForm.booth = b.boothNumber;
  dealForm.price = priceText(d.actualPrice);
  dealForm.notes = notesText(d.notes);
  dealForm.company = d.company || null;
  f.price.value = dealForm.price;
  f.notes.value = dealForm.notes;
  paintDealState(b);
}

/** Which fields now hold something other than what they were filled with. */
function dealTyped() {
  const f = dealEls();
  return { price: f.price.value !== dealForm.price, notes: f.notes.value !== dealForm.notes };
}

const changedHands = (b) => (dealOf(b).company || null) !== dealForm.company;

function syncDealFields(b) {
  if (dealForm.booth !== b.boothNumber) return fillDealFields(b);
  const typed = dealTyped();
  if (!typed.price && !typed.notes) return fillDealFields(b);
  // Something has been typed. While the stand is still the same exhibitor's,
  // the field nobody touched follows the stand; once it has changed hands,
  // what was typed was meant for someone else, so nothing moves and the form
  // says so.
  if (!changedHands(b)) {
    const d = dealOf(b), f = dealEls();
    if (!typed.price) { dealForm.price = priceText(d.actualPrice); f.price.value = dealForm.price; }
    if (!typed.notes) { dealForm.notes = notesText(d.notes); f.notes.value = dealForm.notes; }
  }
  paintDealState(b);
}

/** Usable only where the server accepts a deal, and a stale form said plainly. */
function paintDealState(b) {
  const f = dealEls();
  const editable = dealEditable(b);
  const typed = dealTyped();
  // A field already typed in stays usable even if the stand was released
  // under it, so what was typed is not locked away mid-word.
  f.price.disabled = !editable && !typed.price;
  f.notes.disabled = !editable && !typed.notes;
  const why = editable ? '' : 'Only a sold or held stand can carry a deal price or notes.';
  f.price.title = why; f.notes.title = why;
  if (f.note) {
    const moved = changedHands(b) && (typed.price || typed.notes);
    f.note.hidden = !moved;
    f.note.textContent = moved
      ? `Stand ${shownB(b)} has changed hands since this form was filled` +
        `${dealForm.company ? ` for ${dealForm.company}` : ''}. What is typed here has not been saved — ` +
        'click the stand again to start from its current booking.'
      : '';
  }
}

async function saveDealDetails() {
  const n = dealForm.booth;
  const b = booths[n];
  const f = dealEls();
  if (!b || n !== selectedAdminId) return;
  // The server checks this too. Saying it here as well costs nothing, and
  // does not depend on which side of the race the broadcast landed.
  if (changedHands(b)) return adminToast('This stand has changed hands since you opened it — reopen it before saving.', 'error');
  if (!dealEditable(b)) return adminToast('Only a sold or held stand can carry a deal price or notes.', 'error');
  const typed = dealTyped();
  if (!typed.price && !typed.notes) return adminToast('Nothing has been changed, so there is nothing to save.', 'ok');

  const payload = { boothNumber: n };
  // The price is sent as typed (blank → clear). `parseFloat(v) || null` turned
  // a legitimate zero into null, so a stand genuinely given away free could
  // not be recorded as free — and it disagreed with the inline path in the
  // bookings table, which has always preserved "0". The server parses and
  // validates. A field nobody typed in is not sent at all, so it cannot put
  // back a value somebody else has since changed.
  const sentPrice = f.price.value;
  const sentNotes = f.notes.value.trim();
  if (typed.price) payload.actualPrice = String(sentPrice).trim() === '' ? null : sentPrice;
  if (typed.notes) payload.notes = sentNotes;
  if (dealForm.company) payload.expectCompany = dealForm.company;

  f.save.disabled = true; f.save.textContent = 'Saving…';
  // Confirmed from the server rather than claimed on emit. This showed
  // "✅ Saved!" even when the write failed.
  const res = await emitAck(socket, 'booth:update-deal', payload);
  f.save.disabled = false;
  if (res && res.ok) {
    // What was sent is now what is stored, so those fields are no longer
    // "typed" — unless the person carried on typing while it saved.
    if (dealForm.booth === n) {
      if (typed.price) dealForm.price = sentPrice;
      if (typed.notes) {
        dealForm.notes = sentNotes;
        if (f.notes.value.trim() === sentNotes) f.notes.value = sentNotes;
      }
      if (booths[n]) paintDealState(booths[n]);
    }
    f.save.textContent = '✅ Saved!';
    setTimeout(() => { f.save.textContent = '💾 Save Deal Details'; }, 2000);
  } else {
    f.save.textContent = '💾 Save Deal Details';
    adminToast((res && res.error) || 'Could not save deal details.', 'error');
  }
}
document.getElementById('aba-save-deal')?.addEventListener('click', saveDealDetails);
['aba-actual-price', 'aba-notes'].forEach(id => document.getElementById(id)?.addEventListener('input', () => {
  if (booths[dealForm.booth]) paintDealState(booths[dealForm.booth]);
}));

/**
 * The stand on the open panel no longer exists: merged into a neighbour,
 * taken off the plan, or a cell whose split was undone.
 *
 * The panel stayed open and live — "Stand 116 · Available", offering Mark Sold
 * on a stand a colleague had just merged into 115, which answered "Stand 116
 * not found." It closes now, and says why, so a stand vanishing from under the
 * cursor is not a mystery.
 */
function closeVanishedStand(n, label = n, into = null) {
  closeStandPanel();
  const merged = into || (Object.values(booths).find(b => (b.mergedFrom || []).includes(n)) || {}).boothNumber;
  const why = removedBooths[n] ? 'has been taken off the plan'
            : merged ? `has been merged into stand ${shownN(merged)}`
            : 'no longer exists — the merge or split that made it was undone';
  adminToast(`Stand ${label} ${why}, so its panel has been closed.`, 'ok');
}

function cell(parent, tag = 'td') {
  const el = document.createElement(tag);
  parent.appendChild(el);
  return el;
}

function actionButton(td, label, cls, action, n) {
  const btn = document.createElement('button');
  btn.className = `admin-btn ${cls}`;
  btn.style.cssText = 'font-size:11px;padding:5px 10px';
  btn.textContent = label;
  btn.dataset.action = action;
  btn.dataset.booth  = n;
  td.appendChild(btn);
  return btn;
}

// ── Holds: the clock nobody could see ────────────────────────────────────────
//
// A hold expires after 24 hours and the stand goes quietly back on sale. The
// server has tracked the expiry and swept it all along; the console simply never
// showed it, so "on hold" looked like a state rather than a countdown and an
// operator found out it had lapsed by noticing the stand was white again.
//
// Expiry lives in the holds collection, not on the booth, so it is fetched
// separately and kept in this map. Re-read on every state broadcast (the only
// thing that can start or end a hold) and on a slow timer as a backstop.
let holdsCache = new Map();          // boothNumber -> expiry in ms

async function loadHolds() {
  try {
    const rows = await api('/api/holds') || [];
    holdsCache = new Map(rows
      .filter(h => h && h.boothNumber && h.expiresAt)
      .map(h => [String(h.boothNumber), new Date(h.expiresAt).getTime()]));
  } catch {
    // Not fatal: the stand still reads "On hold", it just has no clock on it.
    return;
  }
  // Guarded too: this runs from the state:full handler, where an uncaught
  // rejection is invisible — it would not even reach the safely() wrapper,
  // because that returns before the promise settles.
  try { paintHoldClocks(); } catch (e) { console.error('Hold clocks:', e); }
}

/** "3h 12m left" — the unit people actually think in at each scale. */
function holdLeft(boothNumber) {
  const exp = holdsCache.get(String(boothNumber));
  if (!exp) return null;
  const ms = exp - Date.now();
  if (ms <= 0) return { text: 'expired — releasing shortly', urgent: true, ms };
  const mins = Math.floor(ms / 60000);
  if (mins >= 1440) return { text: `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h left`, urgent: false, ms };
  if (mins >= 60)   return { text: `${Math.floor(mins / 60)}h ${mins % 60}m left`, urgent: mins < 120, ms };
  if (mins >= 1)    return { text: `${mins}m left`, urgent: true, ms };
  return { text: `${Math.max(0, Math.floor(ms / 1000))}s left`, urgent: true, ms };
}

/** Repaint every clock on the page in place — no rebuild, no lost focus. */
function paintHoldClocks() {
  document.querySelectorAll('[data-hold-clock]').forEach(node => {
    const left = holdLeft(node.dataset.holdClock);
    node.textContent = left ? left.text : '';
    node.classList.toggle('hidden', !left);
    node.classList.toggle('urgent', !!(left && left.urgent));
  });
  if (selectedAdminId) renderHoldPanel(selectedAdminId);
}
setInterval(paintHoldClocks, 1000);
setInterval(loadHolds, 120000);      // backstop for a hold placed by someone else

/** The hold block in the stand panel: when it runs out, and how to extend it. */
function renderHoldPanel(n) {
  const row = document.getElementById('aba-hold-row');
  if (!row) return;
  const b = booths[n];
  const left = b && b.status === 'held' ? holdLeft(n) : null;
  row.classList.toggle('hidden', !left);
  if (!left) return;
  const txt = document.getElementById('aba-hold-left');
  if (txt) {
    const exp = holdsCache.get(String(n));
    txt.textContent = `Hold ${left.text} · until ${new Date(exp).toLocaleString('en-GB')}`;
    txt.classList.toggle('urgent', left.urgent);
  }
  const btn = document.getElementById('aba-hold-extend');
  if (btn) btn.dataset.booth = n;
}

/** Give a hold another 24 hours, measured from whichever is later. */
async function extendHold(boothNumber, btn) {
  return withPending(btn, async () => {
    try {
      const r = await api(`/api/holds/${encodeURIComponent(boothNumber)}/extend`, {
        method: 'POST', body: JSON.stringify({ hours: 24 }),
      });
      holdsCache.set(String(boothNumber), new Date(r.expiresAt).getTime());
      paintHoldClocks();
      adminToast(`Stand ${shownN(boothNumber)} now held until ${new Date(r.expiresAt).toLocaleString('en-GB')}.`, 'ok');
    } catch (e) {
      adminToast(e.message || 'Could not extend that hold.', 'error');
      loadHolds();
    }
  });
}

document.getElementById('aba-hold-extend')?.addEventListener('click', (e) => {
  const n = e.currentTarget.dataset.booth;
  if (n) extendHold(n, e.currentTarget);
});

// ─── Bookings table ───────────────────────────────────────────────────────────
//
// Built with DOM nodes rather than an interpolated HTML string. Company names
// and notes originate from the public enquiry form, so treating them as markup
// made the admin dashboard executable by anyone who could submit the form.
//
// It is also PATCHED rather than rebuilt whenever it can be. This table used to
// be thrown away and re-created on every broadcast, and broadcasts used to
// include a visitor hovering a stand on the public plan — so an admin typing a
// note lost it mid-word to a stranger's mouse. The server no longer broadcasts
// on presence; this side no longer rebuilds unless the set of rows has actually
// changed, and never while the operator has focus inside the table.

/** Which stands the current search/filter selects, in display order. */
function bookingRows() {
  const search = document.getElementById('bookings-search').value.toLowerCase();
  const filter = document.getElementById('bookings-filter').value;
  return Object.values(booths).filter(b => {
    const d = dealOf(b);
    const matchFilter = filter === 'all' || b.status === filter;
    const matchSearch = !search ||
      String(b.boothNumber).toLowerCase().includes(search) ||
      String(b.displayNumber || '').toLowerCase().includes(search) ||
      (d.company || '').toLowerCase().includes(search);
    return matchFilter && matchSearch;
  });
}

/** A deal price or note only exists on a sold or held stand — the server
 *  refuses the write on any other, so offering the box was offering a failure. */
const dealEditable = (b) => b.status === 'sold' || b.status === 'held';

function dealInput({ type, cls, placeholder, width, field, booth, value, enabled, label }) {
  const inp = document.createElement('input');
  inp.type = type;
  inp.className = `admin-input ${cls}`;
  inp.placeholder = placeholder;
  inp.value = value;
  inp.style.cssText = `width:${width}px;padding:4px 8px;font-size:12px;background:var(--bg);`;
  inp.dataset.field = field;
  inp.dataset.booth = booth;
  // Remembered so a rejected save can put back exactly what was on screen.
  inp.dataset.prev = value;
  inp.disabled = !enabled;
  inp.title = enabled ? '' : 'Only a sold or held stand can carry a deal price or notes.';
  // Every one of these boxes was unlabelled — a screen reader announced eight
  // identical "edit text" fields per row with nothing to tell them apart.
  inp.setAttribute('aria-label', `${label} for stand ${booth}`);
  return inp;
}

function buildBookingRow(b) {
  const d  = dealOf(b);
  const n  = b.boothNumber;
  const tr = document.createElement('tr');
  tr.dataset.booth = n;

  const stand = cell(tr);
  stand.dataset.cell = 'stand';
  const strong = document.createElement('strong');
  // Show the override when set, with the real identity in parentheses so the
  // operator can still cross-reference bookings/history keyed by identity.
  strong.textContent = b.displayNumber ? `Stand ${b.displayNumber} (${n})` : `Stand ${n}`;
  stand.appendChild(strong);

  const sizeTd = cell(tr); sizeTd.dataset.cell = 'size';
  sizeTd.textContent = `${b.sqm} ${UNIT}`;

  const listTd = cell(tr); listTd.dataset.cell = 'list';
  listTd.textContent = money(b.listPrice || 0);

  const priceTd = cell(tr); priceTd.dataset.cell = 'price';
  priceTd.appendChild(dealInput({
    type: 'number', cls: 'deal-price', placeholder: 'Price…', width: 80,
    field: 'price', booth: n, value: d.actualPrice ?? '', enabled: dealEditable(b),
    label: 'Deal price',
  }));

  const statusTd = cell(tr); statusTd.dataset.cell = 'status';
  const pill = document.createElement('span');
  pill.className = `status-pill pill-${b.status}`;
  pill.textContent = cap(b.status);
  statusTd.appendChild(pill);
  // The countdown on a held stand, patched in place by paintHoldClocks.
  const clock = document.createElement('span');
  clock.className = 'hold-clock hidden';
  clock.dataset.holdClock = n;
  statusTd.appendChild(clock);

  const companyTd = cell(tr); companyTd.dataset.cell = 'company';
  paintCompanyCell(companyTd, d.company);

  const notesTd = cell(tr); notesTd.dataset.cell = 'notes';
  notesTd.appendChild(dealInput({
    type: 'text', cls: 'deal-notes', placeholder: 'Notes…', width: 140,
    field: 'notes', booth: n, value: d.notes ?? '', enabled: dealEditable(b),
    label: 'Notes',
  }));

  const actions = cell(tr); actions.dataset.cell = 'actions';
  actions.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
  paintActionCell(actions, b);

  return tr;
}

function paintCompanyCell(td, company) {
  td.replaceChildren();
  if (company) { td.textContent = company; return; }
  const dash = document.createElement('span');
  dash.style.color = 'var(--muted)';
  dash.textContent = '—';
  td.appendChild(dash);
}

function paintActionCell(td, b) {
  const n = b.boothNumber;
  td.replaceChildren();
  td.dataset.forStatus = b.status;
  if (b.status !== 'sold')      actionButton(td, 'Book',    'success', 'book',    n);
  if (b.status === 'available') actionButton(td, 'Hold',    'warning', 'hold',    n);
  if (b.status === 'held')      actionButton(td, '+24h',    '',        'extend',  n);
  if (b.status !== 'available') actionButton(td, 'Release', '',        'release', n);
  const csv = actionButton(td, '⬇️ CSV', '', 'csv', n);
  csv.style.cssText += ';background:var(--glass-bg);border:1px solid var(--border);';
}

/** Update one existing row's cells without replacing the row. */
function patchBookingRow(tr, b) {
  const d = dealOf(b);
  const q = (name) => tr.querySelector(`[data-cell="${name}"]`);

  const stand = q('stand')?.querySelector('strong');
  const standText = b.displayNumber ? `Stand ${b.displayNumber} (${b.boothNumber})` : `Stand ${b.boothNumber}`;
  if (stand && stand.textContent !== standText) stand.textContent = standText;

  const size = q('size'); const sizeText = `${b.sqm} ${UNIT}`;
  if (size && size.textContent !== sizeText) size.textContent = sizeText;

  const list = q('list'); const listText = money(b.listPrice || 0);
  if (list && list.textContent !== listText) list.textContent = listText;

  const pill = q('status')?.querySelector('.status-pill');
  if (pill && pill.textContent !== cap(b.status)) {
    pill.textContent = cap(b.status);
    pill.className = `status-pill pill-${b.status}`;
  }

  const company = q('company');
  if (company && company.textContent.trim() !== (d.company || '—')) paintCompanyCell(company, d.company);

  const actions = q('actions');
  if (actions && actions.dataset.forStatus !== b.status) paintActionCell(actions, b);

  // The two editable fields: never overwritten while they are being typed into.
  [['price', d.actualPrice ?? ''], ['notes', d.notes ?? '']].forEach(([field, value]) => {
    const inp = tr.querySelector(`input[data-field="${field}"]`);
    if (!inp) return;
    inp.disabled = !dealEditable(b);
    inp.title = dealEditable(b) ? '' : 'Only a sold or held stand can carry a deal price or notes.';
    if (document.activeElement === inp) return;
    if (String(inp.value) !== String(value)) inp.value = value;
    inp.dataset.prev = value;
  });
}

let lastRowSig = '';
let bookingsDeferred = false;

/**
 * Bring the table in line with the current state, doing the least work that
 * will do it.
 *
 * Three levels, deliberately: leave it entirely alone while the operator is
 * typing in it; patch the cells when the same stands are showing; rebuild only
 * when the set of rows has genuinely changed.
 */
function refreshBookingsTable() {
  const tbody = document.getElementById('bookings-tbody');
  if (!tbody) return;

  // Never rebuild under someone's hands. A rebuild moves focus, drops a
  // half-typed note and closes an open select — which is exactly the bug.
  if (tbody.contains(document.activeElement)) {
    bookingsDeferred = true;
    const rows = bookingRows();
    // The focused row's own cells are still safe to patch: patchBookingRow
    // skips whatever is focused.
    rows.forEach(b => {
      const tr = tbody.querySelector(`tr[data-booth="${CSS.escape(b.boothNumber)}"]`);
      if (tr) patchBookingRow(tr, b);
    });
    paintHoldClocks();
    return;
  }

  const rows = bookingRows();
  const sig = rows.map(b => b.boothNumber).join('|');
  if (sig !== lastRowSig) {
    lastRowSig = sig;
    tbody.replaceChildren(...rows.map(buildBookingRow));
  } else {
    rows.forEach(b => {
      const tr = tbody.querySelector(`tr[data-booth="${CSS.escape(b.boothNumber)}"]`);
      if (tr) patchBookingRow(tr, b);
    });
  }
  bookingsDeferred = false;
  paintHoldClocks();
}

/** A full rebuild, for when the operator themselves changed what should show. */
function renderBookingsTable() {
  lastRowSig = '';
  refreshBookingsTable();
}

// Anything deferred while the operator was typing is applied the moment they
// step out of the table, rather than waiting for the next broadcast.
document.getElementById('bookings-tbody')?.addEventListener('focusout', () => {
  setTimeout(() => {
    const tbody = document.getElementById('bookings-tbody');
    if (bookingsDeferred && tbody && !tbody.contains(document.activeElement)) refreshBookingsTable();
  }, 0);
});

// Delegation, so no handler names are exposed on `window` and no user data is
// ever interpolated into an attribute.
document.getElementById('bookings-tbody').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const n = btn.dataset.booth;
  if (btn.dataset.action === 'csv') exportSingleCSV(n);
  else if (btn.dataset.action === 'extend') extendHold(n, btn);
  else adminAction(btn.dataset.action, n);
});

document.getElementById('bookings-tbody').addEventListener('change', (e) => {
  const input = e.target.closest('input[data-field]');
  if (!input || input.disabled) return;
  // Nothing to save if it did not actually change — a blur after a broadcast
  // patched the value would otherwise fire a pointless write.
  if (String(input.value) === String(input.dataset.prev ?? '')) return;
  inlineUpdateDeal(input.dataset.booth, input.dataset.field, input.value, input);
});

// Pressing Enter should save. A standalone input frequently fires 'change' only
// on blur, not on Enter — so blur it, which commits the value and triggers the
// 'change' handler above. (preventDefault stops any implicit form behaviour.)
document.getElementById('bookings-tbody').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const input = e.target.closest('input[data-field]');
  if (!input) return;
  e.preventDefault();
  input.blur();
});

/**
 * The actions this stand can actually take, given where it is.
 *
 * A stand moves available → on hold → sold, and only some steps exist at each
 * stage. All three buttons used to show on every stand, which offered "Release"
 * on an available stand (nothing to release) and "Put on Hold" on one already
 * held (the server rejects it — a hold needs an available stand). Worse, a held
 * stand's "Mark Sold" read like a fresh booking and re-asked for a company it
 * was already holding for.
 *
 *   available → Mark Sold · Put on Hold
 *   on hold   → Move to Sold · Release
 *   sold      → Release
 */
function renderStandActions(n) {
  const b = booths[n];
  if (!b) return;

  const book    = document.getElementById('aba-book');
  const hold    = document.getElementById('aba-hold');
  const release = document.getElementById('aba-release');
  if (!book || !hold || !release) return;

  const held = b.status === 'held';
  const sold = b.status === 'sold';

  // "Move to Sold" names the step it is: converting a hold that already has an
  // exhibitor, not booking an empty stand.
  book.textContent = held ? '✅ Move to Sold' : '✅ Mark Sold';
  book.title = held
    ? `Convert the hold on stand ${n} into a confirmed sale`
    : `Book stand ${n}`;

  book.hidden    = sold;                 // already there
  hold.hidden    = held || sold;         // a hold needs an available stand
  release.hidden = !held && !sold;       // nothing to release

  book.onclick    = () => adminAction('book', n);
  hold.onclick    = () => adminAction('hold', n);
  release.onclick = () => adminAction('release', n);

  // Drag-to-split, offered only where the server would accept the split.
  const split = document.getElementById('aba-split');
  if (split) {
    split.hidden = !canSplitOnMap(b);
    split.onclick = () => enterSplitMode(n);
  }

  // Reset, for any stand that is (or is part of) a split or a merge. The label
  // says which it is, and for a split cell names the parent it will restore.
  const reset = document.getElementById('aba-reset');
  if (reset) {
    const r = resetTargetOf(b);
    reset.hidden = !r;
    if (r) {
      reset.textContent = r.kind === 'unmerge' ? '↩️ Un-merge' : r.kind === 'unsplit' ? '↩️ Undo split' : '↩️ Remove cell';
      reset.title = `Reset: ${resetDescription(r)}`;
      reset.onclick = () => resetFromPanel(n);
    }
  }

  // Take the stand off the plan. Offered on the same terms the server accepts
  // it on, so the button is never there to be refused: a plain available stand,
  // nobody's booking on it, not half of a merge or a split.
  const remove = document.getElementById('aba-remove');
  if (remove) {
    remove.hidden = !canRemoveStand(b);
    remove.onclick = () => removeStandFromPlan(n);
  }
}

/** Mirrors the server's rules for booth:remove (see booths.remove). */
function canRemoveStand(b) {
  if (!b || b.removed === true) return false;
  if (b.status !== 'available' || dealOf(b).company) return false;
  return !(b.mergeSnapshot || b.splitSnapshot || b.splitFrom);
}

/**
 * Take a stand off the plan from the stand panel.
 *
 * Spelled out in the dialog because it is the one action here that changes the
 * DRAWING rather than a booking, and because what happens to the neighbours is
 * the first thing anyone asks.
 */
async function removeStandFromPlan(boothNumber) {
  const b = booths[boothNumber];
  if (!canRemoveStand(b)) return adminToast('That stand cannot be removed — it is booked, merged or split.', 'error');
  if (!await confirmDialog(
    `Take stand ${shownN(boothNumber)} off the plan?\n\n` +
    `The rectangle becomes hall floor. Any wall it shares with the stands around it stays drawn, so its neighbours are unchanged — only its own outline, number and size go.\n\n` +
    `It leaves the totals, the bookings table and every dropdown, and its number stays reserved. Tools → Removed Stands puts it back exactly as it was.`,
    { title: `Remove stand ${shownN(boothNumber)}`, confirmLabel: 'Remove it', danger: true })) return;
  const res = await emitAck(socket, 'booth:remove', { boothNumber });
  if (!res || !res.ok) return adminToast((res && res.error) || 'Could not remove that stand.', 'error');
  // The stand is off the plan, so its panel goes with it — here, where the
  // toast below already says what happened.
  if (selectedAdminId === boothNumber) closeStandPanel();
  // Undo where the change was made, the way releasing a booking offers it (see
  // offerUndoRelease). Tools → Removed Stands is the permanent way back, but it
  // is one of eleven cards on a long page, and nothing about a stand quietly
  // vanishing says to go looking there — so the first person to remove one had
  // no way to put it back that they could find.
  // No countdown: this one does not expire. Tools -> Plan History holds the
  // hall as it stood before every change, so the button here is a convenience
  // for the next few seconds, not the only chance — and it says so, because a
  // ticking number that means nothing is worse than no number at all.
  window.UI.toastAction(
    `Stand ${shownN(boothNumber)} taken off the plan. Tools \u2192 Plan History goes back to it at any time.`,
    { ...TOAST, kind: 'ok', ms: 9000, countdown: false, label: 'Undo',
      onAction: async () => {
        const back = await emitAck(socket, 'booth:restore-stand', { boothNumber });
        adminToast(back && back.ok
          ? `Stand ${shownN(boothNumber)} is back on the plan.`
          : ((back && back.error) || 'Could not put that stand back.'),
          back && back.ok ? 'ok' : 'error');
      } });
}

/** What the release/un-book gate is asking for, in the operator's words. */
const secretNoun = () => (recoveryRequired ? 'recovery key' : 'admin password');

// What a hold taken without a name is stored as. It must never become the
// exhibitor on a confirmed sale, so it is neither offered nor accepted as one.
const HOLD_PLACEHOLDER = 'Pending';
const isPlaceholder = (name) => String(name || '').trim().toLowerCase() === HOLD_PLACEHOLDER.toLowerCase();

// A hold is measured in hours, within the bounds the server keeps a hold to
// (the extend route's): at least one hour, at most thirty days.
const HOLD_HOURS_MAX = 24 * 30;
function holdHoursProblem(text) {
  // Number(), not parseFloat(): parseFloat reads "24 hours" as 24 and lets
  // "Infinity" and "1e10" through as numbers, and a hold of ten billion hours
  // is a sale nobody agreed to.
  const h = Number(text);
  if (text === '' || !Number.isFinite(h) || h < 1 || h > HOLD_HOURS_MAX) {
    return `A hold lasts between 1 and ${HOLD_HOURS_MAX} hours (30 days) — enter the number of hours.`;
  }
  return null;
}

async function adminAction(action, boothNumber) {
  const done = (verb) => (res) => {
    if (res && res.ok) adminToast(`Stand ${boothNumber} ${verb}.`, 'ok');
    else adminToast((res && res.error) || `Could not ${action} stand ${boothNumber}.`, 'error');
  };
  // Both of these were window.prompt(). OK on an empty "Company name:" booked
  // the stand as "Admin"; a nameless hold's "Move to Sold" was pre-filled with
  // "Pending", so Enter sold the stand to the placeholder; and Cancel on "Hold
  // for how many hours?" still held it, because `parseFloat(null) || 24` is 24.
  // They ask in the console's own dialog now, which can refuse an answer and
  // say why without losing what was typed.
  if (action === 'book') {
    const b = booths[boothNumber];
    const held = !!b && b.status === 'held';
    // A held stand is already holding for someone, so the name is offered
    // rather than asked for — Enter confirms it. Still editable, and never the
    // placeholder a nameless hold is stored as.
    const existing = isPlaceholder(dealOf(b).company) ? '' : (dealOf(b).company || '');
    const company = await askText(
      held ? `Stand ${shownN(boothNumber)} is on hold${existing ? ` for ${existing}` : ' without a name'}. Who is it sold to?`
           : `Book stand ${shownN(boothNumber)} as sold.`,
      { title: held ? `Move stand ${shownN(boothNumber)} to sold` : `Mark stand ${shownN(boothNumber)} sold`,
        name: 'company', label: 'Exhibitor (company name)', value: existing,
        confirmLabel: held ? 'Move to sold' : 'Mark sold',
        required: true, requiredMessage: 'A sale needs the exhibitor\'s name.',
        validate: (v) => (isPlaceholder(v)
          ? `"${HOLD_PLACEHOLDER}" is what a hold without a name is called — enter the exhibitor's real name.` : null) });
    if (company === null) return;
    done(held ? 'moved to sold' : 'booked')(await emitAck(socket, 'booth:book', { boothNumber, company }));
  }
  if (action === 'hold') {
    const v = await askFields(
      `Hold stand ${shownN(boothNumber)}. Nobody else can book it until the hold runs out or is released.`,
      { title: `Put stand ${shownN(boothNumber)} on hold`, confirmLabel: 'Hold it',
        fields: [
          // A hold may be nameless; it is stored under the placeholder.
          { name: 'company', label: 'For (company name — optional)', placeholder: 'Leave blank if not known yet' },
          { name: 'hours', label: 'For how many hours', value: '24', inputMode: 'decimal', validate: holdHoursProblem },
        ] });
    if (!v) return;                                    // cancelled: nothing is held
    done('held')(await emitAck(socket, 'booth:hold',
      { boothNumber, company: v.company || HOLD_PLACEHOLDER, hours: Number(v.hours) }));
  }
  if (action === 'release') {
    // Releasing frees a stand and clears its booking, so it's gated: the recovery
    // key when the failsafe is on, otherwise the admin's own password. Asked for
    // in a masked field — prompt() showed it in clear text and left it in the
    // browser's dialog history.
    const b = booths[boothNumber];
    const co = dealOf(b).company;
    const price = dealOf(b).actualPrice;
    // Snapshot BEFORE the release, because the release is what destroys it —
    // this is what Undo puts back.
    const snapshot = {
      status: b?.status,
      assignment: {
        company: co || '',
        actualPrice: dealOf(b).actualPrice ?? null,
        notes: dealOf(b).notes || '',
        tags: (dealOf(b).tags || []).slice(),
        country: dealOf(b).country || null,
      },
    };
    const secret = await askSecret(
      `Releasing stand ${shownN(boothNumber)}${co ? ` from ${co}` : ''}` +
      `${price != null ? ` (${money(price)})` : ''}.\n\n` +
      'The stand goes back on sale and its company, price and notes are cleared.',
      { title: `Release stand ${shownN(boothNumber)}`,
        label: recoveryRequired ? 'Recovery key' : 'Your admin password',
        confirmLabel: 'Release it' });
    if (secret === null) return;                       // cancelled
    if (!secret) return adminToast(`A ${secretNoun()} is required to release a stand.`, 'error');
    socket.emit('booth:release', { boothNumber, password: secret }, (res) => {
      if (res && res.ok) offerUndoRelease(boothNumber, snapshot, secret);
      else adminToast((res && res.error) || `Could not release stand ${boothNumber}.`, 'error');
    });
  }
}

/**
 * A short window in which a release can be taken back.
 *
 * Release destroys a booking outright — the company, the negotiated price, the
 * notes, the tags — and the only recovery was to retype all of it from memory,
 * assuming anyone remembered it. The snapshot is the console's own copy of the
 * stand as it was a moment ago, and the secret has just been verified, so
 * undoing costs one click rather than a second interrogation.
 *
 * The secret is held in a closure for the length of the window and nowhere
 * else — not in storage, not on an element — and the server refuses the restore
 * outright if anyone else has taken the stand in the meantime.
 */
function offerUndoRelease(boothNumber, snapshot, secret) {
  if (!snapshot?.assignment?.company) {
    return adminToast(`Stand ${shownN(boothNumber)} released.`, 'ok');
  }
  window.UI.toastAction(
    `Stand ${shownN(boothNumber)} released from ${snapshot.assignment.company}.`,
    { ...TOAST, kind: 'ok', ms: 10000, label: 'Undo',
      onAction: async () => {
        try {
          await api(`/api/booths/${encodeURIComponent(boothNumber)}/restore`, {
            method: 'POST',
            headers: { 'X-Confirm-Password': secret },
            body: JSON.stringify(snapshot),
          });
          adminToast(`Stand ${shownN(boothNumber)} restored to ${snapshot.assignment.company}.`, 'ok');
        } catch (e) {
          adminToast(e.message || 'Could not restore that booking.', 'error');
        }
      } });
}

// ─── Toast ──────────────────────────────────────────────────────────────────
// Transient confirmation or error. Server actions used to fail silently, so an
// admin had no way to tell a rejected hold from a successful one.
const TOAST = { id: 'admin-toast', cls: 'admin-toast', show: 'show', ms: 4000 };
function adminToast(message, kind = 'ok') {
  return window.UI.toast(message, kind, TOAST);
}

function inlineUpdateDeal(boothNumber, field, value, input) {
  const b = booths[boothNumber];
  if (!b) return;
  const d = dealOf(b);
  // Send the price as typed (empty → clear); the server parses + validates, so a
  // literal "0" is kept rather than turned into null by a falsy check.
  const actualPrice = field === 'price'
    ? (String(value).trim() === '' ? null : value)
    : d.actualPrice;
  const notes = field === 'notes' ? value : d.notes;
  // Ack so a save actually confirms (or surfaces why it didn't) instead of
  // failing silently and reverting on the next broadcast.
  socket.emit('booth:update-deal', { boothNumber, actualPrice, notes }, (res) => {
    if (res && res.ok) {
      if (input) input.dataset.prev = input.value;
      adminToast(`Stand ${boothNumber} ${field} saved.`, 'ok');
      return;
    }
    // The typed value used to stay on screen after a refusal, until some later
    // broadcast happened to overwrite it — so the table showed a price that was
    // never stored, looking for all the world like it had been.
    if (input) {
      input.value = input.dataset.prev ?? '';
      input.classList.add('save-failed');
      setTimeout(() => input.classList.remove('save-failed'), 1200);
    }
    adminToast((res && res.error) || `Could not save ${field} for stand ${boothNumber}.`, 'error');
  });
}

// Search/filter live update
document.getElementById('bookings-search').addEventListener('input', renderBookingsTable);
document.getElementById('bookings-filter').addEventListener('change', renderBookingsTable);

// ─── CSV Export ───────────────────────────────────────────────────────────────
function downloadCSV(dataArray, filename) {
  if (!dataArray || dataArray.length === 0) return adminToast('Nothing to export with those filters.', 'error');
  // The price columns were headed "(EUR)" on every show, including the ones
  // priced in dollars — a spreadsheet that states the wrong currency is worse
  // than one that states none.
  const headers = ['Stand', `Size (${UNIT})`, `Listed Price (${CURRENCY})`, `Deal Price (${CURRENCY})`,
                   'Status', 'Company', 'Notes', 'Hold expires', 'Live Viewers', 'Total Clicks'];
  // Neutralise spreadsheet formula injection: company/notes are free text (often
  // pasted from a customer enquiry). A value like =HYPERLINK(...) or =cmd|... is
  // evaluated when the CSV is opened in Excel/Sheets, so prefix any cell starting
  // with a formula trigger with a single quote, then quote + escape as normal.
  const cell = (v) => {
    let s = String(v ?? '').replace(/\n/g, ' ');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const rows = dataArray.map(b => [
    cell(shownB(b)),
    cell(b.sqm),
    cell(b.listPrice || 0),
    cell(dealOf(b).actualPrice ?? ''),
    cell(b.status),
    cell(dealOf(b).company || ''),
    cell(dealOf(b).notes || ''),
    cell(b.status === 'held' && holdsCache.get(String(b.boothNumber))
      ? new Date(holdsCache.get(String(b.boothNumber))).toISOString() : ''),
    cell(b.viewers || 0),
    cell(b.clicks || 0)
  ]);

  const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

document.getElementById('export-all-csv').onclick = () => {
  const search = document.getElementById('bookings-search').value.toLowerCase();
  const filter = document.getElementById('bookings-filter').value;

  let rows = Object.values(booths).filter(b => {
    const matchFilter = filter === 'all' || b.status === filter;
    const matchSearch = !search || String(b.boothNumber).toLowerCase().includes(search) || String(b.displayNumber || '').toLowerCase().includes(search) || (dealOf(b).company || '').toLowerCase().includes(search);
    return matchFilter && matchSearch;
  });

  // The filename named neither the event nor the day. Three exports taken from
  // three events over a week were four identical "blueprint_stands_export.csv"
  // files in one Downloads folder, distinguishable only by opening them.
  downloadCSV(rows, `${csvPrefix()}-stands-${csvDate()}.csv`);
};

/** The event this export came from, as a filename-safe word. */
function csvPrefix() {
  const slug = (window.__SHOW && (window.__SHOW.slug || window.__SHOW.id)) || 'blueprint';
  return String(slug).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
}
const csvDate = () => new Date().toISOString().slice(0, 10);

function exportSingleCSV(boothNumber) {
  if (booths[boothNumber]) {
    downloadCSV([booths[boothNumber]], `${csvPrefix()}-stand-${boothNumber}-${csvDate()}.csv`);
  }
}
window.exportSingleCSV = exportSingleCSV;

// ─── Populate Tool Dropdowns ──────────────────────────────────────────────────
function populateToolDropdowns() {
  const all = Object.values(booths);

  // Split and merge only apply to AVAILABLE stands — a purchased stand is locked
  // so its paid area can't be divided or absorbed (the server enforces this too).
  // Reset lists every stand: it undoes a merge/split or clears a stray cell.
  const openStands = all.filter(b => b.status === 'available' && !(dealOf(b).company));
  const dropdownSets = { 'merge-1': openStands, 'merge-2': openStands, 'split-stand': openStands, 'csplit-stand': openStands, 'reset-stand': all };
  Object.entries(dropdownSets).forEach(([id, list]) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">Select…</option>' +
      list.map(b => `<option value="${esc(b.boothNumber)}">Stand ${esc(shownB(b))}</option>`).join('');
    sel.value = cur;
  });

  // How many stands are off the plan, on the Tools tab that puts them back.
  // Without it the only trace of a removal is the stand no longer being there,
  // and nothing tells you it can be undone at all.
  const removedBadge = document.getElementById('removed-badge');
  if (removedBadge) {
    const n = Object.keys(removedBooths).length;
    removedBadge.textContent = String(n);
    removedBadge.classList.toggle('hidden', n === 0);
  }

  // Removed stands — the only list on this page built from the other map.
  const restoreSel = document.getElementById('restore-stand');
  if (restoreSel) {
    const cur = restoreSel.value;
    const gone = Object.values(removedBooths)
      .sort((a, b) => String(a.boothNumber).localeCompare(String(b.boothNumber), undefined, { numeric: true }));
    restoreSel.innerHTML = gone.length
      ? '<option value="">Select…</option>' + gone.map(b =>
          `<option value="${esc(b.boothNumber)}">Stand ${esc(shownB(b))}${b.sqm ? ` — ${esc(b.sqm)} ${esc(UNIT)}` : ''}</option>`).join('')
      : '<option value="">No stands have been removed</option>';
    restoreSel.value = cur;
  }

  const statusStand = document.getElementById('status-stand');
  const cur2 = statusStand.value;
  statusStand.innerHTML = '<option value="">Select…</option>' +
    all.map(b => `<option value="${esc(b.boothNumber)}">Stand ${esc(shownB(b))}</option>`).join('');
  statusStand.value = cur2;

  // Move: "from" is a stand that has a booking (sold/held) — labelled with the
  // company so the operator can find the right one; "to" is an available stand.
  const moveFrom = document.getElementById('move-from');
  if (moveFrom) {
    const cur = moveFrom.value;
    const booked = all.filter(b => b.status === 'sold' || b.status === 'held');
    moveFrom.innerHTML = '<option value="">Select…</option>' + booked.map(b => {
      const co = esc(dealOf(b).company || '(no company)');
      return `<option value="${esc(b.boothNumber)}">Stand ${esc(shownB(b))} — ${co}</option>`;
    }).join('');
    moveFrom.value = cur;
  }
  const moveTo = document.getElementById('move-to');
  if (moveTo) {
    const cur = moveTo.value;
    const avail = all.filter(b => b.status === 'available');
    moveTo.innerHTML = '<option value="">Select…</option>' +
      avail.map(b => `<option value="${esc(b.boothNumber)}">Stand ${esc(shownB(b))} — ${b.sqm} ${UNIT}</option>`).join('');
    moveTo.value = cur;
  }
  // Shown Number: every stand, labelled with its current shown number and, when
  // overridden, its real identity so the operator knows which stand it is.
  const numberStand = document.getElementById('number-stand');
  if (numberStand) {
    const cur = numberStand.value;
    numberStand.innerHTML = '<option value="">Select…</option>' + all.map(b => {
      const idn = esc(b.boothNumber);
      const label = b.displayNumber ? `${esc(b.displayNumber)} (id ${idn})` : idn;
      return `<option value="${idn}">Stand ${label}</option>`;
    }).join('');
    numberStand.value = cur;
    syncNumberField();
  }

  updateMovePreview();
  renderSponsorBooths();
}

// Prefill the text box with the selected stand's current shown number — when
// the choice of STAND changes, and only then. This used to run on every
// keystroke in the box (it was the box's own `input` listener) and on every
// broadcast and settings push (through populateToolDropdowns), and each time
// it put the stored number back: the box could not be typed into at all.
let numberFieldFor = null;
function syncNumberField() {
  const sel = document.getElementById('number-stand');
  const inp = document.getElementById('number-value');
  if (!sel || !inp) return;
  if (sel.value !== numberFieldFor) {
    numberFieldFor = sel.value;
    const b = booths[sel.value];
    inp.value = (b && b.displayNumber) || '';
  }
  paintNumberPreview();
}

/** "Stand 112 → shown as 1037", from whatever is in the box right now. */
function paintNumberPreview() {
  const sel = document.getElementById('number-stand');
  const inp = document.getElementById('number-value');
  const prev = document.getElementById('number-preview');
  if (!sel || !inp || !prev) return;
  const b = booths[sel.value];
  if (b) {
    const to = inp.value.trim() || b.boothNumber;
    prev.innerHTML = `Stand <b>${esc(b.boothNumber)}</b> → shown as <b>${esc(to)}</b>` +
      (to === b.boothNumber ? ' <span class="mv-rate">(own number)</span>' : '');
    prev.classList.remove('hidden');
  } else prev.classList.add('hidden');
}
document.getElementById('number-stand')?.addEventListener('change', syncNumberField);
document.getElementById('number-value')?.addEventListener('input', paintNumberPreview);
document.getElementById('number-form')?.addEventListener('submit', e => {
  e.preventDefault();
  const boothNumber = document.getElementById('number-stand').value;
  const displayNumber = document.getElementById('number-value').value.trim();
  if (!boothNumber) return adminToast('Pick a stand.', 'error');
  socket.emit('booth:set-number', { boothNumber, displayNumber }, (res) => {
    if (res && res.ok) {
      adminToast(res.cleared ? `Stand ${boothNumber} reverted to its own number.`
                             : `Stand ${boothNumber} now shown as ${res.value}.`, 'ok');
    } else adminToast((res && res.error) || 'Could not update.', 'error');
  });
});

// ─── Floorplan sponsor ────────────────────────────────────────────────────────
document.getElementById('fp-sponsor-form')?.addEventListener('submit', e => {
  e.preventDefault();
  const name  = document.getElementById('fp-sponsor-name').value.trim();
  const color = document.getElementById('fp-sponsor-color').value;
  socket.emit('sponsor:set-floorplan', { name, color }, (res) => {
    adminToast(res && res.ok ? 'Floorplan sponsor saved.' : (res && res.error) || 'Could not save.', res && res.ok ? 'ok' : 'error');
  });
});
document.getElementById('fp-sponsor-clear')?.addEventListener('click', (e) => withPending(e.currentTarget, async () => {
  if (!await confirmDialog(
    `Clear the floorplan sponsor${sponsorName ? ` (${sponsorName})` : ''}?\n\nEvery sponsored stand goes back to its status colour on both the admin and the public plan.`,
    { title: 'Clear the floorplan sponsor', confirmLabel: 'Clear it', danger: true })) return;
  // The acknowledgement was thrown away and success announced unconditionally —
  // a refused clear (no admin rights, a dropped socket) still said "cleared",
  // and the colour was still there.
  const res = await emitAck(socket, 'sponsor:set-floorplan', { name: '', color: '' });
  if (res && res.ok) adminToast('Floorplan sponsor cleared.', 'ok');
  else adminToast((res && res.error) || 'Could not clear the floorplan sponsor.', 'error');
}));
document.getElementById('fp-sponsor-add')?.addEventListener('click', () => {
  const boothNumber = document.getElementById('fp-sponsor-stand').value;
  if (!boothNumber) return adminToast('Pick a stand to mark.', 'error');
  socket.emit('booth:set-sponsored', { boothNumber, sponsored: true }, (res) => {
    adminToast(res && res.ok ? `Stand ${boothNumber} marked as sponsored.` : (res && res.error) || 'Could not update.', res && res.ok ? 'ok' : 'error');
  });
});

// Populate the stand picker and render a chip per sponsored stand (with remove).
function renderSponsorBooths() {
  const sel = document.getElementById('fp-sponsor-stand');
  if (sel) {
    const cur = sel.value;
    const opts = Object.values(booths).filter(b => !b.sponsored);
    sel.innerHTML = '<option value="">Select…</option>' +
      opts.map(b => `<option value="${esc(b.boothNumber)}">Stand ${esc(shownB(b))}</option>`).join('');
    sel.value = cur;
  }
  const chips = document.getElementById('fp-sponsor-chips');
  if (chips) {
    const marked = Object.values(booths).filter(b => b.sponsored);
    chips.innerHTML = marked.length
      ? marked.map(b => `<button type="button" class="fp-chip" data-unsponsor="${esc(b.boothNumber)}">Stand ${esc(shownB(b))} <span aria-hidden="true">×</span></button>`).join('')
      : '<span class="fp-chips-empty">No sponsored stands yet.</span>';
  }
}
document.getElementById('fp-sponsor-chips')?.addEventListener('click', e => {
  const btn = e.target.closest('[data-unsponsor]');
  if (!btn) return;
  socket.emit('booth:set-sponsored', { boothNumber: btn.getAttribute('data-unsponsor'), sponsored: false }, (res) => {
    if (!(res && res.ok)) adminToast((res && res.error) || 'Could not update.', 'error');
  });
});

// Live preview of the size/cost change so the move is never a surprise.
function updateMovePreview() {
  const el = document.getElementById('move-preview');
  if (!el) return;
  const from = booths[document.getElementById('move-from')?.value];
  const to   = booths[document.getElementById('move-to')?.value];
  if (!from || !to) { el.classList.add('hidden'); return; }
  // money() is the shared helper now. This function called one that was never
  // defined anywhere, while this unused local `eur` sat right beside it — so
  // picking both Move dropdowns threw a ReferenceError, and because
  // populateToolDropdowns calls this and the state:full handler calls THAT,
  // every later broadcast died at the same line: the search list, the tag
  // counts and the plan repaint all stopped until someone reloaded.
  const dealFrom = dealOf(from);
  const rate = (dealFrom.actualPrice != null && from.sqm > 0) ? dealFrom.actualPrice / from.sqm : null;
  const newCost = rate != null ? Math.round(rate * to.sqm) : to.listPrice;
  const dir = to.sqm > from.sqm ? 'Upgrade ↑' : to.sqm < from.sqm ? 'Downgrade ↓' : 'Move';
  el.innerHTML =
    `<span class="mv-dir">${dir}</span> ` +
    `<b>${esc(dealFrom.company || 'Booking')}</b>: ` +
    `${from.sqm} ${UNIT} → <b>${to.sqm} ${UNIT}</b> · ` +
    `${money(dealFrom.actualPrice ?? from.listPrice)} → <b>${money(newCost)}</b>` +
    (rate != null ? ` <span class="mv-rate">(rate kept)</span>` : ``);
  el.classList.remove('hidden');
}
document.getElementById('move-from')?.addEventListener('change', updateMovePreview);
document.getElementById('move-to')?.addEventListener('change', updateMovePreview);

// ─── Move Form ────────────────────────────────────────────────────────────────
// Every form below is wrapped in withPending. None of them had any guard, and
// the second half of a double-click was genuinely sent: Split answered "done"
// and then "already split — reset it first", which reads as the first one
// having failed.
document.getElementById('move-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  return withPending(e.target.querySelector('button[type=submit]'), async () => {
    const from = document.getElementById('move-from').value;
    const to   = document.getElementById('move-to').value;
    if (!from || !to) return adminToast('Pick the booked stand and the destination.', 'error');
    if (from === to) return adminToast('Pick two different stands.', 'error');
    const co = dealOf(booths[from]).company || 'this booking';
    const price = dealOf(booths[from]).actualPrice;
    const fSqm = booths[from]?.sqm, tSqm = booths[to]?.sqm;
    if (!await confirmDialog(
      `Move ${co}${price != null ? ` (${money(price)})` : ''} from stand ${shownN(from)} (${fSqm} ${UNIT}) ` +
      `to stand ${shownN(to)} (${tSqm} ${UNIT})?\n\nStand ${shownN(from)} is freed and goes back on sale.`,
      { title: `Move ${co}`, confirmLabel: 'Move it' })) return;
    const res = await emitAck(socket, 'booth:move', { from, to });
    if (res && res.ok) {
      adminToast(`${res.company || 'Booking'} moved to Stand ${to} — now ${res.toSqm} ${UNIT}.`, 'ok');
      document.getElementById('move-from').value = '';
      document.getElementById('move-to').value = '';
      updateMovePreview();
    } else adminToast((res && res.error) || 'Move failed.', 'error');
  });
});

// ─── Consolidation Form ───────────────────────────────────────────────────────
document.getElementById('consolidation-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  return withPending(e.target.querySelector('button[type=submit]'), async () => {
    const p = document.getElementById('merge-1').value;
    const sec = document.getElementById('merge-2').value;
    if (!p || !sec || p === sec) return adminToast('Select two different stands to merge.', 'error');
    // Reshaping the plan happened with no confirmation at all.
    const area = (booths[p]?.sqm || 0) + (booths[sec]?.sqm || 0);
    if (!await confirmDialog(
      `Merge stand ${shownN(sec)} into stand ${shownN(p)}, making one stand of about ${area} ${UNIT}?\n\n` +
      `Stand ${shownN(sec)} disappears from the plan, the bookings table and every dropdown. Tools → Reset undoes it.`,
      { title: `Merge ${shownN(sec)} into ${shownN(p)}`, confirmLabel: 'Merge them' })) return;
    const res = await emitAck(socket, 'booth:consolidate', { primary: p, secondary: sec });
    adminToast(res && res.ok ? `Stand ${sec} merged into ${p}.` : (res && res.error) || 'Merge failed.',
               res && res.ok ? 'ok' : 'error');
  });
});

// ─── Split Form ───────────────────────────────────────────────────────────────
document.getElementById('split-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  return withPending(e.target.querySelector('button[type=submit]'), async () => {
    const boothNumber = document.getElementById('split-stand').value;
    const parts = parseInt(document.getElementById('split-parts').value, 10);
    const axis = document.getElementById('split-axis').value;
    if (!boothNumber) return adminToast('Select a stand to split.', 'error');
    const b = booths[boothNumber];
    const each = b && parts > 0 ? Math.round(b.sqm / parts) : null;
    if (!await confirmDialog(
      `Split stand ${shownN(boothNumber)} (${b?.sqm} ${UNIT}) into ${parts} parts` +
      `${each ? ` of about ${each} ${UNIT} each` : ''}?\n\n` +
      'New stand numbers are created on the plan and each part is priced from its own size. Tools → Reset undoes it.',
      { title: `Split stand ${shownN(boothNumber)}`, confirmLabel: 'Split it' })) return;
    const res = await emitAck(socket, 'booth:split', { boothNumber, parts, axis });
    adminToast(res && res.ok ? `Stand ${boothNumber} split into ${(res.created || []).length + 1} — added ${(res.created || []).join(', ')}.`
                             : (res && res.error) || 'Split failed.',
               res && res.ok ? 'ok' : 'error');
  });
});

// ─── Custom Split (your own numbers + sizes) ──────────────────────────────────
// A size is kept to the hundredth, and the parts must add up to the stand
// exactly — to the hundredth, as the server now requires. The box stepped in
// whole units and a total out by as much as a whole unit was let through, only
// for the server to refuse it.
const round2 = (n) => Math.round(n * 100) / 100;
const sizesMatch = (sum, total) => Math.abs(sum - total) < 0.005;

const csplitRows = document.getElementById('csplit-rows');
function csplitAddRow() {
  if (!csplitRows || csplitRows.children.length >= 8) return;
  const row = document.createElement('div');
  row.className = 'csplit-row';
  const num = document.createElement('input');  num.className = 'csplit-num';  num.type = 'text';   num.placeholder = 'Number';
  const size = document.createElement('input'); size.className = 'csplit-size'; size.type = 'number'; size.min = '0.01'; size.step = '0.01'; size.placeholder = 'Size';
  const del = document.createElement('button');  del.type = 'button'; del.className = 'csplit-del'; del.title = 'Remove'; del.textContent = '×';
  row.append(num, size, del);
  csplitRows.appendChild(row);
}
function csplitTotal() { const b = booths[document.getElementById('csplit-stand')?.value]; return b ? (b.sqm || 0) : 0; }
function csplitUpdateTally() {
  const tally = document.getElementById('csplit-tally'); if (!tally) return;
  const total = csplitTotal();
  let sum = 0; csplitRows.querySelectorAll('.csplit-size').forEach(i => { sum += Number(i.value) || 0; });
  if (!total) { tally.textContent = 'Select a stand to see its total size.'; tally.className = 'csplit-tally'; return; }
  const left = total - sum;
  tally.textContent = `Total ${total} ${UNIT} · placed ${round2(sum)} · left ${round2(left)}`;
  tally.className = 'csplit-tally' + (sizesMatch(sum, total) ? ' ok' : (left < 0 ? ' over' : ''));
}
if (csplitRows) {
  document.getElementById('csplit-add').addEventListener('click', () => { csplitAddRow(); csplitUpdateTally(); });
  csplitRows.addEventListener('click', (e) => { const d = e.target.closest('.csplit-del'); if (d) { d.closest('.csplit-row').remove(); csplitUpdateTally(); } });
  csplitRows.addEventListener('input', (e) => { if (e.target.classList.contains('csplit-size')) csplitUpdateTally(); });
  document.getElementById('csplit-stand').addEventListener('change', csplitUpdateTally);
  csplitAddRow(); csplitAddRow(); csplitUpdateTally();   // start with two parts

  document.getElementById('csplit-form').addEventListener('submit', (e) => {
    e.preventDefault();
    return withPending(e.target.querySelector('button[type=submit]'), async () => {
      const boothNumber = document.getElementById('csplit-stand').value;
      const axis = document.getElementById('csplit-axis').value;
      if (!boothNumber) return adminToast('Select a stand to split.', 'error');
      const parts = [];
      csplitRows.querySelectorAll('.csplit-row').forEach(r => {
        const number = r.querySelector('.csplit-num').value.trim();
        const sqm = Number(r.querySelector('.csplit-size').value);
        if (number && sqm > 0) parts.push({ number, sqm });
      });
      if (parts.length < 2) return adminToast('Enter at least two parts, each with a number and a size.', 'error');
      const total = csplitTotal(), sum = parts.reduce((acc, p) => acc + p.sqm, 0);
      if (!sizesMatch(sum, total)) {
        return adminToast(`The parts must add up to exactly ${total} ${UNIT}, the size of the stand — they come to ` +
          `${round2(sum)} ${UNIT}, ${round2(Math.abs(total - sum))} ${UNIT} ${sum > total ? 'too much' : 'short'}.`, 'error');
      }
      if (!await confirmDialog(
        `Split stand ${shownN(boothNumber)} (${total} ${UNIT}) into:\n\n` +
        parts.map(p => `    ${p.number} — ${p.sqm} ${UNIT}`).join('\n') +
        '\n\nTools → Reset undoes it.',
        { title: `Split stand ${shownN(boothNumber)} into ${parts.length}`, confirmLabel: 'Split it' })) return;
      const res = await emitAck(socket, 'booth:split-custom', { boothNumber, axis, parts });
      if (res && res.ok) {
        adminToast(`Stand ${boothNumber} split into ${(res.created || []).length + 1}.`, 'ok');
        csplitRows.replaceChildren(); csplitAddRow(); csplitAddRow(); csplitUpdateTally();
      } else adminToast((res && res.error) || 'Custom split failed.', 'error');
    });
  });
}

// ─── Reset Form (undo a merge or split) ───────────────────────────────────────
document.getElementById('reset-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  return withPending(e.target.querySelector('button[type=submit]'), async () => {
    const boothNumber = document.getElementById('reset-stand').value;
    if (!boothNumber) return adminToast('Select a stand to reset.', 'error');
    // Resolved exactly as the stand panel resolves it (resetTargetOf). This sent
    // the chosen number as it was, so a split CELL picked here reached the
    // server as a stray cell and was deleted on its own — its floor space gone
    // from the hall, the split still in place — instead of the split being
    // undone. And the dialog could not say which of the two was about to happen.
    const r = resetTargetOf(booths[boothNumber]);
    if (!r) return adminToast(`Stand ${shownN(boothNumber)} was not merged or split, so there is nothing to reset.`, 'error');
    if (!await confirmDialog(`This will ${resetDescription(r)}.`,
        { title: `Reset stand ${shownN(r.target)}`, confirmLabel: 'Reset it' })) return;
    const res = await emitAck(socket, 'booth:reset', { boothNumber: r.target });
    if (res && res.ok) adminToast(resetToastFor(r.target, res), 'ok');
    else adminToast((res && res.error) || 'Reset failed.', 'error');
  });
});

// ─── Plan history ─────────────────────────────────────────────────────────────
/**
 * Every change to the shape of the plan, as a point to go back to.
 *
 * The console had no way back from a change beyond the one offered in the
 * moment: ten seconds of Undo on a toast, and Reset for the stand in front of
 * you. Anything older than that was recoverable only by someone who knew the
 * snapshots existed and could reach a terminal, which is not a way back.
 *
 * Rendered newest first, because the thing being looked for is almost always
 * "what did I just do".
 */
async function loadHistory() {
  const box = document.getElementById('history-list');
  if (!box) return;
  let rows;
  try { rows = await api('/api/history?limit=50'); }
  catch (e) { box.innerHTML = `<div class="history-empty">Could not load the history — ${esc(e.message || 'try again')}.</div>`; return; }

  if (!rows.length) {
    box.innerHTML = '<div class="history-empty">Nothing has been changed yet. Merge, split or remove a stand and the step back appears here.</div>';
    return;
  }
  box.innerHTML = '';
  rows.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'history-row';
    const when = new Date(p.at);
    const stands = (p.boothNumbers || []).map(shownN).join(', ');
    row.innerHTML =
      `<span class="hr-when">${esc(when.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</span>` +
      `<span class="hr-what"><b>${esc(p.label)}</b>` +
      (stands ? ` — ${esc(stands)}` : '') +
      `<div class="hr-detail">${esc(p.actor || 'unknown')} · ${p.stands} stands stored` +
      (p.revisionLabel ? ` · on plan ${esc(p.revisionLabel)}` : '') + `</div></span>`;
    const btn = document.createElement('button');
    btn.className = 'admin-btn';
    // Named for what it does to the hall, not for the row it sits on: this puts
    // the plan back to how it was BEFORE that change, which is not the same
    // sentence as "undo this row" once several changes sit on top of it.
    btn.textContent = '↩ Go back to here';
    btn.onclick = () => restoreHistoryPoint(p, btn);
    row.appendChild(btn);
    box.appendChild(row);
  });
}

async function restoreHistoryPoint(point, btn) {
  return withPending(btn, async () => {
    // What it WOULD do, read from the server rather than guessed at, because
    // which stands change — and which bookings are in the way — is the thing
    // worth seeing before agreeing.
    let plan;
    try { plan = await api(`/api/history/${encodeURIComponent(point.id)}/restore`, { method: 'POST', body: JSON.stringify({}) }); }
    catch (e) { return adminToast(e.message || 'Could not read that point.', 'error'); }

    const when = new Date(point.at).toLocaleString();
    // Going back puts back the SHAPE of the hall and never a booking: every
    // sale and hold stays as it is now. A point that would take a booked stand
    // away, or change its size or place, cannot be applied until that booking
    // is moved or released — so name them and stop, rather than ask for a
    // password to do something the server will refuse.
    const conflicts = plan.conflicts || [];
    if (conflicts.length) {
      const what = { gone: 'would disappear', removed: 'would be taken off the plan', resized: 'would change size or place' };
      await confirmDialog(
        `Going back to just before "${point.label}" (${when}) keeps every booking as it is now, ` +
        `and these booked stands would not fit the plan as it was then:

` +
        conflicts.slice(0, 12).map(c => `    ${shownN(c.boothNumber)} — ${c.status}${c.company ? `, ${c.company}` : ''} — ${what[c.why] || 'would change'}`).join('\n') +
        (conflicts.length > 12 ? `\n    …and ${conflicts.length - 12} more` : '') +
        `

Move or release them first, then go back to this point.`,
        { title: 'Bookings are in the way', confirmLabel: 'OK' });
      return;
    }

    const lost = plan.logosNotRestored || [];
    const ch = plan.changes || {};
    const n = (list) => (list || []).length;
    const pw = await askSecret(
      `The plan goes back to how it stood just before "${point.label}" on ${when}.

` +
      `Only its shape goes back — merges, splits, removed stands and shown numbers: ` +
      `${n(ch.reshaped)} stand(s) change shape, ${n(ch.added)} come back and ${n(ch.dropped)} go.

` +
      `Every booking stays exactly as it is now. ${plan.bookingsKept || 0} sold or held stand(s) keep ` +
      `their exhibitor, price, notes and hold.

` +
      (plan.artwork ? `The floorplan goes back to ${plan.artwork.label} as well — visitors see it at the same link.

` : '') +
      (lost.length ? `Sponsor logos are not stored in a point; ${lost.length} will need re-uploading (${lost.slice(0, 6).map(shownN).join(', ')}${lost.length > 6 ? '…' : ''}).

` : '') +
      'The hall as it stands right now is stored first, so this is itself undoable.',
      { title: 'Put the plan back', confirmLabel: 'Put it back' });
    if (pw === null) return;

    try {
      const r = await api(`/api/history/${encodeURIComponent(point.id)}/restore`, {
        method: 'POST',
        headers: { 'X-Confirm-Password': pw },
        body: JSON.stringify({ apply: true }),
      });
      adminToast(`The plan is back to ${new Date(point.at).toLocaleString()} — ${r.stands} stands, every booking kept` +
        (r.artwork ? `, on ${r.artwork.label}.` : '.'), 'ok');
      loadHistory();
    } catch (e) {
      adminToast(e.message || 'Could not put the plan back.', 'error');
    }
  });
}

// ─── Removed Stands (put one back) ────────────────────────────────────────────
document.getElementById('restore-stand-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  return withPending(e.target.querySelector('button[type=submit]'), async () => {
    const boothNumber = document.getElementById('restore-stand').value;
    if (!boothNumber) return adminToast('Select a stand to put back.', 'error');
    const res = await emitAck(socket, 'booth:restore-stand', { boothNumber });
    if (res && res.ok) adminToast(`Stand ${boothNumber} is back on the plan.`, 'ok');
    else adminToast((res && res.error) || 'Could not put that stand back.', 'error');
  });
});

// ─── Status Form ──────────────────────────────────────────────────────────────
document.getElementById('status-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  return withPending(e.target.querySelector('button[type=submit]'), async () => {
    const boothNumber = document.getElementById('status-stand').value;
    const status = document.getElementById('status-new').value;
    const company = document.getElementById('status-company').value.trim();
    if (!boothNumber) return;
    const cur = booths[boothNumber];

    // A sale needs a real exhibitor here as much as on the stand panel. A blank
    // box keeps the name a held stand already has; on a stand with none, it
    // sold the stand to nobody — and "Pending" is what a nameless hold is
    // called, not a name.
    if (status === 'sold') {
      const kept = cur && !isPlaceholder(dealOf(cur).company) ? dealOf(cur).company : '';
      if (isPlaceholder(company) || (!company && !kept)) {
        return adminToast('A sale needs the exhibitor\'s name — enter it under Company.', 'error');
      }
    }

    // Forcing a booked/held stand back to Available un-books it, and the server
    // now gates that exactly as Release is gated: the recovery key when the
    // failsafe is on, the admin's own password when it is NOT. This only ever
    // asked in the recovery case, so with the failsafe off (the default) it sent
    // an empty secret and every un-booking from here was simply refused.
    const unbooking = status === 'available' && cur && cur.status !== 'available';
    let key;
    if (unbooking) {
      const co = dealOf(cur).company;
      const price = dealOf(cur).actualPrice;
      key = await askSecret(
        `Setting stand ${shownN(boothNumber)} back to Available${co ? `, clearing ${co}` : ''}` +
        `${price != null ? ` (${money(price)})` : ''}.\n\nIts company, price and notes are cleared.`,
        { title: `Un-book stand ${shownN(boothNumber)}`,
          label: recoveryRequired ? 'Recovery key' : 'Your admin password',
          confirmLabel: 'Set it available' });
      if (key === null) return;
      if (!key) return adminToast(`A ${secretNoun()} is required to un-book a stand.`, 'error');
    }
    // Sent under both names: the handler accepts either, and the recovery path
    // has always read `key`.
    const res = await emitAck(socket, 'admin:setStatus', { boothNumber, status, company, key, password: key });
    if (res && res.ok) adminToast(`Stand ${boothNumber} set to ${status}.`, 'ok');
    else adminToast((res && res.error) || 'Status update failed.', 'error');
  });
});

// ─── Reset ────────────────────────────────────────────────────────────────────
// The bulk reset has been removed. It wiped all 272 booths in one call and was
// reachable from any anonymous browser console. Bookings now live in MongoDB;
// to reseed geometry run `node scripts/migrate.js`, which preserves commercial
// state. Individual stands are released from the Bookings table.
document.getElementById('reset-btn')?.remove();

// ─── Clear Log ────────────────────────────────────────────────────────────────
// Clears only what has arrived live since the page loaded. The stored history
// is not the console's to delete, and "Clear" wiping an audit trail from the
// screen is exactly the sort of thing that makes people distrust one.
document.getElementById('clear-log')?.addEventListener('click', () => {
  document.querySelectorAll('#admin-log .log-entry.is-live').forEach(n => n.remove());
  adminToast('Live lines cleared — the stored history is still below.', 'ok');
});

// ─── Socket Events ────────────────────────────────────────────────────────────
let lastAdminSig = '';

/**
 * Run one section's render without letting it take the others down with it.
 *
 * The handler below was a straight run of eight calls. A throw anywhere in it —
 * and there WAS one, see updateMovePreview — abandoned everything after that
 * line for the rest of the session, so the page kept receiving broadcasts and
 * silently ignored them. The failure is reported once per section rather than
 * on every broadcast, because a broken render fires as often as the plan moves.
 */
const renderFailures = new Set();
function safely(what, fn) {
  try { fn(); }
  catch (e) {
    console.error(`Admin render failed (${what}):`, e);
    if (!renderFailures.has(what)) {
      renderFailures.add(what);
      adminToast(`The ${what} could not be redrawn — reload if it looks out of date.`, 'error');
    }
  }
}

socket.on('state:full', (allBooths) => {
  // Removed stands ride in the same broadcast and are split out here, once, so
  // nothing below this line has to remember they exist.
  const serverBooths = [];
  const stillGone = new Set();
  allBooths.forEach(b => {
    if (b && b.removed === true) { removedBooths[b.boothNumber] = b; stillGone.add(b.boothNumber); }
    else serverBooths.push(b);
  });
  Object.keys(removedBooths).forEach(n => { if (!stillGone.has(n)) delete removedBooths[n]; });

  const incoming = new Set(serverBooths.map(b => b.boothNumber));
  // Named before the reconcile below can take the stand away with its name.
  const openLabel = selectedAdminId ? shownN(selectedAdminId) : null;
  serverBooths.forEach(b => { booths[b.boothNumber] = b; });
  // Reconcile: drop booths the server no longer has (merged secondary, reset
  // cell) so the tools, tables and overview counts don't show ghosts.
  Object.keys(booths).forEach(n => { if (!incoming.has(n)) delete booths[n]; });
  if (selectedAdminId && !booths[selectedAdminId]) safely('stand panel', () => closeVanishedStand(selectedAdminId, openLabel));
  // Likewise a shift-selection: a stand that has gone cannot be merged.
  if ([...multiSel].some(n => !booths[n])) {
    [...multiSel].forEach(n => { if (!booths[n]) multiSel.delete(n); });
    if (svgDoc) safely('multi-select', renderMultiSelect);
  }
  // Someone else booked or reshaped the stand under the divider: the split the
  // admin is lining up can no longer happen, so take the divider away rather
  // than let it be submitted and refused.
  if (splitUI.id && !canSplitOnMap(booths[splitUI.id])) exitSplitMode();

  safely('overview', updateOverview);
  safely('bookings table', refreshBookingsTable);
  safely('tool dropdowns', populateToolDropdowns);
  // A change made on the plan — or by a colleague — is a new point, and the
  // list is useless if it only shows what was there when the tab was opened.
  if (document.getElementById('section-tools')?.classList.contains('active')) safely('plan history', loadHistory);
  safely('stand search list', populateAdminSearchList);
  safely('activity tags', renderTagCatalogue);   // "used on N stands" moves with the booths
  // A broadcast is a state CHANGE, which is the only thing that can start or
  // end a hold — so it is exactly when the countdowns need re-reading.
  safely('hold clocks', loadHolds);
  // The whole panel, not just its tags and buttons — status, company, size and
  // the deal fields too. See renderAdminBoothAction.
  if (selectedAdminId) safely('stand panel', refreshStandPanel);

  safely('floorplan', () => {
    // Tag on the first state if the floorplan tab is already open; otherwise
    // loadAdminSVG() tags when the tab is first shown.
    if (adminSvgReady && !adminTagged) { tagAdminBooths(); lastAdminSig = BoothMap.signature(allBooths); return; }
    if (svgDoc && adminTagged) {
      // A split/merge/reset changes the plan's STRUCTURE; re-tag the whole map so
      // new cells appear and removed ones disappear without a page reload.
      // allBooths, not serverBooths: a stand coming off the plan (or going back
      // on) is precisely the structural change this fingerprint is here to catch.
      const sig = BoothMap.signature(allBooths);
      if (sig !== lastAdminSig) { lastAdminSig = sig; retagAdminMap(); }
      else Object.values(booths).forEach(b => {
        const el = svgDoc.querySelector(`[data-booth="${CSS.escape(b.boothNumber)}"]`);
        if (el) applyAdminVisual(el, b.status);
      });
    }
  });
});

/**
 * Live viewer counts, on their own channel.
 *
 * Presence used to ride on state:full, so a visitor moving their mouse over a
 * stand on the public plan rebuilt this entire console: the bookings table, all
 * eight tool dropdowns and the tag catalogue. An admin halfway through typing a
 * note watched it vanish, and an open <select> snapped shut. The server now
 * sends presence separately — and this handler touches NOTHING but the numbers.
 *
 * The payload only carries stands that have at least one viewer; anything
 * absent from it is at zero.
 */
socket.on('viewers:map', (map) => {
  const counts = map && typeof map === 'object' ? map : {};
  Object.values(booths).forEach(b => { b.viewers = Number(counts[b.boothNumber]) || 0; });

  // The one place a count is on screen, patched in place.
  if (selectedAdminId) {
    const cell = document.getElementById('aba-viewers');
    if (cell) cell.textContent = booths[selectedAdminId]?.viewers || 0;
  }
});

// The server's "your first state has landed". Used rather than ignored: it is
// the moment the console genuinely has the event in front of it.
socket.on('ready', () => {
  document.getElementById('conn-badge')?.classList.add('is-live');
  loadHolds();
});

// The analytics session this socket belongs to. Kept rather than dropped, so a
// line in the activity log can be matched to this browser.
let adminSessionId = null;
socket.on('session:id', (id) => { adminSessionId = id || null; });

// Re-run the SVG↔booth mapping from a clean slate after a structural change.
function retagAdminMap() {
  if (!svgDoc) return;
  if (splitUI.id) exitSplitMode();   // the stand under the divider may be gone or reshaped
  BoothMap.clear(svgDoc);
  adminTagged = false;
  tagAdminBooths();
}

// The artwork was replaced, re-read or removed. Fetch it again and re-bind the
// stands in place — the pan/zoom is on the frame around the plan, not the plan
// itself, so it survives the swap. The Settings cards refresh too, so the
// previews and the artwork check show the plan that is now in use.
socket.on('floorplan:changed', async () => {
  if (svgDoc) {
    const mount = document.getElementById('admin-svg-mount');
    try {
      const svgRes = await fetch(`/floorplan.svg?show=${encodeURIComponent(SHOW)}`);
      if (svgRes.ok) {
        if (splitUI.id) exitSplitMode();
        mount.innerHTML = await svgRes.text();
        svgDoc = mount.querySelector('svg');
        if (svgDoc) {
          svgDoc.setAttribute('width', '100%');
          svgDoc.setAttribute('height', '100%');
          adminTagged = false;
          tagAdminBooths();
          lucide.createIcons();
        }
      }
    } catch (e) { console.warn('Could not re-fetch the plan —', e.message); }
  }
  if (document.getElementById('section-settings')?.classList.contains('active')) loadPlans();
});

socket.on('floorplan-sponsor', (s) => {
  sponsorColor = (s && s.color) || '';
  sponsorName  = (s && s.name)  || '';
  // Reflect into the Sponsors-section controls if they're present.
  const nameEl = document.getElementById('fp-sponsor-name');
  const colEl  = document.getElementById('fp-sponsor-color');
  const swEl   = document.getElementById('fp-sponsor-swatch');
  if (nameEl && document.activeElement !== nameEl) nameEl.value = sponsorName;
  if (colEl && sponsorColor) colEl.value = sponsorColor;
  if (swEl) swEl.style.background = sponsorColor || 'transparent';
  // Repaint every stand so sponsored fills appear/clear.
  if (svgDoc && adminTagged) Object.values(booths).forEach(b => {
    const el = svgDoc.querySelector(`[data-booth="${CSS.escape(b.boothNumber)}"]`);
    if (el) applyAdminVisual(el, b.status);
  });
});

// Show settings (area unit, currency, rate). Re-render everything that prints a
// size or a rate so the label/price updates live.
socket.on('settings', (s) => {
  // The colours this event's spaces are painted in — only when the event
  // carries the field. The rate and unit handlers send partial settings, and
  // applying an absent palette wiped the event's colours on every one.
  if (window.BoothPalette && s && ('palette' in s)) BoothPalette.apply(s.palette);
  if (s && s.unit) UNIT = s.unit === 'ft' ? 'ft²' : 'm²';
  if (s && s.unit) relabelSplitSizes();
  if (s && s.currencySymbol) { CUR = s.currencySymbol; window.UI.setCurrency(CUR); }
  if (s && s.currency) CURRENCY = s.currency;
  if (s && s.ratePerSqm != null) RATE = s.ratePerSqm;
  if (s && s.recoveryRequired !== undefined) recoveryRequired = !!s.recoveryRequired;
  document.querySelectorAll('.unit-label').forEach(el => { el.textContent = UNIT; });
  document.querySelectorAll('.currency-label').forEach(el => { el.textContent = CUR.trim(); });
  const rf = document.getElementById('rate-current'); if (rf && RATE != null) rf.textContent = `${CUR}${RATE}/${UNIT}`;
  const uBtnM = document.getElementById('unit-m'), uBtnF = document.getElementById('unit-ft');
  if (uBtnM && uBtnF) { uBtnM.classList.toggle('active', UNIT === 'm²'); uBtnF.classList.toggle('active', UNIT === 'ft²'); }
  document.querySelectorAll('[data-currency]').forEach(b =>
    b.classList.toggle('active', b.getAttribute('data-currency') === CURRENCY));
  updateOverview(); renderBookingsTable(); populateToolDropdowns();
});

// ─── Rate + unit settings ─────────────────────────────────────────────────────
document.getElementById('rate-save')?.addEventListener('click', () => {
  const rate = Number(document.getElementById('rate-input').value);
  const password = document.getElementById('rate-password').value;
  if (!Number.isFinite(rate) || rate <= 0) return adminToast('Enter a valid rate (a positive number).', 'error');
  if (!password) return adminToast('Enter your password to change the rate.', 'error');
  if (!confirm(`Set the rate to ${CUR}${rate}/${UNIT} and reprice every stand's list price? Negotiated deals are kept.`)) return;
  socket.emit('settings:set-rate', { rate, password }, (res) => {
    if (res && res.ok) {
      adminToast(`Rate set to ${CUR}${res.ratePerSqm}/${UNIT} — ${res.repriced} stands repriced.`, 'ok');
      document.getElementById('rate-input').value = '';
      document.getElementById('rate-password').value = '';
    } else adminToast((res && res.error) || 'Could not update the rate.', 'error');
  });
});
['m', 'ft'].forEach(u => document.getElementById(`unit-${u}`)?.addEventListener('click', () => {
  socket.emit('settings:set-unit', { unit: u }, (res) => {
    if (!(res && res.ok)) adminToast((res && res.error) || 'Could not change the unit.', 'error');
  });
}));

// Currency. Like the unit, this is a label — it changes no stored number, which
// the confirm makes explicit so nobody expects €600 to become its dollar value.
document.querySelectorAll('[data-currency]').forEach(btn => btn.addEventListener('click', () => {
  const code = btn.getAttribute('data-currency');
  if (code === CURRENCY) return;
  if (!confirm(`Show this event's prices in ${code}?\n\nThis changes the symbol only — a rate of ${RATE ?? '600'} stays ${RATE ?? '600'}, it is not converted.`)) return;
  socket.emit('settings:set-currency', { currency: code }, (res) => {
    if (res && res.ok) adminToast(`Prices now shown in ${res.currency}.`, 'ok');
    else adminToast((res && res.error) || 'Could not change the currency.', 'error');
  });
}));

// Rejected holds, failed merges and denied actions used to disappear silently.
socket.on('error:action', ({ message }) => adminToast(message || 'That action could not be completed.', 'error'));

// "Administrator access required" on a page you are LOOKING at means the socket
// is no longer authenticated — almost always an expired session after a
// reconnect. Toasting it on every action and leaving the admin there was a dead
// end; re-check and send them to sign in.
socket.on('error:auth', ({ message }) => {
  adminToast(message || 'Administrator access required.', 'error');
  checkSession();
});

/**
 * The event this console was opened for is no longer at this address —
 * renamed, or gone, while the page was open. The server says so (show:gone)
 * and closes the connection, and everything this page sends from then on
 * names an event that is not there. So the page stops, with one message in
 * front of everything that cannot be dismissed and says what to do, rather
 * than every button failing in turn with a refusal of its own.
 */
let showGone = false;
socket.on('show:gone', (info) => {
  if (showGone) return;
  showGone = true;
  const name = (window.__SHOW && window.__SHOW.name) || 'The event this page was opened for';
  window.UI.stopDialog(
    (info && typeof info.message === 'string' && info.message) ||
    `${name} is no longer at this address — it may have been moved to a new one, or taken off the air, while ` +
    'this page was open. Nothing more can be saved from here.\n\nReload the page to carry on. If the event has ' +
    'moved, open the console and choose it from the list of events.',
    { title: 'This event is no longer here',
      actions: [
        { label: 'Open the console', onClick: () => { location.href = '/admin'; } },
        { label: 'Reload the page', primary: true, onClick: () => location.reload() },
      ] });
});

// 'booth:updated' used to be handled here. The server has never emitted it, so
// the handler was fifteen lines that could not run — and its existence implied a
// per-stand update channel that does not exist. Stand changes arrive as
// state:full, which is why that handler has to stay cheap.

socket.on('stats:updated', (stats) => {
  updateOverviewFromStats(stats);
});

socket.on('booth:consolidated', ({ primary, secondary, absorbed }) => {
  // Two shapes: a single merge sends one `secondary`, an N-way merge sends
  // `absorbed` as an ARRAY. This did `delete booths[secondary]` in both cases,
  // so after a multi-stand merge `secondary` was undefined, nothing was
  // removed, and every absorbed stand stayed in the table and the dropdowns as
  // a ghost until the next reload.
  const gone = Array.isArray(absorbed) ? absorbed : (secondary ? [secondary] : []);
  const open = selectedAdminId && gone.includes(selectedAdminId)
    ? { n: selectedAdminId, label: shownN(selectedAdminId) } : null;
  gone.forEach(n => { delete booths[n]; });
  // The open panel was on a stand that has just been merged away. This only
  // cleared the selection, and left the panel up and live over a stand that
  // no longer existed.
  if (open) safely('stand panel', () => closeVanishedStand(open.n, open.label, primary || null));
  // The state:full that follows re-tags the map cleanly (removing each overlay,
  // split box, number and size node together), so no ghost outline is left
  // behind on the plan either.
  safely('bookings table', refreshBookingsTable);
  safely('tool dropdowns', populateToolDropdowns);
});

socket.on('viewers:count', (n) => {
  document.getElementById('conn-count').textContent = n;
});

socket.on('log:entry', ({ msg, type, time, boothNumber }) => {
  addLog(msg, type, time, boothNumber || null);
});

// ─── Update Overview KPIs ─────────────────────────────────────────────────────
function updateOverview() {
  const all = Object.values(booths);
  const avail = all.filter(b => b.status === 'available');
  const sold = all.filter(b => b.status === 'sold');
  const held = all.filter(b => b.status === 'held');

  const totalSqm = all.reduce((s, b) => s + (b.sqm || 0), 0);
  const availSqm = avail.reduce((s, b) => s + (b.sqm || 0), 0);
  const soldSqm = sold.reduce((s, b) => s + (b.sqm || 0), 0);
  const heldSqm = held.reduce((s, b) => s + (b.sqm || 0), 0);
  // A booked stand is worth the price agreed for it, where one was agreed, and
  // its list price only where none was — the way the server's stats() counts
  // it. Revenue Earned summed list prices whatever the deal said, so a stand
  // sold at a discount was counted at a price nobody is paying, and this
  // panel disagreed with the one drawn from the server's figures.
  const agreed = (b) => (dealOf(b).actualPrice != null ? Number(dealOf(b).actualPrice) || 0 : (b.listPrice || 0));
  const earnedRev = sold.reduce((s, b) => s + agreed(b), 0);
  const availRev = avail.reduce((s, b) => s + (b.listPrice || 0), 0);
  const heldRev = held.reduce((s, b) => s + agreed(b), 0);
  // The floor's value is what its three rows add up to, so the total row and
  // the rows above it agree.
  const totalRev = earnedRev + heldRev + availRev;
  const fillPct = totalSqm > 0 ? Math.round(((soldSqm + heldSqm) / totalSqm) * 100) : 0;
  const soldPct = totalSqm > 0 ? Math.round((soldSqm / totalSqm) * 100) : 0;
  const heldPct = totalSqm > 0 ? Math.round((heldSqm / totalSqm) * 100) : 0;

  el('kpi-earned').textContent = `${CUR}${earnedRev.toLocaleString()}`;
  el('kpi-earned-sqm').textContent = `${soldSqm.toLocaleString()} ${UNIT} sold`;
  el('kpi-avail-sqm').textContent = `${availSqm.toLocaleString()} ${UNIT}`;
  el('kpi-avail-rev').textContent = `${CUR}${availRev.toLocaleString()} potential`;
  el('kpi-held-sqm').textContent = `${heldSqm.toLocaleString()} ${UNIT}`;
  el('kpi-held-count').textContent = `${held.length} stands`;
  el('kpi-total-sqm').textContent = `${totalSqm.toLocaleString()} ${UNIT}`;
  el('kpi-total-booths').textContent = `${all.length} stands`;
  el('fill-pct').textContent = `${fillPct}%`;
  el('fill-bar-sold').style.width = `${soldPct}%`;
  el('fill-bar-held').style.width = `${heldPct}%`;
  el('rev-booked').textContent = `${CUR}${earnedRev.toLocaleString()}`;
  el('rev-held').textContent = `${CUR}${heldRev.toLocaleString()}`;
  el('rev-avail').textContent = `${CUR}${availRev.toLocaleString()}`;
  el('rev-total').textContent = `${CUR}${totalRev.toLocaleString()}`;
}

function updateOverviewFromStats(s) {
  el('kpi-earned').textContent = `${CUR}${s.earnedRev.toLocaleString()}`;
  el('kpi-earned-sqm').textContent = `${s.soldSqm.toLocaleString()} ${UNIT} sold`;
  el('kpi-avail-sqm').textContent = `${s.availSqm.toLocaleString()} ${UNIT}`;
  el('kpi-avail-rev').textContent = `${CUR}${s.availRev.toLocaleString()} potential`;
  el('kpi-held-sqm').textContent = `${s.heldSqm.toLocaleString()} ${UNIT}`;
  el('kpi-held-count').textContent = `${s.heldBooths} stands`;
  el('kpi-total-sqm').textContent = `${s.totalSqm.toLocaleString()} ${UNIT}`;
  el('kpi-total-booths').textContent = `${s.totalBooths} stands`;
  const pct = s.totalSqm > 0 ? Math.round(((s.soldSqm + s.heldSqm) / s.totalSqm) * 100) : 0;
  const sold = s.totalSqm > 0 ? Math.round((s.soldSqm / s.totalSqm) * 100) : 0;
  const held = s.totalSqm > 0 ? Math.round((s.heldSqm / s.totalSqm) * 100) : 0;
  el('fill-pct').textContent = `${pct}%`;
  el('fill-bar-sold').style.width = `${sold}%`;
  el('fill-bar-held').style.width = `${held}%`;
  el('rev-booked').textContent = `${CUR}${s.earnedRev.toLocaleString()}`;
  el('rev-held').textContent = `${CUR}${s.heldRev.toLocaleString()}`;
  el('rev-avail').textContent = `${CUR}${s.availRev.toLocaleString()}`;
  el('rev-total').textContent = `${CUR}${s.totalRevenue.toLocaleString()}`;
}

// ─── Activity Log ─────────────────────────────────────────────────────────────
//
// Two halves: the stored history (GET /api/audit), loaded when the tab opens,
// and the live socket lines that append on top of it. It used to be the live
// half ALONE, held in the DOM and nowhere else, so refreshing the page — the
// exact moment an operator wants to check what just happened — emptied it.

// Only these tags survive from a server-composed line. The messages arrive with
// <strong> in them for emphasis and every interpolation escaped, and this used
// to be written straight to innerHTML — which made the whole log safe only for
// as long as every one of those interpolations stayed escaped, forever, in a
// file nobody reads while writing a log line. Parsing and rebuilding from an
// allow-list moves that from a promise to a property.
const LOG_TAGS = { strong: 'strong', b: 'strong', em: 'em', i: 'em' };

function logMessageNodes(msg) {
  const frag = document.createDocumentFragment();
  // DOMParser neither runs scripts nor fetches anything, and nothing is copied
  // across except text and the four tags above — no attributes at all, so an
  // onerror= or an href= cannot survive the trip.
  const doc = new DOMParser().parseFromString(String(msg ?? ''), 'text/html');
  const copy = (src, dest) => {
    src.childNodes.forEach(node => {
      if (node.nodeType === Node.TEXT_NODE) { dest.appendChild(document.createTextNode(node.nodeValue)); return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = LOG_TAGS[node.tagName.toLowerCase()];
      if (!tag) { copy(node, dest); return; }      // unknown element: keep its words, drop it
      const el = document.createElement(tag);
      copy(node, el);
      dest.appendChild(el);
    });
  };
  copy(doc.body, frag);
  return frag;
}

function logEntry({ msg, type = 'info', time, boothNumber = null, live = false }) {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}` + (live ? ' is-live' : '');
  const t = document.createElement('span');
  t.className = 'log-time';
  t.textContent = time;
  entry.append(t, document.createTextNode(' '), logMessageNodes(msg));
  if (boothNumber && booths[boothNumber]) {
    // A log line names a stand; clicking it should take you to that stand.
    entry.classList.add('log-linked');
    entry.tabIndex = 0;
    entry.setAttribute('role', 'button');
    entry.title = `Open stand ${shownN(boothNumber)} on the plan`;
    // The plan may still be on its way — this is often the first thing to open
    // the Floorplan tab — so wait for it, and for the tab to be laid out,
    // rather than guessing at 60 ms and selecting on a plan that is not there.
    const go = async () => {
      showAdminSection('floorplan');
      await adminPlanReady();
      await new Promise(r => requestAnimationFrame(() => r()));
      if (!svgDoc) return;
      if (!booths[boothNumber]) return adminToast(`Stand ${boothNumber} is no longer on the plan.`, 'error');
      selectAdminBooth(boothNumber);
      focusAdminBooth(boothNumber);
    };
    entry.addEventListener('click', go);
    entry.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
  }
  return entry;
}

function addLog(msg, type = 'info', time = new Date().toLocaleTimeString('en-GB'), boothNumber = null) {
  const log = document.getElementById('admin-log');
  if (!log) return;
  log.prepend(logEntry({ msg, type, time, boothNumber, live: true }));
  while (log.children.length > 300) log.removeChild(log.lastChild);
}

// ── The stored history ──────────────────────────────────────────────────────
const AUDIT_CLASS = {
  'booth.status_change': 'admin', 'deal.update': 'admin',
  'hold.create': 'hold', 'hold.extend': 'hold', 'hold.release': 'release', 'hold.expire': 'release',
  'booth.restore': 'booking', 'security.denied': 'error', 'security.secret_failed': 'error',
};

/** One stored event, as a sentence. */
function auditText(r) {
  const m = r.meta || {};
  const n = r.boothNumber ? `stand ${shownN(r.boothNumber)}` : '';
  const co = m.company ? ` (${m.company})` : '';
  switch (r.type) {
    case 'booth.status_change': return `${cap(n)} ${m.from || '?'} → ${m.to || '?'}${co}${m.forced ? ' (forced)' : ''}`;
    case 'deal.update':         return `Deal updated on ${n}${m.toPrice != null ? ` — ${money(m.toPrice)}` : ''}${m.notesChanged ? ', notes changed' : ''}`;
    case 'hold.create':         return `${cap(n)} put on hold${co}${m.expiresAt ? ` until ${new Date(m.expiresAt).toLocaleString('en-GB')}` : ''}`;
    case 'hold.extend':         return `Hold on ${n} extended${m.expiresAt ? ` to ${new Date(m.expiresAt).toLocaleString('en-GB')}` : ''}`;
    case 'hold.release':        return `${cap(n)} released`;
    case 'hold.expire':         return `Hold on ${n} expired — back on sale`;
    case 'booth.restore':       return `${cap(n)} restored${co}`;
    case 'booth.consolidate':   return `${cap(n)} absorbed ${(m.many || [m.secondary]).filter(Boolean).join(', ') || 'another stand'}`;
    case 'booth.split':         return `${cap(n)} split into ${(m.created || []).length + 1}`;
    case 'booth.reset':
    case 'unmerge':
    case 'unsplit':             return `${cap(n)} reset — ${r.type === 'unmerge' ? 'un-merged' : r.type === 'unsplit' ? 'un-split' : 'restored'}`;
    case 'booth.move':          return `Booking moved ${m.from ? `from ${m.from} ` : ''}to ${n || m.to || '?'}`;
    case 'booth.set_number':    return `${cap(n)} shown as ${m.displayNumber || 'its own number'}`;
    case 'booth.set_tags':      return `Activities set on ${n}`;
    case 'booth.set_country':   return `Country set on ${n}`;
    case 'booth.set_logo':      return `Sponsor logo ${m.logo === '' ? 'removed from' : 'set on'} ${n}`;
    case 'floorplan.upload':    return `Floorplan ${m.revision ? `${m.revision} ` : ''}uploaded${m.revision ? ' as a draft' : ''}${m.bytes ? ` (${Math.round(m.bytes / 1024)} KB)` : ''}`;
    case 'floorplan.publish':   return `Floorplan ${m.revision || ''} made live`;
    case 'floorplan.discard':   return 'Draft floorplan discarded';
    case 'floorplan.revert':    return 'Floorplan reverted to the shipped plan';
    case 'stands.import':       return `Stands ${m.mode === 'update' ? 'updated from a re-issued plan' : 'imported from the artwork'}${m.imported ? ` — ${m.imported}` : ''}`;
    case 'settings.palette':    return m.use === 'app' ? 'Colours set back to the app\'s own'
                                     : m.use === 'artwork' ? 'Colours set from the plan' : 'Colours chosen for the plan';
    case 'sponsor.create':      return `Sponsorship package added${m.name ? `: ${m.name}` : ''}`;
    case 'sponsor.delete':      return `Sponsorship package deleted${m.name ? `: ${m.name}` : ''}`;
    case 'sponsor.import':      return 'Sponsorship catalogue imported';
    case 'enquiry.forward':     return `Enquiry forwarded${m.to ? ` to ${m.to}` : ''}`;
    case 'lead.admin':          return `Lead ${m.action || 'changed'}`;
    case 'admin.team':          return `Team: ${m.action || 'changed'}${m.target ? ` ${m.target}` : ''}`;
    case 'security.denied':     return `Refused: ${m.event || 'an admin action'} from an unauthenticated connection`;
    case 'security.secret_failed': return `Wrong ${m.what ? 'confirmation' : 'password'}${m.failures ? ` (attempt ${m.failures})` : ''}${m.what ? ` — ${m.what}` : ''}`;
    default: return `${r.type}${n ? ` — ${n}` : ''}`;
  }
}

let auditRows = [];

async function loadAuditLog() {
  const log = document.getElementById('admin-log');
  if (!log) return;
  const params = new URLSearchParams({ limit: '200' });
  const q = document.getElementById('log-q')?.value.trim();
  const type = document.getElementById('log-type')?.value;
  const actor = document.getElementById('log-actor')?.value;
  if (q) params.set('q', q);
  if (type) params.set('type', type);
  if (actor) params.set('actor', actor);

  log.replaceChildren(logEntry({ msg: 'Loading history…', type: 'system', time: 'Now' }));
  try {
    auditRows = await api(`/api/audit?${params}`) || [];
  } catch (e) {
    log.replaceChildren(logEntry({ msg: `Could not load the history — ${esc(e.message)}`, type: 'error', time: 'Now' }));
    return;
  }
  renderAuditLog();
  loadAuditActors();
}

function renderAuditLog() {
  const log = document.getElementById('admin-log');
  const count = document.getElementById('log-count');
  if (!log) return;
  if (count) count.textContent = auditRows.length ? `${auditRows.length} entries` : '';

  if (!auditRows.length) {
    log.replaceChildren(logEntry({ msg: 'Nothing recorded for those filters.', type: 'system', time: 'Now' }));
    return;
  }
  log.replaceChildren(...auditRows.map(r => logEntry({
    msg: esc(auditText(r)) + (r.actor?.userId ? ` <em>— ${esc(r.actor.userId)}</em>` : ''),
    type: AUDIT_CLASS[r.type] || 'info',
    time: new Date(r.ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
    boothNumber: r.boothNumber || null,
  })));
}

let auditActorsLoaded = false;
async function loadAuditActors() {
  if (auditActorsLoaded) return;
  const sel = document.getElementById('log-actor');
  if (!sel) return;
  try {
    const names = await api('/api/audit/actors') || [];
    auditActorsLoaded = true;
    const cur = sel.value;
    sel.replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: 'Anyone' }),
      ...names.map(nm => Object.assign(document.createElement('option'), { value: nm, textContent: nm })));
    sel.value = cur;
  } catch { /* the filter simply stays at "Anyone" */ }
}

let auditDebounce = null;
document.getElementById('log-q')?.addEventListener('input', () => {
  clearTimeout(auditDebounce);
  auditDebounce = setTimeout(loadAuditLog, 300);
});
document.getElementById('log-type')?.addEventListener('change', loadAuditLog);
document.getElementById('log-actor')?.addEventListener('change', loadAuditLog);
document.getElementById('log-refresh')?.addEventListener('click', (e) => withPending(e.currentTarget, loadAuditLog));

// ─── Helpers ──────────────────────────────────────────────────────────────────
// esc / cap / money live in lib/ui.js now (destructured at the top of this
// file). `el` stays local and stays a by-id lookup: it is used a couple of
// dozen times in the KPI code below, and it means something different from the
// shared element BUILDER of the same name.
function el(id) { return document.getElementById(id); }

// ─── Leads ──────────────────────────────────────────────────────────────────
// Enquiries captured from the public floorplan, each shown with the browsing
// history that led to it. Built with DOM nodes — the fields are visitor input.
let leadCache = [];

let leadsArchived = false;   // false = active list, true = the archive shelf

async function loadLeads() {
  const listEl = document.getElementById('leads-list');
  listEl.textContent = 'Loading…';
  try {
    leadCache = await api(`/api/inquiries?limit=200&archived=${leadsArchived ? 1 : 0}`) || [];
    renderLeadsList();
  } catch (e) {
    // Say WHY. "No enquiries yet" over a failed request reads as a quiet sales
    // pipeline, which is the opposite of what it means.
    listEl.textContent = `Could not load enquiries — ${e.message}`;
  }
}

// Active / Archived toggle.
document.getElementById('leads-filter')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.leads-filter-btn');
  if (!btn) return;
  leadsArchived = btn.dataset.archived === '1';
  document.querySelectorAll('.leads-filter-btn').forEach(b => b.classList.toggle('active', b === btn));
  renderLeadEmpty();                                          // clear any open detail
  loadLeads();
});

function renderLeadsList() {
  const listEl = document.getElementById('leads-list');
  const noun = leadsArchived ? 'archived' : (leadCache.length === 1 ? 'enquiry' : 'enquiries');
  document.getElementById('leads-count').textContent = `${leadCache.length} ${noun}`;

  // The nav badge tracks unactioned NEW leads on the active list only — archived
  // leads shouldn't light it up.
  if (!leadsArchived) {
    const newCount = leadCache.filter(l => l.status === 'new').length;
    const badge = document.getElementById('leads-badge');
    badge.textContent = newCount;
    badge.classList.toggle('hidden', newCount === 0);
  }

  // Keep the right-hand panel's summary in step, unless a lead is open there.
  if (!document.querySelector('#lead-detail .lead-detail-head')) renderLeadEmpty();

  listEl.replaceChildren();
  if (!leadCache.length) {
    const empty = document.createElement('div');
    empty.className = 'leads-empty-row';
    empty.textContent = leadsArchived ? 'No archived enquiries.' : 'No enquiries yet.';
    listEl.appendChild(empty);
    return;
  }

  leadCache.forEach(l => {
    const row = document.createElement('button');
    row.className = 'lead-row';
    row.dataset.id = l._id;

    // Line 1 — name + status chip.
    const top = document.createElement('div');
    top.className = 'lead-row-top';
    const name = document.createElement('span');
    name.className = 'lead-row-name';
    name.textContent = l.contact?.name || '(no name)';
    const chip = document.createElement('span');
    chip.className = `lead-chip st-${l.status || 'new'}`;
    chip.textContent = LEAD_STATUS_LABEL[l.status] || 'New';
    top.append(name, chip);

    // Line 2 — company/email · stands · sponsorship interest.
    const meta = document.createElement('div');
    meta.className = 'lead-row-meta';
    const parts = [];
    const org = l.contact?.company || l.contact?.email;
    if (org) parts.push(org);
    const booths = l.boothsOfInterest || [];
    if (booths.length) parts.push('stands ' + booths.join(', '));
    const sponsors = l.sponsorsOfInterest || [];
    if (sponsors.length) parts.push(`+${sponsors.length} sponsorship`);
    const areas = l.areasOfInterest || [];
    if (areas.length) parts.push(`+${areas.length} area${areas.length > 1 ? 's' : ''}`);
    meta.textContent = parts.join(' · ') || '—';

    // Line 3 — date · assignee.
    const foot = document.createElement('div');
    foot.className = 'lead-row-foot';
    const time = document.createElement('span');
    time.textContent = l.createdAt ? new Date(l.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '';
    const who = document.createElement('span');
    who.className = 'lead-row-assignee' + (l.assignedTo?.name ? '' : ' unassigned');
    who.textContent = l.assignedTo?.name || 'Unassigned';
    foot.append(time, who);

    row.append(top, meta, foot);
    row.onclick = () => { document.querySelectorAll('.lead-row').forEach(r => r.classList.remove('active')); row.classList.add('active'); openLead(l._id); };
    listEl.appendChild(row);
  });
}

const LEAD_STATUS_LABEL = { new: 'New', contacted: 'Contacted', won: 'Won', lost: 'Lost' };

// The right-hand panel before any enquiry is picked — a prompt plus a quick
// count of what's in the current view, so the page never looks empty.
function renderLeadEmpty() {
  const panel = document.getElementById('lead-detail');
  if (!panel) return;
  panel.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'lead-empty';
  const icon = document.createElement('i'); icon.setAttribute('data-lucide', 'inbox');
  const p = document.createElement('p');
  p.textContent = 'Select an enquiry to see the contact and their browsing history.';
  wrap.append(icon, p);

  const stats = document.createElement('div');
  stats.className = 'lead-empty-stats';
  const stat = (num, label) => {
    const s = document.createElement('div'); s.className = 'lead-empty-stat';
    const n = document.createElement('strong'); n.textContent = num;
    const t = document.createElement('span'); t.textContent = label;
    s.append(n, t); return s;
  };
  stats.append(
    stat(leadCache.length, leadsArchived ? 'archived' : 'active'),
    stat(leadCache.filter(l => l.status === 'new').length, 'new'),
    stat(leadCache.filter(l => l.assignedTo?.name).length, 'assigned'),
  );
  wrap.appendChild(stats);
  panel.appendChild(wrap);
  lucide.createIcons();
}

const EVENT_LABEL = {
  'session.start': 'Arrived', 'booth.view': 'Viewed stand', 'booth.click': 'Clicked stand',
  'booth.dwell': 'Spent time on stand', 'plan.zoom': 'Zoomed the plan',
  'inquiry.submit': 'Sent this enquiry', 'consent.granted': 'Accepted tracking',
};

// ─── Enquiries to Make (→ Salesforce, Dotdigital) ───────────────────────────
// Every enquiry is POSTed to a Make webhook as it arrives; the scenario behind
// it creates the Salesforce lead and the Dotdigital contact. The server retries
// what Make does not take, and records the outcome on the enquiry — this is
// where that is set up, and where a lead says whether it got through.
let makeHook = null;

async function fetchMakeHook() {
  try { makeHook = await api('/api/integrations/enquiry-webhook'); }
  catch { makeHook = null; }
  return makeHook;
}

const shortWhen = (d) => new Date(d).toLocaleString('en-GB',
  { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const MAKE_HELP = `
  <details class="make-help">
    <summary>Setting it up in Make</summary>
    <ol>
      <li>In Make, create a scenario and add <b>Webhooks › Custom webhook</b>. Add a new webhook, name it (e.g. "Floorplan enquiries"), save, and copy its address.</li>
      <li>Paste the address above and press <b>Save</b>.</li>
      <li>On the webhook in Make, press <b>Redetermine data structure</b> — it starts listening — then press <b>Send a test enquiry</b> here. Make now knows every field.</li>
      <li>Add <b>Salesforce › Create a Record</b>, record type <b>Lead</b>, and map the fields below.</li>
      <li>Add <b>Dotdigital</b>, adding the contact to the address book you want, and map the fields below.</li>
      <li>Put a filter straight after the webhook: <code>test</code> <i>Equal to</i> <code>false</code>, so test enquiries never become leads.</li>
      <li>Turn the scenario on, set to run <b>Immediately</b>.</li>
    </ol>
    <table>
      <tr><th>Salesforce Lead</th><th>From the enquiry</th></tr>
      <tr><td>First Name</td><td><code>firstName</code></td></tr>
      <tr><td>Last Name</td><td><code>leadLastName</code> — never empty</td></tr>
      <tr><td>Company</td><td><code>leadCompany</code> — never empty</td></tr>
      <tr><td>Email · Phone · Title</td><td><code>email</code> · <code>phone</code> · <code>jobTitle</code></td></tr>
      <tr><td>Lead Source</td><td><code>leadSource</code></td></tr>
      <tr><td>Description</td><td><code>description</code> — event, stands with sizes, sponsorship, areas, message, and a link back to the lead here</td></tr>
    </table>
    <table>
      <tr><th>Dotdigital contact</th><th>From the enquiry</th></tr>
      <tr><td>Email</td><td><code>email</code></td></tr>
      <tr><td>FIRSTNAME · LASTNAME · FULLNAME</td><td><code>firstName</code> · <code>lastName</code> · <code>name</code></td></tr>
      <tr><td>COMPANY (if you have the field)</td><td><code>company</code></td></tr>
    </table>
    Also there for custom fields or a router per event: <code>eventName</code>, <code>eventId</code>, <code>standList</code>,
    <code>totalSize</code>, <code>listPriceTotal</code>, <code>currency</code>, <code>sponsorshipNames</code>, <code>areaNames</code>,
    <code>message</code>, <code>kind</code> (<i>enquiry</i> or <i>waitlist</i>), <code>enquiryId</code> and <code>consoleUrl</code>.
  </details>`;

async function loadMakeCard() {
  const card = document.getElementById('make-card');
  if (!card) return;
  const h = await fetchMakeHook();
  card.hidden = false;
  card.replaceChildren();

  const head = document.createElement('div');
  head.className = 'plan-head';
  const name = document.createElement('span');
  name.className = 'plan-name';
  name.textContent = 'Enquiries to Make';
  const badge = document.createElement('span');
  badge.className = 'plan-badge' + (h && h.connected ? '' : ' is-off');
  badge.textContent = h && h.connected ? 'Connected' : 'Not connected';
  head.append(name, badge);
  card.appendChild(head);

  const about = document.createElement('p');
  about.className = 'plan-meta';
  about.textContent = 'Every enquiry, from every event, is sent to Make the moment it arrives, so a Make scenario can create the ' +
    'Salesforce lead and add the contact to Dotdigital. If Make does not answer it is tried again for about a day, ' +
    'and each enquiry under Leads says whether it got through.';
  card.appendChild(about);

  if (!h) {
    const bad = document.createElement('p');
    bad.className = 'make-bad';
    bad.textContent = 'Could not read the Make connection — reload to try again.';
    card.appendChild(bad);
    return;
  }

  // How it is going.
  const lines = [];
  if (h.connected) {
    lines.push(['make-ok', h.lastSentAt ? `Last enquiry sent ${shortWhen(h.lastSentAt)}.` : 'Connected. No enquiry has been sent yet.']);
    if (h.source === 'env') lines.push(['plan-meta', 'This address is set on the server (NOTIFY_WEBHOOK). Saving one here replaces it.']);
  }
  if (h.retrying) lines.push(['make-warn', `${h.retrying} ${h.retrying === 1 ? 'enquiry is' : 'enquiries are'} waiting to be tried again.`]);
  if (h.gaveUp) lines.push(['make-bad', `${h.gaveUp} ${h.gaveUp === 1 ? 'enquiry' : 'enquiries'} could not be delivered. Open ${h.gaveUp === 1 ? 'it' : 'them'} under Leads and press Resend once Make is fixed.`]);
  for (const [cls, text] of lines) {
    const p = document.createElement('p');
    p.className = cls;
    p.textContent = text;
    card.appendChild(p);
  }

  const row = document.createElement('div');
  row.className = 'make-row';
  if (h.editable) {
    const input = document.createElement('input');
    input.type = 'url';
    input.className = 'admin-input';
    input.placeholder = 'https://hook.eu1.make.com/…';
    input.value = h.source === 'settings' ? (h.url || '') : '';
    input.setAttribute('aria-label', 'Make webhook address');
    const save = document.createElement('button');
    save.className = 'admin-btn success';
    save.textContent = 'Save';
    save.onclick = () => withPending(save, async () => {
      try {
        const r = await api('/api/integrations/enquiry-webhook', { method: 'PUT', body: JSON.stringify({ url: input.value }) });
        adminToast(r.connected ? 'Saved. New enquiries now go to Make.' : 'Disconnected. Enquiries are no longer sent to Make.', 'ok');
        loadMakeCard();
      } catch (e) { adminToast(e.message || 'Could not save the address.', 'error'); }
    });
    row.append(input, save);
    if (h.source === 'settings') {
      const off = document.createElement('button');
      off.className = 'admin-btn';
      off.textContent = 'Disconnect';
      off.onclick = async () => {
        if (!await confirmDialog('Stop sending enquiries to Make? They will still arrive here under Leads, but Salesforce and Dotdigital will not hear of them until it is connected again.',
          { title: 'Disconnect Make', confirmLabel: 'Disconnect', danger: true })) return;
        input.value = '';
        save.click();
      };
      row.appendChild(off);
    }
  } else {
    const note = document.createElement('span');
    note.className = 'plan-meta';
    note.textContent = h.connected ? `Sending to ${h.url}. Only the owner account can change where enquiries go.`
                                   : 'Only the owner account can connect Make.';
    row.appendChild(note);
  }
  if (h.connected) {
    const test = document.createElement('button');
    test.className = 'admin-btn';
    test.innerHTML = '<i data-lucide="send"></i> Send a test enquiry';
    test.onclick = () => withPending(test, async () => {
      try {
        const r = await api('/api/integrations/enquiry-webhook/test', { method: 'POST', body: '{}' });
        adminToast(`Test enquiry sent to ${r.to}. It is marked test: true, so your filter keeps it out of Salesforce.`, 'ok');
      } catch (e) { adminToast(e.message || 'The test did not get through.', 'error'); }
    });
    row.appendChild(test);
  }
  card.appendChild(row);

  const help = document.createElement('div');
  help.innerHTML = MAKE_HELP;
  card.appendChild(help);
  lucide.createIcons();
}

/** A lead's line about Make, and the button that sends it again. */
function renderLeadDelivery(box, lead, id) {
  box.replaceChildren();
  const d = lead.delivery || null;
  const connected = !!(makeHook && makeHook.connected);
  if (!d && !connected) { box.hidden = true; return; }
  box.hidden = false;

  const label = document.createElement('span');
  label.className = 'lead-field-label';
  label.textContent = 'Make';
  const text = document.createElement('span');
  if (!d) {
    text.className = 'plan-meta';
    text.textContent = 'Not sent — it arrived before Make was connected.';
  } else if (d.status === 'sent') {
    text.className = 'make-ok';
    text.textContent = `Sent ${shortWhen(d.sentAt)}`;
  } else if (d.status === 'sending') {
    text.className = 'plan-meta';
    text.textContent = 'Being sent…';
  } else if (d.nextAttemptAt) {
    text.className = 'make-warn';
    text.textContent = `Not in Make yet — ${d.error || 'no answer'}. Trying again at ${shortWhen(d.nextAttemptAt)}.`;
  } else {
    text.className = 'make-bad';
    text.textContent = `Not delivered — ${d.error || 'no answer'}.`;
  }
  box.append(label, text);

  if (!connected) return;
  const btn = document.createElement('button');
  btn.className = 'admin-btn';
  btn.style.cssText = 'font-size:12px;padding:5px 10px';
  const sent = d && d.status === 'sent';
  btn.textContent = sent ? 'Send again' : d ? 'Resend' : 'Send to Make';
  btn.onclick = async () => {
    if (sent && !await confirmDialog('Make already has this enquiry. Sending it again will create a second Salesforce lead unless your scenario checks for one.',
      { title: 'Send to Make again', confirmLabel: 'Send again' })) return;
    await withPending(btn, async () => {
      try {
        const r = await api(`/api/inquiries/${encodeURIComponent(id)}/deliver`, { method: 'POST', body: '{}' });
        lead.delivery = r.delivery;
        adminToast('Sent to Make.', 'ok');
      } catch (e) {
        adminToast(e.message || 'Could not send it to Make.', 'error');
        try { lead.delivery = (await api(`/api/inquiries/${encodeURIComponent(id)}`)).delivery || lead.delivery; } catch { /* keep what we had */ }
      }
      renderLeadDelivery(box, lead, id);
    });
  };
  box.appendChild(btn);
}

// A link to one lead — the consoleUrl Make puts on the Salesforce record —
// opens this console on that lead.
function openLinkedLead() {
  const m = /^#lead=([a-f0-9]{24})$/i.exec(location.hash || '');
  if (!m) return;
  showAdminSection('leads');
  openLead(m[1]);
}
window.addEventListener('hashchange', openLinkedLead);
setTimeout(openLinkedLead, 0);

async function openLead(id) {
  const panel = document.getElementById('lead-detail');
  panel.textContent = 'Loading…';
  let lead;
  try { lead = await api(`/api/inquiries/${encodeURIComponent(id)}`); }
  catch (e) { panel.textContent = `Could not load this enquiry — ${e.message}`; return; }
  if (!lead) { panel.textContent = 'Could not load this enquiry.'; return; }

  panel.replaceChildren();

  const head = document.createElement('div');
  head.className = 'lead-detail-head';
  const h = document.createElement('h2');
  h.textContent = lead.contact?.name || '(no name)';
  head.appendChild(h);

  // Archive / restore + delete. Archiving shelves the lead (reversible);
  // delete removes it for good behind a confirm.
  const actions = document.createElement('div');
  actions.className = 'lead-detail-actions';

  const archiveBtn = document.createElement('button');
  archiveBtn.className = 'admin-btn';
  archiveBtn.style.cssText = 'font-size:12px;padding:5px 10px';
  archiveBtn.innerHTML = lead.archived
    ? '<i data-lucide="archive-restore"></i> Restore'
    : '<i data-lucide="archive"></i> Archive';
  archiveBtn.onclick = async () => {
    const toArchive = !lead.archived;
    await withPending(archiveBtn, async () => {
      try {
        await api(`/api/inquiries/${encodeURIComponent(id)}/archive`, {
          method: 'POST', body: JSON.stringify({ archived: toArchive }),
        });
        adminToast(toArchive ? 'Enquiry archived.' : 'Enquiry restored.', 'ok');
        renderLeadEmpty();                   // it just left this view
        loadLeads();
      } catch (e) { adminToast(e.message || 'Could not update the enquiry.', 'error'); }
    });
  };
  actions.appendChild(archiveBtn);

  const delBtn = document.createElement('button');
  delBtn.className = 'admin-btn danger';
  delBtn.style.cssText = 'font-size:12px;padding:5px 10px';
  delBtn.innerHTML = '<i data-lucide="trash-2"></i> Delete';
  delBtn.onclick = async () => {
    if (!await confirmDialog(
      `Permanently delete the enquiry from ${lead.contact?.name || 'this contact'}` +
      `${lead.contact?.company ? ` at ${lead.contact.company}` : ''}?\n\n` +
      'Their browsing history goes with it. This cannot be undone — Archive shelves it instead, and is reversible.',
      { title: 'Delete this enquiry', confirmLabel: 'Delete it', danger: true })) return;
    await withPending(delBtn, async () => {
      try {
        await api(`/api/inquiries/${encodeURIComponent(id)}`, { method: 'DELETE' });
        adminToast('Enquiry deleted.', 'ok');
        renderLeadEmpty();
        loadLeads();
      } catch (e) { adminToast(e.message || 'Could not delete the enquiry.', 'error'); }
    });
  };
  actions.appendChild(delBtn);

  head.appendChild(actions);
  panel.appendChild(head);
  lucide.createIcons();

  // Pipeline status — sales move a lead new → contacted → won / lost.
  const statusRow = document.createElement('div');
  statusRow.className = 'lead-status-row';
  const label = document.createElement('span'); label.className = 'lead-field-label'; label.textContent = 'Status';
  statusRow.appendChild(label);
  const btns = document.createElement('div'); btns.className = 'lead-status-btns';
  ['new', 'contacted', 'won', 'lost'].forEach(st => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `lead-status-btn st-${st}` + (lead.status === st ? ' active' : '');
    btn.textContent = st.charAt(0).toUpperCase() + st.slice(1);
    btn.onclick = () => withPending(btn, async () => {
      try {
        await api(`/api/inquiries/${encodeURIComponent(id)}`, {
          method: 'PATCH', body: JSON.stringify({ status: st }),
        });
        lead.status = st;
        statusRow.querySelectorAll('.lead-status-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const cached = leadCache.find(l => l._id === id); if (cached) cached.status = st;
        renderLeadsList();                       // refresh the list + "new" badge
        adminToast(`Lead marked ${st}.`, 'ok');
      } catch (e) { adminToast(e.message || 'Could not update lead status.', 'error'); }
    });
    btns.appendChild(btn);
  });
  statusRow.appendChild(btns);
  panel.appendChild(statusRow);

  // Whether this enquiry reached Make — and so Salesforce and Dotdigital.
  const makeBox = document.createElement('div');
  makeBox.className = 'lead-make';
  panel.appendChild(makeBox);
  if (!makeHook) await fetchMakeHook();
  renderLeadDelivery(makeBox, lead, id);

  // ── Forward to a salesperson ────────────────────────────────────────────────
  const fwd = document.createElement('div');
  fwd.className = 'lead-forward';

  const fwdLabel = document.createElement('span');
  fwdLabel.className = 'lead-field-label';
  fwdLabel.textContent = 'Send to';
  fwd.appendChild(fwdLabel);

  const select = document.createElement('select');
  select.className = 'admin-select lead-assign';
  const none = document.createElement('option'); none.value = ''; none.textContent = 'Choose a salesperson…';
  select.appendChild(none);
  (salesTeamCache.team || []).forEach(m => {
    const o = document.createElement('option');
    o.value = m.name; o.textContent = m.name;
    if (lead.assignedTo && lead.assignedTo.name === m.name) o.selected = true;
    select.appendChild(o);
  });
  select.onchange = async () => {
    // The response was never looked at. The server returns 400 for an unknown
    // name and 404 for a lead that has been deleted underneath the panel, and
    // both of those toasted "Assigned to …" as though they had worked.
    const previous = lead.assignedTo?.name || '';
    try {
      await api(`/api/inquiries/${encodeURIComponent(id)}/assign`, {
        method: 'POST', body: JSON.stringify({ name: select.value }),
      });
      lead.assignedTo = select.value ? { name: select.value } : null;
      const cached = leadCache.find(l => l._id === id);
      if (cached) cached.assignedTo = lead.assignedTo;
      renderLeadsList();
      adminToast(select.value ? `Assigned to ${select.value}.` : 'Assignment cleared.', 'ok');
    } catch (e) {
      select.value = previous;                 // don't leave a name that wasn't saved
      adminToast(e.message || 'Could not save assignment.', 'error');
    }
  };
  fwd.appendChild(select);

  const sendBtn = document.createElement('button');
  sendBtn.className = 'admin-btn success';
  const alreadySent = (lead.sendCount || 0) > 0;
  sendBtn.innerHTML = `<i data-lucide="send"></i> ${alreadySent ? 'Send again' : 'Send now'}`;
  sendBtn.onclick = () => sendLead(id, select.value, sendBtn);
  fwd.appendChild(sendBtn);

  const ccNote = document.createElement('span');
  ccNote.className = 'lead-cc-note';
  ccNote.textContent = salesTeamCache.manager
    ? `${salesTeamCache.manager.name} is copied on every send`
    : '';
  fwd.appendChild(ccNote);

  panel.appendChild(fwd);

  if (alreadySent) {
    const sent = document.createElement('div');
    sent.className = 'lead-sent-note';
    sent.textContent = `Sent ${lead.sendCount}× — last to ${lead.lastSentTo || '—'}` +
      (lead.lastSentAt ? ` on ${new Date(lead.lastSentAt).toLocaleString('en-GB')}` : '');
    panel.appendChild(sent);
  }

  const contact = document.createElement('div');
  contact.className = 'lead-contact-grid';
  const field = (label, value, href) => {
    const wrap = document.createElement('div');
    const l = document.createElement('span'); l.className = 'lead-field-label'; l.textContent = label;
    const v = href ? document.createElement('a') : document.createElement('span');
    v.className = 'lead-field-value'; v.textContent = value || '—';
    if (href && value) { v.href = href; }
    wrap.append(l, v); return wrap;
  };
  // Map sponsor keys to their names for a readable label.
  const sponsorNames = (lead.sponsorsOfInterest || [])
    .map(k => (sponsorAdminCache.find(s => s.key === k) || {}).name || k);
  // Areas are named from the live catalogue, so a renamed area reads correctly
  // on an enquiry taken before the rename.
  const areaNames = (lead.areasOfInterest || [])
    .map(k => (planAreas.find(a => a.key === k) || {}).label || k);

  contact.append(
    field('Email', lead.contact?.email, lead.contact?.email ? `mailto:${lead.contact.email}` : null),
    field('Phone', lead.contact?.phone, lead.contact?.phone ? `tel:${lead.contact.phone}` : null),
    field('Company', lead.contact?.company),
    field('Job title', lead.contact?.jobTitle),
    field('Heard about us', lead.contact?.heardAbout),
    field('Stands of interest', (lead.boothsOfInterest || []).join(', ')),
    field('Sponsorship interest', sponsorNames.join(', ')),
    field('Areas of interest', areaNames.join(', ')),
  );
  panel.appendChild(contact);

  if (lead.message) {
    const msg = document.createElement('div');
    msg.className = 'lead-message';
    msg.textContent = lead.message;
    panel.appendChild(msg);
  }

  // Browsing history — the retroactive session join in action.
  const histHead = document.createElement('h3');
  histHead.className = 'lead-hist-head';
  histHead.textContent = 'Before they enquired';
  panel.appendChild(histHead);

  const history = (lead.history || []).filter(e => EVENT_LABEL[e.type]);
  if (!history.length) {
    const none = document.createElement('p');
    none.className = 'lead-hist-none';
    none.textContent = 'No tracked activity — this visitor did not accept analytics, or arrived straight to the form.';
    panel.appendChild(none);
  } else {
    const tl = document.createElement('div');
    tl.className = 'lead-timeline';
    history.forEach(e => {
      const item = document.createElement('div');
      item.className = 'lead-tl-item';
      const t = document.createElement('span'); t.className = 'lead-tl-time';
      t.textContent = new Date(e.ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      const d = document.createElement('span'); d.className = 'lead-tl-desc';
      d.textContent = EVENT_LABEL[e.type] + (e.boothNumber ? ` ${e.boothNumber}` : '') +
        (e.type === 'booth.dwell' && e.meta?.ms ? ` (${Math.round(e.meta.ms / 1000)}s)` : '');
      item.append(t, d); tl.appendChild(item);
    });
    panel.appendChild(tl);
  }
}

// ─── Analytics ──────────────────────────────────────────────────────────────
async function loadAnalytics() {
  const days = document.getElementById('analytics-days').value;
  try {
    const [funnel, demand] = await Promise.all([
      api(`/api/analytics/funnel?days=${days}`),
      api(`/api/analytics/demand?days=${days}`),
    ]);
    renderFunnel(funnel);
    renderDemand(demand);
  } catch (e) {
    // The demand table was left showing the PREVIOUS period's numbers under the
    // new period's heading — stale data presented as current, which is worse
    // than no data. Clear it and say what happened.
    document.getElementById('funnel').textContent = `Could not load analytics — ${e.message}`;
    const tb = document.getElementById('demand-tbody');
    if (tb) {
      tb.replaceChildren();
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6; td.className = 'demand-empty';
      td.textContent = 'Not loaded — these numbers would be from a different period.';
      tr.appendChild(td); tb.appendChild(tr);
    }
  }
}

function renderFunnel(data) {
  const el = document.getElementById('funnel');
  el.replaceChildren();
  const steps = data.steps || [];
  const top = Math.max(1, steps[0]?.count || 1);
  steps.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'funnel-step';

    const label = document.createElement('div'); label.className = 'funnel-label';
    label.textContent = s.step;

    // The bar sits in its own track; the count lives in a fixed column to the
    // right so it is always fully readable, even when the bar is tiny.
    const track = document.createElement('div'); track.className = 'funnel-track';
    const barWrap = document.createElement('div'); barWrap.className = 'funnel-bar-wrap';
    const bar = document.createElement('div'); bar.className = 'funnel-bar';
    bar.style.width = Math.round((s.count / top) * 100) + '%';
    barWrap.appendChild(bar);

    const count = document.createElement('span'); count.className = 'funnel-count';
    const prev = i > 0 ? steps[i - 1].count : null;
    const pct = prev != null ? ` (${prev ? Math.round((s.count / prev) * 100) : 0}%)` : '';
    count.textContent = `${s.count}${pct}`;

    track.append(barWrap, count);
    row.append(label, track);
    el.appendChild(row);
  });

  // Note how many bot/no-interaction connections were excluded from the top of
  // the funnel, so the numbers are transparent rather than mysteriously lower.
  if (data.botsFiltered > 0) {
    const note = document.createElement('div');
    note.className = 'funnel-note';
    note.textContent = `${data.botsFiltered} bot / no-interaction visit${data.botsFiltered === 1 ? '' : 's'} excluded (of ${data.rawVisits} total connections)`;
    el.appendChild(note);
  }
}

// Dwell reads better in minutes once it passes a minute.
function formatDwell(ms) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  if (s < 90) return s + 's';
  const m = Math.floor(s / 60), rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

function renderDemand(data) {
  const tb = document.getElementById('demand-tbody');
  tb.replaceChildren();
  const rows = (data.booths || []).slice(0, 40);
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td'); td.colSpan = 6; td.className = 'demand-empty';
    td.textContent = 'No stand activity in this period yet.';
    tr.appendChild(td); tb.appendChild(tr); return;
  }
  const maxU = Math.max(...rows.map(r => r.uniqueSessions || 0), 1);
  rows.forEach(r => {
    const tr = document.createElement('tr');
    const cell = (v) => { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); return td; };
    cell(r.boothNumber);
    cell(r.uniqueSessions || 0);
    cell(r.clicks || 0);
    cell(r.views || 0);
    cell(formatDwell(r.dwellMs));
    const barTd = document.createElement('td'); barTd.className = 'demand-bar-cell';
    const bar = document.createElement('div'); bar.className = 'demand-bar';
    bar.style.width = Math.round(((r.uniqueSessions || 0) / maxU) * 100) + '%';
    barTd.appendChild(bar); tr.appendChild(barTd);
    tb.appendChild(tr);
  });
}

/**
 * Sponsor logos in the admin sidebar. Same list managed under
 * Sponsors → Partner logos, so updating a logo or its link there changes it
 * here too. Built with DOM nodes and http(s)-only links (validated server-side).
 */
async function loadNavPartners() {
  const wrap = document.getElementById('nav-partners');
  const box  = document.getElementById('nav-partners-logos');
  if (!wrap || !box) return;
  let list = [];
  try { list = (await api('/partners') || {}).partners || []; } catch { /* the strip just stays hidden */ }

  box.replaceChildren();
  if (!list.length) { wrap.classList.add('hidden'); return; }

  list.forEach(p => {
    const img = document.createElement('img');
    img.src = p.image; img.alt = p.alt || p.name || 'Partner'; img.loading = 'lazy';

    const holder = p.url ? document.createElement('a') : document.createElement('span');
    if (p.url) {
      holder.href = p.url; holder.target = '_blank'; holder.rel = 'noopener noreferrer';
      holder.title = p.name || '';
    }
    // A logo whose file is missing shouldn't leave a broken icon in the nav.
    img.onerror = () => holder.remove();
    holder.appendChild(img);
    box.appendChild(holder);
  });
  wrap.classList.remove('hidden');
}
loadNavPartners();

/**
 * Only the latest of overlapping loads may draw.
 *
 * The partner, sponsor and team tables each cleared themselves, waited for the
 * server, and then appended a row per answer. Two loads in flight — a
 * double-click on the nav item is enough — both cleared first and both
 * appended after, so every row came out twice. `latestLoad('team')` returns a
 * check that is true only while no newer load of the same table has started.
 */
const loadSeq = {};
function latestLoad(name) {
  const n = (loadSeq[name] = (loadSeq[name] || 0) + 1);
  return () => loadSeq[name] === n;
}

// ─── Partner logos (public "In partnership with" strip) ──────────────────────
async function loadPartners() {
  const tbody = document.getElementById('partners-tbody');
  if (!tbody) return;
  const current = latestLoad('partners');
  let list = [];
  let failed = null;
  try { list = await api('/api/partners') || []; } catch (e) { failed = e.message; }
  if (!current()) return;                    // a newer load is drawing this table
  tbody.replaceChildren();

  if (failed) {
    const tr = document.createElement('tr');
    const td = document.createElement('td'); td.colSpan = 5; td.className = 'partners-empty';
    td.textContent = `Could not load the logos — ${failed}`;
    tr.appendChild(td); tbody.appendChild(tr); return;
  }

  if (!list.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td'); td.colSpan = 5; td.className = 'partners-empty';
    td.textContent = 'No sponsorship logos yet — drop one in above and it appears on the public floorplan.';
    tr.appendChild(td); tbody.appendChild(tr); return;
  }

  list.forEach(p => {
    const tr = document.createElement('tr');
    if (p.active === false) tr.classList.add('partner-hidden');

    // The thumbnail doubles as a drop target, so replacing a logo is the same
    // gesture as adding one — drop a new file on the old logo.
    const prev = document.createElement('td');
    const zone = document.createElement('div');
    zone.className = 'partner-thumb-zone'; zone.tabIndex = 0; zone.role = 'button';
    zone.title = 'Drop a new logo here, or click to choose one';
    const img = document.createElement('img');
    img.className = 'partner-thumb'; img.src = p.image; img.alt = p.name || 'logo';
    img.onerror = () => { img.replaceWith(Object.assign(document.createElement('span'), { className: 'partner-broken', textContent: 'broken' })); };
    const rep = document.createElement('input');
    rep.type = 'file'; rep.accept = 'image/*'; rep.className = 'visually-hidden';
    zone.append(img, rep, Object.assign(document.createElement('span'), { className: 'partner-thumb-hint', textContent: 'Replace' }));
    initDropzone(zone, async (file) => {
      try { await savePartner(p._id, { image: await fileToDataUrl(file) }); }
      catch (err) { adminToast(err.message, 'error'); }
    }, { input: rep });
    prev.appendChild(zone); tr.appendChild(prev);

    tr.appendChild(partnerInput(p._id, 'name',  p.name  || '', 'Name', 130));
    tr.appendChild(partnerInput(p._id, 'url',   p.url   || '', 'Link (optional)', 200));

    const shown = document.createElement('td');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = p.active !== false;
    cb.onchange = () => savePartner(p._id, { active: cb.checked });
    shown.appendChild(cb); tr.appendChild(shown);

    const act = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'admin-btn danger'; del.style.cssText = 'font-size:11px;padding:5px 10px';
    del.textContent = 'Remove';
    del.onclick = async () => {
      if (!await confirmDialog(
        `Remove "${p.name || 'this logo'}" from the public floorplan?\n\nThe logo is deleted; add it again by dropping the file back in.`,
        { title: 'Remove this logo', confirmLabel: 'Remove it', danger: true })) return;
      // No try/catch at all before this: a dropped connection here was an
      // unhandled rejection with no toast, so the row simply stayed put and the
      // admin clicked Remove again.
      await withPending(del, async () => {
        try {
          await api(`/api/partners/${p._id}`, { method: 'DELETE' });
          adminToast('Logo removed.', 'ok');
          loadPartners(); loadNavPartners();
        } catch (e) { adminToast(e.message || 'Could not remove that logo.', 'error'); }
      });
    };
    act.appendChild(del); tr.appendChild(act);

    tbody.appendChild(tr);
  });
}

function partnerInput(id, field, value, placeholder, width) {
  const td = document.createElement('td');
  const inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'admin-input'; inp.value = value; inp.placeholder = placeholder;
  inp.style.cssText = `width:${width}px;padding:5px 8px;font-size:12px;background:var(--bg);`;
  inp.onchange = () => savePartner(id, { [field]: inp.value });
  td.appendChild(inp);
  return td;
}

async function savePartner(id, fields) {
  try {
    await api(`/api/partners/${id}`, { method: 'PATCH', body: JSON.stringify(fields) });
    adminToast('Logo updated.', 'ok');
    if ('image' in fields || 'active' in fields) loadPartners();
    loadNavPartners();
  } catch (e) { adminToast(e.message || 'Could not save that logo.', 'error'); }
}

/**
 * Turn a chosen file into an inline data URI, downscaled so the stored logo
 * stays small. Render's filesystem is wiped on every deploy, so the image is
 * kept in the database rather than written to disk. SVGs pass through untouched
 * to keep them vector.
 *
 * Nothing this returns is longer than the server will store (IMAGE_CAP). An
 * SVG cannot be shrunk here, so it has to fit as it is — and it used to be let
 * through at up to 8 MB, far past what the server keeps. A logo that size did
 * not even reach the server's refusal: it dropped the connection on the way,
 * and the page said nothing at all. It is refused here, before it is sent,
 * with the reason and the way round it.
 */
const IMAGE_CAP = 2_000_000;   // characters of data URI: the server's cap on every stored image
const SVG_PREFIX = 'data:image/svg+xml;base64,'.length;
const tooBigSvg = (bytes) => new Error(
  `That SVG is ${(bytes / (1024 * 1024)).toFixed(1)} MB, which is too large to store as a logo — ` +
  `the most an SVG can be is about ${((IMAGE_CAP - SVG_PREFIX) * 3 / 4 / (1024 * 1024)).toFixed(1)} MB. ` +
  'Save it with less detail, or export it as a PNG, which is shrunk to fit.');

function fileToDataUrl(file, maxWidth = 800) {
  // Keep the stored data URI comfortably under the server's ~2M-char cap.
  const MAX_LEN = 1_500_000;
  const svg = file.type === 'image/svg+xml';
  return new Promise((resolve, reject) => {
    // Base64 is four characters for every three bytes; checked before the
    // file is even read, so a 6 MB drawing is turned away at once.
    if (svg && SVG_PREFIX + Math.ceil(file.size / 3) * 4 > IMAGE_CAP) return reject(tooBigSvg(file.size));
    if (file.size > 8 * 1024 * 1024) return reject(new Error('Image must be under 8 MB.'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      if (svg) {
        if (reader.result.length > IMAGE_CAP) return reject(tooBigSvg(file.size));
        return resolve(reader.result);
      }
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not a readable image.'));
      img.onload = () => {
        // Downscale by the larger dimension so a tall banner is capped too, not
        // just a wide one — the old width-only scale let tall images through
        // huge and the server truncated them into corruption.
        let scale = Math.min(1, maxWidth / Math.max(img.width, img.height));
        const render = () => {
          const c = document.createElement('canvas');
          c.width  = Math.max(1, Math.round(img.width * scale));
          c.height = Math.max(1, Math.round(img.height * scale));
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, c.width, c.height);
          // PNG preserves transparency (logos), but is huge for photos. Try PNG
          // first; if it's oversized, fall back to JPEG on a white backing.
          let url = c.toDataURL('image/png');
          if (url.length > MAX_LEN) {
            ctx.globalCompositeOperation = 'destination-over';
            ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
            url = c.toDataURL('image/jpeg', 0.85);
          }
          return url;
        };
        let url = render();
        // Still too big (a very detailed image)? Shrink and retry a few times.
        let guard = 0;
        while (url.length > MAX_LEN && guard++ < 5) { scale *= 0.75; url = render(); }
        if (url.length > MAX_LEN) return reject(new Error('That image is too detailed to store — try a simpler or smaller logo.'));
        resolve(url);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Wire an element up as a drag-and-drop target for a single image.
 *
 * Also handles click-to-browse and clipboard paste, because "drop a file" is
 * only one of the ways a logo actually arrives — people just as often have it
 * copied from a design tool or sitting in a folder.
 *
 * `onFile` receives the raw File; it decides what to do with it.
 */
function initDropzone(el, onFile, { input = null } = {}) {
  const take = (file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return adminToast('That file is not an image.', 'error');
    onFile(file);
  };

  // dragover must be cancelled or the browser navigates to the dropped file.
  ['dragenter', 'dragover'].forEach(evt => el.addEventListener(evt, e => {
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; el.classList.add('dragging');
  }));
  ['dragleave', 'dragend'].forEach(evt => el.addEventListener(evt, () => el.classList.remove('dragging')));
  el.addEventListener('drop', e => {
    e.preventDefault(); el.classList.remove('dragging');
    take(e.dataTransfer?.files?.[0]);
  });

  if (input) {
    el.addEventListener('click', () => input.click());
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    input.addEventListener('change', () => { take(input.files?.[0]); input.value = ''; });
    el.addEventListener('paste', e => {
      const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
      if (item) { e.preventDefault(); take(item.getAsFile()); }
    });
  }
}

// The logo chosen for the add form, held until "Add logo" is pressed.
let pendingPartnerImage = '';

(function initPartnerDropzone() {
  const zone = document.getElementById('partner-drop');
  if (!zone) return;
  const preview = document.getElementById('partner-preview');
  const prompt  = document.getElementById('partner-drop-prompt');

  initDropzone(zone, async (file) => {
    try {
      pendingPartnerImage = await fileToDataUrl(file);
      preview.src = pendingPartnerImage;
      preview.classList.remove('hidden');
      prompt.classList.add('hidden');
      zone.classList.add('has-image');
      // Dropping only stages the logo — it isn't live until "Add logo" is
      // pressed. Make that unmissable, since a staged preview reads as "done".
      const form = document.getElementById('partner-add-form');
      form.classList.add('logo-staged');
      form.querySelector('button[type=submit]').classList.add('cta-ready');
    } catch (err) { adminToast(err.message, 'error'); }
  }, { input: document.getElementById('partner-file') });
})();

/** Return the add form to its empty state after a logo is saved. */
function resetPartnerDropzone() {
  pendingPartnerImage = '';
  const zone = document.getElementById('partner-drop');
  if (!zone) return;
  zone.classList.remove('has-image');
  document.getElementById('partner-preview').classList.add('hidden');
  document.getElementById('partner-drop-prompt').classList.remove('hidden');
  const form = document.getElementById('partner-add-form');
  form.classList.remove('logo-staged');
  form.querySelector('button[type=submit]').classList.remove('cta-ready');
}

document.getElementById('partner-add-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  // Guarded: double-clicking Add logo published the same logo twice.
  return withPending(e.target.querySelector('button[type=submit]'), async () => {
    // A dropped file wins over a pasted URL.
    const image = pendingPartnerImage || document.getElementById('partner-image').value.trim();
    if (!image) return adminToast('Drop in a logo, or paste an image URL.', 'error');

    const body = {
      name:  document.getElementById('partner-name').value.trim(),
      image,
      url:   document.getElementById('partner-url').value.trim(),
    };
    try {
      await api('/api/partners', { method: 'POST', body: JSON.stringify(body) });
      adminToast('Logo added.', 'ok');
      ['partner-name', 'partner-image', 'partner-url'].forEach(i => { document.getElementById(i).value = ''; });
      resetPartnerDropzone();
      loadPartners(); loadNavPartners();
    } catch (err) { adminToast(err.message || 'Could not add that logo.', 'error'); }
  });
});

// ─── Sponsors (admin — with prices) ──────────────────────────────────────────
async function loadSponsorsAdmin() {
  loadPartners();
  const tbody = document.getElementById('sponsors-admin-tbody');
  const current = latestLoad('sponsors');      // see latestLoad
  let rows;
  try {
    rows = await api('/api/sponsors') || [];
  } catch (e) {
    if (!current()) return;
    sponsorAdminCache = [];
    tbody.replaceChildren();
    const tr = document.createElement('tr');
    const td = document.createElement('td'); td.colSpan = 8; td.className = 'partners-empty';
    td.textContent = `Could not load the sponsorship catalogue — ${e.message}`;
    tr.appendChild(td); tbody.appendChild(tr);
    return;
  }
  if (!current()) return;                    // a newer load is drawing this table
  sponsorAdminCache = rows;
  tbody.replaceChildren();

  const TIER_RANK = { platinum: 0, gold: 1, silver: 2 };
  sponsorAdminCache.sort((a, b) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9) || (b.price || 0) - (a.price || 0));

  sponsorAdminCache.forEach(s => {
    const tr = document.createElement('tr');
    if (s.active === false) tr.classList.add('sponsor-inactive');

    const nameTd = document.createElement('td');
    const nm = document.createElement('strong'); nm.textContent = s.name;
    const bl = document.createElement('div'); bl.className = 'sp-admin-blurb'; bl.textContent = s.blurb || '';
    nameTd.append(nm, bl);
    tr.appendChild(nameTd);

    const tierTd = document.createElement('td');
    const pill = document.createElement('span'); pill.className = `sp-tier-pill tier-${s.tier}`; pill.textContent = s.tier;
    tierTd.appendChild(pill);
    tr.appendChild(tierTd);

    tr.appendChild(sponsorInput(s.key, 'price', s.price ?? '', 'number', `${CUR.trim()} POA`, 90));
    tr.appendChild(sponsorInput(s.key, 'availability', s.availability ?? '', 'text', 'e.g. Exclusive', 120));
    tr.appendChild(sponsorImageCell(s.key, s.image ?? ''));
    tr.appendChild(sponsorInput(s.key, 'video', s.video ?? '', 'text', 'URL', 130));

    // Offered and Sold out are two sides of one switch. A sold-out package is
    // no longer on offer, but unlike an unticked one it stays on the public
    // floorplan behind a "Sold out" badge — a gone package sells next year.
    const soldOut = s.soldOut === true;
    if (soldOut) tr.classList.add('sponsor-soldout');

    const activeTd = document.createElement('td');
    const cb = document.createElement('input'); cb.type = 'checkbox';
    cb.checked = s.active !== false && !soldOut;
    cb.disabled = soldOut;
    cb.title = soldOut ? 'Sold out packages are not on offer.' : '';
    cb.onchange = () => saveSponsor(s.key, { active: cb.checked });
    activeTd.appendChild(cb);
    tr.appendChild(activeTd);

    const soldTd = document.createElement('td');
    const so = document.createElement('input'); so.type = 'checkbox'; so.checked = soldOut;
    so.title = 'Withdraw from sale but keep it on the floorplan, marked Sold out.';
    so.onchange = () => saveSponsor(s.key, { soldOut: so.checked });
    soldTd.appendChild(so);
    tr.appendChild(soldTd);

    // Delete. Withdrawing (un-tick Offered) is the reversible option and is
    // right most of the time, so the confirm says so — deleting is for a package
    // that should never have existed, not one that has simply stopped selling.
    const delTd = document.createElement('td');
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'admin-btn danger sp-del';
    del.textContent = 'Delete';
    del.title = `Remove ${s.name} from the catalogue`;
    del.onclick = () => deleteSponsor(s);
    delTd.appendChild(del);
    tr.appendChild(delTd);

    tbody.appendChild(tr);
  });
}

/**
 * The package's image: uploaded, pasted or linked.
 *
 * This column used to be a bare text box reading "/sponsors/x.jpg or URL", so
 * the only way to give a package a picture was to host the file somewhere first
 * and paste a link — which is no use for a logo an admin has just been emailed.
 * The file is shrunk in the browser and stored inline, the same way partner and
 * stand logos are, so nothing has to be hosted anywhere.
 *
 * A pasted path or URL still works and is still shown as text: existing
 * packages point at /sponsors/*.jpg and must keep doing so.
 */
function sponsorImageCell(key, value) {
  const td = document.createElement('td');
  td.className = 'sp-image-cell';

  const uploaded = /^data:image\//i.test(value);

  const take = async (file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return adminToast('That file is not an image.', 'error');
    try {
      const dataUrl = await fileToDataUrl(file, 600);
      await saveSponsor(key, { image: dataUrl });
      loadSponsorsAdmin();          // redraw so the thumbnail replaces the box
    } catch (err) {
      adminToast(err.message || 'Could not read that image.', 'error');
    }
  };

  const pick = () => {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/*';
    picker.onchange = () => take(picker.files?.[0]);
    picker.click();
  };

  if (uploaded) {
    // Already an inline image — show it, rather than a text box holding a
    // 200,000-character data URI nobody can read or edit.
    const img = document.createElement('img');
    img.src = value;
    img.alt = '';
    img.className = 'sp-image-thumb';
    img.title = 'Click to replace this image';
    img.onclick = pick;

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'sp-image-clear';
    clear.textContent = 'Remove';
    clear.onclick = async () => { await saveSponsor(key, { image: '' }); loadSponsorsAdmin(); };

    td.append(img, clear);
  } else {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'admin-input sp-image-url';
    inp.value = value;
    inp.placeholder = '/sponsors/x.jpg or URL';
    inp.onchange = () => saveSponsor(key, { image: inp.value });

    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'sp-image-upload';
    up.textContent = 'Upload';
    up.title = 'Upload an image, or drop one onto this cell';
    up.onclick = pick;

    td.append(inp, up);
  }

  // Dropping onto the cell works whichever state it is in.
  ['dragenter', 'dragover'].forEach(ev => td.addEventListener(ev, (e) => {
    e.preventDefault(); td.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach(ev => td.addEventListener(ev, (e) => {
    e.preventDefault(); td.classList.remove('dragover');
  }));
  td.addEventListener('drop', (e) => take(e.dataTransfer?.files?.[0]));

  return td;
}

function sponsorInput(key, field, value, type, placeholder, width) {
  const td = document.createElement('td');
  const inp = document.createElement('input');
  inp.type = type; inp.className = 'admin-input'; inp.value = value; inp.placeholder = placeholder;
  inp.style.cssText = `width:${width}px;padding:5px 8px;font-size:12px;background:var(--bg);`;
  inp.onchange = () => saveSponsor(key, { [field]: type === 'number' ? (inp.value === '' ? null : Number(inp.value)) : inp.value });
  td.appendChild(inp);
  return td;
}

async function saveSponsor(key, fields) {
  // api() carries the server's own explanation of a rejected image (too large,
  // not an image) — saying only "Could not save sponsor" left the admin guessing.
  try {
    await api(`/api/sponsors/${encodeURIComponent(key)}`, { method: 'PATCH', body: JSON.stringify(fields) });
    adminToast('Sponsor updated.', 'ok');
    if ('active' in fields || 'soldOut' in fields) loadSponsorsAdmin();
    return true;
  } catch (e) { adminToast(e.message || 'Could not save sponsor.', 'error'); return false; }
}

// ─── Team (admin accounts) ────────────────────────────────────────────────────
async function loadTeam() {
  const tbody = document.getElementById('team-tbody');
  const current = latestLoad('team');          // see latestLoad
  const isOwner = currentRole === 'owner';

  // Team management (add form + per-member actions) is owner-only. Hide the
  // add-admin card for everyone else.
  const addCard = document.querySelector('.team-add-card');
  if (addCard) addCard.style.display = isOwner ? '' : 'none';

  let admins = [];
  try {
    admins = await api('/api/admins') || [];
  } catch (e) {
    if (!current()) return;
    tbody.replaceChildren();
    // An empty team table is indistinguishable from a company with no staff.
    const tr = document.createElement('tr');
    const td = document.createElement('td'); td.colSpan = 5; td.className = 'partners-empty';
    td.textContent = `Could not load the team — ${e.message}`;
    tr.appendChild(td); tbody.appendChild(tr);
    return;
  }
  if (!current()) return;                    // a newer load is drawing this table
  tbody.replaceChildren();

  admins.forEach(a => {
    const tr = document.createElement('tr');

    const name = document.createElement('td');
    const strong = document.createElement('strong'); strong.textContent = a.username;
    name.appendChild(strong);
    if (a.username === currentUser) { const you = document.createElement('span'); you.className = 'team-you'; you.textContent = ' you'; name.appendChild(you); }
    tr.appendChild(name);

    // Access tier. Shown for everyone; the owner additionally gets a control to
    // move an account between admin and sales.
    const roleCell = document.createElement('td');
    const rolePill = document.createElement('span');
    rolePill.className = 'team-role ' + (a.role || 'admin');
    rolePill.textContent = { owner: 'Owner', admin: 'Administrator', sales: 'Sales' }[a.role] || a.role || 'Administrator';
    roleCell.appendChild(rolePill);
    if (a.displayName) {
      const dn = document.createElement('div');
      dn.className = 'team-dn';
      dn.textContent = a.displayName;
      roleCell.appendChild(dn);
    }
    tr.appendChild(roleCell);

    const tfa = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = 'team-2fa ' + (a.totpEnrolled ? 'on' : 'off');
    pill.textContent = a.totpEnrolled ? 'Enrolled' : 'Not set up';
    tfa.appendChild(pill);
    tr.appendChild(tfa);

    const added = document.createElement('td');
    added.textContent = a.createdAt ? new Date(a.createdAt).toLocaleDateString('en-GB') : '—';
    tr.appendChild(added);

    const actions = document.createElement('td');
    actions.className = 'team-actions';
    // Only the owner may reset a colleague's credentials or remove them.
    if (isOwner) {
      actions.appendChild(teamBtn('Reset 2FA', () => resetMemberTotp(a.username)));
      actions.appendChild(teamBtn('New password', () => resetMemberPassword(a.username)));
      // The owner tier is never re-roled, and changing your own would drop you
      // out of the console mid-session — the server rejects both too.
      if (a.role !== 'owner' && a.username !== currentUser) {
        const to = a.role === 'sales' ? 'admin' : 'sales';
        actions.appendChild(teamBtn(a.role === 'sales' ? 'Make admin' : 'Make sales',
          () => changeMemberRole(a.username, to)));
      }
      if (a.role !== 'owner' && a.username !== currentUser && admins.length > 1) {
        actions.appendChild(teamBtn('Remove', () => removeMember(a.username), 'danger'));
      }
    } else {
      actions.textContent = '—';
    }
    tr.appendChild(actions);

    tbody.appendChild(tr);
  });
}

function teamBtn(label, onClick, kind) {
  const b = document.createElement('button');
  b.className = 'admin-btn' + (kind === 'danger' ? ' danger' : '');
  b.style.cssText = 'font-size:11px;padding:5px 10px';
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

function genPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const a = new Uint32Array(14); crypto.getRandomValues(a);
  return Array.from(a, x => chars[x % chars.length]).join('') + '!';
}

document.getElementById('team-gen-pw')?.addEventListener('click', () => {
  document.getElementById('team-password').value = genPassword();
});

// ─── Role picker ──────────────────────────────────────────────────────────────
// The sales tier needs a display name and email (they sign the rep's client
// proposals), so those fields — and the roster shortcut — only appear for it.
function selectedNewRole() {
  return document.querySelector('input[name="team-role"]:checked')?.value || 'admin';
}

function syncRoleFields() {
  const isSales = selectedNewRole() === 'sales';
  ['team-roster-field', 'team-name-field', 'team-email-field'].forEach(id =>
    document.getElementById(id)?.classList.toggle('hidden', !isSales));
  const label = document.getElementById('team-add-label');
  if (label) label.textContent = isSales ? 'Add sales member' : 'Add administrator';
}

document.querySelectorAll('input[name="team-role"]').forEach(r =>
  r.addEventListener('change', syncRoleFields));

/**
 * Fill the roster dropdown.
 *
 * This used to list nine names hard-coded in server/data/sales-team.js — the
 * same list that fed "Send to" — so it offered people who had no account and
 * omitted every rep who did. It now lists the accounts themselves, and its
 * only job is the shortcut it was always meant to be: it names the people who
 * are already on the roster, so the owner can see at a glance who is missing.
 */
function fillRoster() {
  const sel = document.getElementById('team-roster');
  if (!sel) return;
  const reps = (salesTeamCache.team || []).filter(m => m.role === 'sales');
  const opts = [Object.assign(document.createElement('option'), {
    value: '',
    textContent: reps.length ? 'Choose an existing name…' : 'No sales accounts yet',
  })];
  reps.forEach(m => {
    const o = document.createElement('option');
    o.value = m.name; o.textContent = m.email ? `${m.name} — ${m.email}` : `${m.name} (no email set)`;
    o.dataset.email = m.email || '';
    o.dataset.username = m.username || '';
    opts.push(o);
  });
  sel.replaceChildren(...opts);
}

document.getElementById('team-roster')?.addEventListener('change', (e) => {
  const opt = e.target.selectedOptions[0];
  if (!opt || !opt.value) return;
  // Usernames are constrained to lowercase letters, numbers and . _ - server-side.
  document.getElementById('team-username').value =
    (opt.dataset.username || opt.value).toLowerCase().replace(/[^a-z0-9._-]/g, '');
  document.getElementById('team-displayname').value = opt.value;
  document.getElementById('team-email').value = opt.dataset.email || '';
});

document.getElementById('team-add-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  // Guarded: the second half of a double-click was answered with a 409
  // ("that username already exists") for the account the FIRST half had just
  // created, which reads as a failure.
  return withPending(e.target.querySelector('button[type=submit]'), async () => {
    const role = selectedNewRole();
    const username = document.getElementById('team-username').value.trim();
    const password = document.getElementById('team-password').value;
    const displayName = document.getElementById('team-displayname')?.value.trim() || '';
    const email = document.getElementById('team-email')?.value.trim() || '';
    const noun = role === 'sales' ? 'Sales member' : 'Administrator';
    try {
      const data = await api('/api/admins', {
        method: 'POST', body: JSON.stringify({ username, password, role, displayName, email }),
      });
      adminToast(`${noun} "${username}" added.`, 'ok');
      showInviteCode(username, data.claim, role);
      ['team-username', 'team-password', 'team-displayname', 'team-email'].forEach(id => {
        const fld = document.getElementById(id); if (fld) fld.value = '';
      });
      const roster = document.getElementById('team-roster'); if (roster) roster.value = '';
      // The new account IS the roster now, so both the "Send to" list and the
      // roster shortcut have to be re-read — that is the whole point of the fix.
      await loadSalesTeam();
      fillRoster();
      loadTeam();
    } catch (err) { adminToast(err.message || `Could not add ${noun.toLowerCase()}.`, 'error'); }
  });
});

async function changeMemberRole(username, role) {
  const noun = role === 'sales' ? 'Sales (dashboard only)' : 'Administrator (full console)';
  if (!await confirmDialog(
    `Change "${username}" to ${noun}?\n\nThey are signed out immediately and must log in again.`,
    { title: 'Change access level', confirmLabel: 'Change it' })) return;
  try {
    await api(`/api/admins/${encodeURIComponent(username)}/role`, {
      method: 'PATCH', body: JSON.stringify({ role }),
    });
    adminToast(`"${username}" is now ${role}.`, 'ok');
    await loadSalesTeam();                 // a new rep joins the Send-to list
    fillRoster();
    loadTeam();
  } catch (e) { adminToast(e.message || 'Could not change access level.', 'error'); }
}

// Show the one-time invite code the owner must share (with the temp password)
// so the new admin can enrol 2FA on first login. Blocking + clipboard copy so
// it can't be missed.
function showInviteCode(username, code, role) {
  if (!code) return;
  try { navigator.clipboard?.writeText(code); } catch {}
  const where = role === 'sales'
    ? `They sign in at ${location.origin}/login and land on their sales dashboard.`
    : `They sign in at ${location.origin}/login.`;
  alert(
    `Invite code for "${username}":\n\n    ${code}\n\n` +
    `Give this to them WITH the temporary password (out of band — e.g. in person or a separate channel). ` +
    `They enter it on their FIRST sign-in only, before setting up their authenticator. ` +
    `It's been copied to your clipboard.\n\n${where}`
  );
}

// These three had no try/catch of any kind: a dropped connection mid-click was
// an unhandled promise rejection, with nothing on screen to say the action had
// not happened.
async function resetMemberTotp(username) {
  if (!await confirmDialog(
    `Reset two-factor authentication for "${username}"?\n\nTheir current authenticator stops working and their recovery codes are destroyed. They set it up again on their next login, using a new invite code you will be given to pass on.`,
    { title: 'Reset 2FA', confirmLabel: 'Reset it', danger: true })) return;
  try {
    const data = await api(`/api/admins/${encodeURIComponent(username)}/reset-2fa`, { method: 'POST' });
    adminToast(`2FA reset for ${username}.`, 'ok');
    showInviteCode(username, data.claim);
    loadTeam();
  } catch (e) { adminToast(e.message || 'Could not reset 2FA.', 'error'); }
}

async function resetMemberPassword(username) {
  // Was a window.prompt(): the new password appeared in clear text on screen
  // and went into the browser's dialog history. A password field does neither.
  const pw = await askSecret(
    `Set a new password for "${username}". At least 8 characters.\n\nThey are signed out immediately and will need this password — pass it to them out of band.`,
    { title: `New password for ${username}`, label: 'New password', confirmLabel: 'Set password' });
  if (pw === null) return;
  if (!pw) return adminToast('No password entered — nothing was changed.', 'error');
  try {
    await api(`/api/admins/${encodeURIComponent(username)}/password`, {
      method: 'POST', body: JSON.stringify({ password: pw }),
    });
    adminToast(`Password updated for ${username}. They have been signed out.`, 'ok');
  } catch (e) { adminToast(e.message || 'Could not update password.', 'error'); }
}

async function removeMember(username) {
  if (!await confirmDialog(
    `Remove "${username}"?\n\nTheir account is deleted and any open session ends immediately. Anything they created — proposals, audit lines — stays.`,
    { title: 'Remove this account', confirmLabel: 'Remove them', danger: true })) return;
  try {
    await api(`/api/admins/${encodeURIComponent(username)}`, { method: 'DELETE' });
    adminToast(`Removed ${username}.`, 'ok');
    await loadSalesTeam();                 // they leave the Send-to list too
    fillRoster();
    loadTeam();
  } catch (e) { adminToast(e.message || 'Could not remove that account.', 'error'); }
}

document.getElementById('analytics-refresh')?.addEventListener('click', loadAnalytics);
document.getElementById('analytics-days')?.addEventListener('change', loadAnalytics);
document.getElementById('leads-refresh')?.addEventListener('click', loadLeads);

// A new enquiry arriving live bumps the Leads badge and refreshes the list if
// it is open.
socket.on('inquiry:new', () => {
  const badge = document.getElementById('leads-badge');
  const n = (parseInt(badge.textContent, 10) || 0) + 1;
  badge.textContent = n; badge.classList.remove('hidden');
  if (document.getElementById('section-leads').classList.contains('active')) loadLeads();
  adminToast('New enquiry received.', 'ok');
});


// ─── Exhibitor tags ───────────────────────────────────────────────────────────
// The catalogue lives on the server and is pushed to every client, so a tag
// added here appears on the public floorplan (and in any other admin's browser)
// without a reload. Booths store tag KEYS; the catalogue resolves them to a
// label and colour at render time, which is what makes a rename propagate.

const MAX_BOOTH_TAGS = 3;
let tagCatalogue = [];

const tagByKey = (key) => tagCatalogue.find(t => t.key === key) || null;
const boothTags = (b) => (dealOf(b).tags || []).filter(k => tagByKey(k));

socket.on('tags:catalogue', (list) => {
  tagCatalogue = Array.isArray(list) ? list : [];
  renderTagCatalogue();
  if (selectedAdminId) renderBoothTags(selectedAdminId);
});

/** A chip painted in the tag's own colour, with readable text over it. */
function tagChip(tag, { onRemove = null } = {}) {
  const chip = document.createElement('span');
  chip.className = 'tag-chip';
  chip.style.background = tag.color;
  chip.style.color = contrastText(tag.color);
  chip.appendChild(document.createTextNode(tag.label));
  if (onRemove) {
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.title = `Remove ${tag.label}`;
    x.setAttribute('aria-label', `Remove ${tag.label}`);
    x.onclick = onRemove;
    chip.appendChild(x);
  }
  return chip;
}

// ── Tools → Business Activities ──────────────────────────────────────────────
function tagUsage(key) {
  return Object.values(booths).filter(b => (dealOf(b).tags || []).includes(key)).length;
}

/**
 * The tag list, patched in place rather than rebuilt.
 *
 * It was thrown away and rebuilt on every broadcast — which is to say whenever
 * any stand changed anywhere, because the "used on N stands" counts move with
 * the stands. A rename being typed lost its focus mid-word, and since the
 * input it was typed into no longer existed, its change never fired: the new
 * name was simply gone. Now the rows stay put while the same tags are listed,
 * and only their values and counts are brought up to date — never a field
 * someone has their cursor in. A different SET of tags is redrawn, but not
 * under somebody's hands: that waits until they leave the list.
 */
let tagListDeferred = false;

function renderTagCatalogue() {
  const box = document.getElementById('tag-list');
  if (!box) return;
  const sig = tagCatalogue.map(t => t.key).join('|');
  const rowOf = (key) => box.querySelector(`.tag-row[data-key="${CSS.escape(key)}"]`);

  if (tagCatalogue.length && box.dataset.sig === sig) {
    tagCatalogue.forEach(t => patchTagRow(rowOf(t.key), t));
    return;
  }
  if (box.contains(document.activeElement)) {
    tagListDeferred = true;
    tagCatalogue.forEach(t => patchTagRow(rowOf(t.key), t));
    return;
  }
  tagListDeferred = false;
  box.dataset.sig = sig;
  box.replaceChildren();

  if (!tagCatalogue.length) {
    const p = document.createElement('div');
    p.className = 'tag-empty';
    p.textContent = 'No tags yet. Add one above, then attach it to a booked stand from the Floorplan tab.';
    box.appendChild(p);
    return;
  }

  tagCatalogue.forEach(t => box.appendChild(buildTagRow(t)));
}

// Every handler looks the tag up by its key when it runs, so a row that has
// been patched since it was built never acts on the name it was built with.
function buildTagRow(t) {
  const key = t.key;
  const row = document.createElement('div');
  row.className = 'tag-row';
  row.dataset.key = key;

  // Recolour in place — the swatch IS the colour picker.
  const swatch = document.createElement('input');
  swatch.type = 'color';
  swatch.className = 'tag-swatch';
  swatch.onchange = () => saveTag(key, { color: swatch.value });
  row.appendChild(swatch);

  // Rename in place. Committed on blur/Enter, and reverted if the server
  // rejects it (a duplicate name), so the field never shows a name that
  // was not actually saved.
  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'admin-input tag-name';
  name.maxLength = 40;
  name.onchange = () => {
    const cur = tagByKey(key);
    if (!cur) return;
    const label = name.value.trim();
    if (!label || label === cur.label) { name.value = cur.label; return; }
    saveTag(key, { label }, () => { name.value = (tagByKey(key) || cur).label; });
  };
  name.onkeydown = (e) => { if (e.key === 'Enter') name.blur(); };
  row.appendChild(name);

  const used = document.createElement('span');
  used.className = 'tag-uses';
  row.appendChild(used);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'admin-btn danger';
  del.textContent = 'Delete';
  del.onclick = () => deleteTag(tagByKey(key) || t, tagUsage(key));
  row.appendChild(del);

  patchTagRow(row, t);
  return row;
}

function patchTagRow(row, t) {
  if (!row) return;
  const swatch = row.querySelector('.tag-swatch');
  const name = row.querySelector('.tag-name');
  if (swatch && document.activeElement !== swatch && swatch.value !== t.color) swatch.value = t.color;
  if (swatch) swatch.title = `Colour for ${t.label}`;
  if (name && document.activeElement !== name && name.value !== t.label) name.value = t.label;
  const uses = tagUsage(t.key);
  const used = row.querySelector('.tag-uses');
  if (used) used.textContent = uses ? `${uses} stand${uses === 1 ? '' : 's'}` : 'unused';
}

// Whatever was put off while someone was editing is drawn the moment they leave.
document.getElementById('tag-list')?.addEventListener('focusout', () => {
  setTimeout(() => {
    const box = document.getElementById('tag-list');
    if (tagListDeferred && box && !box.contains(document.activeElement)) renderTagCatalogue();
  }, 0);
});

document.getElementById('tag-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('tag-label');
  const label = input.value.trim();
  if (!label) return adminToast('Give the tag a name first.', 'error');

  socket.emit('tags:create', { label, color: document.getElementById('tag-color').value }, (res) => {
    if (res && res.ok) {
      input.value = '';
      adminToast(`Tag "${res.tag.label}" added.`, 'ok');
    } else {
      adminToast((res && res.error) || 'Could not add that tag.', 'error');
    }
  });
});

function saveTag(key, fields, onFail) {
  socket.emit('tags:update', { key, ...fields }, (res) => {
    if (!res || !res.ok) {
      adminToast((res && res.error) || 'Could not update that tag.', 'error');
      if (onFail) onFail();
    }
  });
}

function deleteTag(tag, uses) {
  const warn = uses
    ? `Delete "${tag.label}"? It will be removed from ${uses} stand${uses === 1 ? '' : 's'}.`
    : `Delete "${tag.label}"?`;
  if (!confirm(warn)) return;
  socket.emit('tags:delete', { key: tag.key }, (res) => {
    if (res && res.ok) adminToast(`Tag "${tag.label}" deleted.`, 'ok');
    else adminToast((res && res.error) || 'Could not delete that tag.', 'error');
  });
}

// ── Settings: every event and the plan it is drawn from ─────────────────────
// Shown side by side rather than one at a time. The point of the page is to
// answer "which events have artwork and which are still empty" at a glance,
// which a per-event view cannot do.
async function loadPlans() {
  const grid = document.getElementById('plans-grid');
  if (!grid) return;

  let rows = [];
  try {
    rows = await api('/api/floorplans') || [];
  } catch (e) {
    // "No events yet" was shown for a failed request as readily as for an empty
    // system — and this deployment has never had zero events.
    grid.textContent = `Could not load the events — ${e.message}`;
    return;
  }

  grid.replaceChildren();
  const here = (window.__SHOW && window.__SHOW.slug) || '';
  // Events on air first; retired ones after them, so past years gather at the
  // end of the page instead of between the events being sold now.
  const ordered = [...rows.filter(r => r.active !== false), ...rows.filter(r => r.active === false)];
  ordered.forEach(row => grid.appendChild(planCard(row, row.slug === here)));
  // The way to the next one — a new year of an event, or a new location.
  grid.appendChild(addEventCard(rows));
}

/**
 * Add an event from the page that lists them.
 *
 * It lived only under Tools → Events, and started every event empty: no rate,
 * no currency, no colours, no packages. A new year of an event sells the way
 * the last one did, so it can START FROM one — taking its configuration and
 * none of its trading. See server/services/new-event.js for exactly what moves.
 */
function addEventCard(rows) {
  const card = document.createElement('div');
  card.className = 'plan-card plan-add';

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'plan-add-open';
  open.innerHTML = '<span class="plan-add-plus"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></span><span><b>Add an event</b>' +
    '<small>A new year, a new show or a new location — with its own link</small></span>';

  // Creating an event is owner-only on the server. Saying so here beats a form
  // that is filled in and then refused.
  if (currentRole && currentRole !== 'owner') {
    open.disabled = true;
    open.querySelector('small').textContent = 'Only the owner account can add events.';
    card.appendChild(open);
    return card;
  }

  const form = document.createElement('form');
  form.className = 'plan-add-form';
  form.hidden = true;
  form.innerHTML = `
    <div class="plan-add-title">Add an event</div>
    <label>Start from
      <select class="admin-select" name="copyFrom">
        <option value="">A blank event</option>
      </select>
    </label>
    <div class="plan-add-copies"></div>
    <label>Name
      <input class="admin-input" name="name" maxlength="80" placeholder="e.g. Lubricant Expo Europe 2028" autocomplete="off">
    </label>
    <div class="plan-add-pair">
      <label>Show id
        <input class="admin-input" name="showId" maxlength="32" placeholder="LEX28" autocomplete="off">
      </label>
      <label>URL name
        <input class="admin-input" name="slug" maxlength="24" placeholder="lex28" autocomplete="off">
      </label>
    </div>
    <div class="plan-add-link"></div>
    <p class="settings-hint">The show id is permanent — every stand, lead and setting is filed under it. The name and URL name can be changed later under Tools → Events.</p>
    <div class="plan-draft-actions">
      <button type="submit" class="admin-btn primary">Add event</button>
      <button type="button" class="admin-btn" data-cancel>Cancel</button>
    </div>`;

  const f = (n) => form.elements[n];
  rows.filter(r => r.active !== false).forEach(r => {
    const o = document.createElement('option');
    o.value = r.showId;
    o.textContent = r.name || r.showId;
    f('copyFrom').appendChild(o);
  });

  // The URL name follows the show id until someone types their own.
  let slugTouched = false;
  const linkLine = form.querySelector('.plan-add-link');
  const showLink = () => {
    const slug = f('slug').value.trim();
    linkLine.textContent = slug ? `Visitors' link: /floorplan/${slug}` : '';
  };
  f('showId').addEventListener('input', () => {
    if (!slugTouched) f('slug').value = f('showId').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
    showLink();
  });
  f('slug').addEventListener('input', () => { slugTouched = true; showLink(); });

  // Choosing an event to start from suggests the next edition of it: LEX27 is
  // followed by LEX28, read from the name its live plan carries, or from the
  // event's own id where that carries the year (LEX26, LNA27). The next
  // edition that does not exist yet, that is: counting one on from LEX26 while
  // LEX27 is already running suggested the very event already on this page —
  // and the add was refused. An edition counts as taken when an event's id, its
  // URL name or its plan's name already says it.
  const copies = form.querySelector('.plan-add-copies');
  const taken = new Set();
  rows.forEach(r => [r.showId, r.slug, r.label && String(r.label).replace(/\.\d+$/, '')]
    .forEach(v => { if (v) taken.add(String(v).toUpperCase()); }));
  const EDITION = /^([A-Za-z]+)(\d{2}|\d{4})(?!\d)/;
  const nextEdition = (src) => {
    const m = EDITION.exec(src.label || '') || EDITION.exec(src.showId || '');
    if (!m) return null;
    const width = m[2].length;
    let n = Number(m[2]), id;
    do { n += 1; id = `${m[1].toUpperCase()}${String(n).padStart(width, '0')}`; } while (taken.has(id) && n < 10 ** width - 1);
    return { id, year: width === 4 ? String(n) : `20${String(n).padStart(2, '0')}` };
  };
  // "Lubricant Expo Europe 2027" becomes "… 2028", not "… 2027 2028".
  const YEAR_AT_END = /\b(?:19|20)\d{2}(\s*)$/;
  const nameFor = (src, year) => {
    const base = src.name || src.showId;
    return YEAR_AT_END.test(base) ? base.replace(YEAR_AT_END, `${year}$1`).trim() : `${base} ${year}`;
  };
  // What was suggested last, so a different choice replaces it — but never
  // something the person typed themselves.
  let suggested = { id: '', name: '' };
  f('copyFrom').addEventListener('change', () => {
    const src = rows.find(r => r.showId === f('copyFrom').value);
    if (!src) { copies.textContent = ''; return; }
    copies.textContent = `Copies its rate, currency, units, colours, business activities and sponsorship packages. ` +
                         'Not its stands, bookings, leads or plan — upload the new plan to the new event.';
    const next = nextEdition(src);
    const idFree = !f('showId').value || f('showId').value === suggested.id;
    const nameFree = !f('name').value || f('name').value === suggested.name;
    if (next && idFree) {
      f('showId').value = next.id;
      f('showId').dispatchEvent(new Event('input'));
      if (nameFree) f('name').value = nameFor(src, next.year);
      suggested = { id: next.id, name: f('name').value };
    } else if (nameFree) {
      f('name').value = src.name || '';
      suggested = { id: suggested.id, name: f('name').value };
    }
  });

  open.onclick = () => { open.hidden = true; form.hidden = false; f('copyFrom').focus(); };
  form.querySelector('[data-cancel]').onclick = () => { form.reset(); slugTouched = false; suggested = { id: '', name: '' }; copies.textContent = ''; showLink(); form.hidden = true; open.hidden = false; };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    return withPending(form.querySelector('button[type=submit]'), async () => {
      const body = {
        name: f('name').value.trim(),
        showId: f('showId').value.trim(),
        slug: f('slug').value.trim().toLowerCase(),
        copyFrom: f('copyFrom').value || undefined,
      };
      if (!body.showId || !body.slug) return adminToast('A show id and a URL name are both needed.', 'error');
      let r;
      try {
        r = await api('/api/shows', { method: 'POST', body: JSON.stringify(body) });
      } catch (err) {
        return adminToast(err.message || 'Could not add that event.', 'error');
      }
      const c = r.copied;
      adminToast(`${r.name || r.showId} added — visitors' link /floorplan/${r.slug}.` +
        (c && c.failed ? ' Its settings could NOT be copied — set them by hand.'
         : c ? ` Copied: settings, ${c.activities} ${c.activities === 1 ? 'activity' : 'activities'}, ` +
               `${c.packages} ${c.packages === 1 ? 'package' : 'packages'}.` : '') +
        ' Upload its plan from its card.', 'ok');
      await loadPlans();
      initShowSwitcher();
      loadShows();
    });
  });

  card.append(open, form);
  return card;
}

/** A retired event: kept, listed, and answering 404 to visitors. */
const offAir = (row) => row.active === false;

function planCard(row, isCurrent) {
  const card = document.createElement('div');
  card.className = 'plan-card' + (isCurrent ? ' is-current' : '');

  const head = document.createElement('div');
  head.className = 'plan-head';
  const name = document.createElement('span');
  name.className = 'plan-name';
  name.textContent = row.name || row.showId;
  head.appendChild(name);
  // Which revision of the plan the public link is showing: LEX27, LEX27.1 …
  if (row.label) {
    const lbl = document.createElement('span');
    lbl.className = 'plan-label';
    lbl.textContent = row.label;
    lbl.title = 'The version of the plan visitors see now. The public link never changes.';
    head.appendChild(lbl);
  }
  if (isCurrent) {
    const badge = document.createElement('span');
    badge.className = 'plan-badge';
    badge.textContent = 'Viewing';
    head.appendChild(badge);
  }
  if (row.active === false) {
    card.classList.add('is-retired');
    const badge = document.createElement('span');
    badge.className = 'plan-badge is-retired';
    badge.textContent = 'Retired';
    badge.title = 'Off the air: its links answer 404. Nothing is deleted — put it back under Tools → Events.';
    head.appendChild(badge);
  }

  // The preview is an <img>, not inline SVG: an image cannot run anything, so
  // even an unsanitised plan could not execute here. It is also why the ground
  // is light — the artwork is drawn for paper.
  const preview = document.createElement('img');
  preview.className = 'plan-preview';
  preview.loading = 'lazy';
  preview.alt = `${row.name || row.showId} floorplan`;
  preview.src = `/floorplan.svg?show=${encodeURIComponent(row.slug)}&v=${row.uploadedAt || 'shipped'}`;
  preview.onerror = () => {
    const ph = document.createElement('div');
    ph.className = 'plan-preview-empty';
    ph.textContent = 'Could not load this plan';
    preview.replaceWith(ph);
  };

  const meta = document.createElement('div');
  meta.className = 'plan-meta';
  const kb = row.bytes ? ` · ${(row.bytes / 1024).toFixed(0)} KB` : '';
  const stands = row.boothCount > 0 ? ` · ${row.boothCount} stands` : '';
  meta.textContent = row.uploaded
    ? `${row.filename}${kb} · uploaded ${new Date(row.uploadedAt).toLocaleDateString('en-GB')}${stands}`
    : `Using the plan shipped with the app${stands}`;

  // The artwork check. Shown only where a plan was uploaded — the shipped
  // artwork belongs to a running show and is deliberately not scored.
  let specLine = null;
  if (row.spec) {
    specLine = document.createElement('div');
    const clean = row.spec.passed === row.spec.total;
    specLine.className = 'plan-spec' + (clean ? ' is-clean' : '');
    specLine.textContent = clean
      ? `Artwork check: ${row.spec.passed}/${row.spec.total} — meets the specification`
      : `Artwork check: ${row.spec.passed}/${row.spec.total} — see ${row.spec.failedClauses.join(', ')}`;
    specLine.title = 'Specification BEC-FP-01. This is a report, not a gate — the plan is used either way.';
  }

  const actions = document.createElement('div');
  actions.className = 'plan-actions';

  const up = document.createElement('button');
  up.type = 'button';
  up.className = 'admin-btn';
  // A new file never replaces the plan outright: it lands as a draft beside
  // the live one, and goes live only from the check that follows.
  up.textContent = row.uploaded ? 'New version' : 'Upload';
  up.title = 'Uploaded as a draft. Visitors keep seeing the live plan until you make the draft live.';
  up.onclick = () => pickPlan(row);

  const dl = document.createElement('a');
  dl.className = 'admin-btn';
  // The file as it was uploaded, names and all — not the copy the public page
  // is served, which has had them taken out.
  dl.href = `/floorplan.svg?show=${encodeURIComponent(row.slug)}&original=1`;
  dl.setAttribute('download', `${row.slug}-floorplan.svg`);
  dl.textContent = 'Download';

  const rm = document.createElement('button');
  rm.type = 'button';
  rm.className = 'admin-btn danger';
  rm.textContent = 'Remove';
  rm.hidden = !row.uploaded;          // nothing uploaded, nothing to remove
  rm.onclick = () => removePlan(row);

  // Reading the plan is only offered where there is a plan to read.
  const imp = document.createElement('button');
  imp.type = 'button';
  imp.className = 'admin-btn';
  imp.textContent = 'Read stands';
  imp.hidden = !row.uploaded;
  imp.onclick = () => previewStands(row);

  // The colours this event's spaces are painted in — every event, uploaded or
  // not, because Europe's shipped plan is coloured too.
  const col = document.createElement('button');
  col.type = 'button';
  col.className = 'admin-btn';
  col.textContent = 'Colours';
  col.onclick = () => openPalettePanel(row);

  // The layout as it stands NOW, to send the designer before they redraw.
  // Their last file does not know about a stand this console has since merged,
  // split or renumbered, so a re-issue drawn from it comes back undoing all of
  // it — and the diff reports those as sold stands that have moved or gone.
  // Offered only where there are stands to schedule.
  const sch = document.createElement('button');
  sch.type = 'button';
  sch.className = 'admin-btn';
  sch.textContent = 'Stand schedule';
  sch.title = 'The current stands as a CSV — send this to the designer with the brief before a plan is redrawn.';
  sch.hidden = !row.boothCount;
  sch.onclick = () => downloadSchedule(row, sch);

  // Every plan this event has been given, and the way back to any of them —
  // offered whenever there IS one. It hid itself as soon as nothing was
  // uploaded, which is exactly what Remove leaves behind; and Remove keeps the
  // old plan as an earlier version precisely so it can be put back. The only
  // way back went with it. The listing may say how many versions there are;
  // where it does not, the event is asked.
  const ver = document.createElement('button');
  ver.type = 'button';
  ver.className = 'admin-btn';
  ver.textContent = 'Versions';
  ver.hidden = typeof row.revisions === 'number' ? row.revisions === 0 : (!row.uploaded && !row.draft);
  if (ver.hidden && typeof row.revisions !== 'number') {
    api('/api/floorplan/revisions', { headers: { 'X-Show': row.slug } })
      .then(list => { if (Array.isArray(list) && list.length) ver.hidden = false; })
      .catch(() => { /* nothing to offer, as before */ });
  }
  ver.onclick = () => openRevisions(row);

  actions.append(up, dl, imp, ver, col, sch, rm);

  const parts = [head, preview, meta];
  // A retired event's controls act on THAT event — its plan, its colours, its
  // stands — and nobody sees any of it until it is back on air. Said on the
  // card itself and not only in the badge's tooltip, because every button
  // below otherwise reads exactly as it does on an event that is selling.
  if (offAir(row)) {
    const note = document.createElement('div');
    note.className = 'plan-retired-note';
    note.textContent = `Off the air: /floorplan/${row.slug} answers 404. Anything changed on this card is changed ` +
      `on ${row.name || row.showId} itself, and visitors see it once the event is put back on air under Tools → Events.`;
    parts.push(note);
  }
  if (specLine) parts.push(specLine);
  if (row.draft) parts.push(draftPanel(row));
  // Only where there is something to lose.
  if (row.boothCount > 0 && !row.draft) {
    const warn = document.createElement('div');
    warn.className = 'plan-warn';
    warn.textContent = `${row.boothCount} stands are positioned against this plan. A new version is uploaded as a draft: you see what it does to them, and make it live with their bookings kept. Visitors see no change until then.`;
    parts.push(warn);
  }
  parts.push(actions);
  card.append(...parts);
  return card;
}

/**
 * The upload waiting to go live, on the card of the event it belongs to.
 *
 * Its own preview beside the live one, so the two drawings can be compared
 * before anyone commits, and the one button that matters: check it against
 * the stands, which is where it is made live from.
 */
function draftPanel(row) {
  const d = row.draft;
  const box = document.createElement('div');
  box.className = 'plan-draft';

  const head = document.createElement('div');
  head.className = 'plan-draft-head';
  const t = document.createElement('strong');
  t.textContent = `Draft ${d.label}`;
  const chip = document.createElement('span');
  chip.className = 'plan-draft-chip';
  chip.textContent = 'Not live yet';
  head.append(t, chip);

  const img = document.createElement('img');
  img.className = 'plan-preview is-draft';
  img.loading = 'lazy';
  img.alt = `Draft ${d.label}`;
  img.src = `/api/floorplan/revisions/${encodeURIComponent(d.revisionId)}/svg`;

  const meta = document.createElement('div');
  meta.className = 'plan-meta';
  const kb = d.bytes ? ` · ${(d.bytes / 1024).toFixed(0)} KB` : '';
  meta.textContent = `${d.filename}${kb} · uploaded ${new Date(d.uploadedAt).toLocaleDateString('en-GB')}` +
                     (d.uploadedBy ? ` by ${d.uploadedBy}` : '') +
                     (d.spec ? ` · artwork check ${d.spec.passed}/${d.spec.total}` : '');

  const acts = document.createElement('div');
  acts.className = 'plan-draft-actions';
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'admin-btn primary';
  go.textContent = 'Check & make live';
  go.title = 'Read this draft against the stands on the event, then make it live with every booking kept.';
  go.onclick = () => previewStands(row, { revision: d });
  const drop = document.createElement('button');
  drop.type = 'button';
  drop.className = 'admin-btn';
  drop.textContent = 'Discard';
  drop.title = 'Set this draft aside. It is kept under Versions; the live plan is not touched.';
  drop.onclick = () => discardDraft(row, d);
  acts.append(go, drop);

  box.append(head, img, meta, acts);
  return box;
}

async function discardDraft(row, rev) {
  if (!await confirmDialog(
    `Set ${rev.label} aside? Visitors never saw it, and it stays listed under Versions if you want it later.`,
    { title: `Discard draft ${rev.label}`, confirmLabel: 'Discard it' })) return;
  try {
    await api(`/api/floorplan/revisions/${encodeURIComponent(rev.revisionId)}/discard`, {
      method: 'POST', headers: { 'X-Show': row.slug },
    });
    adminToast(`${rev.label} discarded — the live plan is unchanged.`, 'ok');
  } catch (e) {
    adminToast(e.message || 'Could not discard that draft.', 'error');
  }
  document.getElementById('stand-report')?.remove();
  loadPlans();
}

/**
 * Every version of an event's plan, newest first, with the way back to each.
 *
 * Making an old version live again runs through exactly the same check as a
 * new draft: what it does to the stands is read first, and bookings are kept.
 */
const REVISION_STATUS = { live: 'Live', draft: 'Draft', superseded: 'Earlier', discarded: 'Discarded' };

async function openRevisions(row) {
  document.getElementById('revisions-panel')?.remove();
  let list;
  try {
    list = await api('/api/floorplan/revisions', { headers: { 'X-Show': row.slug } });
  } catch (e) {
    return adminToast(`Could not load the versions — ${e.message}`, 'error');
  }

  const box = document.createElement('div');
  box.id = 'revisions-panel';
  box.className = 'spec-report';
  const head = document.createElement('div');
  head.className = 'spec-report-head';
  head.append(Object.assign(document.createElement('strong'),
    { textContent: `${row.name || row.showId} — versions of the plan` }));
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'admin-btn'; close.textContent = 'Close';
  close.onclick = () => box.remove();
  head.appendChild(close);

  const note = document.createElement('p');
  note.className = 'spec-report-note';
  note.textContent = `Visitors always use the same link — /floorplan/${row.slug} — and see whichever version is live.`;

  const table = document.createElement('div');
  table.className = 'revision-list';
  if (!list.length) table.textContent = 'Nothing uploaded yet — this event shows the plan shipped with the app.';
  const when = (d) => d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  list.forEach(rev => {
    const r = document.createElement('div');
    r.className = 'revision-row is-' + rev.status;
    const name = document.createElement('span');
    name.className = 'revision-label';
    name.textContent = rev.label;
    const st = document.createElement('span');
    st.className = 'revision-status';
    st.textContent = REVISION_STATUS[rev.status] || rev.status;
    const info = document.createElement('span');
    info.className = 'revision-info';
    info.textContent = `${rev.filename} · uploaded ${when(rev.uploadedAt)}${rev.uploadedBy ? ` by ${rev.uploadedBy}` : ''}` +
      (rev.publishedAt && rev.status !== 'draft' ? ` · live from ${when(rev.publishedAt)}` : '');

    const acts = document.createElement('span');
    acts.className = 'revision-actions';
    const view = document.createElement('a');
    view.className = 'admin-btn';
    view.href = `/api/floorplan/revisions/${encodeURIComponent(rev.revisionId)}/svg`;
    view.target = '_blank';
    view.rel = 'noopener';
    view.textContent = 'View';
    const dl = document.createElement('a');
    dl.className = 'admin-btn';
    dl.href = `/api/floorplan/revisions/${encodeURIComponent(rev.revisionId)}/svg?original=1`;
    dl.setAttribute('download', `${rev.label}.svg`);
    dl.textContent = 'Download';
    acts.append(view, dl);
    if (rev.status !== 'live') {
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'admin-btn' + (rev.status === 'draft' ? ' primary' : '');
      go.textContent = rev.status === 'draft' ? 'Check & make live' : 'Make live again';
      go.onclick = () => { box.remove(); previewStands(row, { revision: rev }); };
      acts.appendChild(go);
    }
    r.append(name, st, info, acts);
    table.appendChild(r);
  });

  box.append(head, note, table);
  document.getElementById('section-settings')?.prepend(box);
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * Download this event's stands as the schedule specification BEC-FP-01 asks a
 * designer to send back with a drawing.
 *
 * Fetched rather than linked because the event is named in the X-Show header,
 * which an <a href> cannot send — a plain link would hand over the DEFAULT
 * event's stands under this event's filename, which is worse than no link.
 */
async function downloadSchedule(row, btn) {
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Preparing…';
  try {
    const res = await fetch('/api/stands/schedule.csv', { headers: { 'X-Show': row.slug } });
    if (res.status === 401) {
      location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
      return;
    }
    if (!res.ok) throw new Error(`Could not build the schedule (${res.status}).`);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `${row.slug}-stand-schedule-${csvDate()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked on a delay: revoking in the same tick cancels the download in
    // Safari, which reads the blob after the click returns.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    adminToast(`Stand schedule downloaded — send it to the designer with the brief.`, 'ok');
  } catch (e) {
    adminToast(e.message || 'Could not build the schedule.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = was;
  }
}

/**
 * The artwork report for a plan that has just been uploaded.
 *
 * The plan is already stored — this is not a rejection. It exists because the
 * spec's own value is being able to hand a designer the exact clauses to fix,
 * so the text is written to be forwarded as it stands.
 */
function showSpecReport(eventName, spec) {
  document.getElementById('spec-report')?.remove();

  const lines = (spec.results || []).map(r =>
    `  ${r.ok ? 'PASS' : 'FAIL'}  [${r.clause}] ${r.name}${r.detail ? '\n        ' + r.detail : ''}`).join('\n');
  const text = `Artwork validation — ${eventName}\n`
             + `Specification ${spec.spec || 'BEC-FP-01'}\n\n${lines}\n\n`
             + `${spec.passed}/${spec.total} checks passed\n`
             + `Clauses to correct: ${spec.failedClauses.join(', ')}`;

  const box = document.createElement('div');
  box.id = 'spec-report';
  box.className = 'spec-report';

  const head = document.createElement('div');
  head.className = 'spec-report-head';
  const title = document.createElement('strong');
  title.textContent = `${eventName} — artwork check ${spec.passed}/${spec.total}`;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'admin-btn';
  close.textContent = 'Close';
  close.onclick = () => box.remove();
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'admin-btn';
  copy.textContent = 'Copy for the designer';
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(text); adminToast('Report copied.', 'ok'); }
    catch { adminToast('Could not copy — select the text and copy it.', 'error'); }
  };
  head.append(title, copy, close);

  const note = document.createElement('p');
  note.className = 'spec-report-note';
  note.textContent = 'The plan has been saved and is in use. This is what to send whoever produced the artwork, together with the ';
  const brief = document.createElement('a');
  brief.href = '/artwork-brief'; brief.target = '_blank'; brief.rel = 'noopener';
  brief.textContent = 'designer brief';
  note.append(brief, '.');

  const pre = document.createElement('pre');
  pre.className = 'spec-report-body';
  pre.textContent = text;

  box.append(head, note, pre);
  document.getElementById('section-settings')?.prepend(box);
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Settings: the colours an event's spaces are painted in ───────────────────
// Five colours: a stand available, taken and on hold, and a sponsorable area
// open and taken. The picker starts from whatever the plan is drawn in, shows
// what each colour on the plan currently reads as, and saves per event. A
// colour left as "app default" means the app's own — which is what Europe has
// always used.
const PALETTE_ROWS = [
  { key: 'available', label: 'Stand — available',   hint: 'An empty stand a visitor can enquire about.', fallback: '#ffffff' },
  { key: 'sold',      label: 'Stand — taken',       hint: 'A stand that has been sold.',                 fallback: '#fcdf6d' },
  { key: 'held',      label: 'Stand — on hold',     hint: 'Reserved for 24 hours, or by the plan. The app\'s orange unless you choose otherwise.', fallback: '#f97316' },
  { key: 'sponsored', label: 'Area — open',         hint: 'A lounge, theatre or track still available to sponsor. Painted only once you choose a colour; until then it keeps the plan\'s own.', fallback: '#fcdf6d' },
  { key: 'areaTaken', label: 'Area — sponsored',    hint: 'An area a sponsor has taken.',              fallback: '#fcdf6d' },
];

async function openPalettePanel(row, { fresh = false } = {}) {
  document.getElementById('palette-panel')?.remove();
  const where = row.name || row.showId;

  let info;
  try {
    info = await api('/api/palette', { headers: { 'X-Show': row.slug } });
  } catch (e) {
    return adminToast(`Could not read ${where}'s colours — ${e.message}`, 'error');
  }
  const current = info.palette || null;
  const suggested = info.fromArtwork || null;
  // What each row starts on: the colour in force, else the plan's own, else
  // the app's. Whether it is "set" is what decides if it is saved.
  const state = {};
  PALETTE_ROWS.forEach(r => {
    state[r.key] = { value: (current && current[r.key]) || (suggested && suggested[r.key]) || r.fallback,
                     set: !!(current && current[r.key]) };
  });

  const box = document.createElement('div');
  box.id = 'palette-panel';
  box.className = 'spec-report palette-panel';

  const head = document.createElement('div');
  head.className = 'spec-report-head';
  const title = document.createElement('strong');
  title.textContent = `${where} — colours`;
  head.append(title);

  const note = document.createElement('p');
  note.className = 'spec-report-note';
  note.textContent = fresh
    ? 'The plan is uploaded. Choose what each kind of space is painted in — these start from the colours the plan is drawn in. The plan sponsor\'s own colour is set under Sponsors.'
    : current && current.source === 'admin'
      ? 'These colours were chosen here and will not be changed by re-reading the plan. The plan sponsor\'s own colour is set under Sponsors.'
      : current
        ? 'These are the colours read from the plan. Change any of them and your choice will stick, even if the plan is re-read.'
        : 'This event uses the app\'s own colours. Choose any to paint this event differently; leave the rest as they are.';

  const grid = document.createElement('div');
  grid.className = 'palette-grid';
  PALETTE_ROWS.forEach(r => {
    const rowEl = document.createElement('div');
    rowEl.className = 'palette-row';
    const lab = document.createElement('label');
    lab.className = 'palette-label';
    lab.textContent = r.label;
    const hint = document.createElement('div');
    hint.className = 'palette-hint';
    hint.textContent = r.hint;
    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'palette-input';
    input.value = state[r.key].value;
    input.setAttribute('data-palette-key', r.key);
    input.setAttribute('aria-label', r.label);
    const status = document.createElement('span');
    status.className = 'palette-status';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'admin-btn palette-clear';
    clear.textContent = 'App default';
    clear.title = 'Use the app\'s own colour for this';
    const paint = () => {
      status.textContent = state[r.key].set ? input.value : 'app default';
      rowEl.classList.toggle('is-set', state[r.key].set);
    };
    input.oninput = () => { state[r.key] = { value: input.value, set: true }; paint(); };
    clear.onclick = () => { state[r.key] = { value: r.fallback, set: false }; input.value = r.fallback; paint(); };
    paint();
    const controls = document.createElement('div');
    controls.className = 'palette-controls';
    controls.append(input, status, clear);
    rowEl.append(lab, hint, controls);
    grid.appendChild(rowEl);
  });

  // What the plan itself uses, so the choice can be made against the drawing.
  let swatches = null;
  if (info.fills && info.fills.length) {
    swatches = document.createElement('div');
    swatches.className = 'palette-swatches';
    const cap = document.createElement('div');
    cap.className = 'palette-hint';
    cap.textContent = 'Colours on the plan and what each reads as — click one to copy it into the matching row:';
    swatches.appendChild(cap);
    info.fills.forEach(f => {
      if (!f.fill) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'palette-swatch';
      const key = f.sponsored ? 'sponsored' : f.status;
      const dot = document.createElement('span');
      dot.className = 'palette-swatch-dot';
      dot.style.background = f.fill;
      b.append(dot, `${f.fill} · ${f.count} · ${f.sponsored ? 'area' : f.status}`);
      b.title = `Use ${f.fill} for "${(PALETTE_ROWS.find(r => r.key === key) || {}).label || key}"`;
      b.onclick = () => {
        const input = grid.querySelector(`[data-palette-key="${key}"]`);
        if (!input) return;
        input.value = f.fill;
        input.dispatchEvent(new Event('input'));
      };
      swatches.appendChild(b);
    });
  }

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'admin-btn primary';
  save.textContent = 'Save colours';
  save.onclick = (e) => withPending(e.currentTarget, async () => {
    const palette = {};
    PALETTE_ROWS.forEach(r => { palette[r.key] = state[r.key].set ? state[r.key].value : null; });
    try {
      await api('/api/palette', { method: 'PUT', headers: { 'X-Show': row.slug }, body: JSON.stringify({ palette }) });
      adminToast(`${where}: colours saved.`, 'ok');
      box.remove();
    } catch (err) { adminToast(err.message || 'Could not save the colours.', 'error'); }
  });

  const usePlan = document.createElement('button');
  usePlan.type = 'button';
  usePlan.className = 'admin-btn';
  usePlan.textContent = 'Use the plan\'s colours';
  usePlan.title = 'Read the colours off the plan and use those. On hold stays the app\'s orange; the areas keep the plan\'s own fills.';
  usePlan.hidden = !suggested;
  usePlan.onclick = (e) => withPending(e.currentTarget, async () => {
    try {
      await api('/api/palette', { method: 'PUT', headers: { 'X-Show': row.slug }, body: JSON.stringify({ use: 'artwork' }) });
      adminToast(`${where}: using the plan's own colours.`, 'ok');
      box.remove();
    } catch (err) { adminToast(err.message || 'Could not set the colours.', 'error'); }
  });

  const useApp = document.createElement('button');
  useApp.type = 'button';
  useApp.className = 'admin-btn';
  useApp.textContent = 'Use the app\'s colours';
  useApp.onclick = (e) => withPending(e.currentTarget, async () => {
    try {
      await api('/api/palette', { method: 'PUT', headers: { 'X-Show': row.slug }, body: JSON.stringify({ use: 'app' }) });
      adminToast(`${where}: using the app's own colours.`, 'ok');
      box.remove();
    } catch (err) { adminToast(err.message || 'Could not set the colours.', 'error'); }
  });

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'admin-btn';
  close.textContent = 'Close';
  close.onclick = () => box.remove();
  head.append(save, usePlan, useApp, close);

  box.append(head, note, grid);
  if (swatches) box.appendChild(swatches);
  document.getElementById('section-settings')?.prepend(box);
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * Show what an event's artwork says its stands are, and offer to import them.
 *
 * Deliberately two steps. Reading is free and reversible; importing replaces
 * every stand on the event, so it happens only after someone has seen the
 * numbers and typed the admin password.
 */
async function previewStands(row, { revision = null } = {}) {
  document.getElementById('stand-report')?.remove();
  adminToast(`Reading ${revision ? revision.label : row.name || row.showId}…`);

  let p;
  try {
    // A revision that is not live is read against the stands as they are now —
    // nothing changes until it is made live from the button below.
    const q = revision ? `?revision=${encodeURIComponent(revision.revisionId)}` : '';
    p = await api(`/api/stands/preview${q}`, { headers: { 'X-Show': row.slug } });
  } catch (e) {
    return adminToast(`Could not read the floorplan — ${e.message}`, 'error');
  }
  if (!p.ok) return adminToast(p.message || 'No floorplan to read for this event.', 'error');
  if (!p.stands) {
    return adminToast('No stands could be read — the plan\'s text may have been converted to outlines.', 'error');
  }

  const unit = p.unit === 'sqft' ? 'ft²' : 'm²';
  const box = document.createElement('div');
  box.id = 'stand-report';
  box.className = 'spec-report';

  const head = document.createElement('div');
  head.className = 'spec-report-head';
  const title = document.createElement('strong');
  title.textContent = revision
    ? `${row.name || row.showId} — ${revision.label} (not live yet): ${p.stands} stands readable`
    : `${row.name || row.showId} — ${p.stands} stands readable`;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'admin-btn';
  close.textContent = 'Close';
  close.onclick = () => box.remove();
  head.append(title);

  const st = p.byStatus || {};
  const d = p.diff || null;
  const ds = (d && d.summary) || {};
  const note = document.createElement('p');
  note.className = 'spec-report-note';
  note.textContent =
    `${st.available || 0} available, ${st.sold || 0} sold, ${st.held || 0} on hold` +
    ` — read from the colours the plan is drawn in. ` +
    (p.sponsored
      ? `${p.sponsored} sponsorable areas (${(p.areas || []).join(', ')}) are left in the artwork, not imported as stands. `
      : '') +
    `${p.totalArea.toLocaleString()} ${unit} in total. ` +
    (p.existing
      ? `This event has ${p.existing} stands now: against this plan, ${ds.added || 0} new, ${ds.moved || 0} moved, ` +
        `${ds.resized || 0} resized, ${ds.unchanged || 0} unchanged, ` +
        (ds.absorbed ? `${ds.absorbed} inside merged blocks, ` : '') + `${ds.missing || 0} no longer drawn` +
        (ds.committedMissing ? ` — ${ds.committedMissing} of them sold or on hold` : '') + '. '
      : '') +
    'Exhibitor names become ours: drawn in our own type, searchable, and editable here.';

  // The stands the drawing drops that somebody has sold: the one thing that
  // must not be scrolled past, so it is its own line, in the warning colour.
  let dropped = null;
  if (d && ds.committedMissing) {
    dropped = document.createElement('p');
    dropped.className = 'plan-warn stand-report-dropped';
    dropped.textContent = 'Not drawn on this plan but sold or on hold here: ' +
      d.missing.filter(m => m.committed)
        .map(m => `${m.boothNumber}${m.company ? ` (${m.company})` : ''}`).join(', ') +
      '. They are kept exactly as they are, but will not appear on the map until the drawing puts them back. ' +
      'If they have been renumbered, renumber them here (Tools → Renumber) before updating.';
  }

  const list = (rows, f) => rows.slice(0, 40).map(f).join(', ') + (rows.length > 40 ? ` … and ${rows.length - 40} more` : '');
  // Numbers the drawing prints that this event has merged into a block: not
  // new stands, and not stands to add — the update keeps the block whole. A
  // server from before the diff reported them sends no such list.
  const absorbed = (d && d.absorbed) || [];
  const pre = document.createElement('pre');
  pre.className = 'spec-report-body';
  pre.textContent = [
    ...(d && p.existing ? [
      'What this drawing changes:',
      ...(d.added.length   ? [`  new        ${list(d.added, a => a.boothNumber)}`] : []),
      ...(absorbed.length  ? [`  inside merged blocks  ${list(absorbed, a => `${a.boothNumber} (in ${a.into})`)}`] : []),
      ...(d.moved.length   ? [`  moved      ${list(d.moved, a => a.boothNumber)}`] : []),
      ...(d.resized.length ? [`  resized    ${list(d.resized, a => `${a.boothNumber} (${a.from ?? '?'}→${a.to ?? '?'} ${unit})`)}`] : []),
      ...(d.missing.length ? [`  not drawn  ${list(d.missing, a => `${a.boothNumber}${a.committed ? ' *' : ''}`)}` +
                              (d.missing.some(m => m.committed) ? '   (* sold or on hold — kept)' : '   (empty stands are removed by Update)')] : []),
      ...(!d.added.length && !absorbed.length && !d.moved.length && !d.resized.length && !d.missing.length
        ? ['  nothing — every stand is where it was'] : []),
      '',
    ] : []),
    ...(p.fills && p.fills.length ? [
      'What the plan\'s colours mean:',
      '  colour     outline    stands  reads as',
      ...p.fills.map(f =>
        `  ${(f.fill || '-').padEnd(10)} ${(f.stroke || '-').padEnd(10)} ` +
        `${String(f.count).padStart(6)}  ${f.status}${f.sponsored ? ' (sponsorable area)' : ''}` +
        (f.example ? ` — e.g. ${f.example}` : '')),
      '',
    ] : []),
    ...(p.warnings.length ? ['Worth a look:', ...p.warnings.map(w => '  - ' + w), ''] : []),
    '  number   area      exhibitor',
    ...p.sample.map(s =>
      `  ${String(s.number).padEnd(8)} ${String(s.area).padStart(5)} ${unit.padEnd(4)} ${s.exhibitor || ''}`),
    p.stands > p.sample.length ? `  … and ${p.stands - p.sample.length} more` : '',
  ].join('\n');

  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'admin-btn primary';
  // For a revision that is not live, the same three choices make it live: the
  // drawing goes up and the stands are moved onto it in one step.
  const live = revision ? `Make ${revision.label} live` : null;
  if (!p.existing) {
    // A fresh event: the plan becomes its inventory.
    go.textContent = live ? `${live} — ${p.stands} stands` : `Import ${p.stands} stands`;
    go.title = 'Reads each stand\u2019s number, shape, size, status and exhibitor from the plan.';
    go.onclick = () => importStands(row, p, box, { mode: 'import', revision });
  } else if (p.committed > 0 || p.handwork > 0) {
    // The re-issued plan on an event that is selling. Every booking stays
    // where it is; only shapes, sizes and list prices are re-read, new stands
    // are added, and empty stands the drawing no longer has are removed.
    go.textContent = `${live || 'Update from this plan'} — keeps ${p.committed || 0} booking${p.committed === 1 ? '' : 's'}`;
    go.title = 'Sold and held stands keep their company, price and notes and only take their new shape from the plan. ' +
               'New stands are added; empty stands the plan no longer draws are removed; anything sold that is missing is kept and listed.';
    go.onclick = () => importStands(row, p, box, { mode: 'update', revision });
  } else {
    // Nothing committed yet: the ordinary re-read, which keeps anything set by
    // hand and refreshes the rest from the plan.
    go.textContent = live ? `${live} — ${p.stands} stands` : `Update ${p.stands} stands from this plan`;
    go.title = 'Re-reads each stand\u2019s shape, size and list price from the plan. Anything set by hand is kept.';
    go.onclick = () => importStands(row, p, box, { mode: 'upsert', revision });
  }

  // Kept well apart from the button above, and named for what it destroys.
  // Making "import" mean "throw the inventory away" was the original problem;
  // this is the same power, asked for explicitly.
  const wipe = document.createElement('button');
  wipe.type = 'button';
  wipe.className = 'admin-btn danger stand-report-wipe';
  wipe.textContent = 'Replace everything';
  wipe.title = 'Throws away this event\u2019s stands and rebuilds them from the plan. Bookings and anything set by hand are lost.';
  wipe.disabled = p.committed > 0;
  wipe.hidden = !p.existing;
  wipe.onclick = () => importStands(row, p, box, { mode: 'replace', revision });

  head.append(go, wipe, close);

  box.append(head, note);
  if (dropped) box.appendChild(dropped);
  box.appendChild(pre);
  document.getElementById('section-settings')?.prepend(box);
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * Import the stands, once the password is given.
 *
 *   import  — a fresh event; the plan becomes its inventory
 *   upsert  — re-read shapes, sizes and prices; keep anything set by hand
 *   update  — the re-issued plan on a selling event: bookings stay put
 *   replace — throw the inventory away and rebuild it (asked for by name)
 */
async function importStands(row, preview, box, { mode = 'upsert', revision = null } = {}) {
  const where = row.name || row.showId;
  // Said in every dialog for a revision: the one thing an organiser wants to
  // know before a new plan goes up is whether the link they sent out changes.
  // A retired event has no visitors to see it, and saying it did was the one
  // untrue sentence left on its card.
  const goesLive = !revision ? ''
    : offAir(row)
      ? `\n\n${where} is retired, so nobody sees ${revision.label} until the event is put back on air — ` +
        `then at the same link (/floorplan/${row.slug}). If the stands cannot be moved onto it, nothing changes.`
      : `\n\nVisitors see ${revision.label} from now on, at the same link (/floorplan/${row.slug}). ` +
        'If the stands cannot be moved onto it, nothing goes live.';
  const replace = mode === 'replace';
  const update = mode === 'update';

  if (replace && !await confirmDialog(
    `Throw away ${where}'s ${preview.existing || 0} stands and rebuild them from the plan?\n\n` +
    'Every booking, deal price, note, shown number, sponsor logo, tag and country on this event is destroyed. ' +
    'A recovery snapshot is taken first, but restoring it is a manual job.\n\n' +
    'The ordinary Import keeps all of that and only re-reads each stand\u2019s shape, size and price.',
    { title: `Replace every stand on ${where}`, confirmLabel: 'Replace everything', danger: true })) return;

  // Was a window.prompt(), which shows the admin password in clear text and
  // leaves it in the browser's dialog history.
  const ds = (preview.diff && preview.diff.summary) || {};
  const pw = await askSecret((
    replace
      ? `Replacing every stand on ${where} from its artwork.`
      : update
        ? `Updating ${where} from the re-issued plan.\n\n` +
          `${preview.committed || 0} sold or held stands keep their company, price and notes and take their new shape from the plan. ` +
          `${ds.added || 0} new stands are added` +
          (ds.missing ? `; ${ds.missing} the plan no longer draws are removed if empty, kept and listed if sold.` : '.')
        : `Reading ${preview.stands} stands into ${where}.\n\n` +
          'Each stand\u2019s shape, size and list price are re-read from the plan. Shown numbers, sponsor logos, tags and countries are kept.'
    ) + goesLive,
    { title: revision ? `Make ${revision.label} live on ${where}`
           : replace ? `Replace every stand on ${where}` : update ? `Update ${where} from the plan` : `Import stands into ${where}`,
      confirmLabel: revision ? 'Make it live' : replace ? 'Replace them' : update ? 'Update them' : 'Import them' });
  if (!pw) return;

  adminToast(replace ? 'Replacing…' : update ? 'Updating…' : 'Importing…');
  let r;
  try {
    const q = replace ? '?replace=1' : update ? '?mode=update' : '';
    const url = revision
      ? `/api/floorplan/revisions/${encodeURIComponent(revision.revisionId)}/publish${q}`
      : `/api/stands/import${q}`;
    r = await api(url, {
      method: 'POST',
      headers: { 'X-Show': row.slug, 'X-Confirm-Password': pw },
    });
  } catch (e) {
    // A refusal now explains itself, and the explanation is a paragraph with a
    // next step in it — too long and too important to flash past in a toast.
    showImportRefusal(where, e.message);
    return adminToast('The import was refused — see the note on the page.', 'error');
  }

  adminToast(
    (revision ? `${revision.label} is ${offAir(row) ? `now the plan for ${where}, which is still off the air` : `live on ${where}`}. ${r.imported} stands placed on it — `
              : `${where}: ${r.imported} stands ${r.mode === 'replace' ? 'replaced' : 'updated from the plan'} — `) +
    `${r.available} available, ${r.sold} sold, ${r.held || 0} on hold` +
    (r.created ? `, ${r.created} new` : '') +
    (r.removed && r.removed.length ? `, ${r.removed.length} empty stands no longer drawn removed` : '') +
    (r.areasImported ? `, ${r.areasImported} sponsorable areas read from this plan` : '') +
    (r.namesRemoved ? `, ${r.namesRemoved} printed names taken out of the artwork.` : '.'), 'ok');
  box?.remove();
  // What the drawing dropped that could not be removed stays on the page, by
  // number and company, until it is read — a toast is not the place for it.
  if (r.kept && r.kept.length) {
    showImportRefusal(where,
      'Updated. These stands are not drawn on the new plan but carry a booking or hand-work, so they were kept: ' +
      r.kept.map(k => `${k.boothNumber} (${k.status}${k.company ? `, ${k.company}` : ''})`).join(', ') +
      '. They will not appear on the map until the drawing includes them again — or renumber them here if the plan has renumbered them.');
  }
  await loadPlans();
  // A plan just made live may be drawn in different colours; the picker opens
  // on what it suggests, exactly as it used to after an upload.
  if (revision) await openPalettePanel(row, { fresh: true });
}

/**
 * Why an import was refused, left on the page to be read and acted on.
 *
 * All three refusals used to arrive as the same "The stands could not be
 * imported", which told an organiser nothing. Each one now names what is in the
 * way — bookings, hand-work, or artwork the reader cannot interpret — and what
 * to do about it, which is a paragraph, not a toast.
 */
function showImportRefusal(where, message) {
  document.getElementById('import-refusal')?.remove();
  const boxEl = document.createElement('div');
  boxEl.id = 'import-refusal';
  boxEl.className = 'spec-report import-refusal';

  const head = document.createElement('div');
  head.className = 'spec-report-head';
  head.append(Object.assign(document.createElement('strong'), { textContent: `${where} — import refused` }));
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'admin-btn'; close.textContent = 'Close';
  close.onclick = () => boxEl.remove();
  head.appendChild(close);

  const p = document.createElement('p');
  p.className = 'spec-report-note';
  p.textContent = message;

  boxEl.append(head, p);
  document.getElementById('section-settings')?.prepend(boxEl);
  boxEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** Upload or replace ONE event's plan, named explicitly rather than implied. */
function pickPlan(row) {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = '.svg,image/svg+xml';
  picker.onchange = async () => {
    const file = picker.files?.[0];
    if (!file) return;
    if (!/svg/i.test(file.type) && !/\.svg$/i.test(file.name)) {
      return adminToast('That is not an SVG. The floorplan must be vector artwork.', 'error');
    }
    // No longer a destructive step, so no warning before it: the file is
    // stored as a draft and the live plan does not move until it is made live.
    const password = await askSecret(
      `Uploading a new version of ${row.name || row.showId}'s plan as a draft.\n\n` +
      (offAir(row)
        ? `${row.name || row.showId} is retired, so nobody sees its plan until it is put back on air. `
        : 'Visitors keep seeing the live plan. ') +
      'You will see what the new one does to the stands before making it live.',
      { title: 'Upload a new version', confirmLabel: 'Upload it' });
    if (password === null) return;
    if (!password) return adminToast('Password required to change a floorplan.', 'error');

    try {
      // Raw fetch, not api(): the BODY of this request is the SVG, so it does
      // not carry a JSON content type. The 401 case is handled explicitly.
      const res = await fetch('/api/floorplan', {
        method: 'POST',
        // X-Show names the event explicitly: this page can change any of them,
        // not only the one it happens to be viewing.
        headers: { 'Content-Type': 'image/svg+xml', 'X-Filename': file.name,
                   'X-Show': row.slug, 'X-Confirm-Password': password },
        body: await file.text(),
      });
      if (res.status === 401) {
        location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
        return;
      }
      if (!res.ok) {
        let msg = 'Could not upload that floorplan.';
        try { msg = (await res.json()).error || msg; } catch { /* no JSON body */ }
        return adminToast(msg, 'error');
      }
      const r = await res.json();
      const label = (r.revision && r.revision.label) || 'The new version';
      adminToast(`${label} uploaded as a draft — ${offAir(row) ? 'the event is off the air, so nobody sees either plan yet' : 'visitors still see the live plan'}.` +
        (r.removed && r.removed.length ? ` Removed for safety: ${r.removed.join(', ')}.` : ''), 'ok');
      // The plan is stored either way; this is what to send the designer.
      if (r.spec && r.spec.failedClauses && r.spec.failedClauses.length) {
        showSpecReport(row.name || row.showId, r.spec);
      }
      // What follows an upload, opened rather than left to be found: what
      // this draft does to the stands already here, with the button that
      // makes it live. The colours follow once it is.
      await loadPlans();
      await previewStands({ ...row, uploaded: true }, { revision: r.revision || null });
    } catch (err) {
      adminToast(err.message || 'Could not read that file.', 'error');
    }
  };
  picker.click();
}

async function removePlan(row) {
  if (!await confirmDialog(
    `${row.name || row.showId} goes back to the floorplan shipped with the app.` +
    (row.boothCount > 0 ? `\n\nIts ${row.boothCount} stands are positioned against the uploaded artwork and may stop appearing on the map.` : ''),
    { title: `Remove ${row.name || row.showId}'s uploaded plan`, confirmLabel: 'Remove it', danger: true })) return;

  const password = await askSecret(
    `Removing the uploaded floorplan for ${row.name || row.showId}.`,
    { title: 'Confirm the removal', confirmLabel: 'Remove it' });
  if (password === null) return;
  if (!password) return adminToast('Password required to remove a floorplan.', 'error');

  try {
    await api('/api/floorplan', {
      method: 'DELETE', headers: { 'X-Show': row.slug, 'X-Confirm-Password': password },
    });
    adminToast(`${row.name || row.showId}: reverted to the shipped plan.`, 'ok');
  } catch (e) {
    adminToast(e.message || 'Could not remove that floorplan.', 'error');
  }
  loadPlans();
}

// ── The event this console is showing ────────────────────────────────────────
// Admins see every event, so switching is a navigation, not a permission check:
// each event is a separate URL, and moving between them is a page load. That is
// deliberate — the alternative, swapping the data underneath a live socket, is
// a great deal of machinery for something done a few times a day.
async function initShowSwitcher() {
  const wrap = document.getElementById('nav-show');
  const sel = document.getElementById('show-switch');
  if (!wrap || !sel) return;

  let list = [];
  try { list = await api('/api/shows') || []; } catch { list = []; }
  let live = list.filter(sh => sh.active !== false);

  // ALWAYS shown, even with a single event. It used to hide itself when there
  // was nothing to switch between, on the theory that a one-option dropdown is
  // clutter. In practice that made the whole multi-event capability invisible:
  // you could not tell whether it existed, which event you were editing, or
  // where to add another. Naming the event you are working in is worth the row
  // on its own.
  if (!live.length) {
    const cur = (window.__SHOW && window.__SHOW.slug) || '';
    live = [{ slug: cur, name: (window.__SHOW && window.__SHOW.name) || cur || 'This event' }];
  }

  sel.replaceChildren();
  live.forEach(sh => {
    const o = document.createElement('option');
    o.value = sh.slug;
    o.textContent = sh.name || sh.showId;
    sel.appendChild(o);
  });
  sel.value = (window.__SHOW && window.__SHOW.slug) || live[0].slug;
  // If the page's show is not among the options — a registry that has moved on,
  // a slug that no longer exists — the select would render BLANK, which reads
  // as broken and hides which event you are editing. Fall back to naming
  // something rather than nothing.
  if (sel.selectedIndex < 0) sel.selectedIndex = 0;
  wrap.classList.remove('hidden');

  sel.onchange = () => { location.href = `/admin/${sel.value}`; };
}
initShowSwitcher();

// ── Tools: the events this system runs ───────────────────────────────────────
// Each row is a whole parallel set of data — its own stands, pricing, leads and
// artwork. Creating one is owner-only server-side; the UI shows the list to any
// admin so they can see which event they are working in.
let showsCache = [];

async function loadShows() {
  const box = document.getElementById('show-list');
  if (!box) return;
  try { showsCache = await api('/api/shows') || []; }
  catch (e) {
    showsCache = [];
    box.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'tag-empty', textContent: `Could not load the events — ${e.message}`,
    }));
    return;
  }

  box.replaceChildren();
  if (!showsCache.length) {
    const p = document.createElement('p');
    p.className = 'tag-empty';
    p.textContent = 'No events yet.';
    box.appendChild(p);
    return;
  }

  showsCache.forEach(sh => {
    const card = document.createElement('div');
    card.className = 'area-card';

    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'admin-input area-name';
    name.value = sh.name || sh.showId;
    name.maxLength = 80;
    name.setAttribute('aria-label', `Name of ${sh.name || sh.showId}`);
    name.onchange = () => saveShow(sh.showId, { name: name.value });

    // The URL name: the address the event lives at. The Add an event card
    // promises it can be changed here, and it could not be — the server took a
    // new one, but nothing on this page offered it.
    const slugRow = document.createElement('label');
    slugRow.className = 'show-slug';
    const slugLbl = document.createElement('span');
    slugLbl.textContent = '/floorplan/';
    const slug = document.createElement('input');
    slug.type = 'text';
    slug.className = 'admin-input show-slug-input';
    slug.value = sh.slug;
    slug.maxLength = 24;
    slug.spellcheck = false;
    slug.autocomplete = 'off';
    slug.setAttribute('aria-label', `URL name of ${sh.name || sh.showId}`);
    slug.onchange = () => changeShowSlug(sh, slug);
    slug.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); slug.blur(); } };
    slugRow.append(slugLbl, slug);

    const meta = document.createElement('div');
    meta.className = 'area-package-note';
    meta.textContent = `id ${sh.showId} (permanent)${sh.active === false ? ' · retired' : ''}`;

    // The two places this event lives. Shown as links so they can be opened and
    // checked without anyone having to remember the URL shape.
    const links = document.createElement('div');
    links.className = 'show-links';
    [['Floorplan', `/floorplan/${sh.slug}`], ['Admin', `/admin/${sh.slug}`]].forEach(([label, href]) => {
      const a = document.createElement('a');
      a.href = href; a.target = '_blank'; a.rel = 'noopener';
      a.className = 'admin-btn show-link';
      a.textContent = label;
      links.appendChild(a);
    });

    const retire = document.createElement('button');
    retire.type = 'button';
    retire.className = 'admin-btn area-remove';
    const retired = sh.active === false;
    retire.textContent = retired ? 'Put back on air' : 'Retire';
    retire.title = retired
      ? 'Make this event reachable again'
      : 'Stop serving this event. Nothing is deleted — its data stays exactly as it is.';
    // This took a live event off the air the instant it was clicked, with no
    // confirmation at all: its public URL starts returning 404 to anyone
    // already on it, and the button sits next to a plain "rename" field.
    retire.onclick = () => withPending(retire, async () => {
      const name = sh.name || sh.showId;
      const ok = retired
        ? await confirmDialog(
            `Put ${name} back on air?\n\n/floorplan/${sh.slug} starts answering again immediately.`,
            { title: `Put ${name} back on air`, confirmLabel: 'Put it back' })
        : await confirmDialog(
            `Take ${name} off the air?\n\n/floorplan/${sh.slug} and /admin/${sh.slug} start returning 404 straight away — including for anyone looking at the plan right now. Nothing is deleted: its stands, bookings and artwork stay exactly as they are, and this is reversible.`,
            { title: `Retire ${name}`, confirmLabel: 'Take it off the air', danger: true });
      if (!ok) return;
      await saveShow(sh.showId, { active: retired });
    });

    card.append(name, slugRow, meta, links, retire);
    box.appendChild(card);
  });
}

// What the server accepts as a URL name (models/shows.js), checked here so a
// typo is explained before anything is asked or sent.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

/**
 * Move an event to a new address.
 *
 * Asked first, because the old address stops answering the moment it moves:
 * every link already sent out or printed for it starts returning 404. If this
 * page is that event's console it reopens at the new address — left where it
 * was, every request it made would name an event that is no longer there.
 */
async function changeShowSlug(sh, input) {
  const next = input.value.trim().toLowerCase();
  if (next === sh.slug) { input.value = sh.slug; return; }
  if (!SLUG_RE.test(next)) {
    input.value = sh.slug;
    return adminToast('A URL name is up to 24 lowercase letters, numbers and dashes, starting with a letter or a number.', 'error');
  }
  const name = sh.name || sh.showId;
  const here = sh.slug === SHOW;
  const ok = await confirmDialog(
    `Move ${name} from /floorplan/${sh.slug} to /floorplan/${next}?\n\n` +
    `The old address stops working straight away: /floorplan/${sh.slug} and /admin/${sh.slug} answer 404, ` +
    'including any link to them already sent out or printed. Nothing else about the event changes.' +
    (here ? `\n\nThis page is ${name}'s console, so it reopens at /admin/${next}.` : ''),
    { title: `Change ${name}'s address`, confirmLabel: 'Move it', danger: true });
  if (!ok) { input.value = sh.slug; return; }
  const saved = await saveShow(sh.showId, { slug: next }, { refresh: !here });
  if (!saved) { input.value = sh.slug; return; }
  if (here) location.href = `/admin/${encodeURIComponent(next)}`;
}

/**
 * Save a change to an event, and refresh everything that lists the events.
 *
 * Only this card used to be refreshed, so an event renamed, retired or moved
 * here went on reading as it was in the sidebar's switcher and on the
 * Settings page until a reload.
 */
async function saveShow(showId, fields, { refresh = true } = {}) {
  try {
    await api(`/api/shows/${encodeURIComponent(showId)}`, {
      method: 'PATCH', body: JSON.stringify(fields),
    });
    adminToast('Event updated.', 'ok');
    if (refresh) refreshEventLists();
    return true;
  } catch (e) { adminToast(e.message || 'Could not update that event.', 'error'); return false; }
}

/** Every list of events on the page: Tools → Events, the switcher, Settings. */
function refreshEventLists() {
  loadShows();
  initShowSwitcher();
  loadPlans();
}

document.getElementById('show-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  return withPending(e.target.querySelector('button[type=submit]'), async () => {
    const name = document.getElementById('show-name').value.trim();
    const slug = document.getElementById('show-slug').value.trim();
    const showId = document.getElementById('show-id').value.trim();
    if (!slug || !showId) return adminToast('A URL name and a show id are both needed.', 'error');

    try {
      await api('/api/shows', { method: 'POST', body: JSON.stringify({ name, slug, showId }) });
      adminToast(`${name || showId} added — it is live at /floorplan/${slug}.`, 'ok');
      ['show-name', 'show-slug', 'show-id'].forEach(id => { document.getElementById(id).value = ''; });
      // Not just this list: an event added here was missing from the switcher
      // and from Settings — where its plan is uploaded — until a reload.
      refreshEventLists();
    } catch (err) { adminToast(err.message || 'Could not add that event.', 'error'); }
  });
});

// ── Tools: sponsored areas ───────────────────────────────────────────────────
// One card per named area on the plan. The logo is uploaded rather than linked,
// for the same reason a stand's is: the plan's PNG download rasterises the SVG
// through an <img>, where an external reference is never fetched.
function renderAreaCards() {
  const box = document.getElementById('area-list');
  if (!box) return;
  box.replaceChildren();

  if (!planAreas.length) {
    const p = document.createElement('p');
    p.className = 'tag-empty';
    p.textContent = 'No named areas on this plan.';
    box.appendChild(p);
    return;
  }

  planAreas.forEach(a => {
    const card = document.createElement('div');
    card.className = 'area-card';

    // The shipped names were matched from the artwork's layout, so any of them
    // may be wrong — editable in place rather than needing a code change.
    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'admin-input area-name';
    name.value = a.label;
    name.maxLength = 60;
    name.title = 'Rename this area';
    name.onchange = () => {
      socket.emit('area:set-label', { key: a.key, label: name.value }, (res) => {
        if (!res || !res.ok) adminToast((res && res.error) || 'Could not rename that area.', 'error');
      });
    };

    card.append(name, areaEditor(a));
    box.appendChild(card);
  });
}

/**
 * The controls for one area: which package sells it, who has it, whether it is
 * still going, and their logo.
 *
 * Shared between the Tools card and the panel that opens when an area is
 * clicked on the plan, so the two can never offer different things — the split
 * between "the image on the package" and "the logo on the area" was confusing
 * enough without two editors that disagree.
 */
function areaEditor(a) {
  const frag = document.createDocumentFragment();
  const label = (text) => {
    const el = document.createElement('div');
    el.className = 'ara-field-lbl';
    el.textContent = text;
    return el;
  };

  // ── Which package sells this area ──
  const pkg = document.createElement('select');
  pkg.className = 'admin-input area-package';
  const none = document.createElement('option');
  none.value = ''; none.textContent = '— Not linked to a package —';
  pkg.appendChild(none);
  sponsorAdminCache.forEach(p => {
    const o = document.createElement('option');
    o.value = p.key;
    o.textContent = `${p.name}${p.tier ? ` (${p.tier})` : ''}`;
    pkg.appendChild(o);
  });
  pkg.value = a.sponsorKey || '';
  pkg.onchange = () => {
    socket.emit('area:set-package', { key: a.key, sponsorKey: pkg.value }, (res) => {
      if (!res || !res.ok) adminToast((res && res.error) || 'Could not link that area.', 'error');
    });
  };

  const note = document.createElement('div');
  note.className = 'area-package-note';
  note.textContent = a.package
    ? `Sells as ${a.package.name}${a.package.availability ? ` · ${a.package.availability}` : ''}${a.package.soldOut ? ' · sold out' : ''}`
    : 'Not linked — this area\u2019s availability is set by hand.';

  // ── Who has it ──
  const sponsor = document.createElement('input');
  sponsor.type = 'text';
  sponsor.className = 'admin-input area-sponsor';
  sponsor.placeholder = 'Sponsor (leave blank if available)';
  sponsor.value = a.sponsor || '';
  sponsor.maxLength = 80;
  sponsor.onchange = () => {
    socket.emit('area:set-sponsor', { key: a.key, sponsor: sponsor.value }, (res) => {
      if (!res || !res.ok) adminToast((res && res.error) || 'Could not save the sponsor.', 'error');
    });
  };

  const status = document.createElement('select');
  status.className = 'admin-input area-status';
  [['available', 'Available to sponsor'], ['taken', 'Sponsored']].forEach(([v, text]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = text;
    status.appendChild(o);
  });
  status.value = a.status || 'available';
  status.onchange = () => {
    socket.emit('area:set-sponsor', { key: a.key, status: status.value }, (res) => {
      if (!res || !res.ok) adminToast((res && res.error) || 'Could not update that area.', 'error');
    });
  };

  // ── Their logo, drawn on the plan ──
  const drop = document.createElement('button');
  drop.type = 'button';
  drop.className = 'area-drop';
  drop.title = `Drop ${a.label}'s sponsor logo here, or click to choose one`;
  if (a.logo) {
    const img = document.createElement('img');
    img.src = a.logo; img.alt = '';
    drop.appendChild(img);
  } else {
    drop.appendChild(document.createTextNode('Drop a logo here, or click to choose'));
  }

  const take = async (file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return adminToast('That file is not an image.', 'error');
    try { saveAreaLogo(a.key, await fileToDataUrl(file, 400)); }
    catch (err) { adminToast(err.message || 'Could not read that image.', 'error'); }
  };

  drop.onclick = () => {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/*';
    picker.onchange = () => take(picker.files?.[0]);
    picker.click();
  };
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.remove('dragover');
  }));
  drop.addEventListener('drop', (e) => take(e.dataTransfer?.files?.[0]));

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'admin-btn danger area-remove';
  remove.textContent = 'Remove logo';
  remove.hidden = !a.logo;
  remove.onclick = () => saveAreaLogo(a.key, '');

  frag.append(label('Sells as'), pkg, note,
              label('Sponsor'), sponsor, status,
              label('Sponsor logo (shown on the plan)'), drop, remove);
  return frag;
}

// A logo is the largest thing this console sends over the socket, and these
// two were bare emits with no timeout: an upload the connection dropped left
// nothing on screen, ever. emitAck always answers — with the server's reply,
// or with a failure once it has waited long enough for a large image on a
// slow line.
const LOGO_ACK_MS = 60000;

/** Store (or clear) an area's logo. The cards redraw from the server's answer. */
async function saveAreaLogo(key, dataUrl) {
  const res = await emitAck(socket, 'area:set-logo', { key, logo: dataUrl || '' }, { timeout: LOGO_ACK_MS });
  if (res && res.ok) adminToast(res.logo ? 'Sponsor logo saved.' : 'Sponsor logo removed.', 'ok');
  else adminToast((res && res.error) || 'Could not save the logo.', 'error');
}

// ── Booth panel: the sponsor and their logo ──────────────────────────────────
//
// The logo is drawn INSIDE the stand on both plans, in place of the exhibitor
// name — on a small stand there is room for one or the other, and a logo
// already says the name. It is offered only once the stand is marked as having
// a sponsor, which is the same flag the floorplan-sponsor tooling uses; marking
// a stand changes no colours on its own (the brand fill only applies when a
// floorplan sponsor colour is actually set).
function renderBoothSponsor(n) {
  const section = document.getElementById('aba-sponsor-section');
  if (!section) return;
  const b = booths[n];
  if (!b) return;

  const on = b.sponsored === true;
  const toggle = document.getElementById('aba-sponsored');
  toggle.checked = on;
  toggle.dataset.booth = n;

  const box = document.getElementById('aba-logo-box');
  box.classList.toggle('hidden', !on);
  box.dataset.booth = n;

  const preview = document.getElementById('aba-logo-preview');
  const hint    = document.getElementById('aba-logo-hint');
  const remove  = document.getElementById('aba-logo-remove');
  const logo    = b.sponsorLogo || '';

  preview.hidden = !logo;
  if (logo) preview.src = logo; else preview.removeAttribute('src');
  hint.hidden   = !!logo;
  remove.hidden = !logo;
}

/** Store (or clear) this stand's logo, redrawing from the server's answer. */
async function saveBoothLogo(boothNumber, dataUrl) {
  const res = await emitAck(socket, 'booth:set-logo', { boothNumber, logo: dataUrl || '' }, { timeout: LOGO_ACK_MS });
  if (res && res.ok) {
    const b = booths[boothNumber];
    if (b) b.sponsorLogo = res.logo;
    adminToast(res.logo ? 'Sponsor logo saved.' : 'Sponsor logo removed.', 'ok');
  } else {
    adminToast((res && res.error) || 'Could not save the logo.', 'error');
  }
  // Only if the panel is still on this stand: the answer to a slow upload can
  // arrive after another stand has been opened.
  if (selectedAdminId === boothNumber) renderBoothSponsor(boothNumber);
}

document.getElementById('aba-sponsored')?.addEventListener('change', (e) => {
  const n = e.target.dataset.booth;
  if (!n) return;
  socket.emit('booth:set-sponsored', { boothNumber: n, sponsored: e.target.checked }, (res) => {
    if (!res || !res.ok) adminToast((res && res.error) || 'Could not update the sponsor flag.', 'error');
    else { const b = booths[n]; if (b) b.sponsored = res.sponsored; }
    renderBoothSponsor(n);
  });
});

(function wireBoothLogo() {
  const drop = document.getElementById('aba-logo-drop');
  const file = document.getElementById('aba-logo-file');
  if (!drop || !file) return;

  const boothOf = () => document.getElementById('aba-logo-box')?.dataset.booth || '';

  // Shrunk to a data URI in the browser, the same way partner logos are — the
  // server stores only inline images, so the plan's PNG download stays
  // self-contained (see booths.setSponsorLogo).
  const take = async (f) => {
    const n = boothOf();
    if (!n || !f) return;
    try { saveBoothLogo(n, await fileToDataUrl(f, 400)); }
    catch (err) { adminToast(err.message || 'Could not read that image.', 'error'); }
  };

  drop.addEventListener('click', () => file.click());
  file.addEventListener('change', () => { take(file.files?.[0]); file.value = ''; });

  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.remove('dragover');
  }));
  drop.addEventListener('drop', (e) => take(e.dataTransfer?.files?.[0]));

  document.getElementById('aba-logo-remove')?.addEventListener('click', () => {
    const n = boothOf();
    if (n) saveBoothLogo(n, '');
  });
})();

// ── Booth panel: the exhibitor's country ─────────────────────────────────────
// A built-in list (server/data/countries.js), fetched once and cached, rather
// than a curated catalogue like the activities — see that file's header for
// why. The booth stores the ISO code; the label here is only a label.
let countryList = [];
let countryListLoaded = null;

function loadCountries() {
  if (!countryListLoaded) {
    countryListLoaded = api('/countries', { cache: 'force-cache' })
      .then(d => { countryList = Array.isArray(d?.countries) ? d.countries : []; fillCountrySelect(); })
      .catch(() => { countryList = []; });
  }
  return countryListLoaded;
}

function fillCountrySelect() {
  const sel = document.getElementById('aba-country');
  if (!sel || sel.dataset.filled === '1' || !countryList.length) return;
  countryList.forEach(c => {
    const o = document.createElement('option');
    o.value = c.code;
    o.textContent = `${c.flag}  ${c.name}`;
    sel.appendChild(o);
  });
  sel.dataset.filled = '1';
  // The list arrives after the panel may already have been drawn, so re-apply
  // the selected stand's country once the options actually exist.
  if (selectedAdminId) renderBoothCountry(selectedAdminId);
}

function renderBoothCountry(n) {
  const sel = document.getElementById('aba-country');
  if (!sel) return;
  loadCountries();
  sel.value = dealOf(booths[n]).country || '';
  sel.dataset.booth = n;
}

document.getElementById('aba-country')?.addEventListener('change', (e) => {
  const n = e.target.dataset.booth;
  if (!n) return;
  const country = e.target.value;
  // Saved from the server's answer, never optimistically: a rejected change
  // (the stand was released underneath the edit) must not leave the dropdown
  // showing a country that was not stored.
  socket.emit('booth:set-country', { boothNumber: n, country }, (res) => {
    if (res && res.ok) {
      const b = booths[n];
      if (b) { b.assignment = b.assignment || {}; b.assignment.country = res.country; }
      adminToast(res.country ? `Country set — ${res.name}.` : 'Country cleared.', 'ok');
    } else {
      adminToast((res && res.error) || 'Could not save the country.', 'error');
    }
    renderBoothCountry(n);
  });
});

// ── Booth panel: the tags on this stand, plus one-click add ──────────────────
function renderBoothTags(n) {
  const section = document.getElementById('aba-tags-section');
  if (!section) return;

  const b = booths[n];
  // Tags describe an exhibitor, so the block only appears where there is one.
  // The server enforces the same rule on the write.
  const booked = b && (b.status === 'sold' || b.status === 'held');
  section.classList.toggle('hidden', !booked);
  if (!booked) return;

  renderBoothCountry(n);

  const current = boothTags(b);
  document.getElementById('aba-tag-count').textContent = `${current.length}/${MAX_BOOTH_TAGS}`;

  const currentBox = document.getElementById('aba-tag-current');
  currentBox.replaceChildren();
  if (!current.length) {
    const none = document.createElement('span');
    none.className = 'aba-tag-none';
    none.textContent = 'No activity set.';
    currentBox.appendChild(none);
  } else {
    current.forEach(key => currentBox.appendChild(
      tagChip(tagByKey(key), { onRemove: () => saveBoothTags(n, current.filter(k => k !== key)) })
    ));
  }

  const pick = document.getElementById('aba-tag-pick');
  pick.replaceChildren();

  if (!tagCatalogue.length) {
    const hint = document.createElement('p');
    hint.className = 'aba-tag-hint';
    hint.textContent = 'No activities exist yet — create them under Tools → Business Activities.';
    pick.appendChild(hint);
    return;
  }

  const full = current.length >= MAX_BOOTH_TAGS;
  tagCatalogue.filter(t => !current.includes(t.key)).forEach(t => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tag-add';
    btn.textContent = `+ ${t.label}`;
    btn.style.borderColor = t.color;
    btn.disabled = full;
    btn.title = full ? `A stand can carry at most ${MAX_BOOTH_TAGS} tags` : `Add ${t.label} to this stand`;
    btn.onclick = () => saveBoothTags(n, [...current, t.key]);
    pick.appendChild(btn);
  });

  if (full) {
    const hint = document.createElement('p');
    hint.className = 'aba-tag-hint';
    hint.textContent = `That is the maximum of ${MAX_BOOTH_TAGS}. Remove one to add another.`;
    pick.appendChild(hint);
  }
}

/**
 * Replace this stand's whole tag set. The panel is redrawn from the server's
 * answer rather than optimistically, so a rejected change (the stand was
 * released underneath the edit) never leaves a chip showing that isn't saved.
 */
function saveBoothTags(boothNumber, keys) {
  socket.emit('booth:set-tags', { boothNumber, tags: keys }, (res) => {
    if (res && res.ok) {
      const b = booths[boothNumber];
      if (b) { b.assignment = b.assignment || {}; b.assignment.tags = res.tags; }
      renderBoothTags(boothNumber);
      renderTagCatalogue();
    } else {
      adminToast((res && res.error) || 'Could not save tags.', 'error');
      renderBoothTags(boothNumber);
    }
  });
}

// ─── Sponsorship: add, delete, and spreadsheet import ────────────────────────
// The catalogue used to be seedable only by running scripts/seed-sponsors.js on
// the server, and nothing in the admin could add or remove a package. These are
// the missing halves. Everything here writes to the same collection the public
// floorplan's recommendations and the sales catalogue read from, so a change is
// live on both the moment it saves.

async function deleteSponsor(s) {
  const inUse = s.soldOut || s.active !== false;
  if (!confirm(
    `Delete "${s.name}" from the sponsorship catalogue?\n\n` +
    `This removes it for good. Proposals already sent that include it will show it as no longer available.\n\n` +
    (inUse ? 'If it has simply stopped selling, un-tick "Offered" instead — that is reversible.' : '')
  )) return;

  try {
    await api(`/api/sponsors/${encodeURIComponent(s.key)}`, { method: 'DELETE' });
    adminToast(`"${s.name}" deleted.`, 'ok');
    loadSponsorsAdmin();
  } catch (e) { adminToast(e.message, 'error'); }
}

document.getElementById('sponsor-add-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('sp-new-name').value.trim();
  if (!name) return adminToast('Give the package a name first.', 'error');
  const priceRaw = document.getElementById('sp-new-price').value;

  return withPending(e.target.querySelector('button[type=submit]'), async () => {
    try {
      await api('/api/sponsors', {
        method: 'POST',
        body: JSON.stringify({
          name, tier: document.getElementById('sp-new-tier').value,
          price: priceRaw === '' ? '' : Number(priceRaw),
        }),
      });
      document.getElementById('sp-new-name').value = '';
      document.getElementById('sp-new-price').value = '';
      adminToast(`"${name}" added.`, 'ok');
      loadSponsorsAdmin();
    } catch (err) { adminToast(err.message, 'error'); }
  });
});

// ── CSV import ───────────────────────────────────────────────────────────────
// Two passes: a dry run that writes nothing and reports what WOULD happen, shown
// for confirmation, then the real one. Nobody should find out what an upload did
// only after it has done it.
(function initSponsorCsv() {
  const drop = document.getElementById('csv-drop');
  const input = document.getElementById('csv-file');
  const report = document.getElementById('csv-report');
  if (!drop || !input) return;

  const show = (html, kind) => {
    report.className = `csv-report ${kind || ''}`;
    report.replaceChildren(...html);
    report.hidden = false;
  };
  const line = (text, cls) => { const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = text; return d; };
  const list = (label, items) => {
    const d = document.createElement('div');
    d.className = 'csv-line';
    d.textContent = `${label}: ${items.map(i => i.name || i.key).join(', ')}`;
    return d;
  };

  async function send(text, { dryRun }) {
    return api('/api/sponsors/import', {
      method: 'POST',
      body: JSON.stringify({ csv: text, dryRun, removeMissing: document.getElementById('csv-remove-missing').checked }),
    });
  }

  async function handleFile(file) {
    if (!file) return;
    // A wrong file type here is a common slip (an .xlsx rather than a CSV), and
    // the server's error would be cryptic — say it plainly up front.
    if (!/\.csv$/i.test(file.name) && file.type && !/csv|text/i.test(file.type)) {
      return show([line(`"${file.name}" isn't a CSV. In Excel or Sheets use File → Save as / Download → CSV.`, 'csv-err')], 'err');
    }
    let text;
    try { text = await file.text(); }
    catch { return show([line('That file could not be read.', 'csv-err')], 'err'); }

    try {
      const plan = await send(text, { dryRun: true });
      const parts = [];
      if (plan.created.length) parts.push(list(`Add ${plan.created.length}`, plan.created));
      // Each update says what it changes — "Lanyards: price €5,000 → €5,500" —
      // where it used to give only the package's name, which read the same for
      // a file that moved one price as for one that rewrote every package.
      if (plan.updated.length) {
        parts.push(line(`Update ${plan.updated.length}:`, 'csv-line'));
        plan.updated.forEach(u => parts.push(line(
          u.detail ? `${u.name || u.key}: ${u.detail}` : (u.name || u.key), 'csv-line csv-detail')));
      }
      // Rows that change nothing are not written, and are counted rather than
      // listed — a re-uploaded catalogue is mostly these.
      const unchanged = (plan.unchanged || []).length;
      if (unchanged) {
        parts.push(line(unchanged === 1
          ? 'Unchanged: 1 row matches the catalogue already and is left alone.'
          : `Unchanged: ${unchanged} rows match the catalogue already and are left alone.`, 'csv-line'));
      }
      if (plan.removed.length) parts.push(list(`REMOVE ${plan.removed.length}`, plan.removed));
      plan.errors.forEach(er => parts.push(line(`Row ${er.line}: ${er.error}`, 'csv-err')));
      // The server refuses removals when any row failed, because the file cannot
      // be the whole truth if part of it could not be read. Say so, or ticking
      // the box appears to do nothing.
      if (plan.removalsBlocked) {
        parts.push(line('Nothing will be removed: some rows could not be read, so the file can\'t be treated as the full catalogue. Fix the rows above and upload again.', 'csv-err'));
      }

      if (!plan.created.length && !plan.updated.length && !plan.removed.length) {
        return show([line('Nothing to apply from that file.', 'csv-err'), ...parts], 'err');
      }

      show([line('Ready to apply:', 'csv-head'), ...parts, line('Applying…', 'csv-head')], 'ok');

      const summary = [
        plan.created.length ? `add ${plan.created.length}` : '',
        plan.updated.length ? `update ${plan.updated.length}` : '',
        plan.removed.length ? `REMOVE ${plan.removed.length}` : '',
        plan.removalsBlocked ? 'remove nothing (some rows could not be read)' : '',
      ].filter(Boolean).join(', ');
      if (!confirm(`Apply this import?\n\n${summary}\n\n` +
                   (plan.removed.length ? `Removing: ${plan.removed.map(r => r.name || r.key).join(', ')}\n\n` : '') +
                   (plan.errors.length ? `${plan.errors.length} row(s) will be skipped — see the list on the page.\n\n` : ''))) {
        return show([line('Import cancelled — nothing was changed.', 'csv-head'), ...parts], '');
      }

      const done = await send(text, { dryRun: false });
      show([
        line(`Imported: ${done.created.length} added, ${done.updated.length} updated` +
             `${(done.unchanged || []).length ? `, ${done.unchanged.length} unchanged` : ''}` +
             `${done.removed.length ? `, ${done.removed.length} removed` : ''}.`, 'csv-head'),
        ...done.updated.filter(u => u.detail).map(u => line(`${u.name || u.key}: ${u.detail}`, 'csv-line csv-detail')),
        ...done.errors.map(er => line(`Row ${er.line}: ${er.error}`, 'csv-err')),
      ], 'ok');
      adminToast('Sponsorship catalogue updated.', 'ok');
      loadSponsorsAdmin();
    } catch (e) {
      show([line(e.message, 'csv-err')], 'err');
    } finally {
      input.value = '';   // so re-picking the same file fires change again
    }
  }

  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => handleFile(input.files[0]));
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('dragover'); }));
  drop.addEventListener('drop', (e) => handleFile(e.dataTransfer?.files?.[0]));
})();
