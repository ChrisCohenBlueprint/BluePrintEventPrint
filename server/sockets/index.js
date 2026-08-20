const crypto = require('crypto');

const config    = require('../config');
const booths    = require('../models/booths');
const sponsors  = require('../models/sponsors');
const settings  = require('../models/settings');
const tags      = require('../models/tags');
const users     = require('../models/users');
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

// Versioned so concurrent refreshes can't leave the cache on an OLDER snapshot:
// two mutations racing means two in-flight all() queries, and whichever RETURNS
// last would otherwise win regardless of which was issued last. We stamp each
// refresh and only accept the result of the most-recently issued one — the one
// that saw the newest DB state. Otherwise a held/sold stand could show as
// available to every viewer until the next mutation happened to refresh.
let refreshSeq = 0;
async function refresh() {
  const seq = ++refreshSeq;
  const rows = await booths.all();
  if (seq === refreshSeq) cache = rows;
}

// ─── Tag catalogue ────────────────────────────────────────────────────────────
// Every client needs it to turn a booth's tag KEYS into labelled chips, and it
// changes only when an admin edits the catalogue — so it is cached here and
// pushed on connect and on every edit, rather than repeated on each of the 272
// booths in every state broadcast.
let tagCache = [];
async function refreshTags() { tagCache = await tags.catalogue(); }
function broadcastTags(io) { io.emit('tags:catalogue', tagCache); }

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

  // Prime the tag catalogue once at boot. A failure here is not fatal — stands
  // simply render without chips until the next catalogue edit refreshes it.
  refreshTags().catch(e => console.error('Tag catalogue not loaded:', e.message));

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
      // Also move the live-viewer marker, else the heatmap stayed pinned to the
      // last booth:view and clicks never moved it.
      activeViewers[socket.id] = n;
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
      // Coerce to finite numbers — the client controls these and they land in a
      // stored `meta`; an arbitrarily large string/object would bloat memory and
      // could even produce a >16 MB document Mongo rejects. Non-finite → null.
      const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
      track({ type: 'plan.zoom', socket, meta: { level: num(level), cx: num(cx), cy: num(cy) } });
    });

    // Replaces booth:book / booth:hold on the public floorplan. Captures the
    // name and email that were previously discarded in the browser.
    socket.on('inquiry:submit', safe('inquiry:submit', async (payload = {}, ack) => {
      if (!allowSubmit()) return ack?.({ ok: false, errors: ['Too many submissions. Please wait a moment.'] });
      if (payload.website) return ack?.({ ok: true });   // honeypot

      try {
        const res = await inquiries.create({ ...payload, sessionId: socket.data.sessionId });
        if (res.ok) {
          // create() accepts an enquiry on sponsorKeys alone, so boothNumbers may
          // be absent or a non-array. Guard the .join — a raw string would throw
          // here, drop into the catch, and tell the visitor it failed (prompting
          // a duplicate submit) even though the lead was saved and the admin ping
          // below was skipped.
          // The stand numbers as STORED (validated + length-capped by create),
          // rather than the raw form payload.
          const booths = res.boothsOfInterest || [];
          // The form now sends first/last separately; build a display name from
          // whatever it provided (falling back to a legacy single `name`).
          const who = [payload.firstName, payload.lastName].map(s => (s || '').trim()).filter(Boolean).join(' ')
                    || (payload.name || '').trim() || 'someone';
          // Escaped per element, exactly like every other value that reaches the
          // admin log. These originate in the PUBLIC enquiry form and are never
          // checked against real stands, so an unescaped join put attacker-chosen
          // HTML into addLog()'s innerHTML — script execution in the
          // authenticated admin session, triggered by an anonymous visitor.
          log(io, `📩 Enquiry from <strong>${escapeHtml(who)}</strong> — stands ${booths.map(escapeHtml).join(', ') || 'none'}`, 'inquiry');
          // The socket payload is rendered with textContent by the client, so it
          // carries the raw values.
          io.to(ADMIN_ROOM).emit('inquiry:new', { id: res.id, name: who, booths });
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
      // Only book from available/held — if another admin booked it in the
      // meantime the conditional write won't match, and we say so rather than
      // overwriting their exhibitor.
      const r = await booths.setStatus(n, 'sold', { company, actor: socket.data.user, expect: ['available', 'held'] });
      if (!r) return { ok: false, error: `Stand ${n} not found.` };
      if (!r.changed) return { ok: false, error: `Stand ${n} is already taken — reload to see the latest.` };
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

    // Password-gated (re-enter the admin's own login password): release now frees
    // a SOLD stand too, which drops the sale, so a stray click can't un-book an
    // exhibitor without the password.
    socket.on('booth:release', requireAdmin(socket, 'booth:release', async ({ boothNumber, password }) => {
      // Releasing un-books a stand (destroys the booking). When the recovery-key
      // failsafe is on, require THAT key (not the admin login, so a stolen admin
      // session can't erase bookings); otherwise fall back to the admin password.
      if (config.recoveryEnabled()) {
        if (!config.recoveryOk(password)) return { ok: false, error: 'Recovery key incorrect — stand not released.' };
      } else {
        const account = await users.findByUsername(socket.data.user);   // full doc incl. passwordHash
        if (!account || !users.verifyPassword(String(password || ''), account.passwordHash)) {
          users.absorbPassword(String(password || ''));          // constant-time on the failure path
          return { ok: false, error: 'Password incorrect — stand not released.' };
        }
      }
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
      if (!r) return { ok: false, error: `Stand ${n} not found.` };
      if (r.error === 'bad_price') return { ok: false, error: 'Price must be a non-negative number.' };
      // The write is guarded to sold/held stands; `changed:false` means it didn't
      // match, so report it instead of falsely acking success (which left the UI
      // showing "saved" while the value reverted on the next broadcast).
      if (!r.changed) return { ok: false, error: `Stand ${n} must be sold or on hold to hold a price or notes.` };
      track({ type: 'deal.update', boothNumber: n, socket, meta: {
        fromPrice: r.before.assignment?.actualPrice ?? null, toPrice: actualPrice ?? null,
        notesChanged: notes !== undefined && notes !== r.before.assignment?.notes,
      } });
      await refresh(); broadcastState(io);
      log(io, `📝 Deal updated for Stand ${escapeHtml(n)}`, 'admin');
    }));

    socket.on('admin:setStatus', requireAdmin(socket, 'admin:setStatus', async ({ boothNumber, status, company, key }) => {
      const allowed = ['available', 'held', 'sold'];
      // Returning bare `undefined` here made requireAdmin ack {ok:true}, so the
      // UI reported a successful change that never happened.
      if (!allowed.includes(status)) return { ok: false, error: 'Status must be available, held or sold.' };
      const n = stand(boothNumber);
      const before = await booths.get(n);
      if (!before) return { ok: false, error: `Stand ${n} not found.` };

      // Forcing a booked/held stand back to Available un-books it (destroys the
      // booking) — same failsafe as Release: require the recovery key when on.
      const unbooking = status === 'available' && before.status !== 'available';
      if (unbooking && config.recoveryEnabled() && !config.recoveryOk(key)) {
        return { ok: false, error: 'Recovery key incorrect — status not changed.' };
      }

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

    // Move a booking from one stand to another — an exhibitor upgrading or
    // downgrading. Size and cost follow because they belong to the stand.
    socket.on('booth:move', requireAdmin(socket, 'booth:move', async ({ from, to }) => {
      const f = stand(from), t = stand(to);
      const r = await booths.move(f, t, { actor: socket.data.user });
      if (!r.ok) {
        const why = r.reason === 'nothing_to_move'  ? 'the first stand has no booking to move'
                  : r.reason === 'to_not_available' ? 'the destination stand is not available'
                  : r.reason === 'same_booth'       ? 'pick two different stands'
                  : r.reason === 'move_conflict'    ? 'the first stand changed while moving — nothing was moved, please try again'
                  : r.reason;
        return { ok: false, error: `Could not move — ${why}.` };
      }
      // A held booking carries a hold document; move it to the new stand so the
      // expiry sweep doesn't reclaim the destination (held with no doc) in 60s,
      // and doesn't leave a stale doc on the freed source.
      if (r.status === 'held') {
        await holdsSvc.drop(f);
        await holdsSvc.forceHold(t, { company: r.company || 'Pending', actor: socket.data.user });
      }
      track({ type: 'booth.move', boothNumber: t, socket, meta: {
        from: f, to: t, company: r.company, status: r.status,
        fromSqm: r.fromSqm, toSqm: r.toSqm, fromListPrice: r.fromListPrice, toListPrice: r.toListPrice,
        newActualPrice: r.newActualPrice,
      } });
      await refresh(); broadcastState(io);
      log(io, `↕ <strong>${escapeHtml(r.company || 'Booking')}</strong> moved from Stand ${escapeHtml(f)} (${r.fromSqm} m²) to Stand ${escapeHtml(t)} (${r.toSqm} m²)`, 'booking');
      return { ok: true, ...r };
    }));

    // Merge two stands into one. The admin client emitted this for a long time
    // with no server handler at all, so the button did nothing.
    socket.on('booth:consolidate', requireAdmin(socket, 'booth:consolidate', async ({ primary, secondary }) => {
      const p = stand(primary), s = stand(secondary);
      const r = await booths.consolidate(p, s, { actor: socket.data.user });
      if (!r.ok) {
        const why = r.reason === 'not_adjacent' ? 'the stands are not next to each other'
                  : r.reason === 'not_available' ? 'both stands must be available'
                  : r.reason === 'reset_first'   ? 'one of the stands was already merged or split — reset it first'
                  : r.reason;
        return { ok: false, error: `Could not merge — ${why}.` };
      }
      track({ type: 'booth.consolidate', boothNumber: p, socket, meta: { secondary: s } });
      await refresh();
      io.to(ADMIN_ROOM).emit('booth:consolidated', { primary: p, secondary: s });
      broadcastState(io);
      log(io, `🔗 Stand ${escapeHtml(s)} merged into ${escapeHtml(p)}`, 'admin');
    }));

    // Merge a whole shift-selected block of adjacent stands into one.
    socket.on('booth:consolidate-many', requireAdmin(socket, 'booth:consolidate-many', async ({ boothNumbers }) => {
      const nums = (boothNumbers || []).map(stand);
      const r = await booths.consolidateMany(nums, { actor: socket.data.user });
      if (!r.ok) {
        const why = r.reason === 'not_contiguous' ? 'the stands must sit next to each other with no gaps'
                  : r.reason === 'not_available' ? 'every stand must be available'
                  : r.reason === 'reset_first'   ? 'one of the stands is already merged or split — reset it first'
                  : r.reason === 'need_two'      ? 'select at least two stands'
                  : r.reason === 'missing_booth' ? 'one of the stands no longer exists — refresh and try again'
                  : r.reason === 'no_geometry'   ? 'one of the stands has no shape to merge'
                  : r.reason;
        return { ok: false, error: `Could not merge — ${why}.` };
      }
      track({ type: 'booth.consolidate', boothNumber: r.primary.boothNumber, socket, meta: { many: r.absorbed } });
      await refresh();
      io.to(ADMIN_ROOM).emit('booth:consolidated', { primary: r.primary.boothNumber, secondary: r.absorbed });
      broadcastState(io);
      log(io, `🔗 ${r.absorbed.length + 1} stands merged into ${escapeHtml(r.primary.boothNumber)}`, 'admin');
      return { ok: true, primary: r.primary.boothNumber, absorbed: r.absorbed };
    }));

    // Divide one stand into equal parts — the inverse of consolidate, and the
    // manual fix for stands the artwork drew as a single block.
    socket.on('booth:split', requireAdmin(socket, 'booth:split', async ({ boothNumber, parts, axis }) => {
      const n = stand(boothNumber);
      const r = await booths.split(n, { parts, axis, actor: socket.data.user });
      if (!r.ok) {
        const why = r.reason === 'reset_first' ? 'it was already merged or split — reset it first'
                  : r.reason === 'not_available' ? 'the stand must be available'
                  : r.reason === 'too_small' ? 'the stand is too small to divide that many ways'
                  : r.reason;
        return { ok: false, error: `Could not split — ${why}.` };
      }
      track({ type: 'booth.split', boothNumber: n, socket, meta: { parts, axis, created: r.created } });
      await refresh(); broadcastState(io);
      log(io, `✂️ Stand ${escapeHtml(n)} split into ${r.created.length + 1} — added ${r.created.map(escapeHtml).join(', ')}`, 'admin');
      return { ok: true, created: r.created };
    }));

    // Custom split: re-carve a stand into cells with the admin's own numbers and
    // sizes (parts = [{ number, sqm }]). Works on a merged block too.
    socket.on('booth:split-custom', requireAdmin(socket, 'booth:split-custom', async ({ boothNumber, axis, parts }) => {
      const n = stand(boothNumber);
      const r = await booths.splitCustom(n, { axis, parts, actor: socket.data.user });
      if (!r.ok) {
        const why = r.reason === 'reset_first' ? 'it is already split — reset it first'
                  : r.reason === 'not_available' ? 'the stand must be available'
                  : r.reason === 'bad_parts' ? 'give 2–8 parts, each with a number and a size'
                  : r.reason === 'size_mismatch' ? `the sizes must add up to the stand's ${r.total} — you entered ${r.got}`
                  : r.reason === 'dup_number' ? 'each part needs a different number'
                  : r.reason === 'duplicate' ? `the number ${r.number} is already used by Stand ${r.clashWith}`
                  : r.reason === 'bad_value' ? `"${r.number}" isn't a valid number — use only letters, numbers, spaces, . / or -`
                  : r.reason === 'suffix_exists' ? 'a generated cell id already exists — reset the stand first'
                  : r.reason === 'no_geometry' ? 'the stand has no geometry to divide'
                  : r.reason;
        return { ok: false, error: `Could not split — ${why}.` };
      }
      track({ type: 'booth.split', boothNumber: n, socket, meta: { custom: true, axis, created: r.created } });
      await refresh(); broadcastState(io);
      log(io, `✂️ Stand ${escapeHtml(n)} custom-split into ${r.created.length + 1}`, 'admin');
      return { ok: true, created: r.created };
    }));

    // Undo a merge or split (or clear a stray leftover cell).
    socket.on('booth:reset', requireAdmin(socket, 'booth:reset', async ({ boothNumber }) => {
      const n = stand(boothNumber);
      const r = await booths.reset(n);
      if (!r.ok) {
        const why = r.reason === 'not_composite' ? 'this stand was not merged or split'
                  : r.reason === 'not_available' ? 'the stand must be available'
                  : r.reason === 'child_booked'  ? 'one of its split cells has been booked — release it first'
                  : r.reason === 'child_split'   ? 'one of its split cells was split again — reset that cell first'
                  : r.reason;
        return { ok: false, error: `Could not reset ${n} — ${why}.` };
      }
      track({ type: 'booth.reset', boothNumber: n, socket, meta: { type: r.type, changed: r.restored || r.removed } });
      await refresh(); broadcastState(io);
      const detail = r.type === 'unmerge' ? `restored ${(r.restored || []).join(', ') || 'originals'}`
                   : r.type === 'unsplit' ? `removed ${(r.removed || []).join(', ')}`
                   : 'removed leftover cell';
      log(io, `↩️ Stand ${escapeHtml(n)} reset — ${escapeHtml(detail)}`, 'admin');
      return { ok: true, ...r };
    }));

    // Set (or clear) a stand's shown number — a display label only; the internal
    // identity (boothNumber) is unchanged, so nothing else needs to move.
    socket.on('booth:set-number', requireAdmin(socket, 'booth:set-number', async ({ boothNumber, displayNumber }) => {
      const n = stand(boothNumber);
      const r = await booths.setDisplayNumber(n, displayNumber, { actor: socket.data.user });
      if (!r.ok) {
        const why = r.reason === 'missing_booth' ? 'that stand does not exist'
                  : r.reason === 'bad_value'     ? 'use only letters, numbers, spaces, . / or -'
                  : r.reason === 'duplicate'     ? `that number is already used by Stand ${r.clashWith}`
                  : r.reason;
        return { ok: false, error: `Could not update — ${why}.` };
      }
      track({ type: 'booth.set_number', boothNumber: n, socket, meta: { displayNumber: r.value || null, cleared: !!r.cleared } });
      await refresh(); broadcastState(io);
      log(io, r.cleared
        ? `#️⃣ Stand ${escapeHtml(n)} shown number cleared — back to ${escapeHtml(n)}`
        : `#️⃣ Stand ${escapeHtml(n)} now shown as ${escapeHtml(r.value)}`, 'admin');
      return { ok: true, ...r };
    }));

    // ── Tags ──────────────────────────────────────────────────────────────
    // The catalogue an admin curates in Tools, and the (max 3) tags each booked
    // stand carries. Handled over the socket rather than REST so every open
    // floorplan repaints the moment a tag is added, renamed or removed.

    socket.on('tags:create', requireAdmin(socket, 'tags:create', async ({ label, color }) => {
      const r = await tags.create({ label, color });
      if (!r.ok) {
        const why = r.reason === 'no_label'  ? 'give the tag a name'
                  : r.reason === 'duplicate' ? 'a tag with that name already exists'
                  : 'that tag could not be created';
        return { ok: false, error: `Could not add tag — ${why}.` };
      }
      await refreshTags(); broadcastTags(io);
      log(io, `🏷️ Tag added — ${escapeHtml(r.tag.label)}`, 'admin');
      return { ok: true, tag: r.tag, catalogue: tagCache };
    }));

    // Rename / recolour. The stored key never changes, so every stand already
    // carrying this tag simply starts rendering the new label.
    socket.on('tags:update', requireAdmin(socket, 'tags:update', async ({ key, label, color }) => {
      const r = await tags.update(String(key || ''), { label, color });
      if (!r.ok) {
        const why = r.reason === 'missing_tag' ? 'that tag no longer exists'
                  : r.reason === 'duplicate'   ? 'a tag with that name already exists'
                  : r.reason === 'no_label'    ? 'give the tag a name'
                  : 'it could not be saved';
        return { ok: false, error: `Could not update tag — ${why}.` };
      }
      await refreshTags(); broadcastTags(io);
      log(io, `🏷️ Tag updated — ${escapeHtml(r.tag.label)}`, 'admin');
      return { ok: true, tag: r.tag, catalogue: tagCache };
    }));

    // Delete. The tag is pulled off every stand FIRST, so no stand is ever left
    // holding a key with nothing to resolve it against.
    socket.on('tags:delete', requireAdmin(socket, 'tags:delete', async ({ key }) => {
      const k = String(key || '');
      const cleared = await booths.removeTag(k);
      const ok = await tags.remove(k);
      if (!ok) return { ok: false, error: 'That tag no longer exists.' };
      await refreshTags(); broadcastTags(io);
      await refresh(); broadcastState(io);
      log(io, `🏷️ Tag deleted — removed from ${cleared} stand${cleared === 1 ? '' : 's'}`, 'admin');
      return { ok: true, cleared, catalogue: tagCache };
    }));

    // Set the tags on one booked stand. Replaces the whole set, so the UI can
    // send exactly what the chips show.
    socket.on('booth:set-tags', requireAdmin(socket, 'booth:set-tags', async ({ boothNumber, tags: keys }) => {
      const n = stand(boothNumber);
      const r = await booths.setTags(n, keys, {
        valid: await tags.validKeys(), max: tags.MAX_PER_BOOTH, actor: socket.data.user,
      });
      if (!r.ok) {
        const why = r.reason === 'missing_booth' ? 'that stand does not exist'
                  : r.reason === 'too_many'      ? `a stand can carry at most ${r.max} tags`
                  : r.reason === 'unknown_tag'   ? 'one of those tags no longer exists'
                  : 'they could not be saved';
        return { ok: false, error: `Could not save tags — ${why}.` };
      }
      if (!r.changed) return { ok: false, error: `Stand ${n} is not booked — tags apply to a booked stand.` };
      track({ type: 'booth.set_tags', boothNumber: n, socket, meta: { tags: r.tags } });
      await refresh(); broadcastState(io);
      const names = r.tags.map(k => tagCache.find(t => t.key === k)?.label || k);
      log(io, names.length
        ? `🏷️ Stand ${escapeHtml(n)} tagged — ${escapeHtml(names.join(', '))}`
        : `🏷️ Stand ${escapeHtml(n)} tags cleared`, 'admin');
      return { ok: true, tags: r.tags };
    }));

    // Set the exhibitor's country on one booked stand. Unlike the tags this is
    // a single value from a built-in list, so there is nothing to curate — the
    // handler only has to reject a code the list does not contain.
    socket.on('booth:set-country', requireAdmin(socket, 'booth:set-country', async ({ boothNumber, country }) => {
      const n = stand(boothNumber);
      const r = await booths.setCountry(n, country, { actor: socket.data.user });
      if (!r.ok) {
        const why = r.reason === 'missing_booth'   ? 'that stand does not exist'
                  : r.reason === 'unknown_country' ? 'that is not a country we recognise'
                  : 'it could not be saved';
        return { ok: false, error: `Could not save the country — ${why}.` };
      }
      if (!r.changed) return { ok: false, error: `Stand ${n} is not booked — a country applies to a booked stand.` };
      track({ type: 'booth.set_country', boothNumber: n, socket, meta: { country: r.country } });
      await refresh(); broadcastState(io);
      log(io, r.country
        ? `🌍 Stand ${escapeHtml(n)} country set — ${escapeHtml(r.name)}`
        : `🌍 Stand ${escapeHtml(n)} country cleared`, 'admin');
      return { ok: true, country: r.country, name: r.name };
    }));

    // Set the floorplan (title) sponsor: name + brand colour. Broadcast to every
    // client so the legend swatch and any sponsored-booth fills update live.
    socket.on('sponsor:set-floorplan', requireAdmin(socket, 'sponsor:set-floorplan', async ({ name, color }) => {
      const saved = await sponsors.setFloorplanSponsor({ name, color });
      io.emit('floorplan-sponsor', saved);
      log(io, saved.color
        ? `🎨 Floorplan sponsor set — ${escapeHtml(saved.name || 'unnamed')} (${escapeHtml(saved.color)})`
        : `🎨 Floorplan sponsor cleared`, 'admin');
      return { ok: true, ...saved };
    }));

    // Flag/unflag a stand as the sponsor's, so it fills with the brand colour.
    socket.on('booth:set-sponsored', requireAdmin(socket, 'booth:set-sponsored', async ({ boothNumber, sponsored }) => {
      const n = stand(boothNumber);
      const r = await booths.setSponsored(n, sponsored === true, { actor: socket.data.user });
      if (!r.ok) return { ok: false, error: `Could not update Stand ${n}.` };
      await refresh(); broadcastState(io);
      log(io, r.sponsored ? `🎨 Stand ${escapeHtml(n)} marked as sponsor booth`
                          : `🎨 Stand ${escapeHtml(n)} unmarked as sponsor booth`, 'admin');
      return { ok: true, ...r };
    }));

    // Change the €/unit rate. Password-gated (re-enter the admin's own login
    // password), because it reprices every stand's list price across the board.
    socket.on('settings:set-rate', requireAdmin(socket, 'settings:set-rate', async ({ rate, password }) => {
      const account = await users.findByUsername(socket.data.user);   // full doc incl. passwordHash
      if (!account || !users.verifyPassword(String(password || ''), account.passwordHash)) {
        users.absorbPassword(String(password || ''));          // constant-time on the failure path
        return { ok: false, error: 'Password incorrect — rate not changed.' };
      }
      const saved = await settings.setRate(rate);
      if (!saved.ok) return { ok: false, error: 'Enter a valid rate (a positive number).' };
      const rep = await booths.recomputeListPrices(saved.ratePerSqm, { actor: socket.data.user });
      await refresh(); broadcastState(io);
      io.to(ADMIN_ROOM).emit('settings', { ratePerSqm: saved.ratePerSqm });
      log(io, `💶 Rate set to €${saved.ratePerSqm}/unit — ${rep.repriced || 0} stands repriced`, 'admin');
      return { ok: true, ratePerSqm: saved.ratePerSqm, repriced: rep.repriced };
    }));

    // Switch the area unit (m² ↔ ft²). A display label only — no numbers change.
    socket.on('settings:set-unit', requireAdmin(socket, 'settings:set-unit', async ({ unit }) => {
      const saved = await settings.setUnit(unit);
      io.emit('settings', { unit: saved.unit });               // public: label only
      log(io, `📐 Area unit set to ${saved.unit === 'ft' ? 'ft²' : 'm²'}`, 'admin');
      return { ok: true, unit: saved.unit };
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

        socket.emit('floorplan-sponsor', await sponsors.getFloorplanSponsor());
        socket.emit('tags:catalogue', tagCache);

        // Unit is a harmless display label (public). The €/unit rate is
        // admin-only: public sqm × rate would reveal list prices.
        const st = await settings.get();
        socket.emit('settings', { unit: st.unit, ratePerSqm: isAdmin ? st.ratePerSqm : undefined,
          // Whether destructive admin actions need the recovery key, so the UI
          // knows to prompt for it. Admin-only — never advertised to the public.
          recoveryRequired: isAdmin ? config.recoveryEnabled() : undefined });

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
