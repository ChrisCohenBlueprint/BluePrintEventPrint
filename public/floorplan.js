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
    mount.innerHTML = '<p style="color:#f87171;padding:20px">Floorplan could not be loaded. Please refresh.</p>';
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
function openDeepLink() {
  const n = new URLSearchParams(location.search).get('booth');
  if (!n || !booths[n]) return;
  selectBooth(n);
  const el = svgDoc.querySelector(`[data-booth="${CSS.escape(n)}"]`);
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────
const tooltip = document.getElementById('fp-tooltip');
function showTooltip(e, n) {
  const b = booths[n];
  document.getElementById('tt-label').textContent  = `Stand ${n}`;
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

// ─── Shortlist ────────────────────────────────────────────────────────────────
// A prospect interested in three adjacent stands should send one enquiry, not
// three.
function toggleShortlist(n) {
  const i = shortlist.indexOf(n);
  if (i > -1) shortlist.splice(i, 1);
  else if (shortlist.length < 25) shortlist.push(n);
  renderShortlist();
  renderPanel(selectedId);
}

function renderShortlist() {
  const card = document.getElementById('enquiry-card');
  const box  = document.getElementById('eq-shortlist');

  if (!shortlist.length) { card.classList.add('hidden'); box.innerHTML = ''; return; }
  if (!submitted) card.classList.remove('hidden');

  box.innerHTML = `
    <div class="eq-shortlist-lbl">Enquiring about ${shortlist.length} stand${shortlist.length > 1 ? 's' : ''}</div>
    <div class="eq-chips">
      ${shortlist.map(n => `
        <button type="button" class="eq-chip" data-remove="${esc(n)}" aria-label="Remove stand ${esc(n)}">
          Stand ${esc(n)} <span aria-hidden="true">×</span>
        </button>`).join('')}
    </div>`;

  box.querySelectorAll('[data-remove]').forEach(btn => {
    btn.onclick = () => toggleShortlist(btn.getAttribute('data-remove'));
  });
}

// ─── Detail panel ─────────────────────────────────────────────────────────────
function renderPanel(n) {
  if (!n) return;
  const b     = booths[n] || { status: 'sold' };
  const panel = document.getElementById('booth-panel');
  panel.classList.remove('hidden');

  const status = b.status || 'sold';
  const inList = shortlist.includes(n);

  if (status !== 'available') {
    panel.innerHTML = `
      <div class="stand-header">
        <div class="stand-id">Stand ${esc(n)}</div>
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
socket.on('state:full', (rows) => {
  rows.forEach(b => {
    const n = b.boothNumber;
    booths[n] = { ...(booths[n] || {}), ...b };
  });
  stateReady = true;

  // First broadcast may arrive before the plan has finished downloading.
  if (!tagged) { tagBooths(); return; }

  rows.forEach(b => applyVisual(b.boothNumber));
  if (selectedId) renderPanel(selectedId);
  updateStatsStrip();
});

socket.on('stats:updated', (stats) => {
  if (stats.availableBooths != null) document.getElementById('avail-count').textContent = stats.availableBooths;
  if (stats.availSqm != null) document.getElementById('avail-sqm').textContent = stats.availSqm.toLocaleString();
  updateStatsStrip();
});

socket.on('viewers:count', (n) => {
  document.getElementById('viewer-count').textContent = n;
});

socket.on('error:action', ({ message }) => console.warn(message));

function applyVisual(n) {
  const el = svgDoc?.querySelector(`[data-booth="${CSS.escape(n)}"]`);
  if (!el) return;

  const status = booths[n]?.status || 'sold';
  el.classList.remove('booth-available', 'booth-sold', 'booth-held');
  el.classList.add(`booth-${status}`);

  if (shortlist.includes(n)) el.classList.add('booth-shortlisted');
  else el.classList.remove('booth-shortlisted');

  // Exhibitor name painted onto the stand, as before. textContent, never
  // innerHTML — the value reaches here from the public enquiry form.
  let textNode = svgDoc.querySelector(`#text-booth-${CSS.escape(n)}`);
  const company = booths[n]?.company;

  if (status !== 'available' && company) {
    if (!textNode) {
      textNode = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      textNode.setAttribute('id', `text-booth-${n}`);
      textNode.setAttribute('text-anchor', 'middle');
      textNode.setAttribute('dominant-baseline', 'middle');
      textNode.setAttribute('fill', '#111827');
      textNode.setAttribute('font-size', '14px');
      textNode.setAttribute('font-family', 'Raleway, sans-serif');
      textNode.setAttribute('font-weight', '700');
      textNode.style.pointerEvents = 'none';
      el.parentNode.appendChild(textNode);
    }
    const bbox = el.getBBox();
    textNode.setAttribute('x', bbox.x + bbox.width / 2);
    textNode.setAttribute('y', bbox.y + bbox.height / 2);
    textNode.textContent = company.length > 20 ? company.substring(0, 18) + '…' : company;
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
    const res = await fetch('/sponsors/sponsors.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const cfg = await res.json();
    const list = Array.isArray(cfg.sponsors) ? cfg.sponsors.filter(s => s && s.image) : [];
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
