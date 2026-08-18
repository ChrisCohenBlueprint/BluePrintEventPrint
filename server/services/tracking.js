const { getDb } = require('../db');
const config    = require('../config');

// ─── Buffered event writer ────────────────────────────────────────────────────
// Events are queued in memory and flushed as one bulk insert every few seconds.
// The previous implementation did a synchronous full-file rewrite of all 272
// booths on every single click.
let buffer = [];
let timer  = null;
let inFlight = null;   // the promise of the flush currently writing, if any
let dropped  = 0;      // events dropped while the buffer was full (for one warning)

function flushSoon() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; flush(); }, config.trackingFlushMs);
  if (timer.unref) timer.unref();
}

// Cap on how many events we'll hold in memory if the database is unreachable,
// so a prolonged outage can't grow the buffer without bound.
const MAX_BUFFER = 10_000;

async function flush() {
  // Wait for a write already in progress, THEN send whatever accumulated while
  // it ran. Returning the in-flight promise instead (the previous behaviour)
  // silently skipped the current buffer, so a caller awaiting flush() could be
  // told everything was on disk while recent events were still in memory.
  if (inFlight) await inFlight;
  if (!buffer.length) return;
  const batch = buffer;
  buffer = [];
  inFlight = (async () => {
    try {
      await getDb().collection('activity').insertMany(batch, { ordered: false });
    } catch (e) {
      console.error('Activity flush failed:', e.message);
      // Re-queue rather than drop, so a transient DB blip doesn't silently lose
      // events — but ONLY the docs that genuinely didn't land. The driver stamps
      // each doc with an _id before sending; re-queuing the whole batch after a
      // *partial* success (ordered:false inserts what it can, then throws) would
      // re-send already-inserted docs, which then dup-key, throw again, and loop
      // forever. So: on a BulkWriteError re-queue only the failed indices and
      // drop poison docs (duplicate-key / too-large); otherwise the whole batch
      // never landed. Strip _id so a doc the server actually wrote — despite the
      // client seeing a rejection (e.g. a timeout) — can't dup-key on retry.
      let failed;
      if (e && Array.isArray(e.writeErrors)) {
        const POISON = new Set([11000, 10334, 17419]);   // dup key, doc/BSON too large
        failed = e.writeErrors.filter(we => !POISON.has(we.code)).map(we => batch[we.index]).filter(Boolean);
      } else {
        failed = batch;
      }
      for (const d of failed) { if (d) delete d._id; }
      if (failed.length && buffer.length + failed.length <= MAX_BUFFER) {
        buffer = failed.concat(buffer); flushSoon();
      }
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
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
  // Hard cap the in-memory buffer. The re-queue-on-failure path was bounded, but
  // track() itself pushed unconditionally — during a sustained DB outage new
  // events kept growing the buffer without limit. Once full we drop new events
  // (analytics only) and log once, rather than risk the process memory.
  if (buffer.length >= MAX_BUFFER) {
    if (!dropped) console.error(`Activity buffer full (${MAX_BUFFER}) — dropping events until the DB catches up`);
    dropped++;
    return null;
  }
  if (dropped) { console.warn(`Activity buffer recovered — dropped ${dropped} events during the outage`); dropped = 0; }

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
  // Drain before linking: every event this visitor generated has to be ON DISK,
  // or the updateMany below cannot match it and the lead opens with a partial
  // history. flush() now waits for any in-flight write before sending the
  // current buffer, so one pass is normally enough; the loop covers events
  // recorded while that final write was committing. Bounded so a busy stream of
  // unrelated events can't hold the enquiry response open.
  for (let pass = 0; pass < 5 && (buffer.length || inFlight); pass++) await flush();
  const res = await getDb().collection('activity').updateMany(
    { sessionId, 'actor.contactId': { $exists: false } },
    { $set: { 'actor.contactId': contactId } }
  );
  return res.modifiedCount;
}

module.exports = { track, flush, attributeSession };
