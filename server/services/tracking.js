const { getDb } = require('../db');
const config    = require('../config');

// ─── Buffered event writer ────────────────────────────────────────────────────
// Events are queued in memory and flushed as one bulk insert every few seconds.
// The previous implementation did a synchronous full-file rewrite of all 272
// booths on every single click.
let buffer = [];
let timer  = null;

function flushSoon() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; flush(); }, config.trackingFlushMs);
  if (timer.unref) timer.unref();
}

// Cap on how many events we'll hold in memory if the database is unreachable,
// so a prolonged outage can't grow the buffer without bound.
const MAX_BUFFER = 10_000;

async function flush() {
  if (!buffer.length) return;
  const batch = buffer;
  buffer = [];
  try {
    await getDb().collection('activity').insertMany(batch, { ordered: false });
  } catch (e) {
    console.error('Activity flush failed:', e.message);
    // Re-queue rather than drop, so a transient DB blip doesn't silently lose
    // events — bounded, and only if newer events haven't already filled it.
    if (buffer.length + batch.length <= MAX_BUFFER) { buffer = batch.concat(buffer); flushSoon(); }
  }
}

// Client IP, accounting for Render's proxy. Truncated (IPv4 → /24, IPv6 → /48)
// before storage: enough for coarse network/analytics context without keeping a
// full address that identifies an individual visitor for the retention window.
function clientIp(socket) {
  const fwd = socket?.handshake?.headers?.['x-forwarded-for'];
  const raw = fwd ? String(fwd).split(',')[0].trim() : (socket?.handshake?.address || null);
  if (!raw) return null;
  if (raw.includes('.')) {                       // IPv4 (incl. ::ffff:a.b.c.d)
    const p = raw.replace(/^::ffff:/i, '').split('.');
    return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0` : raw;
  }
  if (raw.includes(':')) {                        // IPv6 → first three hextets
    const head = raw.split(':').slice(0, 3).join(':');
    return head.includes('::') ? head : head + '::';
  }
  return raw;
}

/**
 * Record one event.
 *
 * Identity and timestamp are stamped server-side — a client-supplied actor is
 * not an audit trail. The client only ever supplies sessionId and event meta.
 */
function track({ type, boothNumber = null, meta = {}, socket = null, sessionId = null, actor = null }) {
  // `actor` covers writes that originate outside a socket — the hold expiry
  // sweep, migrations, and service calls that only know the acting username.
  const resolvedActor = actor
    ? (typeof actor === 'string'
        ? { kind: actor.startsWith('system') ? 'system' : 'admin', userId: actor }
        : actor)
    : { kind: socket?.data?.isAdmin ? 'admin' : 'visitor', userId: socket?.data?.user || null };

  const doc = {
    ts:     new Date(),
    showId: config.showId,
    type,
    sessionId: sessionId || socket?.data?.sessionId || null,
    actor: resolvedActor,
    boothNumber,
    meta,
    context: socket ? {
      ip:        clientIp(socket),
      userAgent: socket.handshake.headers['user-agent'] || null,
      referrer:  socket.handshake.headers.referer || null,
    } : {},
  };

  buffer.push(doc);
  flushSoon();
  return doc;
}

/**
 * Link every event a visitor generated before they identified themselves to the
 * contact record they just created. This is what lets sales open a lead and see
 * the full browsing history that preceded it (plan §04).
 */
async function attributeSession(sessionId, contactId) {
  if (!sessionId || !contactId) return 0;
  await flush();  // make sure this session's pending events are on disk first
  const res = await getDb().collection('activity').updateMany(
    { sessionId, 'actor.contactId': { $exists: false } },
    { $set: { 'actor.contactId': contactId } }
  );
  return res.modifiedCount;
}

module.exports = { track, flush, attributeSession };
