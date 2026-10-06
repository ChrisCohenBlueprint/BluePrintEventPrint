/**
 * A lead shows its own visitor's history, and is only ever forwarded from its
 * own event.
 *
 *   history  — a lead's browsing trail was every event in its browser session,
 *              so on a shared device (a stand-side tablet, a family laptop) B's
 *              lead showed A's browsing and A's enquiry, A's email in it — and
 *              anything browsed AFTER the enquiry too. It is now what belongs
 *              to this contact: the events attributed to them when they
 *              enquired, and any the session left unattributed between the
 *              previous person's enquiry and this one.
 *   forward  — "Send" read the lead by id alone and named its sponsorship
 *              packages from every event's catalogue. Copied events share
 *              package keys, so Europe's lead could go out naming North
 *              America's package; and a lead from another event was "sent"
 *              (ok: true) while the scoped writes after it quietly did nothing.
 *   retry    — two copies of one retried enquiry that race past the lookup are
 *              still one enquiry.
 */
process.env.SHOW_ID = 'LEX';
process.env.SHOWS = 'lex:LEX,lna:LNA';

const express = require('express');
const { ObjectId } = require('mongodb');
const { fakeDb } = require('./fake-mongo');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const S = 'f'.repeat(32);
const at = (hhmm, ms = 0) => new Date(new Date(`2026-10-06T${hhmm}:00Z`).getTime() + ms);
const id = () => new ObjectId().toHexString();
const A1 = id(), B1 = id(), A2 = id(), L1 = id(), N1 = id();
const lead = (_id, showId, email, createdAt, extra = {}) => ({ _id, showId, sessionId: S, createdAt, status: 'new',
  contact: { name: email.split('@')[0], email }, boothsOfInterest: ['101'], sponsorsOfInterest: [], areasOfInterest: [], ...extra });
const ev = (type, boothNumber, ts, contactId, extra = {}) => ({ showId: 'LEX', sessionId: S, type, boothNumber, ts,
  actor: contactId ? { kind: 'visitor', userId: null, contactId } : { kind: 'visitor', userId: null }, meta: {}, ...extra });

const db = fakeDb({
  inquiries: [
    lead(A1, 'LEX', 'a@example.com', at('10:00')),
    lead(B1, 'LEX', 'b@example.com', at('10:30')),
    lead(A2, 'LEX', 'a@example.com', at('11:00')),
    lead(L1, 'LEX', 'l@example.com', at('12:00'), { sessionId: null, sponsorsOfInterest: ['gold'] }),
    lead(N1, 'LNA', 'n@example.com', at('12:00'), { sessionId: null, sponsorsOfInterest: ['gold'] }),
  ],
  activity: [
    ev('booth.view', '106', at('09:40'), null),                     // A's, left unattributed
    ev('booth.view', '101', at('09:50'), A1),
    ev('inquiry.submit', null, at('10:00', 5), A1, { meta: { email: 'a@example.com' } }),
    ev('booth.view', '102', at('10:10'), B1),
    ev('booth.view', '103', at('10:20'), null),                     // B's, left unattributed
    ev('booth.view', '104', at('10:45'), A2),
    ev('booth.view', '105', at('11:30'), null),                     // after everyone's enquiry
    { ...ev('booth.view', '201', at('10:05'), null), showId: 'LNA' },
  ],
  booths: [{ showId: 'LEX', boothNumber: '101', status: 'available' }],
  // North America's copy first, so a lookup across events finds it first.
  sponsors: [{ showId: 'LNA', key: 'gold', name: 'Gold Package (North America)' },
             { showId: 'LEX', key: 'gold', name: 'Gold Package (Europe)' }],
  users: [{ username: 'rep', role: 'sales', email: 'rep@example.com', displayName: 'Rep' },
          { username: 'boss', role: 'owner', email: 'boss@example.com' }],
});
// Leads here carry hex-string ids, as the route's ObjectIds compare equal to
// nothing in the fake. Every filter is put in those terms on the way in.
const plain = (v) => v instanceof ObjectId ? v.toHexString()
  : Array.isArray(v) ? v.map(plain)
  : v && typeof v === 'object' && !(v instanceof Date) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
  : v;
let raceOnce = null;
const realCollection = db.collection;
db.collection = (name) => {
  const c = realCollection(name);
  const wrap = (op) => { const f = c[op]; c[op] = (filter, ...rest) => f(plain(filter), ...rest); };
  ['find', 'findOne', 'updateOne', 'updateMany', 'countDocuments', 'deleteOne'].forEach(wrap);
  if (name === 'inquiries') {
    const insertOne = c.insertOne;
    c.insertOne = async (doc) => {
      if (raceOnce) { const r = raceOnce; raceOnce = null; return r(doc); }
      return insertOne(doc);
    };
  }
  return c;
};
const dbPath = require.resolve('../server/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => db } };

const config = require('../server/config');
config.trackingFlushMs = 60_000;
const showContext = require('../server/show-context');
const inquiries = require('../server/models/inquiries');
const api = require('../server/routes/api');

const run = (fn) => showContext.runAs('LEX', fn);
const trail = (row) => (row.history || []).map(h => h.boothNumber || h.type).join(',');

(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.admin = { user: 'chris' }; showContext.runAs('LEX', next); });
  app.use('/api', api);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const post = async (p, body) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  try {
    console.log('\nA lead\'s history is its own visitor\'s');
    const b = await run(() => inquiries.withHistory(new ObjectId(B1)));
    check('B sees what B browsed, attributed or not', trail(b) === '102,103', trail(b));
    check('not A\'s browsing, nor A\'s enquiry with A\'s email in it',
          !b.history.some(h => h.type === 'inquiry.submit' || ['101', '106'].includes(h.boothNumber)));
    check('nor what was browsed after B enquired', !b.history.some(h => ['104', '105'].includes(h.boothNumber)));
    const a1 = await run(() => inquiries.withHistory(new ObjectId(A1)));
    check('A\'s first lead: A\'s trail up to the enquiry', trail(a1) === '106,101,inquiry.submit', trail(a1));
    const a2 = await run(() => inquiries.withHistory(new ObjectId(A2)));
    check('A\'s second lead: everything A did, nothing of B\'s, nothing after',
          trail(a2) === '101,inquiry.submit,104', trail(a2));
    check('and never another event\'s', ![a1, a2, b].some(r => r.history.some(h => h.showId !== 'LEX')));

    console.log('\nSending a lead stays inside its event');
    let r = await post(`/inquiries/${L1}/send`, { name: 'Rep' });
    check('this event\'s lead is sent', r.status === 200 && r.body.ok, JSON.stringify(r.body).slice(0, 160));
    check('naming this event\'s package', /Gold Package \(Europe\)/.test(r.body.body || '') &&
          !/North America/.test(r.body.body || ''), (r.body.body || '').split('\n').find(l => /Sponsorship/.test(l)));
    r = await post(`/inquiries/${N1}/send`, { name: 'Rep' });
    check('another event\'s lead is not found', r.status === 404, `${r.status} ${JSON.stringify(r.body)}`);
    const n1 = db.store.inquiries.find(x => x._id === N1);
    check('and nothing was written to it', !n1.assignedTo && !n1.sendCount && !n1.lastSentAt);
    r = await post(`/inquiries/${N1}/assign`, { name: 'Rep' });
    check('nor can it be assigned from here', r.status === 404);

    console.log('\nTwo racing copies of one retry are one enquiry');
    const rid = 'abcdef0123456789abcdef0123456789';
    const before = db.store.inquiries.length;
    raceOnce = async (doc) => {
      // The other copy got in first; this insert hits the unique index.
      db.store.inquiries.push({ ...doc, _id: 'winner' });
      const e = new Error('E11000 duplicate key error collection: inquiries index: show_request_unique');
      e.code = 11000;
      throw e;
    };
    const res = await run(() => inquiries.create({ firstName: 'Ada', email: 'ada@example.com', boothNumbers: ['101'], requestId: rid }));
    check('answered as the original', res.ok && res.duplicate && res.id === 'winner', JSON.stringify(res));
    check('one stored', db.store.inquiries.length === before + 1);
  } catch (e) {
    check('suite ran without throwing', false, e.stack);
  } finally {
    server.close();
  }

  const failed = out.filter(x => !x).length;
  console.log(failed ? `\n${failed} FAILED (${out.length} checks)` : `\nALL PASSED (${out.length} checks)`);
  process.exit(failed ? 1 : 0);
})();
