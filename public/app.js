// Establish socket connection
const socket = io();

// Local State
let boothsData = [];
let selectedBoothId = null;
let currentTab = 'buyer';

// Zoom & Pan State
let zoomLevel = 1;
let panX = 0;
let panY = 0;
let isDragging = false;
let startX, startY;

// DOM Elements
const connectionBadge = document.getElementById('connection-status');
const boothsLayer = document.getElementById('booths-layer');
const panZoomTarget = document.getElementById('pan-zoom-target');
const floorplanContainer = document.getElementById('floorplan-container');
const selectedDisplay = document.getElementById('selected-booth-display');
const eventLog = document.getElementById('event-log');
const mergeSelect1 = document.getElementById('merge-booth-1');
const mergeSelect2 = document.getElementById('merge-booth-2');
const consolidationForm = document.getElementById('consolidation-form');

// Analytics Stat DOMs
const statRevenue = document.getElementById('stat-revenue');
const statSoldRatio = document.getElementById('stat-sold-ratio');
const statSoldProgress = document.getElementById('stat-sold-progress');
const statBrowsers = document.getElementById('stat-browsers');

// --- Socket Connection Event Listeners ---
socket.on('connect', () => {
  connectionBadge.className = 'status-badge connected';
  connectionBadge.querySelector('.status-label').textContent = 'Synchronized';
  addLogEntry('System', 'Connected to real-time server.', 'system');
});

socket.on('disconnect', () => {
  connectionBadge.className = 'status-badge disconnected';
  connectionBadge.querySelector('.status-label').textContent = 'Offline';
  addLogEntry('System', 'Lost connection to server. Retrying...', 'system');
});

socket.on('booths-update', (data) => {
  const incomingBooths = data.booths || data;
  const connections = data.connections || 1;
  boothsData = incomingBooths;
  
  renderFloorplan();
  updateAnalytics(connections);
  updateDetailsPanel();
  updateAdminDropdowns();
});

socket.on('notification', (msg) => {
  addLogEntry('Info', msg, 'consolidation');
});

socket.on('booking-announcement', (data) => {
  addLogEntry('Booking', `Booth ${data.boothId} was purchased by ${data.companyName}!`, 'booking');
});

socket.on('error-msg', (msg) => {
  alert(`Error: ${msg}`);
});

// Reset Button
document.getElementById('reset-demo-btn').addEventListener('click', () => {
  socket.emit('reset-demo');
});

// --- Tab Swapper ---
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const tabName = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    
    btn.classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.add('active');
    currentTab = tabName;
  });
});

// --- Pan & Zoom Logic ---
function updateTransform() {
  panZoomTarget.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomLevel})`;
}

document.getElementById('zoom-in').addEventListener('click', () => {
  zoomLevel = Math.min(zoomLevel + 0.15, 4);
  updateTransform();
});

document.getElementById('zoom-out').addEventListener('click', () => {
  zoomLevel = Math.max(zoomLevel - 0.15, 0.5);
  updateTransform();
});

document.getElementById('zoom-reset').addEventListener('click', () => {
  zoomLevel = 1;
  panX = 0;
  panY = 0;
  updateTransform();
});

floorplanContainer.addEventListener('mousedown', (e) => {
  if (e.target.tagName === 'svg' || e.target.id === 'floorplan-svg' || e.target.tagName === 'rect' && e.target.classList.contains('grid-bg')) {
    isDragging = true;
    startX = e.clientX - panX;
    startY = e.clientY - panY;
    floorplanContainer.style.cursor = 'grabbing';
  }
});

window.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  panX = e.clientX - startX;
  panY = e.clientY - startY;
  updateTransform();
});

window.addEventListener('mouseup', () => {
  isDragging = false;
  floorplanContainer.style.cursor = 'grab';
});

floorplanContainer.addEventListener('wheel', (e) => {
  e.preventDefault();
  const zoomFactor = 0.05;
  if (e.deltaY < 0) {
    zoomLevel = Math.min(zoomLevel + zoomFactor, 4);
  } else {
    zoomLevel = Math.max(zoomLevel - zoomFactor, 0.5);
  }
  updateTransform();
}, { passive: false });


// --- Dynamic Floorplan Rendering ---
function renderFloorplan() {
  boothsLayer.innerHTML = '';
  
  boothsData.forEach(booth => {
    if (!booth.active) return;
    
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'booth-group');
    g.dataset.id = booth.id;

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', booth.x);
    rect.setAttribute('y', booth.y);
    rect.setAttribute('width', booth.width);
    rect.setAttribute('height', booth.height);
    rect.setAttribute('rx', 6);
    
    let stateClass = `state-${booth.status}`;
    let viewersClass = booth.viewerCount > 0 ? 'has-viewers' : '';
    let selectedClass = selectedBoothId === booth.id ? 'selected' : '';
    
    rect.setAttribute('class', `booth-rect ${stateClass} ${viewersClass} ${selectedClass}`);
    g.appendChild(rect);

    const textLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    textLabel.setAttribute('x', booth.x + booth.width / 2);
    const labelY = booth.status === 'amenity' || (booth.status === 'sold' && booth.width > 70) 
      ? booth.y + booth.height / 2.5 
      : booth.y + booth.height / 2 + 4;
      
    textLabel.setAttribute('y', labelY);
    textLabel.setAttribute('class', 'booth-label');
    textLabel.setAttribute('text-anchor', 'middle');
    textLabel.textContent = booth.id;
    g.appendChild(textLabel);

    if (booth.width >= 70 && (booth.company || booth.status === 'amenity')) {
      const subLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      subLabel.setAttribute('x', booth.x + booth.width / 2);
      subLabel.setAttribute('y', booth.y + booth.height / 2 + 12);
      subLabel.setAttribute('class', 'booth-sublabel');
      subLabel.setAttribute('text-anchor', 'middle');
      
      const displayName = booth.company || booth.company === '' ? booth.company : 'Facility';
      subLabel.textContent = truncateString(displayName, 14);
      g.appendChild(subLabel);
    }
    
    if (booth.viewerCount > 0) {
      const viewerBadgeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', booth.x + booth.width - 8);
      circle.setAttribute('cy', booth.y + 8);
      circle.setAttribute('r', 7);
      circle.setAttribute('fill', 'var(--danger)');
      
      const val = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      val.setAttribute('x', booth.x + booth.width - 8);
      val.setAttribute('y', booth.y + 11);
      val.setAttribute('fill', 'white');
      val.setAttribute('font-size', '8px');
      val.setAttribute('font-weight', 'bold');
      val.setAttribute('text-anchor', 'middle');
      val.textContent = booth.viewerCount;
      
      viewerBadgeGroup.appendChild(circle);
      viewerBadgeGroup.appendChild(val);
      g.appendChild(viewerBadgeGroup);
    }

    g.addEventListener('click', (e) => {
      e.stopPropagation();
      selectBooth(booth.id);
    });

    g.addEventListener('mouseenter', () => {
      if (booth.status !== 'amenity') {
        socket.emit('start-viewing', booth.id);
      }
    });

    g.addEventListener('mouseleave', () => {
      if (booth.status !== 'amenity') {
        socket.emit('stop-viewing');
      }
    });

    boothsLayer.appendChild(g);
  });
}

floorplanContainer.addEventListener('click', (e) => {
  if (e.target.tagName === 'svg' || e.target.id === 'floorplan-svg' || e.target.classList.contains('grid-bg')) {
    deselectBooth();
  }
});

function selectBooth(boothId) {
  selectedBoothId = boothId;
  const booth = boothsData.find(b => b.id === boothId);
  if (booth && booth.status !== 'amenity') {
    socket.emit('track-click', boothId);
  }
  renderFloorplan();
  updateDetailsPanel();
}

function deselectBooth() {
  if (selectedBoothId) {
    selectedBoothId = null;
    renderFloorplan();
    updateDetailsPanel();
  }
}

function updateAnalytics(browsersCount) {
  statBrowsers.textContent = browsersCount;

  const sellableBooths = boothsData.filter(b => b.status !== 'amenity' && b.active);
  const soldBooths = sellableBooths.filter(b => b.status === 'sold');
  
  const ratio = sellableBooths.length > 0 ? Math.round((soldBooths.length / sellableBooths.length) * 100) : 0;
  statSoldRatio.textContent = `${ratio}%`;
  statSoldProgress.style.width = `${ratio}%`;
  
  const revenue = soldBooths.reduce((acc, curr) => acc + (curr.price || 0), 0);
  statRevenue.textContent = `$${revenue.toLocaleString()}`;
}

function updateDetailsPanel() {
  if (!selectedBoothId) {
    selectedDisplay.innerHTML = `
      <div class="empty-state">
        <i data-lucide="mouse-pointer-click"></i>
        <h3>Select a Booth</h3>
        <p>Click any space on the floorplan to inspect live status, pricing, views, and reserve it instantly.</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  const booth = boothsData.find(b => b.id === selectedBoothId);
  if (!booth) {
    selectedBoothId = null;
    updateDetailsPanel();
    return;
  }

  let statusBadge = '';
  let footerAction = '';
  
  if (booth.status === 'available') {
    statusBadge = `<span class="details-badge avail">Available</span>`;
    footerAction = `
      <div class="booking-section">
        <h4 class="form-title">Secure Space Instantly</h4>
        <form id="purchase-form" class="input-group">
          <input type="text" id="company-name-input" class="form-input" placeholder="Company Name" required />
          <button type="submit" class="btn btn-primary flex-btn">
            <i data-lucide="check-circle"></i> Book Booth
          </button>
        </form>
      </div>
    `;
  } else if (booth.status === 'sold') {
    statusBadge = `<span class="details-badge sold">Reserved</span>`;
    footerAction = `
      <div class="booking-section">
        <h4 class="form-title">Space Occupied</h4>
        <p class="section-desc" style="margin-bottom: 12px;">This space is contracted to <strong>${booth.company}</strong>.</p>
        <button id="admin-release-btn" class="btn btn-secondary btn-full flex-btn">
          <i data-lucide="x-circle"></i> Release Booth (Admin)
        </button>
      </div>
    `;
  } else {
    statusBadge = `<span class="details-badge amenity">Amenity</span>`;
    footerAction = `
      <div class="booking-section">
        <p class="section-desc">Public facility space. Cannot be purchased or modified.</p>
      </div>
    `;
  }

  selectedDisplay.innerHTML = `
    <div class="details-card">
      <div class="details-header">
        <div>
          <span class="details-id">Booth ${booth.id}</span>
          <p style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 2px;">
            Size: ${booth.width / 10}m × ${booth.height / 10}m (${(booth.width * booth.height) / 100} sq m)
          </p>
        </div>
        ${statusBadge}
      </div>

      <div class="details-grid">
        <div class="detail-item">
          <span class="detail-label">Base Cost</span>
          <span class="detail-val" style="color: #60a5fa; font-weight: 700;">
            ${booth.status === 'amenity' ? 'N/A' : `$${booth.price.toLocaleString()}`}
          </span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Interest</span>
          <span class="detail-val">${booth.clicks || 0} Clicks</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Live Browsers</span>
          <span class="detail-val live-viewer">
            <span class="status-dotIndicator animate-pulse"></span>
            ${booth.viewerCount || 0} active
          </span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Assigned To</span>
          <span class="detail-val">${booth.company || '—'}</span>
        </div>
      </div>

      ${footerAction}
    </div>
  `;

  lucide.createIcons();

  const purchaseForm = document.getElementById('purchase-form');
  if (purchaseForm) {
    purchaseForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const companyName = document.getElementById('company-name-input').value;
      if (companyName.trim()) {
        socket.emit('book-booth', { boothId: booth.id, companyName: companyName.trim() });
      }
    });
  }

  const releaseBtn = document.getElementById('admin-release-btn');
  if (releaseBtn) {
    releaseBtn.addEventListener('click', () => {
      socket.emit('release-booth', booth.id);
    });
  }
}

function updateAdminDropdowns() {
  const currentVal1 = mergeSelect1.value;
  const currentVal2 = mergeSelect2.value;

  mergeSelect1.innerHTML = '<option value="">Select space...</option>';
  mergeSelect2.innerHTML = '<option value="">Select space...</option>';

  const mergeableBooths = boothsData.filter(b => b.active && b.status !== 'amenity');

  mergeableBooths.forEach(booth => {
    const opt1 = document.createElement('option');
    opt1.value = booth.id;
    opt1.textContent = `Booth ${booth.id} (${booth.status})`;
    mergeSelect1.appendChild(opt1);

    const opt2 = document.createElement('option');
    opt2.value = booth.id;
    opt2.textContent = `Booth ${booth.id} (${booth.status})`;
    mergeSelect2.appendChild(opt2);
  });

  if (mergeableBooths.find(b => b.id === currentVal1)) mergeSelect1.value = currentVal1;
  if (mergeableBooths.find(b => b.id === currentVal2)) mergeSelect2.value = currentVal2;
}

consolidationForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const boothId1 = mergeSelect1.value;
  const boothId2 = mergeSelect2.value;

  if (!boothId1 || !boothId2) {
    alert('Please select two spaces to merge.');
    return;
  }

  if (boothId1 === boothId2) {
    alert('Cannot merge a space with itself. Choose two different booths.');
    return;
  }

  socket.emit('consolidate-booths', { boothId1, boothId2 });
  
  mergeSelect1.value = '';
  mergeSelect2.value = '';
});

function addLogEntry(source, message, type = 'system') {
  const time = new Date().toLocaleTimeString();
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.innerHTML = `<span class="log-time">${time}</span><strong>[${source}]</strong> ${message}`;
  eventLog.appendChild(entry);
  
  eventLog.scrollTop = eventLog.scrollHeight;
}

function truncateString(str, num) {
  if (str.length <= num) return str;
  return str.slice(0, num) + '...';
}
