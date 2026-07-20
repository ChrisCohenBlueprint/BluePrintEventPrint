// ─── BluePrint EventPrint — Admin Dashboard JS ────────────────────────────────
const socket = io();

let booths = {};  // live state
let svgDoc = null;
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

  function addAdminTap(el, callback) {
    let startX, startY;
    el.addEventListener('pointerdown', e => {
      startX = e.clientX;
      startY = e.clientY;
    });
    el.addEventListener('pointerup', e => {
      if (Math.abs(e.clientX - startX) < 10 && Math.abs(e.clientY - startY) < 10) {
        e.stopPropagation();
        callback();
      }
    });
  }

  availEls.forEach(el => {
    const id = String(idx).padStart(3, '0');
    el.setAttribute('data-booth', id);
    el.classList.add('booth-interactive');
    applyAdminVisual(el, booths[id]?.status || 'available');
    el.addEventListener('mouseenter', e => showAdminTooltip(e, id));
    el.addEventListener('mousemove', e => moveAdminTooltip(e));
    el.addEventListener('mouseleave', () => hideAdminTooltip());
    addAdminTap(el, () => selectAdminBooth(id));
    idx++;
  });

  takenEls.forEach(el => {
    const id = String(idx).padStart(3, '0');
    el.setAttribute('data-booth', id);
    el.classList.add('booth-taken-orig');
    applyAdminVisual(el, booths[id]?.status || 'sold');
    el.addEventListener('mouseenter', e => showAdminTooltip(e, id));
    el.addEventListener('mousemove', e => moveAdminTooltip(e));
    el.addEventListener('mouseleave', () => hideAdminTooltip());
    addAdminTap(el, () => selectAdminBooth(id));
    idx++;
  });
}

function applyAdminVisual(el, status) {
  el.classList.remove('booth-available', 'booth-sold', 'booth-held');
  el.classList.add(`booth-${status}`);

  const id = el.getAttribute('data-booth');
  let textNode = svgDoc.querySelector(`#admin-text-${id}`);
  const company = dealOf(booths[id]).company;

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
  document.getElementById('att-label').textContent = `Stand ${id}`;
  document.getElementById('att-status').textContent = cap(b?.status || 'unknown');
  document.getElementById('att-price').textContent = b ? `€${b.listPrice?.toLocaleString()}` : '';
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
  if (selectedAdminId) {
    svgDoc.querySelector(`[data-booth="${selectedAdminId}"]`)?.classList.remove('booth-selected');
  }
  selectedAdminId = id;
  svgDoc.querySelector(`[data-booth="${id}"]`)?.classList.add('booth-selected');
  renderAdminBoothAction(id);
}

// Commercial fields now live under `assignment` on the booth document.
const dealOf = (b) => (b && b.assignment) || {};

function renderAdminBoothAction(n) {
  const b = booths[n];
  if (!b) return;
  const d = dealOf(b);
  const panel = document.getElementById('admin-booth-action');
  panel.classList.remove('hidden');

  document.getElementById('aba-id').textContent      = `Stand ${n}`;
  document.getElementById('aba-status').textContent  = cap(b.status);
  document.getElementById('aba-sqm').textContent     = `${b.sqm} m²`;
  document.getElementById('aba-price').textContent   = `€${(b.listPrice || 0).toLocaleString()}`;
  document.getElementById('aba-company').textContent = d.company || '—';
  document.getElementById('aba-viewers').textContent = b.viewers || 0;
  document.getElementById('aba-clicks').textContent  = b.clicks || 0;

  // Click history is no longer a 20-entry array on the booth; it comes from the
  // activity stream, so it survives restarts and is not capped.
  const clickList = document.getElementById('aba-click-list');
  clickList.textContent = 'Loading…';
  fetch(`/api/booths/${encodeURIComponent(n)}/activity?limit=20`)
    .then(r => r.ok ? r.json() : [])
    .then(rows => {
      clickList.replaceChildren();
      if (!rows.length) { clickList.textContent = 'No activity yet.'; return; }
      rows.forEach(r => {
        const div = document.createElement('div');
        const country = r.context?.country ? ` · ${r.context.country}` : '';
        div.textContent = `${new Date(r.ts).toLocaleString('en-GB')} — ${r.type}${country}`;
        clickList.appendChild(div);
      });
    })
    .catch(() => { clickList.textContent = 'Could not load activity.'; });

  document.getElementById('aba-book').onclick    = () => adminAction('book', n);
  document.getElementById('aba-hold').onclick    = () => adminAction('hold', n);
  document.getElementById('aba-release').onclick = () => adminAction('release', n);
  document.getElementById('aba-export').onclick  = () => exportSingleCSV(n);

  document.getElementById('aba-actual-price').value = d.actualPrice ?? '';
  document.getElementById('aba-notes').value        = d.notes ?? '';
  document.getElementById('aba-save-deal').onclick  = () => {
    const actualPrice = parseFloat(document.getElementById('aba-actual-price').value) || null;
    const notes = document.getElementById('aba-notes').value.trim();
    socket.emit('booth:update-deal', { boothNumber: n, actualPrice, notes });
    const btn = document.getElementById('aba-save-deal');
    btn.textContent = '✅ Saved!';
    setTimeout(() => { btn.textContent = '💾 Save Deal Details'; }, 2000);
  };
}

// ─── Bookings table ───────────────────────────────────────────────────────────
// Built with DOM nodes rather than an interpolated HTML string. Company names
// and notes originate from the public enquiry form, so treating them as markup
// made the admin dashboard executable by anyone who could submit the form.
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

function renderBookingsTable() {
  const tbody  = document.getElementById('bookings-tbody');
  const search = document.getElementById('bookings-search').value.toLowerCase();
  const filter = document.getElementById('bookings-filter').value;

  const rows = Object.values(booths).filter(b => {
    const d = dealOf(b);
    const matchFilter = filter === 'all' || b.status === filter;
    const matchSearch = !search ||
      String(b.boothNumber).toLowerCase().includes(search) ||
      (d.company || '').toLowerCase().includes(search);
    return matchFilter && matchSearch;
  });

  tbody.replaceChildren();

  rows.forEach(b => {
    const d  = dealOf(b);
    const n  = b.boothNumber;
    const tr = document.createElement('tr');

    const stand = cell(tr);
    const strong = document.createElement('strong');
    strong.textContent = `Stand ${n}`;
    stand.appendChild(strong);

    cell(tr).textContent = `${b.sqm} m²`;
    cell(tr).textContent = `€${(b.listPrice || 0).toLocaleString()}`;

    const priceTd = cell(tr);
    const priceIn = document.createElement('input');
    priceIn.type = 'number';
    priceIn.className = 'admin-input';
    priceIn.placeholder = 'Price…';
    priceIn.value = d.actualPrice ?? '';
    priceIn.style.cssText = 'width:80px;padding:4px 8px;font-size:12px;background:var(--bg);';
    priceIn.dataset.field = 'price';
    priceIn.dataset.booth = n;
    priceTd.appendChild(priceIn);

    const statusTd = cell(tr);
    const pill = document.createElement('span');
    pill.className = `status-pill pill-${b.status}`;
    pill.textContent = cap(b.status);
    statusTd.appendChild(pill);

    const companyTd = cell(tr);
    if (d.company) {
      companyTd.textContent = d.company;
    } else {
      const dash = document.createElement('span');
      dash.style.color = 'var(--muted)';
      dash.textContent = '—';
      companyTd.appendChild(dash);
    }

    const notesTd = cell(tr);
    const notesIn = document.createElement('input');
    notesIn.type = 'text';
    notesIn.className = 'admin-input';
    notesIn.placeholder = 'Notes…';
    notesIn.value = d.notes ?? '';
    notesIn.style.cssText = 'width:140px;padding:4px 8px;font-size:12px;background:var(--bg);';
    notesIn.dataset.field = 'notes';
    notesIn.dataset.booth = n;
    notesTd.appendChild(notesIn);

    const actions = cell(tr);
    actions.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
    if (b.status !== 'sold')      actionButton(actions, 'Book',    'success', 'book',    n);
    if (b.status === 'available') actionButton(actions, 'Hold',    'warning', 'hold',    n);
    if (b.status !== 'available') actionButton(actions, 'Release', '',        'release', n);
    const csv = actionButton(actions, '⬇️ CSV', '', 'csv', n);
    csv.style.cssText += ';background:var(--glass-bg);border:1px solid var(--border);';

    tbody.appendChild(tr);
  });
}

// Delegation, so no handler names are exposed on `window` and no user data is
// ever interpolated into an attribute.
document.getElementById('bookings-tbody').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const n = btn.dataset.booth;
  if (btn.dataset.action === 'csv') exportSingleCSV(n);
  else adminAction(btn.dataset.action, n);
});

document.getElementById('bookings-tbody').addEventListener('change', (e) => {
  const input = e.target.closest('input[data-field]');
  if (!input) return;
  inlineUpdateDeal(input.dataset.booth, input.dataset.field, input.value);
});

function adminAction(action, boothNumber) {
  if (action === 'book') {
    const company = prompt('Company name:');
    if (company === null) return;
    socket.emit('booth:book', { boothNumber, company: company.trim() || 'Admin' });
  }
  if (action === 'hold') {
    const company = prompt('Company name:');
    if (company === null) return;
    const hours = parseFloat(prompt('Hold for how many hours?', '24')) || 24;
    socket.emit('booth:hold', { boothNumber, company: company.trim() || 'Pending', hours });
  }
  if (action === 'release') socket.emit('booth:release', { boothNumber });
}

function inlineUpdateDeal(boothNumber, field, value) {
  const b = booths[boothNumber];
  if (!b) return;
  const d = dealOf(b);
  const actualPrice = field === 'price' ? (parseFloat(value) || null) : d.actualPrice;
  const notes       = field === 'notes' ? value : d.notes;
  socket.emit('booth:update-deal', { boothNumber, actualPrice, notes });
}

// Search/filter live update
document.getElementById('bookings-search').addEventListener('input', renderBookingsTable);
document.getElementById('bookings-filter').addEventListener('change', renderBookingsTable);

// ─── CSV Export ───────────────────────────────────────────────────────────────
function downloadCSV(dataArray, filename) {
  if (!dataArray || dataArray.length === 0) return;
  const headers = ['Stand', 'Size (m2)', 'Listed Price (EUR)', 'Deal Price (EUR)', 'Status', 'Company', 'Notes', 'Live Viewers', 'Total Clicks'];
  const rows = dataArray.map(b => [
    b.boothNumber,
    b.sqm,
    b.listPrice || 0,
    dealOf(b).actualPrice ?? '',
    b.status,
    `"${(dealOf(b).company || '').replace(/"/g, '""')}"`,
    `"${(dealOf(b).notes || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`,
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
    const matchSearch = !search || b.boothNumber.toLowerCase().includes(search) || (dealOf(b).company || '').toLowerCase().includes(search);
    return matchFilter && matchSearch;
  });

  downloadCSV(rows, 'blueprint_stands_export.csv');
};

function exportSingleCSV(boothNumber) {
  if (booths[boothNumber]) downloadCSV([booths[boothNumber]], `stand_${boothNumber}_export.csv`);
}
window.exportSingleCSV = exportSingleCSV;

// ─── Populate Tool Dropdowns ──────────────────────────────────────────────────
function populateToolDropdowns() {
  const avail = Object.values(booths).filter(b => b.status === 'available');
  const all = Object.values(booths);

  ['merge-1', 'merge-2'].forEach(id => {
    const sel = document.getElementById(id);
    const cur = sel.value;
    sel.innerHTML = '<option value="">Select…</option>' +
      avail.map(b => `<option value="${b.boothNumber}">Stand ${b.boothNumber}</option>`).join('');
    sel.value = cur;
  });

  const statusStand = document.getElementById('status-stand');
  const cur2 = statusStand.value;
  statusStand.innerHTML = '<option value="">Select…</option>' +
    all.map(b => `<option value="${b.boothNumber}">Stand ${b.boothNumber}</option>`).join('');
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
  const boothNumber = document.getElementById('status-stand').value;
  const status = document.getElementById('status-new').value;
  const company = document.getElementById('status-company').value.trim();
  if (!boothNumber) return;
  socket.emit('admin:setStatus', { boothNumber, status, company });
});

// ─── Reset ────────────────────────────────────────────────────────────────────
// The bulk reset has been removed. It wiped all 272 booths in one call and was
// reachable from any anonymous browser console. Bookings now live in MongoDB;
// to reseed geometry run `node scripts/migrate.js`, which preserves commercial
// state. Individual stands are released from the Bookings table.
document.getElementById('reset-btn')?.remove();

// ─── Clear Log ────────────────────────────────────────────────────────────────
document.getElementById('clear-log').addEventListener('click', () => {
  document.getElementById('admin-log').innerHTML = '<div class="log-entry system"><span class="log-time">Now</span> Log cleared.</div>';
});

// ─── Socket Events ────────────────────────────────────────────────────────────
socket.on('state:full', (serverBooths) => {
  serverBooths.forEach(b => { booths[b.boothNumber] = b; });
  updateOverview();
  renderBookingsTable();
  populateToolDropdowns();
  // Update admin SVG if loaded
  if (svgDoc) {
    Object.values(booths).forEach(b => {
      const el = svgDoc.querySelector(`[data-booth="${b.boothNumber}"]`);
      if (el) applyAdminVisual(el, b.status);
    });
  }
});

socket.on('booth:updated', (b) => {
  booths[b.boothNumber] = { ...booths[b.boothNumber], ...b };
  updateOverview();
  renderBookingsTable();
  if (svgDoc) {
    const el = svgDoc.querySelector(`[data-booth="${b.boothNumber}"]`);
    if (el) applyAdminVisual(el, b.status);
  }
  if (selectedAdminId === b.boothNumber) renderAdminBoothAction(b.boothNumber);
});

socket.on('stats:updated', (stats) => {
  updateOverviewFromStats(stats);
});

socket.on('booth:consolidated', ({ secondary }) => {
  delete booths[secondary];
  renderBookingsTable();
  populateToolDropdowns();
  if (svgDoc) {
    const el = svgDoc.querySelector(`[data-booth="${secondary}"]`);
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
  const all = Object.values(booths);
  const avail = all.filter(b => b.status === 'available');
  const sold = all.filter(b => b.status === 'sold');
  const held = all.filter(b => b.status === 'held');

  const totalSqm = all.reduce((s, b) => s + (b.sqm || 0), 0);
  const availSqm = avail.reduce((s, b) => s + (b.sqm || 0), 0);
  const soldSqm = sold.reduce((s, b) => s + (b.sqm || 0), 0);
  const heldSqm = held.reduce((s, b) => s + (b.sqm || 0), 0);
  const earnedRev = sold.reduce((s, b) => s + (b.listPrice || 0), 0);
  const availRev = avail.reduce((s, b) => s + (b.listPrice || 0), 0);
  const heldRev = held.reduce((s, b) => s + (b.listPrice || 0), 0);
  const totalRev = all.reduce((s, b) => s + (b.listPrice || 0), 0);
  const fillPct = totalSqm > 0 ? Math.round(((soldSqm + heldSqm) / totalSqm) * 100) : 0;
  const soldPct = totalSqm > 0 ? Math.round((soldSqm / totalSqm) * 100) : 0;
  const heldPct = totalSqm > 0 ? Math.round((heldSqm / totalSqm) * 100) : 0;

  el('kpi-earned').textContent = `€${earnedRev.toLocaleString()}`;
  el('kpi-earned-sqm').textContent = `${soldSqm.toLocaleString()} m² sold`;
  el('kpi-avail-sqm').textContent = `${availSqm.toLocaleString()} m²`;
  el('kpi-avail-rev').textContent = `€${availRev.toLocaleString()} potential`;
  el('kpi-held-sqm').textContent = `${heldSqm.toLocaleString()} m²`;
  el('kpi-held-count').textContent = `${held.length} stands`;
  el('kpi-total-sqm').textContent = `${totalSqm.toLocaleString()} m²`;
  el('kpi-total-booths').textContent = `${all.length} stands`;
  el('fill-pct').textContent = `${fillPct}%`;
  el('fill-bar-sold').style.width = `${soldPct}%`;
  el('fill-bar-held').style.width = `${heldPct}%`;
  el('rev-booked').textContent = `€${earnedRev.toLocaleString()}`;
  el('rev-held').textContent = `€${heldRev.toLocaleString()}`;
  el('rev-avail').textContent = `€${availRev.toLocaleString()}`;
  el('rev-total').textContent = `€${totalRev.toLocaleString()}`;
}

function updateOverviewFromStats(s) {
  el('kpi-earned').textContent = `€${s.earnedRev.toLocaleString()}`;
  el('kpi-earned-sqm').textContent = `${s.soldSqm.toLocaleString()} m² sold`;
  el('kpi-avail-sqm').textContent = `${s.availSqm.toLocaleString()} m²`;
  el('kpi-avail-rev').textContent = `€${s.availRev.toLocaleString()} potential`;
  el('kpi-held-sqm').textContent = `${s.heldSqm.toLocaleString()} m²`;
  el('kpi-held-count').textContent = `${s.heldBooths} stands`;
  el('kpi-total-sqm').textContent = `${s.totalSqm.toLocaleString()} m²`;
  el('kpi-total-booths').textContent = `${s.totalBooths} stands`;
  const pct = s.totalSqm > 0 ? Math.round(((s.soldSqm + s.heldSqm) / s.totalSqm) * 100) : 0;
  const sold = s.totalSqm > 0 ? Math.round((s.soldSqm / s.totalSqm) * 100) : 0;
  const held = s.totalSqm > 0 ? Math.round((s.heldSqm / s.totalSqm) * 100) : 0;
  el('fill-pct').textContent = `${pct}%`;
  el('fill-bar-sold').style.width = `${sold}%`;
  el('fill-bar-held').style.width = `${held}%`;
  el('rev-booked').textContent = `€${s.earnedRev.toLocaleString()}`;
  el('rev-held').textContent = `€${s.heldRev.toLocaleString()}`;
  el('rev-avail').textContent = `€${s.availRev.toLocaleString()}`;
  el('rev-total').textContent = `€${s.totalRevenue.toLocaleString()}`;
}

// ─── Activity Log ─────────────────────────────────────────────────────────────
function addLog(msg, type = 'info', time = new Date().toLocaleTimeString('en-GB')) {
  const log = document.getElementById('admin-log');
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.innerHTML = `<span class="log-time">${time}</span> ${msg}`;
  log.prepend(entry);
  while (log.children.length > 100) log.removeChild(log.lastChild);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }

