// ─── BluePrint EventPrint — Real-Time Floorplan Client ───────────────────────
// Loads the real SVG floorplan, tags every booth element, and connects
// everything to the Socket.io backend for live status updates.
//
// Colour convention from the actual floorplan:
//   cls-11 / cls-14 = YELLOW  → TAKEN (already booked)
//   cls-13          = WHITE   → AVAILABLE (for sale)
//
// Pricing: sqm × €600 per square meter

const socket = io();
const PRICE_PER_SQM = 600; // euros

// ─── State ────────────────────────────────────────────────────────────────────
let booths = {};          // { boothId: { status, company, sqm, price, viewers } }
let selectedBoothId = null;
let svgDoc = null;        // the live SVG DOM

// ─── Zoom / Pan ───────────────────────────────────────────────────────────────
let scale = 1, panX = 0, panY = 0;
let isPanning = false, startX = 0, startY = 0;

function applyTransform() {
  const target = document.getElementById('pan-zoom-target');
  if (target) target.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
}

document.getElementById('zoom-in').addEventListener('click', () => { scale = Math.min(scale * 1.25, 8); applyTransform(); });
document.getElementById('zoom-out').addEventListener('click', () => { scale = Math.max(scale / 1.25, 0.3); applyTransform(); });
document.getElementById('zoom-reset').addEventListener('click', () => { scale = 1; panX = 0; panY = 0; applyTransform(); });

const container = document.getElementById('floorplan-container');
container.addEventListener('mousedown', e => { isPanning = true; startX = e.clientX - panX; startY = e.clientY - panY; container.style.cursor = 'grabbing'; });
document.addEventListener('mouseup', () => { isPanning = false; container.style.cursor = 'grab'; });
document.addEventListener('mousemove', e => { if (!isPanning) return; panX = e.clientX - startX; panY = e.clientY - startY; applyTransform(); });
container.addEventListener('wheel', e => { e.preventDefault(); const delta = e.deltaY > 0 ? 0.9 : 1.1; scale = Math.min(Math.max(scale * delta, 0.3), 8); applyTransform(); }, { passive: false });

// ─── Load Real SVG + Booth Data ───────────────────────────────────────────────
let boothDataFromServer = {}; // loaded from booth_data.json (server-extracted)

async function loadFloorplan() {
  const mount = document.getElementById('svg-mount');
  try {
    // Load booth data JSON and SVG in parallel
    const [boothDataRes, svgRes] = await Promise.all([
      fetch('/booth_data.json'),
      fetch('/LEX26_Floorplan_Web-Format_57.svg')
    ]);

    boothDataFromServer = await boothDataRes.json();
    const svgText = await svgRes.text();

    mount.innerHTML = svgText;
    svgDoc = mount.querySelector('svg');
    svgDoc.setAttribute('width', '100%');
    svgDoc.setAttribute('height', '100%');
    svgDoc.style.display = 'block';
    svgDoc.style.maxWidth = '100%';
    svgDoc.style.maxHeight = '100%';

    tagBooths();
    lucide.createIcons();
  } catch (err) {
    mount.innerHTML = '<div style="color:#f87171;padding:20px;text-align:center;">Failed to load floorplan SVG.</div>';
    console.error('Load error:', err);
  }
}

// ─── Tag Every Booth in the SVG ───────────────────────────────────────────────
// White booths (cls-13) = AVAILABLE for sale
// Yellow booths (cls-11, cls-14) = TAKEN (already booked)
// We use the bounding box area to estimate sqm size and calculate price.
function tagBooths() {
  // Get white (available) booths
  const availableEls = svgDoc.querySelectorAll('.cls-13');
  // Get yellow (taken) booths
  const takenEls = svgDoc.querySelectorAll('.cls-11, .cls-14');

  let idx = 1;

  // Process available (white) booths first
  availableEls.forEach(el => {
    const boothId = `booth-${String(idx).padStart(3, '0')}`;
    // Use server-extracted data if available, fall back to bbox estimate
    const serverData = boothDataFromServer[boothId];
    const sqm   = serverData ? serverData.sqm   : estimateSqm(el);
    const price  = serverData ? serverData.price : sqm * PRICE_PER_SQM;

    el.setAttribute('data-booth-id', boothId);
    el.classList.add('booth-interactive');
    el.style.cursor = 'pointer';

    booths[boothId] = {
      id: boothId,
      status: 'available',
      company: null,
      sqm,
      price,
      viewers: 0
    };

    el.addEventListener('mouseenter', (e) => showTooltip(e, boothId));
    el.addEventListener('mousemove', (e) => moveTooltip(e));
    el.addEventListener('mouseleave', () => hideTooltip());
    el.addEventListener('click', (e) => { e.stopPropagation(); selectBooth(boothId); });

    idx++;
  });

  // Process taken (yellow) booths — not clickable for booking but visible
  takenEls.forEach(el => {
    const boothId = `booth-${String(idx).padStart(3, '0')}`;
    const sqm = estimateSqm(el);
    const price = sqm * PRICE_PER_SQM;

    el.setAttribute('data-booth-id', boothId);
    el.classList.add('booth-interactive', 'booth-taken-original');
    el.style.cursor = 'default';

    booths[boothId] = {
      id: boothId,
      status: 'sold',  // yellow = already taken
      company: 'Reserved',
      sqm,
      price,
      viewers: 0
    };

    // Still allow hover tooltip to show it's taken
    el.addEventListener('mouseenter', (e) => showTooltip(e, boothId));
    el.addEventListener('mousemove', (e) => moveTooltip(e));
    el.addEventListener('mouseleave', () => hideTooltip());

    idx++;
  });

  console.log(`Tagged ${availableEls.length} available + ${takenEls.length} taken booths`);
  populateDropdowns();
  renderAllBoothStatuses();
  updateStats();
}

// Estimate sqm from bounding box (SVG units → approximate m²)
// The SVG viewBox is 2594 × 2402 units representing a real expo floor.
// We use the rectangle area in SVG units, scaled appropriately.
// The numbers shown (9, 18, 21, etc.) are the actual m² from the designer.
// Without extractable text, we approximate from bbox area.
function estimateSqm(el) {
  try {
    const bbox = el.getBBox();
    const areaSvgUnits = bbox.width * bbox.height;
    // Calibration: a 50×50 SVG unit booth ≈ 9 sqm (smallest booth size)
    // 50*50 = 2500 SVG units² → 9 sqm → 1 sqm ≈ 277 SVG units²
    const sqm = Math.round(areaSvgUnits / 277);
    // Clamp to sensible expo booth sizes (min 9, max 200)
    return Math.max(9, Math.min(200, sqm));
  } catch (e) {
    return 18; // default
  }
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────
const tooltip = document.getElementById('booth-tooltip');
function showTooltip(e, boothId) {
  const b = booths[boothId];
  document.getElementById('tt-id').textContent = boothId.replace('booth-', 'Stand ');
  document.getElementById('tt-status').textContent = b ? capitalise(b.status) : 'Available';
  tooltip.classList.remove('hidden');
  moveTooltip(e);
}
function moveTooltip(e) {
  const rect = container.getBoundingClientRect();
  tooltip.style.left = (e.clientX - rect.left + 14) + 'px';
  tooltip.style.top  = (e.clientY - rect.top  - 10) + 'px';
}
function hideTooltip() { tooltip.classList.add('hidden'); }

// ─── Select a Booth ───────────────────────────────────────────────────────────
function selectBooth(boothId) {
  // Deselect previous
  if (selectedBoothId) {
    const prev = svgDoc.querySelector(`[data-booth-id="${selectedBoothId}"]`);
    if (prev) prev.classList.remove('booth-selected');
  }

  selectedBoothId = boothId;
  const el = svgDoc.querySelector(`[data-booth-id="${boothId}"]`);
  if (el) el.classList.add('booth-selected');

  // Notify server: viewer is looking at this booth
  socket.emit('booth:view', { boothId });

  renderBoothDetails(boothId);

  // Switch to buyer tab
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector('[data-tab="buyer"]').classList.add('active');
  document.getElementById('tab-buyer').classList.add('active');
}

// ─── Render Booth Detail Panel ────────────────────────────────────────────────
function renderBoothDetails(boothId) {
  const b = booths[boothId];
  if (!b) return;
  const display = document.getElementById('selected-booth-display');
  const isAvailable = b.status === 'available';
  const isHeld = b.status === 'held';
  const isSold = b.status === 'sold';

  display.innerHTML = `
    <div class="booth-detail-card">
      <div class="booth-detail-header">
        <div class="booth-detail-id">Stand ${boothId.replace('booth-', '')}</div>
        <div class="booth-status-badge status-${b.status}">${capitalise(b.status)}</div>
      </div>

      <div class="booth-detail-stats">
        <div class="detail-stat">
          <span class="detail-stat-label">Size</span>
          <span class="detail-stat-value">${b.sqm} m²</span>
        </div>
        <div class="detail-stat">
          <span class="detail-stat-label">Price</span>
          <span class="detail-stat-value">€${b.price.toLocaleString()}</span>
        </div>
        <div class="detail-stat">
          <span class="detail-stat-label">Rate</span>
          <span class="detail-stat-value">€600/m²</span>
        </div>
        <div class="detail-stat">
          <span class="detail-stat-label">Active Viewers</span>
          <span class="detail-stat-value" id="detail-viewers-${boothId}">${b.viewers}</span>
        </div>
        ${b.company && b.company !== 'Reserved' ? `
        <div class="detail-stat full-width">
          <span class="detail-stat-label">Company</span>
          <span class="detail-stat-value">${b.company}</span>
        </div>` : ''}
      </div>

      ${isAvailable ? `
      <form id="booking-form" class="console-form">
        <div class="form-group">
          <label for="company-name">Company Name</label>
          <input type="text" id="company-name" class="form-input" placeholder="e.g. Shell UK Ltd" required>
        </div>
        <div class="form-row">
          <button type="button" id="hold-btn" class="btn btn-warning flex-btn">
            <i data-lucide="clock"></i> Hold
          </button>
          <button type="submit" class="btn btn-primary flex-btn">
            <i data-lucide="check-circle"></i> Book Now
          </button>
        </div>
      </form>` : ''}

      ${isHeld ? `
      <div class="form-row" style="margin-top:12px;">
        <button id="confirm-btn" class="btn btn-primary flex-btn">
          <i data-lucide="check-circle"></i> Confirm Booking
        </button>
        <button id="release-btn" class="btn btn-secondary flex-btn">
          <i data-lucide="x"></i> Release Hold
        </button>
      </div>` : ''}

      ${isSold ? `
      <div class="booked-notice">
        <i data-lucide="lock"></i> This space is already booked.
      </div>` : ''}
    </div>
  `;

  lucide.createIcons();
  wireDetailButtons(boothId);
}

function wireDetailButtons(boothId) {
  const bookingForm = document.getElementById('booking-form');
  const holdBtn     = document.getElementById('hold-btn');
  const confirmBtn  = document.getElementById('confirm-btn');
  const releaseBtn  = document.getElementById('release-btn');

  if (bookingForm) {
    bookingForm.addEventListener('submit', e => {
      e.preventDefault();
      const company = document.getElementById('company-name').value.trim();
      if (!company) return;
      socket.emit('booth:book', { boothId, company });
    });
  }
  if (holdBtn) {
    holdBtn.addEventListener('click', () => {
      const company = document.getElementById('company-name')?.value.trim() || 'Pending';
      socket.emit('booth:hold', { boothId, company });
    });
  }
  if (confirmBtn) confirmBtn.addEventListener('click', () => socket.emit('booth:book', { boothId, company: booths[boothId]?.company || 'Confirmed' }));
  if (releaseBtn) releaseBtn.addEventListener('click', () => socket.emit('booth:release', { boothId }));
}

// ─── Apply Visual Status to All SVG Booths ───────────────────────────────────
function renderAllBoothStatuses() {
  if (!svgDoc) return;
  Object.values(booths).forEach(b => applyBoothVisual(b.id, b.status));
}

function applyBoothVisual(boothId, status) {
  const el = svgDoc?.querySelector(`[data-booth-id="${boothId}"]`);
  if (!el) return;

  el.classList.remove('booth-available', 'booth-sold', 'booth-held', 'booth-has-viewers');

  switch (status) {
    case 'available': el.classList.add('booth-available'); break;
    case 'sold':      el.classList.add('booth-sold');      break;
    case 'held':      el.classList.add('booth-held');      break;
  }

  if (booths[boothId]?.viewers > 0) el.classList.add('booth-has-viewers');
}

// ─── Populate Admin Dropdowns ─────────────────────────────────────────────────
function populateDropdowns() {
  const sel1 = document.getElementById('merge-booth-1');
  const sel2 = document.getElementById('merge-booth-2');
  const availableBooths = Object.values(booths).filter(b => b.status === 'available');

  [sel1, sel2].forEach(sel => {
    const current = sel.value;
    sel.innerHTML = '<option value="">Select space…</option>';
    availableBooths.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = b.id.replace('booth-', 'Stand ');
      sel.appendChild(opt);
    });
    sel.value = current;
  });
}

// ─── Stats Rendering ──────────────────────────────────────────────────────────
function updateStats() {
  const total   = Object.values(booths).length;
  const sold    = Object.values(booths).filter(b => b.status === 'sold').length;
  const revenue = Object.values(booths).filter(b => b.status === 'sold').reduce((s, b) => s + b.price, 0);
  const pct     = total > 0 ? Math.round((sold / total) * 100) : 0;

  document.getElementById('stat-revenue').textContent = `£${revenue.toLocaleString()}`;
  document.getElementById('stat-sold-ratio').textContent = `${pct}%`;
  document.getElementById('stat-sold-progress').style.width = `${pct}%`;
}

// ─── Event Log ────────────────────────────────────────────────────────────────
function addLog(msg, type = 'info') {
  const log = document.getElementById('event-log');
  const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.innerHTML = `<span class="log-time">${now}</span> ${msg}`;
  log.prepend(entry);
  while (log.children.length > 50) log.removeChild(log.lastChild);
}

// ─── Socket.io Events ─────────────────────────────────────────────────────────
socket.on('connect', () => {
  document.getElementById('connection-status').className = 'status-badge connected';
  document.querySelector('#connection-status .status-label').textContent = 'Live';
  addLog('Connected to real-time server.', 'system');
});

socket.on('disconnect', () => {
  document.getElementById('connection-status').className = 'status-badge disconnected';
  document.querySelector('#connection-status .status-label').textContent = 'Disconnected';
  addLog('Connection lost — reconnecting…', 'warning');
});

// Server sends full booth state on connect
socket.on('state:full', (serverBooths) => {
  serverBooths.forEach(b => {
    if (booths[b.id]) {
      booths[b.id] = { ...booths[b.id], ...b };
    }
  });
  renderAllBoothStatuses();
  updateStats();
  populateDropdowns();
});

socket.on('booth:updated', (b) => {
  if (!booths[b.id]) return;
  booths[b.id] = { ...booths[b.id], ...b };
  applyBoothVisual(b.id, b.status);
  updateStats();
  populateDropdowns();
  addLog(`Stand ${b.id.replace('booth-', '')} → <strong>${capitalise(b.status)}</strong>${b.company ? ` — ${b.company}` : ''}`, b.status);
  if (selectedBoothId === b.id) renderBoothDetails(b.id);
});

socket.on('booth:viewers', ({ boothId, viewers }) => {
  if (booths[boothId]) booths[boothId].viewers = viewers;
  applyBoothVisual(boothId, booths[boothId]?.status || 'available');
  const el = document.getElementById(`detail-viewers-${boothId}`);
  if (el) el.textContent = viewers;
  document.getElementById('stat-browsers').textContent = viewers;
});

socket.on('viewers:count', (count) => {
  document.getElementById('stat-browsers').textContent = count;
});

socket.on('booth:consolidated', ({ primary, secondary }) => {
  if (booths[secondary]) {
    booths[secondary].status = 'sold';
    applyBoothVisual(secondary, 'sold');
  }
  addLog(`Stands ${primary.replace('booth-','')} & ${secondary.replace('booth-','')} consolidated.`, 'system');
});

// ─── Admin: Consolidation Form ────────────────────────────────────────────────
document.getElementById('consolidation-form').addEventListener('submit', e => {
  e.preventDefault();
  const b1 = document.getElementById('merge-booth-1').value;
  const b2 = document.getElementById('merge-booth-2').value;
  if (!b1 || !b2 || b1 === b2) { addLog('Select two different spaces to consolidate.', 'warning'); return; }
  socket.emit('booth:consolidate', { primary: b1, secondary: b2 });
});

// ─── Tab Switching ────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ─── Reset Demo ───────────────────────────────────────────────────────────────
document.getElementById('reset-demo-btn').addEventListener('click', () => {
  socket.emit('demo:reset');
  addLog('Demo reset requested.', 'system');
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function capitalise(str) { return str ? str.charAt(0).toUpperCase() + str.slice(1) : ''; }

// ─── Boot ─────────────────────────────────────────────────────────────────────
loadFloorplan();
