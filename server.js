const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const fs      = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
const PORT   = process.env.PORT || 3000;

// ─── Serve static files ───────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/',          (_, res) => res.redirect('/floorplan'));
app.get('/floorplan', (_, res) => res.sendFile(path.join(__dirname, 'public', 'floorplan.html')));
app.get('/admin',     (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ─── Load booth data from extracted JSON ──────────────────────────────────────
const boothDataPath = path.join(__dirname, 'public', 'booth_data.json');
let boothDataRaw    = {};
try {
  boothDataRaw = JSON.parse(fs.readFileSync(boothDataPath, 'utf8'));
} catch (e) {
  console.warn('booth_data.json not found — run scripts/extract_booths.js first');
}

// In-memory live state — keyed by boothId
// Merges extracted SVG data with live status
let boothState = {};

function initBoothState() {
  boothState = {};
  Object.values(boothDataRaw).forEach(b => {
    boothState[b.boothId] = {
      boothId:  b.boothId,
      status:   b.status,   // 'available' | 'sold' | 'held'
      sqm:      b.sqm,
      price:    b.price,    // €600 × sqm
      company:  null,
      viewers:  0,
      clicks:   0,
      x: b.x, y: b.y, w: b.w, h: b.h
    };
  });
}

initBoothState();

// ─── Viewer tracking: socketId → boothId ──────────────────────────────────────
const activeViewers = {}; // { socketId: boothId }
let totalConnections = 0;

// ─── Computed stats ───────────────────────────────────────────────────────────
function getStats() {
  const all       = Object.values(boothState);
  const available = all.filter(b => b.status === 'available');
  const sold      = all.filter(b => b.status === 'sold');
  const held      = all.filter(b => b.status === 'held');

  const totalSqm     = all.reduce((s, b) => s + b.sqm, 0);
  const availSqm     = available.reduce((s, b) => s + b.sqm, 0);
  const soldSqm      = sold.reduce((s, b) => s + b.sqm, 0);
  const heldSqm      = held.reduce((s, b) => s + b.sqm, 0);

  const totalRevenue = all.reduce((s, b) => s + b.price, 0);
  const earnedRev    = sold.reduce((s, b) => s + b.price, 0);
  const availRev     = available.reduce((s, b) => s + b.price, 0);
  const heldRev      = held.reduce((s, b) => s + b.price, 0);

  return {
    totalBooths: all.length,
    availableBooths: available.length,
    soldBooths: sold.length,
    heldBooths: held.length,
    totalSqm, availSqm, soldSqm, heldSqm,
    totalRevenue, earnedRev, availRev, heldRev,
    connections: totalConnections
  };
}

// ─── Broadcast helpers ────────────────────────────────────────────────────────
function broadcastState() {
  // Update viewer counts
  const viewerMap = {};
  Object.values(activeViewers).forEach(bid => {
    viewerMap[bid] = (viewerMap[bid] || 0) + 1;
  });
  Object.values(boothState).forEach(b => {
    b.viewers = viewerMap[b.boothId] || 0;
  });

  io.emit('state:full',    Object.values(boothState));
  io.emit('stats:updated', getStats());
}

function broadcastLog(msg, type = 'info') {
  io.emit('log:entry', { msg, type, time: new Date().toLocaleTimeString('en-GB') });
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  totalConnections++;
  console.log(`+ Client ${socket.id} connected (total: ${totalConnections})`);

  // Send full state on connect
  socket.emit('state:full',    Object.values(boothState));
  socket.emit('stats:updated', getStats());
  io.emit('viewers:count', totalConnections);

  // ── Viewer presence ─────────────────────────────────────────────────────────
  socket.on('booth:view', ({ boothId }) => {
    activeViewers[socket.id] = boothId;
    if (boothState[boothId]) boothState[boothId].clicks++;
    broadcastState();
  });

  // ── Book a booth ─────────────────────────────────────────────────────────────
  socket.on('booth:book', ({ boothId, company }) => {
    const b = boothState[boothId];
    if (!b || b.status === 'sold') return;
    b.status  = 'sold';
    b.company = company;
    broadcastState();
    broadcastLog(`✅ <strong>${company}</strong> booked Stand ${boothId.replace('booth-','')} (${b.sqm}m² — €${b.price.toLocaleString()})`, 'booking');
    socket.emit('booth:updated', b);
  });

  // ── Hold a booth ──────────────────────────────────────────────────────────────
  socket.on('booth:hold', ({ boothId, company }) => {
    const b = boothState[boothId];
    if (!b || b.status === 'sold') return;
    b.status  = 'held';
    b.company = company || 'Pending';
    broadcastState();
    broadcastLog(`⏳ Stand ${boothId.replace('booth-','')} placed on hold for ${b.company}`, 'hold');
    socket.emit('booth:updated', b);
  });

  // ── Release a booth ───────────────────────────────────────────────────────────
  socket.on('booth:release', ({ boothId }) => {
    const b = boothState[boothId];
    if (!b) return;
    const prev = b.company;
    b.status  = 'available';
    b.company = null;
    broadcastState();
    broadcastLog(`🔓 Stand ${boothId.replace('booth-','')} released${prev ? ` (was: ${prev})` : ''}`, 'release');
    socket.emit('booth:updated', b);
  });

  // ── Consolidate two booths ────────────────────────────────────────────────────
  socket.on('booth:consolidate', ({ primary, secondary }) => {
    const b1 = boothState[primary];
    const b2 = boothState[secondary];
    if (!b1 || !b2) return;

    // Merge sqm and price into primary
    b1.sqm   += b2.sqm;
    b1.price += b2.price;

    // Remove secondary from state
    delete boothState[secondary];

    broadcastState();
    broadcastLog(`🔗 Stands ${primary.replace('booth-','')} & ${secondary.replace('booth-','')} consolidated → ${b1.sqm}m²`, 'system');
    io.emit('booth:consolidated', { primary, secondary });
  });

  // ── Admin: force-set booth status ─────────────────────────────────────────────
  socket.on('admin:setStatus', ({ boothId, status, company }) => {
    const b = boothState[boothId];
    if (!b) return;
    b.status  = status;
    b.company = company || null;
    broadcastState();
    broadcastLog(`🛠 Admin set Stand ${boothId.replace('booth-','')} → ${status}`, 'admin');
  });

  // ── Reset to initial extracted state ──────────────────────────────────────────
  socket.on('demo:reset', () => {
    initBoothState();
    broadcastState();
    broadcastLog('🔄 Floorplan reset to original state', 'system');
  });

  // ── Disconnect ────────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    totalConnections = Math.max(0, totalConnections - 1);
    delete activeViewers[socket.id];
    broadcastState();
    io.emit('viewers:count', totalConnections);
    console.log(`- Client ${socket.id} disconnected (total: ${totalConnections})`);
  });
});

// ─── REST API for stats (optional, for future integrations) ──────────────────
app.get('/api/stats',  (_, res) => res.json(getStats()));
app.get('/api/booths', (_, res) => res.json(Object.values(boothState)));

server.listen(PORT, () => console.log(`BluePrint EventPrint running on port ${PORT}`));
