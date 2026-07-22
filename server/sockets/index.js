const crypto = require('crypto');

const config    = require('../config');
const booths    = require('../models/booths');
const inquiries = require('../models/inquiries');
const holdsSvc  = require('../services/holds');
const { track } = require('../services/tracking');
const { socketAuth, requireAdmin } = require('../auth');

const ADMIN_ROOM = 'admins';

// ─── Booth cache ──────────────────────────────────────────────────────────────
// 272 documents; refreshed on mutation rather than read per broadcast.
let cache = [];
let activeViewers = {};   // socketId → boothNumber
let connections   = 0;

async function refresh() { cache = await booths.all(); }

// ─── Rate limiting ────────────────────────────────────────────────────────────
// Token bucket per socket. The public events are unauthenticated by design, so
// they need a ceiling.
function limiter(perMin) {
  let tokens = perMin, last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(perMin, tokens + ((now - last) / 60000) * perMin);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

// ─── Broadcast ────────────────────────────────────────────────────────────────
// Admins and the public receive different payloads from the same state. The
// public projection omits company, negotiated price and internal notes.
function viewerCounts() {
  const m = {};
  Object.values(activeViewers).forEach(n => { m[n] = (m[n] || 0) + 1; });
  return m;
}

function decorate() {
  const v = viewerCounts();
  return cache.map(b => ({ ...b, viewers: v[b.boothNumber] || 0 }));
}

let pending = null;
function broadcastState(io) {
  if (pending) return;
  pending = setTimeout(async () => {
    pending = null;
    // Anything thrown in here is a bare timer callback, so an unhandled
    // rejection would take the whole process down and drop every socket. A
    // failed broadcast should degrade to a missed update, nothing worse.
    try {
      const rows = decorate();
      io.except(ADMIN_ROOM).emit('state:full', rows.map(booths.toPublic));
      io.to(ADMIN_ROOM).emit('state:full',     rows.map(booths.toAdmin));

      const s = await booths.stats();
      io.except(ADMIN_ROOM).emit('stats:updated', {
        totalBooths: s.totalBooths, availableBooths: s.availableBooths,
        totalSqm: s.totalSqm, availSqm: s.availSqm,
      });
      io.to(ADMIN_ROOM).emit('stats:updated', { ...s, connections });
    } catch (e) {
      console.error('Broadcast failed:', e.message);
    }
  }, 80);
}

/**
 * Wrap a public (unauthenticated) handler so a database error becomes a logged
 * failure rather than an unhandled rejection. Without this, anyone able to
 * induce a write failure could crash the server with a single public event.
 */
function safe(type, handler) {
  return async (...args) => {
    try { return await handler(...args); }
    catch (e) { console.error(`✗ ${type} failed:`, e.stack || e.message); }
  };
}

// Activity log is admin-only — it names companies and quotes prices.
function log(io, msg, type = 'info') {
  io.to(ADMIN_ROOM).emit('log:entry', { msg, type, time: new Date().toLocaleTimeString('en-GB') });
}

const stand = (n) => String(n);

function register(io) {
  io.use(socketAuth);

  io.on('connection', (socket) => {
    connections++;
    const isAdmin = socket.data.isAdmin;
    if (isAdmin) socket.join(ADMIN_ROOM);

    // Anonymous session id for behavioural tracking. Generated server-side so a
    // client cannot claim another visitor's session.
    socket.data.sessionId = socket.handshake.auth?.sessionId
      && /^[a-f0-9]{32}$/.test(socket.handshake.auth.sessionId)
        ? socket.handshake.auth.sessionId
        : crypto.randomBytes(16).toString('hex');

    track({ type: 'session.start', socket, meta: { admin: isAdmin } });
    console.log(`+ ${isAdmin ? 'ADMIN' : 'visitor'} ${socket.id} (total: ${connections})`);

    // ── Handlers are bound synchronously, before any await ────────────────────
    // Socket.IO drops inbound events that arrive with no listener attached. If
    // the initial state were sent first, a client acting immediately on it
    // would race the handler registration and have its first action silently
    // discarded.
    const allowView   = limiter(240);
    const allowClick  = limiter(120);
    const allowSubmit = limiter(5);

    // ── Public ────────────────────────────────────────────────────────────────
    socket.on('booth:view', ({ boothNumber }) => {
      if (!allowView()) return;
      const n = stand(boothNumber);

      // Close out the previous booth's dwell before switching. This used to be
      // overwritten, so all attention except the final booth was discarded.
      if (socket.data.viewing && socket.data.viewing !== n && socket.data.viewStart) {
        track({ type: 'booth.dwell', boothNumber: socket.data.viewing, socket,
                meta: { ms: Date.now() - socket.data.viewStart } });
      }
      if (socket.data.viewing === n) return;   // repeat view of the same booth

      activeViewers[socket.id] = n;
      socket.data.viewStart = Date.now();
      socket.data.viewing   = n;
      track({ type: 'booth.view', boothNumber: n, socket });
      broadcastState(io);
    });

    socket.on('booth:click', safe('booth:click', async ({ boothNumber }) => {
      if (!allowClick()) return;
      const n = stand(boothNumber);
      const b = cache.find(x => x.boothNumber === n);
      if (!b) return;

      // Dwell time on the previously-open booth, so attention is measured in
      // seconds rather than clicks.
      if (socket.data.viewing && socket.data.viewing !== n && socket.data.viewStart) {
        track({ type: 'booth.dwell', boothNumber: socket.data.viewing, socket,
                meta: { ms: Date.now() - socket.data.viewStart } });
      }
      await booths.incrementClicks(n);
      track({ type: 'booth.click', boothNumber: n, socket });

      // Re-anchor dwell tracking to the booth now open. Without this the timer
      // stayed pinned to the first booth viewed, so its dwell was re-emitted on
      // every subsequent click and accumulated far beyond real attention.
      socket.data.viewing   = n;
      socket.data.viewStart = Date.now();

      await refresh();
      broadcastState(io);
    }));

    // Sent when a visitor accepts analytics consent mid-session, so their
    // events attach to a stable id from that point on.
    socket.on('session:adopt', ({ sessionId }) => {
      if (typeof sessionId === 'string' && /^[a-f0-9]{32}$/.test(sessionId)) {
        socket.data.sessionId = sessionId;
        track({ type: 'consent.granted', socket });
      }
    });

    socket.on('plan:zoom', ({ level, cx, cy }) => {
      if (!allowView()) return;
      track({ type: 'plan.zoom', socket, meta: { level, cx, cy } });
    });

    // Replaces booth:book / booth:hold on the public floorplan. Captures the
    // name and email that were previously discarded in the browser.
    socket.on('inquiry:submit', safe('inquiry:submit', async (payload = {}, ack) => {
      if (!allowSubmit()) return ack?.({ ok: false, errors: ['Too many submissions. Please wait a moment.'] });
      if (payload.website) return ack?.({ ok: true });   // honeypot

      try {
        const res = await inquiries.create({ ...payload, sessionId: socket.data.sessionId });
        if (res.ok) {
          log(io, `📩 Enquiry from <strong>${escapeHtml(payload.name)}</strong> — stands ${(payload.boothNumbers || []).join(', ')}`, 'inquiry');
          io.to(ADMIN_ROOM).emit('inquiry:new', { id: res.id, name: payload.name, booths: payload.boothNumbers });
        }
        ack?.(res);
      } catch (e) {
        console.error('Inquiry failed:', e.message);
        ack?.({ ok: false, errors: ['Something went wrong. Please try again.'] });
      }
    }));

    // ── Admin ─────────────────────────────────────────────────────────────────
    // Every handler below is wrapped. Previously any visitor could emit these
    // from the browser console.
    socket.on('booth:book', requireAdmin(socket, 'booth:book', async ({ boothNumber, company }) => {
      const n = stand(boothNumber);
      // Clear any hold document first, but without flipping status to available.
      await holdsSvc.drop(n);
      const r = await booths.setStatus(n, 'sold', { company, actor: socket.data.user });
      if (!r) return;
      track({ type: 'booth.status_change', boothNumber: n, socket,
              meta: { from: r.before.status, to: 'sold', company } });
      await refresh(); broadcastState(io);
      log(io, `✅ <strong>${escapeHtml(company)}</strong> booked Stand ${escapeHtml(n)}`, 'booking');
    }));

    socket.on('booth:hold', requireAdmin(socket, 'booth:hold', async ({ boothNumber, company, hours }) => {
      const n  = stand(boothNumber);
      const ms = Number(hours) > 0 ? Number(hours) * 3600_000 : config.defaultHoldMs;
      const r  = await holdsSvc.create({ boothNumber: n, company: company || 'Pending',
                                         durationMs: ms, actor: socket.data.user });
      if (!r.ok) {
        const reason = r.reason === 'not_available' ? 'it is not available' : r.reason;
        socket.emit('error:action', { message: `Cannot hold stand ${n} — ${reason}` });
        return { ok: false, error: `Stand ${n} could not be held — ${reason}.` };
      }
      await refresh(); broadcastState(io);
      log(io, `⏳ Stand ${escapeHtml(n)} held for ${escapeHtml(company || 'Pending')} until ${r.expiresAt.toLocaleString('en-GB')}`, 'hold');
    }));

    socket.on('booth:release', requireAdmin(socket, 'booth:release', async ({ boothNumber }) => {
      const n = stand(boothNumber);
      const before = await booths.get(n);
      await holdsSvc.release(n, { actor: socket.data.user });
      track({ type: 'booth.status_change', boothNumber: n, socket,
              meta: { from: before?.status, to: 'available' } });
      await refresh(); broadcastState(io);
      log(io, `🔓 Stand ${escapeHtml(n)} released`, 'release');
    }));

    socket.on('booth:update-deal', requireAdmin(socket, 'booth:update-deal', async ({ boothNumber, actualPrice, notes }) => {
      const n = stand(boothNumber);
      const r = await booths.updateDeal(n, { actualPrice, notes, actor: socket.data.user });
      if (!r) return;
      track({ type: 'deal.update', boothNumber: n, socket, meta: {
        fromPrice: r.before.assignment?.actualPrice ?? null, toPrice: actualPrice ?? null,
        notesChanged: notes !== undefined && notes !== r.before.assignment?.notes,
      } });
      await refresh(); broadcastState(io);
      log(io, `📝 Deal updated for Stand ${escapeHtml(n)}`, 'admin');
    }));

    socket.on('admin:setStatus', requireAdmin(socket, 'admin:setStatus', async ({ boothNumber, status, company }) => {
      const allowed = ['available', 'held', 'sold'];
      if (!allowed.includes(status)) return;
      const n = stand(boothNumber);
      const before = await booths.get(n);
      if (!before) return;

      // Forcing 'held' without a hold document left the booth to be reclaimed
      // by the expiry sweep within 60 seconds — the stand silently went back on
      // sale. Keep the hold collection in step with whatever status is forced.
      // forceHold always writes a hold document, even when the stand is not
      // currently available. holdsSvc.create refuses in that case, which used to
      // leave the stand 'held' with no hold doc — reclaimed by the sweep in 60s.
      if (status === 'held') await holdsSvc.forceHold(n, { company: company || 'Pending', actor: socket.data.user });
      else await holdsSvc.drop(n);

      const r = await booths.setStatus(n, status, {
        // Blank company on a status change used to wipe an existing exhibitor.
        company: company || (status === 'available' ? null : before.assignment?.company || null),
        actor: socket.data.user,
      });
      if (!r) return;
      track({ type: 'booth.status_change', boothNumber: n, socket,
              meta: { from: r.before.status, to: status, forced: true } });
      await refresh(); broadcastState(io);
      log(io, `🛠 Admin set Stand ${escapeHtml(n)} → ${escapeHtml(status)}`, 'admin');
    }));

    // Merge two stands into one. The admin client emitted this for a long time
    // with no server handler at all, so the button did nothing.
    socket.on('booth:consolidate', requireAdmin(socket, 'booth:consolidate', async ({ primary, secondary }) => {
      const p = stand(primary), s = stand(secondary);
      const r = await booths.consolidate(p, s, { actor: socket.data.user });
      if (!r.ok) return { ok: false, error: `Could not merge — ${r.reason}` };
      track({ type: 'booth.consolidate', boothNumber: p, socket, meta: { secondary: s } });
      await refresh();
      io.to(ADMIN_ROOM).emit('booth:consolidated', { primary: p, secondary: s });
      broadcastState(io);
      log(io, `🔗 Stand ${escapeHtml(s)} merged into ${escapeHtml(p)}`, 'admin');
    }));

    // Divide one stand into equal parts — the inverse of consolidate, and the
    // manual fix for stands the artwork drew as a single block.
    socket.on('booth:split', requireAdmin(socket, 'booth:split', async ({ boothNumber, parts, axis }) => {
      const n = stand(boothNumber);
      const r = await booths.split(n, { parts, axis, actor: socket.data.user });
      if (!r.ok) return { ok: false, error: `Could not split — ${r.reason}` };
      track({ type: 'booth.split', boothNumber: n, socket, meta: { parts, axis, created: r.created } });
      await refresh(); broadcastState(io);
      log(io, `✂️ Stand ${escapeHtml(n)} split into ${r.created.length + 1} — added ${r.created.map(escapeHtml).join(', ')}`, 'admin');
      return { ok: true, created: r.created };
    }));

    // demo:reset is gone. It wiped all 272 booths and was reachable from any
    // anonymous browser console.

    socket.on('disconnect', () => {
      connections = Math.max(0, connections - 1);
      if (socket.data.viewing && socket.data.viewStart) {
        track({ type: 'booth.dwell', boothNumber: socket.data.viewing, socket,
                meta: { ms: Date.now() - socket.data.viewStart } });
      }
      delete activeViewers[socket.id];
      broadcastState(io);
      io.emit('viewers:count', connections);
    });

    // ── Initial state, sent only once every handler above is bound ────────────
    (async () => {
      try {
        socket.emit('session:id', socket.data.sessionId);
        const rows = decorate();
        socket.emit('state:full', isAdmin ? rows.map(booths.toAdmin) : rows.map(booths.toPublic));

        const s = await booths.stats();
        socket.emit('stats:updated', isAdmin
          ? { ...s, connections }
          : { totalBooths: s.totalBooths, availableBooths: s.availableBooths,
              totalSqm: s.totalSqm, availSqm: s.availSqm });

        io.emit('viewers:count', connections);
        socket.emit('ready');
      } catch (e) {
        console.error('Initial state failed:', e.message);
      }
    })();
  });

  holdsSvc.startExpiryLoop(async (expired) => {
    await refresh();
    broadcastState(io);
    expired.forEach(n => log(io, `⏱ Hold expired — Stand ${escapeHtml(n)} back on sale`, 'system'));
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { register, refresh };
