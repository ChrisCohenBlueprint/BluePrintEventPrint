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

async function flush() {
  if (!buffer.length) return;
  const batch = buffer;
  buffer = [];
  try {
    await getDb().collection('activity').insertMany(batch, { ordered: false });
  } catch (e) {
    console.error('Activity flush failed:', e.message);
  }
}

// Client IP, accounting for Render's proxy.
function clientIp(socket) {
  const fwd = socket?.handshake?.headers?.['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return socket?.handshake?.address || null;
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
