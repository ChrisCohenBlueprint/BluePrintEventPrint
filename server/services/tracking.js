const { getDb } = require('../db');
const config    = require('../config');

// ─── Buffered event writer ────────────────────────────────────────────────────
// Events are queued in memory and flushed as one bulk insert every few seconds.
// The previous implementation did a synchronous full-file rewrite of all 272
// booths on every single click.
let buffer = [];
let timer  = null;
let inFlight = null;   // the promise of the flush currently writing, if any
// Events refused while their budget was full (one warning per budget), and
// events from a failed batch that there was no room to put back.
const dropped = { visitor: 0, staff: 0 };
let lost = 0;

function flushSoon() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; flush(); }, config.trackingFlushMs);
  if (timer.unref) timer.unref();
}

// Caps on how many events we'll hold in memory if the database is unreachable,
// so a prolonged outage can't grow the buffer without bound.
//
// Two budgets, not one. There used to be a single cap for everything, and the
// public events are unauthenticated: one anonymous socket looping session:adopt
// filled all 10,000 places in about a second, after which every booking, hold
// and security record was dropped along with the junk. What an anonymous
// visitor can cause now stops at MAX_BUFFER; what staff and the system do — the
// audit trail — may go STAFF_RESERVE past it, so however full the visitors make
// the queue there is always room for that.
const MAX_BUFFER    = 10_000;
const STAFF_RESERVE = 5_000;

// Anything not attributed to a signed-in person or to the system is a
// visitor's, including a refused admin event from an anonymous socket: that is
// exactly what a flood is made of, so it must not be able to use the reserve.
const budgetOf = (doc) => (doc.actor?.kind === 'visitor' ? 'visitor' : 'staff');
const capOf    = (budget) => (budget === 'visitor' ? MAX_BUFFER : MAX_BUFFER + STAFF_RESERVE);

/**
 * Put the documents of a failed batch back at the front of the queue, as far as
 * the budgets allow — staff and system events first, since they are the record
 * of what was actually done. Whatever does not fit is lost; that used to happen
 * without a word, so now it is counted and said.
 */
function requeue(docs) {
  let size = buffer.length;
  const keep = new Set();
  for (const budget of ['staff', 'visitor']) {
    for (const d of docs) {
      if (budgetOf(d) !== budget || size >= capOf(budget)) continue;
      keep.add(d); size++;
    }
  }
  const back = docs.filter(d => keep.has(d));
  const gone = docs.length - back.length;
  if (gone) {
    lost += gone;
    console.error(`Activity flush: ${gone} events from the failed batch did not fit back in the buffer and are lost (${lost} so far)`);
  }
  if (back.length) { buffer = back.concat(buffer); flushSoon(); }
}

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
      // events — but ONLY the docs that genuinely didn't land.
      //
      // insertMany goes through bulkWrite, and the driver reports EVERY failure
      // of a batch as a MongoBulkWriteError — a dropped connection, a server
      // selection timeout and a failover's not-primary included. For those it
      // sets writeErrors to an EMPTY array, so "is writeErrors an array?" read a
      // lost batch as "nothing failed" and dropped all of it: an Atlas blip cost
      // up to one flush interval of events. Only a NON-EMPTY writeErrors is the
      // server naming the documents it refused; then we re-queue just those and
      // drop poison docs (duplicate-key / too-large), which would fail the same
      // way forever. Anything else, the whole batch goes back.
      //
      // Each doc keeps the _id the driver stamped on it before sending. That is
      // what makes the retry safe: a document the server did write — despite
      // the client seeing a rejection (a timeout after commit, a write-concern
      // error) — is refused as a duplicate on the retry and dropped as poison,
      // rather than written a second time under a fresh id.
      let failed;
      if (e && Array.isArray(e.writeErrors) && e.writeErrors.length) {
        const POISON = new Set([11000, 10334, 17419]);   // dup key, doc/BSON too large
        failed = e.writeErrors.filter(we => !POISON.has(we.code)).map(we => batch[we.index]).filter(Boolean);
      } else {
        failed = batch;
      }
      if (failed.length) requeue(failed);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * The address a socket connected from, as Express's `req.ip` gives it.
 *
 * server.js sets `trust proxy` to 1: Render's load balancer is the one hop in
 * front of us, and it APPENDS the address it saw to X-Forwarded-For. So the
 * right-most entry is the client's real address and everything to its left is
 * whatever the client chose to send. This used to take the left-most entry,
 * which made every IP on an analytics or security record the client's own
 * claim. With no header, the connection's own address, as Express does.
 *
 * Untruncated — for in-memory rate limiting only. What is stored goes through
 * clientIp() below.
 */
function socketIp(socket) {
  const fwd = socket?.handshake?.headers?.['x-forwarded-for'];
  const hops = fwd ? String(fwd).split(',').map(h => h.trim()).filter(Boolean) : [];
  return hops.length ? hops[hops.length - 1] : (socket?.handshake?.address || null);
}

// Client IP, accounting for Render's proxy. Truncated (IPv4 → /24, IPv6 → /48)
// before storage: enough for coarse network/analytics context without keeping a
// full address that identifies an individual visitor for the retention window.
function clientIp(socket) {
  const raw = socketIp(socket);
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

  // Hard cap the in-memory buffer. The re-queue-on-failure path was bounded, but
  // track() itself pushed unconditionally — during a sustained DB outage new
  // events kept growing the buffer without limit. Once a budget is full we drop
  // new events from it and log once, rather than risk the process memory.
  const budget = resolvedActor.kind === 'visitor' ? 'visitor' : 'staff';
  if (buffer.length >= capOf(budget)) {
    if (!dropped[budget]) {
      console.error(`Activity buffer full for ${budget} events (${buffer.length}) — dropping them until the DB catches up`);
    }
    dropped[budget]++;
    return null;
  }
  if (dropped[budget]) {
    console.warn(`Activity buffer recovered — dropped ${dropped[budget]} ${budget} events while it was full`);
    dropped[budget] = 0;
  }

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
  // Scoped to the show as well as the session. A session id is a browser, and
  // one browser can visit two of this deployment's events — so attributing by
  // session alone spliced a visitor's browsing of ANOTHER event onto this
  // event's lead, and handed it to sales as that lead's history.
  const res = await getDb().collection('activity').updateMany(
    { showId: config.showId, sessionId, 'actor.contactId': { $exists: false } },
    { $set: { 'actor.contactId': contactId } }
  );
  return res.modifiedCount;
}

/** What is waiting to be written, and what has been given up — for the tests and the logs. */
const stats = () => ({ pending: buffer.length, dropped: { ...dropped }, lost });

module.exports = { track, flush, attributeSession, socketIp, stats };
