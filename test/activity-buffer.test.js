/**
 * The activity buffer keeps what it is given, and keeps the audit trail first.
 *
 * Every event — a visitor looking at a stand, an admin booking one, a refused
 * attempt to reach an admin action — is queued in memory and written in one
 * batch every few seconds. Three ways that lost events, each asserted here:
 *
 *   crowding   — the queue had one cap for everything, so an anonymous socket
 *                looping a public event filled it in about a second and then
 *                every booking, hold and security record was thrown away.
 *                Visitors' events now have a budget of their own; what staff
 *                and the system do always has room.
 *   blips      — the driver reports a network or failover error on a batch as
 *                a bulk-write error with an EMPTY list of per-document
 *                failures, which read as "nothing failed", so the whole batch
 *                was dropped. A batch that never landed is now retried, once
 *                each: a document that did land despite the error is refused
 *                as a duplicate on the retry, not written twice.
 *   overflow   — a failed batch that no longer fitted was discarded without a
 *                word. It is now kept as far as it fits, and the rest counted.
 *
 * And the address recorded on each event is the one the proxy saw, not the
 * left-most X-Forwarded-For entry, which the client writes itself.
 */
const { MongoBulkWriteError, MongoNetworkError } = require('mongodb');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

// A collection that behaves like the real one where it matters here: the driver
// stamps an _id on each document before sending it, and the server refuses a
// second document with the same _id. `fail` decides what the next write does.
// `written` is what each section wrote; `ids` is the unique index, which
// remembers everything.
const written = [];
const ids = new Set();
const land = (d) => { written.push({ ...d }); ids.add(String(d._id)); };
let fail = null;
const activity = {
  insertMany: async (docs) => {
    const ObjectId = require('mongodb').ObjectId;
    for (const d of docs) if (d._id == null) d._id = new ObjectId();
    const mode = fail; fail = null;
    if (mode === 'network') {
      throw new MongoBulkWriteError(new MongoNetworkError('connection 3 to atlas closed'), {});
    }
    // Committed on the server, but the client never heard back.
    if (mode === 'landed-then-timeout') {
      docs.forEach(land);
      throw new MongoBulkWriteError(new MongoNetworkError('socket timeout'), {});
    }
    const writeErrors = [];
    docs.forEach((d, index) => {
      if (ids.has(String(d._id))) {
        writeErrors.push({ index, code: 11000, errmsg: 'E11000 duplicate key' });
      } else if (mode === 'one-transient' && index === 1) {
        writeErrors.push({ index, code: 189, errmsg: 'PrimarySteppedDown' });
      } else {
        land(d);
      }
    });
    if (writeErrors.length) {
      throw new MongoBulkWriteError({ message: 'write errors', code: writeErrors[0].code, writeErrors }, {});
    }
    return { insertedCount: docs.length };
  },
};
const db = { collection: () => activity };
const dbPath = require.resolve('../server/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => db } };

const config = require('../server/config');
config.trackingFlushMs = 60_000;   // the test flushes by hand; no timer may race it
const tracking = require('../server/services/tracking');

const visitorSocket = (headers = {}, address = '10.0.0.9') =>
  ({ data: { isAdmin: false, sessionId: 'a'.repeat(32) }, handshake: { headers, address } });

// Quiet the expected "buffer full" / "flush failed" lines so a failure is legible.
const logs = [];
const realError = console.error, realWarn = console.warn;
console.error = (...a) => logs.push(a.join(' '));
console.warn  = (...a) => logs.push(a.join(' '));

(async () => {
  try {
    console.log('\nA batch the network ate is retried, not dropped');
    for (let i = 0; i < 4; i++) tracking.track({ type: 'booth.view', boothNumber: String(100 + i), socket: visitorSocket() });
    fail = 'network';
    await tracking.flush();
    check('all four are back in the queue', tracking.stats().pending === 4, JSON.stringify(tracking.stats()));
    await tracking.flush();
    check('and land on the next flush', written.length === 4 && tracking.stats().pending === 0, `written ${written.length}`);

    console.log('\nA batch that landed but timed out is not written twice');
    written.length = 0;
    for (let i = 0; i < 3; i++) tracking.track({ type: 'hold.create', boothNumber: String(200 + i), actor: 'chris' });
    fail = 'landed-then-timeout';
    await tracking.flush();
    check('the batch is queued again', tracking.stats().pending === 3);
    await tracking.flush();
    check('the retry is refused as a duplicate, and nothing is lost or doubled',
          written.length === 3 && tracking.stats().pending === 0, `written ${written.length}, pending ${tracking.stats().pending}`);

    console.log('\nA genuine per-document failure re-queues only that document');
    written.length = 0;
    for (let i = 0; i < 3; i++) tracking.track({ type: 'deal.update', boothNumber: String(300 + i), actor: 'chris' });
    fail = 'one-transient';
    await tracking.flush();
    check('one document waits for the next flush', tracking.stats().pending === 1 && written.length === 2);
    await tracking.flush();
    check('and then lands', written.length === 3 && tracking.stats().pending === 0);

    console.log('\nA flood of visitor events cannot push out the audit trail');
    written.length = 0;
    const sock = visitorSocket();
    for (let i = 0; i < 12_000; i++) tracking.track({ type: 'consent.granted', socket: sock });
    const s = tracking.stats();
    check('visitor events stop at their own budget', s.pending === 10_000 && s.dropped.visitor === 2_000, JSON.stringify(s));
    const booked = tracking.track({ type: 'booth.status_change', boothNumber: '101', actor: 'chris', meta: { to: 'sold' } });
    const denied = tracking.track({ type: 'security.secret_failed', actor: 'chris' });
    const expired = tracking.track({ type: 'hold.expire', boothNumber: '102', actor: 'system:expiry' });
    check('a booking, a security record and a hold expiry are all still accepted',
          !!booked && !!denied && !!expired && tracking.stats().pending === 10_003);
    check('while another visitor event is still refused',
          tracking.track({ type: 'booth.view', boothNumber: '101', socket: sock }) === null);
    await tracking.flush();
    check('all of it is written', written.length === 10_003 && written.some(w => w.type === 'booth.status_change'));

    console.log('\nA failed batch that no longer fits is counted, not silently lost');
    written.length = 0;
    for (let i = 0; i < 5; i++) tracking.track({ type: 'booth.view', boothNumber: String(i), socket: sock });
    tracking.track({ type: 'booth.move', boothNumber: '101', actor: 'chris' });
    fail = 'network';
    const flushing = tracking.flush();
    // While that write is out, the visitors fill their budget again.
    for (let i = 0; i < 10_000; i++) tracking.track({ type: 'booth.view', boothNumber: '1', socket: sock });
    await flushing;
    const after = tracking.stats();
    check('the staff event goes back in the queue', after.pending === 10_001, JSON.stringify(after));
    check('the five visitor events that did not fit are counted as lost', after.lost === 5);
    check('and said so in the log', logs.some(l => /5 .*lost/i.test(l)), logs.filter(l => /lost/i.test(l)).join(' | '));
    await tracking.flush();

    console.log('\nThe address is the one the proxy saw');
    const spoofed = visitorSocket({ 'x-forwarded-for': '203.0.113.77, 198.51.100.23' }, '10.1.2.3');
    const doc = tracking.track({ type: 'booth.view', boothNumber: '1', socket: spoofed });
    check('the right-most hop, as Express\'s req.ip gives with trust proxy 1',
          doc.context.ip === '198.51.100.0', doc.context.ip);
    check('not the left-most, which the client wrote', !String(doc.context.ip).startsWith('203.0.113'));
    check('the full address is available for rate limiting, untruncated',
          tracking.socketIp(spoofed) === '198.51.100.23', tracking.socketIp(spoofed));
    const direct = visitorSocket({}, '::ffff:192.0.2.44');
    check('with no proxy header, the connection\'s own address', tracking.socketIp(direct) === '::ffff:192.0.2.44' &&
          tracking.track({ type: 'booth.view', boothNumber: '1', socket: direct }).context.ip === '192.0.2.0');
  } catch (e) {
    check('suite ran without throwing', false, e.stack);
  } finally {
    console.error = realError; console.warn = realWarn;
  }

  const failed = out.filter(x => !x).length;
  console.log(failed ? `\n${failed} FAILED (${out.length} checks)` : `\nALL PASSED (${out.length} checks)`);
  process.exit(failed ? 1 : 0);
})();
