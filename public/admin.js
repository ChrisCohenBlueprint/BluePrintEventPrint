// ─── BluePrint EventPrint — Admin Dashboard JS ────────────────────────────────
const socket = io();

let booths  = {};  // live state
let svgDoc  = null;
let selectedAdminId = null;

// ─── Section Navigation ───────────────────────────────────────────────────────
const sectionTitles = {
  overview: 'Overview',
  floorplan: 'Floorplan',
  bookings: 'Bookings',
  tools: 'Tools',
  log: 'Activity Log'
};

document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', () => {
    const sec = link.dataset.section;
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
    link.classList.add('active');
    document.getElementById(`section-${sec}`).classList.add('active');
    document.getElementById('section-title').textContent = sectionTitles[sec];

    if (sec === 'floorplan' && !svgDoc) loadAdminSVG();
    if (sec === 'bookings') renderBookingsTable();
    if (sec === 'tools') populateToolDropdowns();
  });
});

// ─── Zoom / Pan (Admin Map) ───────────────────────────────────────────────────
const aFrame = document.getElementById('admin-map-frame');
const aInner = document.getElementById('admin-map-inner');

let pzAdmin;
function initAdminPanZoom() {
  pzAdmin = panzoom(aInner, {
    maxZoom: 8,
    minZoom: 0.3,
    bounds: true,
    boundsPadding: 0.1,
    zoomDoubleClickSpeed: 1
  });
  
  document.getElementById('admin-zoom-in').addEventListener('click', () => {
    const r = aFrame.getBoundingClientRect();
    pzAdmin.smoothZoom(r.width/2, r.height/2, 1.5);
  });
  document.getElementById('admin-zoom-out').addEventListener('click', () => {
    const r = aFrame.getBoundingClientRect();
    pzAdmin.smoothZoom(r.width/2, r.height/2, 0.66);
  });
  document.getElementById('admin-zoom-reset').addEventListener('click', () => {
    pzAdmin.moveTo(0, 0);
    pzAdmin.zoomAbs(0, 0, 1);
  });
}

// ─── Load Admin SVG ───────────────────────────────────────────────────────────
async function loadAdminSVG() {
  const mount = document.getElementById('admin-svg-mount');
  try {
    const [bdRes, svgRes] = await Promise.all([
      fetch('/booth_data.json'),
      fetch('/LEX26_Floorplan_Web-Format_57.svg')
    ]);
    const boothData = await bdRes.json();
    mount.innerHTML = await svgRes.text();
    svgDoc = mount.querySelector('svg');
    svgDoc.setAttribute('width', '100%');
    svgDoc.setAttribute('height', '100%');
    tagAdminBooths(boothData);
    lucide.createIcons();
    initAdminPanZoom();
  } catch (e) {
    mount.innerHTML = '<p style="color:#f87171;padding:20px">Failed to load.</p>';
  }
}

function tagAdminBooths(boothData) {
  const availEls = svgDoc.querySelectorAll('.cls-13');
  const takenEls = svgDoc.querySelectorAll('.cls-11, .cls-14');
  let idx = 1;

  // Tap helper — distinguishes tap (<12px movement) from pan
  function addAdminTap(el, id) {
    let sx, sy;
    el.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    el.addEventListener('touchend', e => {
      const dx = Math.abs(e.changedTouches[0].clientX - sx);
      const dy = Math.abs(e.changedTouches[0].clientY - sy);
      if (dx < 12 && dy < 12) { e.preventDefault(); e.stopPropagation(); selectAdminBooth(id); }
    });
  }

  availEls.forEach(el => {
    const id = `booth-${String(idx).padStart(3,'0')}`;
    const bd = boothData[id];
    el.setAttribute('data-id', id);
    el.classList.add('booth-interactive');
    applyAdminVisual(el, booths[id]?.status || 'available');
    el.addEventListener('mouseenter', e => showAdminTooltip(e, id));
    el.addEventListener('mousemove',  e => moveAdminTooltip(e));
    el.addEventListener('mouseleave', () => hideAdminTooltip());
    el.addEventListener('click', e => { e.stopPropagation(); selectAdminBooth(id); });
    addAdminTap(el, id);
    idx++;
  });

  takenEls.forEach(el => {
    const id = `booth-${String(idx).padStart(3,'0')}`;
    el.setAttribute('data-id', id);
    el.classList.add('booth-taken-orig');
    applyAdminVisual(el, booths[id]?.status || 'sold');
    el.addEventListener('mouseenter', e => showAdminTooltip(e, id));
    el.addEventListener('mousemove',  e => moveAdminTooltip(e));
    el.addEventListener('mouseleave', () => hideAdminTooltip());
    el.addEventListener('click', e => { e.stopPropagation(); selectAdminBooth(id); });
    addAdminTap(el, id);
    idx++;
  });
}

function applyAdminVisual(el, status) {
  el.classList.remove('booth-available','booth-sold','booth-held');
  el.classList.add(`booth-${status}`);

  const id = el.getAttribute('data-id');
  let textNode = svgDoc.querySelector(`#admin-text-${id}`);
  const company = booths[id]?.company;

  if (status !== 'available' && company) {
    if (!textNode) {
      textNode = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      textNode.setAttribute('id', `admin-text-${id}`);
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
    
    textNode.textContent = company.length > 20 ? company.substring(0, 18) + '...' : company;
  } else if (textNode) {
    textNode.remove();
  }
}

// ─── Admin Tooltip ────────────────────────────────────────────────────────────
const adminTooltip = document.getElementById('admin-tooltip');
function showAdminTooltip(e, id) {
  const b = booths[id];
  document.getElementById('att-label').textContent  = `Stand ${id.replace('booth-','')}`;
  document.getElementById('att-status').textContent = cap(b?.status || 'unknown');
  document.getElementById('att-price').textContent  = b ? `€${b.price?.toLocaleString()}` : '';
  adminTooltip.classList.remove('hidden');
  moveAdminTooltip(e);
}
function moveAdminTooltip(e) {
  const r = aFrame.getBoundingClientRect();
  adminTooltip.style.left = (e.clientX - r.left + 14) + 'px';
  adminTooltip.style.top  = (e.clientY - r.top  - 10) + 'px';
}
function hideAdminTooltip() { adminTooltip.classList.add('hidden'); }

// ─── Admin Select Booth ───────────────────────────────────────────────────────
function selectAdminBooth(id) {
  if (selectedAdminId) {
    svgDoc.querySelector(`[data-id="${selectedAdminId}"]`)?.classList.remove('booth-selected');
  }
  selectedAdminId = id;
  svgDoc.querySelector(`[data-id="${id}"]`)?.classList.add('booth-selected');
  renderAdminBoothAction(id);
}

function renderAdminBoothAction(id) {
  const b = booths[id];
  if (!b) return;
  const panel = document.getElementById('admin-booth-action');
  panel.classList.remove('hidden');
  document.getElementById('aba-id').textContent      = `Stand ${id.replace('booth-','')}`;
  document.getElementById('aba-status').textContent  = cap(b.status);
  document.getElementById('aba-sqm').textContent     = `${b.sqm} m²`;
  document.getElementById('aba-price').textContent   = `€${b.price?.toLocaleString()}`;
  document.getElementById('aba-company').textContent = b.company || '—';
  document.getElementById('aba-viewers').textContent = b.viewers || 0;
  document.getElementById('aba-clicks').textContent  = b.clicks || 0;

  const clickList = document.getElementById('aba-click-list');
  if (b.clickHistory && b.clickHistory.length > 0) {
    clickList.innerHTML = b.clickHistory.map(c => `<div>${new Date(c.time).toLocaleTimeString('en-GB')} — ${c.location}</div>`).join('');
  } else {
    clickList.innerHTML = '<div>No clicks yet.</div>';
  }

  document.getElementById('aba-book').onclick    = () => socket.emit('booth:book',    { boothId: id, company: prompt('Company name:') || 'Admin' });
  document.getElementById('aba-hold').onclick    = () => socket.emit('booth:hold',    { boothId: id, company: prompt('Company name:') || 'Pending' });
  document.getElementById('aba-release').onclick = () => socket.emit('booth:release', { boothId: id });
  document.getElementById('aba-export').onclick  = () => exportSingleCSV(id);
}

// ─── Bookings Table ───────────────────────────────────────────────────────────
function renderBookingsTable() {
  const tbody  = document.getElementById('bookings-tbody');
  const search = document.getElementById('bookings-search').value.toLowerCase();
  const filter = document.getElementById('bookings-filter').value;

  let rows = Object.values(booths).filter(b => {
    const matchFilter = filter === 'all' || b.status === filter;
    const matchSearch = !search ||
      b.boothId.toLowerCase().includes(search) ||
      (b.company || '').toLowerCase().includes(search);
    return matchFilter && matchSearch;
  });

  tbody.innerHTML = rows.map(b => `
    <tr>
      <td><strong>Stand ${b.boothId.replace('booth-','')}</strong></td>
      <td>${b.sqm} m²</td>
      <td>€${b.price?.toLocaleString()}</td>
      <td><span class="status-pill pill-${b.status}">${cap(b.status)}</span></td>
      <td>${b.company || '<span style="color:var(--muted)">—</span>'}</td>
      <td style="display:flex;gap:6px;flex-wrap:wrap;">
        ${b.status !== 'sold' ? `<button class="admin-btn success" style="font-size:11px;padding:5px 10px" onclick="adminAction('book','${b.boothId}')">Book</button>` : ''}
        ${b.status === 'available' ? `<button class="admin-btn warning" style="font-size:11px;padding:5px 10px" onclick="adminAction('hold','${b.boothId}')">Hold</button>` : ''}
        ${b.status !== 'available' ? `<button class="admin-btn" style="font-size:11px;padding:5px 10px" onclick="adminAction('release','${b.boothId}')">Release</button>` : ''}
        <button class="admin-btn" style="font-size:11px;padding:5px 10px;background:var(--glass-bg);border:1px solid var(--border);" onclick="exportSingleCSV('${b.boothId}')">⬇️ CSV</button>
      </td>
    </tr>`).join('');
}

function adminAction(action, boothId) {
  if (action === 'book')    socket.emit('booth:book',    { boothId, company: prompt('Company name:') || 'Admin' });
  if (action === 'hold')    socket.emit('booth:hold',    { boothId, company: prompt('Company name:') || 'Pending' });
  if (action === 'release') socket.emit('booth:release', { boothId });
}
window.adminAction = adminAction;

// Search/filter live update
document.getElementById('bookings-search').addEventListener('input', renderBookingsTable);
document.getElementById('bookings-filter').addEventListener('change', renderBookingsTable);

// ─── CSV Export ───────────────────────────────────────────────────────────────
function downloadCSV(dataArray, filename) {
  if (!dataArray || dataArray.length === 0) return;
  const headers = ['Stand', 'Size (m2)', 'Price (EUR)', 'Status', 'Company', 'Live Viewers', 'Total Clicks'];
  const rows = dataArray.map(b => [
    b.boothId.replace('booth-', ''),
    b.sqm,
    b.price || 0,
    b.status,
    `"${(b.company || '').replace(/"/g, '""')}"`,
    b.viewers || 0,
    b.clicks || 0
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
    const matchSearch = !search || b.boothId.toLowerCase().includes(search) || (b.company || '').toLowerCase().includes(search);
    return matchFilter && matchSearch;
  });
  
  downloadCSV(rows, 'blueprint_stands_export.csv');
};

function exportSingleCSV(boothId) {
  if (booths[boothId]) downloadCSV([booths[boothId]], `stand_${boothId.replace('booth-', '')}_export.csv`);
}
window.exportSingleCSV = exportSingleCSV;

// ─── Populate Tool Dropdowns ──────────────────────────────────────────────────
function populateToolDropdowns() {
  const avail = Object.values(booths).filter(b => b.status === 'available');
  const all   = Object.values(booths);

  ['merge-1','merge-2'].forEach(id => {
    const sel = document.getElementById(id);
    const cur = sel.value;
    sel.innerHTML = '<option value="">Select…</option>' +
      avail.map(b => `<option value="${b.boothId}">Stand ${b.boothId.replace('booth-','')}</option>`).join('');
    sel.value = cur;
  });

  const statusStand = document.getElementById('status-stand');
  const cur2 = statusStand.value;
  statusStand.innerHTML = '<option value="">Select…</option>' +
    all.map(b => `<option value="${b.boothId}">Stand ${b.boothId.replace('booth-','')}</option>`).join('');
  statusStand.value = cur2;
}

// ─── Consolidation Form ───────────────────────────────────────────────────────
document.getElementById('consolidation-form').addEventListener('submit', e => {
  e.preventDefault();
  const p = document.getElementById('merge-1').value;
  const s = document.getElementById('merge-2').value;
  if (!p || !s || p === s) return alert('Select two different available stands.');
  socket.emit('booth:consolidate', { primary: p, secondary: s });
});

// ─── Status Form ──────────────────────────────────────────────────────────────
document.getElementById('status-form').addEventListener('submit', e => {
  e.preventDefault();
  const boothId = document.getElementById('status-stand').value;
  const status  = document.getElementById('status-new').value;
  const company = document.getElementById('status-company').value.trim();
  if (!boothId) return;
  socket.emit('admin:setStatus', { boothId, status, company });
});

// ─── Reset ────────────────────────────────────────────────────────────────────
document.getElementById('reset-btn').addEventListener('click', () => {
  if (!confirm('Reset entire floorplan to original state?')) return;
  socket.emit('demo:reset');
});

// ─── Clear Log ────────────────────────────────────────────────────────────────
document.getElementById('clear-log').addEventListener('click', () => {
  document.getElementById('admin-log').innerHTML = '<div class="log-entry system"><span class="log-time">Now</span> Log cleared.</div>';
});

// ─── Socket Events ────────────────────────────────────────────────────────────
socket.on('state:full', (serverBooths) => {
  serverBooths.forEach(b => { booths[b.boothId] = b; });
  updateOverview();
  renderBookingsTable();
  populateToolDropdowns();
  // Update admin SVG if loaded
  if (svgDoc) {
    Object.values(booths).forEach(b => {
      const el = svgDoc.querySelector(`[data-id="${b.boothId}"]`);
      if (el) applyAdminVisual(el, b.status);
    });
  }
});

socket.on('booth:updated', (b) => {
  booths[b.boothId] = { ...booths[b.boothId], ...b };
  updateOverview();
  renderBookingsTable();
  if (svgDoc) {
    const el = svgDoc.querySelector(`[data-id="${b.boothId}"]`);
    if (el) applyAdminVisual(el, b.status);
  }
  if (selectedAdminId === b.boothId) renderAdminBoothAction(b.boothId);
});

socket.on('stats:updated', (stats) => {
  updateOverviewFromStats(stats);
});

socket.on('booth:consolidated', ({ secondary }) => {
  delete booths[secondary];
  renderBookingsTable();
  populateToolDropdowns();
  if (svgDoc) {
    const el = svgDoc.querySelector(`[data-id="${secondary}"]`);
    if (el) el.style.visibility = 'hidden';
  }
});

socket.on('viewers:count', (n) => {
  document.getElementById('conn-count').textContent = n;
});

socket.on('log:entry', ({ msg, type, time }) => {
  addLog(msg, type, time);
});

// ─── Update Overview KPIs ─────────────────────────────────────────────────────
function updateOverview() {
  const all   = Object.values(booths);
  const avail = all.filter(b => b.status === 'available');
  const sold  = all.filter(b => b.status === 'sold');
  const held  = all.filter(b => b.status === 'held');

  const totalSqm   = all.reduce((s,b) => s + (b.sqm||0), 0);
  const availSqm   = avail.reduce((s,b) => s + (b.sqm||0), 0);
  const soldSqm    = sold.reduce((s,b) => s + (b.sqm||0), 0);
  const heldSqm    = held.reduce((s,b) => s + (b.sqm||0), 0);
  const earnedRev  = sold.reduce((s,b) => s + (b.price||0), 0);
  const availRev   = avail.reduce((s,b) => s + (b.price||0), 0);
  const heldRev    = held.reduce((s,b) => s + (b.price||0), 0);
  const totalRev   = all.reduce((s,b) => s + (b.price||0), 0);
  const fillPct    = totalSqm > 0 ? Math.round(((soldSqm + heldSqm) / totalSqm) * 100) : 0;
  const soldPct    = totalSqm > 0 ? Math.round((soldSqm / totalSqm) * 100) : 0;
  const heldPct    = totalSqm > 0 ? Math.round((heldSqm / totalSqm) * 100) : 0;

  el('kpi-earned').textContent    = `€${earnedRev.toLocaleString()}`;
  el('kpi-earned-sqm').textContent = `${soldSqm.toLocaleString()} m² sold`;
  el('kpi-avail-sqm').textContent = `${availSqm.toLocaleString()} m²`;
  el('kpi-avail-rev').textContent = `€${availRev.toLocaleString()} potential`;
  el('kpi-held-sqm').textContent  = `${heldSqm.toLocaleString()} m²`;
  el('kpi-held-count').textContent = `${held.length} stands`;
  el('kpi-total-sqm').textContent = `${totalSqm.toLocaleString()} m²`;
  el('kpi-total-booths').textContent = `${all.length} stands`;
  el('fill-pct').textContent      = `${fillPct}%`;
  el('fill-bar-sold').style.width = `${soldPct}%`;
  el('fill-bar-held').style.width = `${heldPct}%`;
  el('rev-booked').textContent    = `€${earnedRev.toLocaleString()}`;
  el('rev-held').textContent      = `€${heldRev.toLocaleString()}`;
  el('rev-avail').textContent     = `€${availRev.toLocaleString()}`;
  el('rev-total').textContent     = `€${totalRev.toLocaleString()}`;
}

function updateOverviewFromStats(s) {
  el('kpi-earned').textContent    = `€${s.earnedRev.toLocaleString()}`;
  el('kpi-earned-sqm').textContent = `${s.soldSqm.toLocaleString()} m² sold`;
  el('kpi-avail-sqm').textContent = `${s.availSqm.toLocaleString()} m²`;
  el('kpi-avail-rev').textContent = `€${s.availRev.toLocaleString()} potential`;
  el('kpi-held-sqm').textContent  = `${s.heldSqm.toLocaleString()} m²`;
  el('kpi-held-count').textContent = `${s.heldBooths} stands`;
  el('kpi-total-sqm').textContent = `${s.totalSqm.toLocaleString()} m²`;
  el('kpi-total-booths').textContent = `${s.totalBooths} stands`;
  const pct  = s.totalSqm > 0 ? Math.round(((s.soldSqm + s.heldSqm) / s.totalSqm) * 100) : 0;
  const sold = s.totalSqm > 0 ? Math.round((s.soldSqm / s.totalSqm) * 100) : 0;
  const held = s.totalSqm > 0 ? Math.round((s.heldSqm / s.totalSqm) * 100) : 0;
  el('fill-pct').textContent      = `${pct}%`;
  el('fill-bar-sold').style.width = `${sold}%`;
  el('fill-bar-held').style.width = `${held}%`;
  el('rev-booked').textContent    = `€${s.earnedRev.toLocaleString()}`;
  el('rev-held').textContent      = `€${s.heldRev.toLocaleString()}`;
  el('rev-avail').textContent     = `€${s.availRev.toLocaleString()}`;
  el('rev-total').textContent     = `€${s.totalRevenue.toLocaleString()}`;
}

// ─── Activity Log ─────────────────────────────────────────────────────────────
function addLog(msg, type = 'info', time = new Date().toLocaleTimeString('en-GB')) {
  const log   = document.getElementById('admin-log');
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.innerHTML = `<span class="log-time">${time}</span> ${msg}`;
  log.prepend(entry);
  while (log.children.length > 100) log.removeChild(log.lastChild);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function el(id)  { return document.getElementById(id); }
function cap(s)  { return s ? s[0].toUpperCase() + s.slice(1) : ''; }
