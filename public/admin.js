// ─── BluePrint EventPrint — Admin Dashboard JS ────────────────────────────────
const socket = io();

// Show who is signed in.
let currentUser = null;
fetch('/api/me').then(r=>r.ok?r.json():null).then(u=>{if(u){currentUser=u.user;document.getElementById('nav-username').textContent=u.user;}}).catch(()=>{});

// Prime the sponsor catalogue so lead detail can name sponsorship interests
// without waiting for the Sponsors tab to be opened.
let sponsorAdminCache = [];
fetch('/api/sponsors').then(r=>r.ok?r.json():[]).then(list=>{sponsorAdminCache=list||[];}).catch(()=>{});

// The sales team an enquiry can be forwarded to, plus the manager who is copied.
let salesTeamCache = { team: [], manager: null };
fetch('/api/sales-team').then(r=>r.ok?r.json():null).then(d=>{if(d)salesTeamCache=d;}).catch(()=>{});

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
    const res = await fetch(`/api/inquiries/${encodeURIComponent(id)}/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'send failed');

    // Open a pre-addressed email so it can be sent immediately.
    const mailto = `mailto:${encodeURIComponent(d.to)}`
      + `?cc=${encodeURIComponent(d.cc)}`
      + `&subject=${encodeURIComponent(d.subject)}`
      + `&body=${encodeURIComponent(d.body)}`;
    window.location.href = mailto;

    adminToast(d.webhook
      ? `Sent to ${name} (and copied to ${salesTeamCache.manager?.name}). Your email client has also opened a copy.`
      : `Email to ${name} opened, copying ${salesTeamCache.manager?.name}. Send it from your mail client.`, 'ok');
    loadLeads();
  } catch (e) {
    adminToast(e.message || 'Could not send.', 'error');
  } finally {
    btn.disabled = false; btn.innerHTML = original; lucide.createIcons();
  }
}

let booths = {};  // live state
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
    if (sec === 'leads') loadLeads();
    if (sec === 'analytics') loadAnalytics();
    if (sec === 'sponsors') loadSponsorsAdmin();
    if (sec === 'team') loadTeam();
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
let adminSvgReady = false;
let adminTagged = false;

async function loadAdminSVG() {
  const mount = document.getElementById('admin-svg-mount');
  try {
    const svgRes = await fetch('/LEX26_Floorplan_Web-Format_57.svg');
    mount.innerHTML = await svgRes.text();
    svgDoc = mount.querySelector('svg');
    svgDoc.setAttribute('width', '100%');
    svgDoc.setAttribute('height', '100%');
    adminSvgReady = true;
    tagAdminBooths();
    lucide.createIcons();
    initAdminPanZoom();
  } catch (e) {
    mount.innerHTML = '<p style="color:#f87171;padding:20px">Failed to load.</p>';
  }
}

function addAdminTap(el, callback) {
  let startX, startY;
  el.addEventListener('pointerdown', e => { startX = e.clientX; startY = e.clientY; });
  el.addEventListener('pointerup', e => {
    if (Math.abs(e.clientX - startX) < 10 && Math.abs(e.clientY - startY) < 10) {
      e.stopPropagation();
      callback();
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

  BoothMap.attach(svgDoc, Object.values(booths).filter(b => b.geometry), {
    onTag(el, id) {
      el.classList.add('booth-interactive');
      applyAdminVisual(el, booths[id]?.status || 'sold');
      el.addEventListener('mouseenter', e => showAdminTooltip(e, id));
      el.addEventListener('mousemove', e => moveAdminTooltip(e));
      el.addEventListener('mouseleave', () => hideAdminTooltip());
      addAdminTap(el, () => selectAdminBooth(id));
    },
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
    const btn = document.getElementById('aba-save-deal');
    btn.disabled = true; btn.textContent = 'Saving…';
    // Confirm from the server rather than claiming success on emit. Previously
    // this showed "✅ Saved!" even when the write failed.
    socket.emit('booth:update-deal', { boothNumber: n, actualPrice, notes }, (res) => {
      btn.disabled = false;
      if (res && res.ok) {
        btn.textContent = '✅ Saved!';
        setTimeout(() => { btn.textContent = '💾 Save Deal Details'; }, 2000);
      } else {
        btn.textContent = '💾 Save Deal Details';
        adminToast((res && res.error) || 'Could not save deal details.', 'error');
      }
    });
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
  const done = (verb) => (res) => {
    if (res && res.ok) adminToast(`Stand ${boothNumber} ${verb}.`, 'ok');
    else adminToast((res && res.error) || `Could not ${action} stand ${boothNumber}.`, 'error');
  };
  if (action === 'book') {
    const company = prompt('Company name:');
    if (company === null) return;
    socket.emit('booth:book', { boothNumber, company: company.trim() || 'Admin' }, done('booked'));
  }
  if (action === 'hold') {
    const company = prompt('Company name:');
    if (company === null) return;
    const hours = parseFloat(prompt('Hold for how many hours?', '24')) || 24;
    socket.emit('booth:hold', { boothNumber, company: company.trim() || 'Pending', hours }, done('held'));
  }
  if (action === 'release') socket.emit('booth:release', { boothNumber }, done('released'));
}

// ─── Toast ──────────────────────────────────────────────────────────────────
// Transient confirmation or error. Server actions used to fail silently, so an
// admin had no way to tell a rejected hold from a successful one.
let toastTimer = null;
function adminToast(message, kind = 'ok') {
  let el = document.getElementById('admin-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'admin-toast';
    el.className = 'admin-toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `admin-toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'admin-toast'; }, 4000);
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
  const all = Object.values(booths);

  // Merge and split operate on all stands, not only available ones — you may
  // need to reshape a stand regardless of its booking status.
  ['merge-1', 'merge-2', 'split-stand'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">Select…</option>' +
      all.map(b => `<option value="${esc(b.boothNumber)}">Stand ${esc(b.boothNumber)}</option>`).join('');
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
  if (!p || !s || p === s) return adminToast('Select two different stands to merge.', 'error');
  socket.emit('booth:consolidate', { primary: p, secondary: s }, (res) => {
    adminToast(res && res.ok ? `Stand ${s} merged into ${p}.` : (res && res.error) || 'Merge failed.',
               res && res.ok ? 'ok' : 'error');
  });
});

// ─── Split Form ───────────────────────────────────────────────────────────────
document.getElementById('split-form').addEventListener('submit', e => {
  e.preventDefault();
  const boothNumber = document.getElementById('split-stand').value;
  const parts = parseInt(document.getElementById('split-parts').value, 10);
  const axis = document.getElementById('split-axis').value;
  if (!boothNumber) return adminToast('Select a stand to split.', 'error');
  socket.emit('booth:split', { boothNumber, parts, axis }, (res) => {
    adminToast(res && res.ok ? `Stand ${boothNumber} split into ${(res.created || []).length + 1} — added ${(res.created || []).join(', ')}.`
                             : (res && res.error) || 'Split failed.',
               res && res.ok ? 'ok' : 'error');
  });
});

// ─── Status Form ──────────────────────────────────────────────────────────────
document.getElementById('status-form').addEventListener('submit', e => {
  e.preventDefault();
  const boothNumber = document.getElementById('status-stand').value;
  const status = document.getElementById('status-new').value;
  const company = document.getElementById('status-company').value.trim();
  if (!boothNumber) return;
  socket.emit('admin:setStatus', { boothNumber, status, company }, (res) => {
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
document.getElementById('clear-log').addEventListener('click', () => {
  document.getElementById('admin-log').innerHTML = '<div class="log-entry system"><span class="log-time">Now</span> Log cleared.</div>';
});

// ─── Socket Events ────────────────────────────────────────────────────────────
socket.on('state:full', (serverBooths) => {
  serverBooths.forEach(b => { booths[b.boothNumber] = b; });
  updateOverview();
  renderBookingsTable();
  populateToolDropdowns();

  // Tag on the first state if the floorplan tab is already open; otherwise
  // loadAdminSVG() tags when the tab is first shown.
  if (adminSvgReady && !adminTagged) tagAdminBooths();
  if (svgDoc) {
    Object.values(booths).forEach(b => {
      const el = svgDoc.querySelector(`[data-booth="${CSS.escape(b.boothNumber)}"]`);
      if (el) applyAdminVisual(el, b.status);
    });
  }
});

// Rejected holds, failed merges and denied actions used to disappear silently.
socket.on('error:action', ({ message }) => adminToast(message || 'That action could not be completed.', 'error'));
socket.on('error:auth',   ({ message }) => adminToast(message || 'Administrator access required.', 'error'));

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
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ─── Leads ──────────────────────────────────────────────────────────────────
// Enquiries captured from the public floorplan, each shown with the browsing
// history that led to it. Built with DOM nodes — the fields are visitor input.
let leadCache = [];

async function loadLeads() {
  const listEl = document.getElementById('leads-list');
  listEl.textContent = 'Loading…';
  try {
    leadCache = await fetch('/api/inquiries?limit=200').then(r => r.ok ? r.json() : []);
    renderLeadsList();
  } catch {
    listEl.textContent = 'Could not load enquiries.';
  }
}

function renderLeadsList() {
  const listEl = document.getElementById('leads-list');
  document.getElementById('leads-count').textContent =
    `${leadCache.length} ${leadCache.length === 1 ? 'enquiry' : 'enquiries'}`;

  const newCount = leadCache.filter(l => l.status === 'new').length;
  const badge = document.getElementById('leads-badge');
  badge.textContent = newCount;
  badge.classList.toggle('hidden', newCount === 0);

  listEl.replaceChildren();
  if (!leadCache.length) {
    const empty = document.createElement('div');
    empty.className = 'leads-empty-row';
    empty.textContent = 'No enquiries yet.';
    listEl.appendChild(empty);
    return;
  }

  leadCache.forEach(l => {
    const row = document.createElement('button');
    row.className = 'lead-row';
    row.dataset.id = l._id;

    const name = document.createElement('div');
    name.className = 'lead-row-name';
    name.textContent = l.contact?.name || '(no name)';
    if (l.status === 'new') {
      const dot = document.createElement('span');
      dot.className = 'lead-new-dot';
      name.prepend(dot);
    }

    const meta = document.createElement('div');
    meta.className = 'lead-row-meta';
    const booths = (l.boothsOfInterest || []).join(', ');
    meta.textContent = `${l.contact?.company || l.contact?.email || ''}${booths ? ' · stands ' + booths : ''}`;

    const time = document.createElement('div');
    time.className = 'lead-row-time';
    time.textContent = l.createdAt ? new Date(l.createdAt).toLocaleDateString('en-GB') : '';

    row.append(name, meta, time);
    row.onclick = () => { document.querySelectorAll('.lead-row').forEach(r => r.classList.remove('active')); row.classList.add('active'); openLead(l._id); };
    listEl.appendChild(row);
  });
}

const EVENT_LABEL = {
  'session.start': 'Arrived', 'booth.view': 'Viewed stand', 'booth.click': 'Clicked stand',
  'booth.dwell': 'Spent time on stand', 'plan.zoom': 'Zoomed the plan',
  'inquiry.submit': 'Sent this enquiry', 'consent.granted': 'Accepted tracking',
};

async function openLead(id) {
  const panel = document.getElementById('lead-detail');
  panel.textContent = 'Loading…';
  let lead;
  try { lead = await fetch(`/api/inquiries/${encodeURIComponent(id)}`).then(r => r.ok ? r.json() : null); }
  catch { lead = null; }
  if (!lead) { panel.textContent = 'Could not load this enquiry.'; return; }

  panel.replaceChildren();

  const head = document.createElement('div');
  head.className = 'lead-detail-head';
  const h = document.createElement('h2');
  h.textContent = lead.contact?.name || '(no name)';
  head.appendChild(h);
  panel.appendChild(head);

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
    btn.onclick = async () => {
      try {
        const res = await fetch(`/api/inquiries/${encodeURIComponent(id)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: st }),
        });
        if (!res.ok) throw new Error();
        lead.status = st;
        statusRow.querySelectorAll('.lead-status-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const cached = leadCache.find(l => l._id === id); if (cached) cached.status = st;
        renderLeadsList();                       // refresh the list + "new" badge
        adminToast(`Lead marked ${st}.`, 'ok');
      } catch { adminToast('Could not update lead status.', 'error'); }
    };
    btns.appendChild(btn);
  });
  statusRow.appendChild(btns);
  panel.appendChild(statusRow);

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
    try {
      await fetch(`/api/inquiries/${encodeURIComponent(id)}/assign`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: select.value }),
      });
      adminToast(select.value ? `Assigned to ${select.value}.` : 'Assignment cleared.', 'ok');
    } catch { adminToast('Could not save assignment.', 'error'); }
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
    sent.textContent = `Sent ${lead.sendCount}× — last to ${lead.lastSentTo || '—'} on ` +
      new Date(lead.lastSentAt).toLocaleString('en-GB');
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

  contact.append(
    field('Email', lead.contact?.email, lead.contact?.email ? `mailto:${lead.contact.email}` : null),
    field('Phone', lead.contact?.phone, lead.contact?.phone ? `tel:${lead.contact.phone}` : null),
    field('Company', lead.contact?.company),
    field('Stands of interest', (lead.boothsOfInterest || []).join(', ')),
    field('Sponsorship interest', sponsorNames.join(', ')),
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
      fetch(`/api/analytics/funnel?days=${days}`).then(r => r.json()),
      fetch(`/api/analytics/demand?days=${days}`).then(r => r.json()),
    ]);
    renderFunnel(funnel);
    renderDemand(demand);
  } catch {
    document.getElementById('funnel').textContent = 'Could not load analytics.';
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
  try { list = (await fetch('/partners').then(r => r.ok ? r.json() : {})).partners || []; } catch {}

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

// ─── Partner logos (public "In partnership with" strip) ──────────────────────
async function loadPartners() {
  const tbody = document.getElementById('partners-tbody');
  if (!tbody) return;
  tbody.replaceChildren();
  let list = [];
  try { list = await fetch('/api/partners').then(r => r.ok ? r.json() : []); } catch {}

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
      if (!confirm(`Remove "${p.name || 'this logo'}" from the floorplan?`)) return;
      const res = await fetch(`/api/partners/${p._id}`, { method: 'DELETE' });
      adminToast(res.ok ? 'Logo removed.' : 'Could not remove.', res.ok ? 'ok' : 'error');
      if (res.ok) { loadPartners(); loadNavPartners(); }
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
    const res = await fetch(`/api/partners/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
    });
    const d = await res.json().catch(() => ({}));
    adminToast(res.ok ? 'Logo updated.' : (d.error || 'Could not save.'), res.ok ? 'ok' : 'error');
    if (res.ok) { if ('image' in fields || 'active' in fields) loadPartners(); loadNavPartners(); }
  } catch { adminToast('Could not save.', 'error'); }
}

/**
 * Turn a chosen file into an inline data URI, downscaled so the stored logo
 * stays small. Render's filesystem is wiped on every deploy, so the image is
 * kept in the database rather than written to disk. SVGs pass through untouched
 * to keep them vector.
 */
function fileToDataUrl(file, maxWidth = 800) {
  // Keep the stored data URI comfortably under the server's ~2M-char cap.
  const MAX_LEN = 1_500_000;
  return new Promise((resolve, reject) => {
    if (file.size > 8 * 1024 * 1024) return reject(new Error('Image must be under 8 MB.'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      if (file.type === 'image/svg+xml') return resolve(reader.result);
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

document.getElementById('partner-add-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  // A dropped file wins over a pasted URL.
  const image = pendingPartnerImage || document.getElementById('partner-image').value.trim();
  if (!image) return adminToast('Drop in a logo, or paste an image URL.', 'error');

  const body = {
    name:  document.getElementById('partner-name').value.trim(),
    image,
    url:   document.getElementById('partner-url').value.trim(),
  };
  try {
    const res = await fetch('/api/partners', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok) {
      adminToast('Logo added.', 'ok');
      ['partner-name', 'partner-image', 'partner-url'].forEach(i => { document.getElementById(i).value = ''; });
      resetPartnerDropzone();
      loadPartners(); loadNavPartners();
    } else adminToast(d.error || 'Could not add logo.', 'error');
  } catch { adminToast('Could not add logo.', 'error'); }
});

// ─── Sponsors (admin — with prices) ──────────────────────────────────────────
async function loadSponsorsAdmin() {
  loadPartners();
  const tbody = document.getElementById('sponsors-admin-tbody');
  tbody.replaceChildren();
  try {
    sponsorAdminCache = await fetch('/api/sponsors').then(r => r.ok ? r.json() : []);
  } catch { sponsorAdminCache = []; }

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

    tr.appendChild(sponsorInput(s.key, 'price', s.price ?? '', 'number', '€ POA', 90));
    tr.appendChild(sponsorInput(s.key, 'availability', s.availability ?? '', 'text', 'e.g. Exclusive', 120));
    tr.appendChild(sponsorInput(s.key, 'image', s.image ?? '', 'text', '/sponsors/x.jpg or URL', 150));
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

    tbody.appendChild(tr);
  });
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
  try {
    const res = await fetch(`/api/sponsors/${encodeURIComponent(key)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
    });
    adminToast(res.ok ? 'Sponsor updated.' : 'Could not save sponsor.', res.ok ? 'ok' : 'error');
    if (res.ok && ('active' in fields || 'soldOut' in fields)) loadSponsorsAdmin();
  } catch { adminToast('Could not save sponsor.', 'error'); }
}

// ─── Team (admin accounts) ────────────────────────────────────────────────────
async function loadTeam() {
  const tbody = document.getElementById('team-tbody');
  tbody.replaceChildren();
  let admins = [];
  try { admins = await fetch('/api/admins').then(r => r.ok ? r.json() : []); } catch {}

  admins.forEach(a => {
    const tr = document.createElement('tr');

    const name = document.createElement('td');
    const strong = document.createElement('strong'); strong.textContent = a.username;
    name.appendChild(strong);
    if (a.username === currentUser) { const you = document.createElement('span'); you.className = 'team-you'; you.textContent = ' you'; name.appendChild(you); }
    tr.appendChild(name);

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
    actions.appendChild(teamBtn('Reset 2FA', () => resetMemberTotp(a.username)));
    actions.appendChild(teamBtn('New password', () => resetMemberPassword(a.username)));
    if (a.username !== currentUser && admins.length > 1) {
      actions.appendChild(teamBtn('Remove', () => removeMember(a.username), 'danger'));
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

document.getElementById('team-add-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('team-username').value.trim();
  const password = document.getElementById('team-password').value;
  try {
    const res = await fetch('/api/admins', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      adminToast(`Administrator "${username}" added. Share the username and password with them.`, 'ok');
      document.getElementById('team-username').value = '';
      document.getElementById('team-password').value = '';
      loadTeam();
    } else {
      adminToast(data.error || 'Could not add administrator.', 'error');
    }
  } catch { adminToast('Could not add administrator.', 'error'); }
});

async function resetMemberTotp(username) {
  if (!confirm(`Reset 2FA for "${username}"? They will set it up again on their next login.`)) return;
  const res = await fetch(`/api/admins/${encodeURIComponent(username)}/reset-2fa`, { method: 'POST' });
  adminToast(res.ok ? `2FA reset for ${username}.` : 'Could not reset 2FA.', res.ok ? 'ok' : 'error');
  if (res.ok) loadTeam();
}

async function resetMemberPassword(username) {
  const pw = prompt(`New password for "${username}" (at least 8 characters):`);
  if (pw === null) return;
  const res = await fetch(`/api/admins/${encodeURIComponent(username)}/password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }),
  });
  const data = await res.json().catch(() => ({}));
  adminToast(res.ok ? `Password updated for ${username}.` : (data.error || 'Could not update password.'), res.ok ? 'ok' : 'error');
}

async function removeMember(username) {
  if (!confirm(`Remove administrator "${username}"? They will lose access immediately.`)) return;
  const res = await fetch(`/api/admins/${encodeURIComponent(username)}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  adminToast(res.ok ? `Removed ${username}.` : (data.error || 'Could not remove.'), res.ok ? 'ok' : 'error');
  if (res.ok) loadTeam();
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

