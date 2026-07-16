// ─── BluePrint EventPrint — Public Floorplan JS ───────────────────────────────
const socket = io();
const PRICE_PER_SQM = 600;

let booths = {};
let selectedId = null;
let svgDoc = null;
let boothData = {};

// ─── Zoom / Pan ───────────────────────────────────────────────────────────────
let scale = 1, panX = 0, panY = 0, isPanning = false, startX = 0, startY = 0;
const frame  = document.getElementById('map-frame');
const inner  = document.getElementById('map-inner');

function applyTransform() { inner.style.transform = `translate(${panX}px,${panY}px) scale(${scale})`; }
document.getElementById('zoom-in').addEventListener('click',    () => { scale = Math.min(scale * 1.25, 8); applyTransform(); });
document.getElementById('zoom-out').addEventListener('click',   () => { scale = Math.max(scale / 1.25, 0.3); applyTransform(); });
document.getElementById('zoom-reset').addEventListener('click', () => { scale = 1; panX = 0; panY = 0; applyTransform(); });
frame.addEventListener('mousedown', e => { isPanning = true; startX = e.clientX - panX; startY = e.clientY - panY; frame.style.cursor = 'grabbing'; });
document.addEventListener('mouseup', () => { isPanning = false; frame.style.cursor = 'grab'; });
document.addEventListener('mousemove', e => { if (!isPanning) return; panX = e.clientX - startX; panY = e.clientY - startY; applyTransform(); });
frame.addEventListener('wheel', e => { e.preventDefault(); scale = Math.min(Math.max(scale * (e.deltaY > 0 ? 0.9 : 1.1), 0.3), 8); applyTransform(); }, { passive: false });

// ─── Load SVG + Data ──────────────────────────────────────────────────────────
async function load() {
  const mount = document.getElementById('svg-mount');
  try {
    const [bdRes, svgRes] = await Promise.all([
      fetch('/booth_data.json'),
      fetch('/LEX26_Floorplan_Web-Format_57.svg')
    ]);
    boothData = await bdRes.json();
    mount.innerHTML = await svgRes.text();
    svgDoc = mount.querySelector('svg');
    svgDoc.setAttribute('width', '100%');
    svgDoc.setAttribute('height', '100%');
    tagBooths();
    lucide.createIcons();
  } catch (e) {
    mount.innerHTML = '<p style="color:#f87171;padding:20px">Failed to load floorplan.</p>';
  }
}

// ─── Tag Booths ───────────────────────────────────────────────────────────────
function tagBooths() {
  const availEls = svgDoc.querySelectorAll('.cls-13');
  const takenEls = svgDoc.querySelectorAll('.cls-11, .cls-14');
  let idx = 1;

  availEls.forEach(el => {
    const id = `booth-${String(idx).padStart(3,'0')}`;
    const bd = boothData[id];
    el.setAttribute('data-id', id);
    el.classList.add('booth-interactive', 'booth-available');

    booths[id] = {
      id, status: 'available', company: null,
      sqm:   bd?.sqm   ?? estimateSqm(el),
      price: bd?.price ?? estimateSqm(el) * PRICE_PER_SQM,
      viewers: 0
    };

    el.addEventListener('mouseenter', e => showTooltip(e, id));
    el.addEventListener('mousemove',  e => moveTooltip(e));
    el.addEventListener('mouseleave', () => hideTooltip());
    el.addEventListener('click',      e => { e.stopPropagation(); selectBooth(id); });
    idx++;
  });

  takenEls.forEach(el => {
    const id = `booth-${String(idx).padStart(3,'0')}`;
    el.setAttribute('data-id', id);
    el.classList.add('booth-taken-orig', 'booth-sold');
    booths[id] = { id, status: 'sold', company: 'Reserved', sqm: estimateSqm(el), price: 0, viewers: 0 };
    el.addEventListener('mouseenter', e => showTooltip(e, id));
    el.addEventListener('mousemove',  e => moveTooltip(e));
    el.addEventListener('mouseleave', () => hideTooltip());
    idx++;
  });
}

function estimateSqm(el) {
  try { const b = el.getBBox(); return Math.max(9, Math.min(300, Math.round((b.width * b.height) / 283))); }
  catch { return 18; }
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────
const tooltip = document.getElementById('fp-tooltip');
function showTooltip(e, id) {
  const b = booths[id];
  document.getElementById('tt-label').textContent  = `Stand ${id.replace('booth-','')}`;
  document.getElementById('tt-status').textContent = cap(b.status);
  document.getElementById('tt-price').textContent  = b.status === 'available' ? `${b.sqm} m²` : '';
  tooltip.classList.remove('hidden');
  moveTooltip(e);
}
function moveTooltip(e) {
  const r = frame.getBoundingClientRect();
  tooltip.style.left = (e.clientX - r.left + 14) + 'px';
  tooltip.style.top  = (e.clientY - r.top  - 10) + 'px';
}
function hideTooltip() { tooltip.classList.add('hidden'); }

// ─── Select Booth ─────────────────────────────────────────────────────────────
function selectBooth(id) {
  if (selectedId) {
    svgDoc.querySelector(`[data-id="${selectedId}"]`)?.classList.remove('booth-selected');
  }
  selectedId = id;
  svgDoc.querySelector(`[data-id="${id}"]`)?.classList.add('booth-selected');
  socket.emit('booth:view', { boothId: id });
  
  // Track click with approximate location (timezone)
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  const loc = tz ? tz.split('/')[1]?.replace('_', ' ') || tz : 'Unknown Location';
  socket.emit('booth:click', { boothId: id, location: loc });
  
  renderPanel(id);
}

function renderPanel(id) {
  const b = booths[id];
  const panel = document.getElementById('booth-panel');
  const eq    = document.getElementById('enquiry-card');

  if (b.status !== 'available') {
    // Show taken notice
    panel.classList.remove('hidden');
    eq.classList.add('hidden');
    panel.innerHTML = `
      <div class="stand-header">
        <div class="stand-id">Stand ${id.replace('booth-','')}</div>
        <div class="stand-badge badge-${b.status}">${cap(b.status)}</div>
      </div>
      <div class="stand-stats">
        <div class="stand-stat"><span class="stand-stat-lbl">Size</span><span class="stand-stat-val">${b.sqm} m²</span></div>
        <div class="stand-stat"><span class="stand-stat-lbl">Status</span><span class="stand-stat-val">${cap(b.status)}</span></div>
      </div>
      <div class="stand-taken-notice">
        <i data-lucide="lock" style="width:14px;height:14px"></i>
        This stand is currently ${b.status === 'sold' ? 'booked' : 'on hold'}.
      </div>`;
    lucide.createIcons();
    return;
  }

  // Available booth
  panel.classList.remove('hidden');
  eq.classList.remove('hidden');
  panel.innerHTML = `
    <div class="stand-header">
      <div class="stand-id">Stand ${id.replace('booth-','')}</div>
      <div class="stand-badge badge-available">Available</div>
    </div>
    <div class="stand-stats">
      <div class="stand-stat"><span class="stand-stat-lbl">Size</span><span class="stand-stat-val">${b.sqm} m²</span></div>
      <div class="stand-stat"><span class="stand-stat-lbl">Live Viewers</span><span class="stand-stat-val" id="live-viewers-${id}">${b.viewers}</span></div>
      <div class="stand-stat"><span class="stand-stat-lbl">Total Clicks</span><span class="stand-stat-val" style="color:var(--orange)">${b.clicks} 🔥</span></div>
    </div>
    <p style="font-size:12px;color:var(--muted);margin-bottom:4px">Fill in your details below and our team will contact you with pricing and availability.</p>`;
  lucide.createIcons();

  // Wire form
  const form = document.getElementById('enquiry-form');
  document.getElementById('hold-btn').onclick = () => {
    const company = document.getElementById('eq-company').value.trim() || 'Enquiry';
    if (!company) return;
    socket.emit('booth:hold', { boothId: id, company });
  };
  form.onsubmit = e => {
    e.preventDefault();
    const company = document.getElementById('eq-company').value.trim();
    socket.emit('booth:book', { boothId: id, company });
  };
}

// ─── Socket Events ────────────────────────────────────────────────────────────
socket.on('state:full', (serverBooths) => {
  serverBooths.forEach(b => {
    if (booths[b.boothId]) {
      booths[b.boothId] = { ...booths[b.boothId], ...b };
      applyVisual(b.boothId);
    }
  });
  updateStatsStrip();
});

socket.on('booth:updated', (b) => {
  if (booths[b.boothId]) {
    booths[b.boothId] = { ...booths[b.boothId], ...b };
    applyVisual(b.boothId);
    if (selectedId === b.boothId) renderPanel(b.boothId);
    updateStatsStrip();
  }
});

socket.on('stats:updated', (stats) => {
  document.getElementById('avail-count').textContent = stats.availableBooths;
  document.getElementById('avail-sqm').textContent   = stats.availSqm.toLocaleString();
  updateStatsStrip(stats);
});

socket.on('viewers:count', (n) => {
  document.getElementById('viewer-count').textContent = n;
});

socket.on('booth:consolidated', ({ secondary }) => {
  const el = svgDoc?.querySelector(`[data-id="${secondary}"]`);
  if (el) el.style.visibility = 'hidden';
});

function applyVisual(id) {
  const el = svgDoc?.querySelector(`[data-id="${id}"]`);
  if (!el) return;
  el.classList.remove('booth-available','booth-sold','booth-held');
  const status = booths[id]?.status || 'available';
  el.classList.add(`booth-${status}`);

  // Company text overlay
  let textNode = svgDoc.querySelector(`#text-${id}`);
  const company = booths[id]?.company;

  if (status !== 'available' && company) {
    if (!textNode) {
      textNode = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      textNode.setAttribute('id', `text-${id}`);
      textNode.setAttribute('text-anchor', 'middle');
      textNode.setAttribute('dominant-baseline', 'middle');
      textNode.setAttribute('fill', '#111827');
      textNode.setAttribute('font-size', '14px');
      textNode.setAttribute('font-family', 'Plus Jakarta Sans, sans-serif');
      textNode.setAttribute('font-weight', '700');
      textNode.style.pointerEvents = 'none';
      el.parentNode.appendChild(textNode);
    }
    const bbox = el.getBBox();
    textNode.setAttribute('x', bbox.x + bbox.width / 2);
    textNode.setAttribute('y', bbox.y + bbox.height / 2);
    
    // Truncate if very long
    textNode.textContent = company.length > 20 ? company.substring(0, 18) + '...' : company;
  } else if (textNode) {
    textNode.remove();
  }
}

function updateStatsStrip(stats) {
  const all  = Object.values(booths);
  const avail = all.filter(b => b.status === 'available');
  const held  = all.filter(b => b.status === 'held');
  document.getElementById('stat-avail').textContent = avail.length;
  document.getElementById('stat-sqm').textContent   = avail.reduce((s,b) => s+b.sqm, 0).toLocaleString();
  document.getElementById('stat-held').textContent  = held.length;
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }

load();
