const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const fs      = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
const PORT   = process.env.PORT || 3000;

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.redirect('/floorplan'));

// ─── Admin Authentication ─────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  if (!req.path.startsWith('/admin') && !['/admin.html', '/admin.js', '/admin.css'].includes(req.path)) {
    return next();
  }
  
  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
  
  const envUser = process.env.ADMIN_USER || 'admin';
  const envPass = process.env.ADMIN_PASS || 'password';
  
  if (login && password && login === envUser && password === envPass) {
    return next();
  }
  
  res.set('WWW-Authenticate', 'Basic realm="401"');
  res.status(401).send('Authentication required.');
}
app.use(adminAuth);

// ─── Serve static files ───────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

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
      status:   b.status,
      sqm:      b.sqm,
      price:    b.price,
      company:  null,
      actualPrice: null,  // the real negotiated price
      notes:    '',       // deal notes, admin only
      viewers:  0,
      clicks:   0,
      clickHistory: [],
      x: b.x, y: b.y, w: b.w, h: b.h
    };
  });
}

// ─── Persistence ─────────────────────────────────────────────────────────────
const statePath = path.join(__dirname, 'booth_state.json');

function saveState() {
  try {
    fs.writeFileSync(statePath, JSON.stringify(boothState, null, 2));
  } catch (e) {
    console.error('Failed to save booth state:', e.message);
  }
}

function loadSavedState() {
  try {
    if (fs.existsSync(statePath)) {
      const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      // Merge saved status/company/clicks over the freshly-initialised state
      // (so new booths from an updated SVG still appear, but existing bookings are preserved)
      Object.keys(saved).forEach(id => {
        if (boothState[id]) {
          boothState[id].status      = saved[id].status;
          boothState[id].company     = saved[id].company;
          boothState[id].actualPrice = saved[id].actualPrice ?? null;
          boothState[id].notes       = saved[id].notes       ?? '';
          boothState[id].clicks      = saved[id].clicks      ?? 0;
          boothState[id].clickHistory= saved[id].clickHistory ?? [];
        }
      });
      console.log('✅ Restored booth state from disk');
    }
  } catch (e) {
    console.warn('Could not load saved state:', e.message);
  }
}

initBoothState();
loadSavedState(); // overlay any previously saved bookings

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
    broadcastState();
  });

  // ── Track Clicks ────────────────────────────────────────────────────────────
  socket.on('booth:click', ({ boothId, location }) => {
    const b = boothState[boothId];
    if (b) {
      b.clicks++;
      b.clickHistory = b.clickHistory || [];
      b.clickHistory.unshift({ time: new Date().toISOString(), location: location || 'Unknown' });
      // Keep only last 20 clicks to prevent unbound array growth
      if (b.clickHistory.length > 20) b.clickHistory.pop();
      saveState();
      broadcastState();
    }
  });

  // ── Book a booth ─────────────────────────────────────────────────────────────
  socket.on('booth:book', ({ boothId, company }) => {
    const b = boothState[boothId];
    if (!b || b.status === 'sold') return;
    b.status  = 'sold';
    b.company = company;
    saveState();
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
    saveState();
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
    saveState();
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
    saveState();
    broadcastState();
    broadcastLog(`🔗 Stands ${primary.replace('booth-','')} & ${secondary.replace('booth-','')} consolidated → ${b1.sqm}m²`, 'system');
    io.emit('booth:consolidated', { primary, secondary });
  });

  // ── Update deal price + notes (admin only) ───────────────────────────────────────
  socket.on('booth:update-deal', ({ boothId, actualPrice, notes }) => {
    const b = boothState[boothId];
    if (!b) return;
    b.actualPrice = actualPrice !== undefined ? actualPrice : b.actualPrice;
    b.notes       = notes       !== undefined ? notes       : b.notes;
    saveState();
    broadcastState();
    broadcastLog(`📝 Deal updated for Stand ${boothId.replace('booth-','')} — €${actualPrice?.toLocaleString() || 'n/a'}`, 'admin');
  });

  // ── Admin: force-set booth status ─────────────────────────────────────────────
  socket.on('admin:setStatus', ({ boothId, status, company }) => {
    const b = boothState[boothId];
    if (!b) return;
    b.status  = status;
    b.company = company || null;
    saveState();
    broadcastState();
    broadcastLog(`🛠 Admin set Stand ${boothId.replace('booth-','')} → ${status}`, 'admin');
  });

  // ── Reset to initial extracted state ──────────────────────────────────────────
  socket.on('demo:reset', () => {
    initBoothState();
    saveState();
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
