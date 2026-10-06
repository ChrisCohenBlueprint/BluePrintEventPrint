/**
 * The real sockets module on a real Socket.IO server, against the in-memory
 * database, spoken to by the real client.
 *
 * Two events are configured — LEX (the default) and LNA — so a test can check
 * that one event's stands and packages are not accepted on the other's plan.
 * Must be required before anything under server/, since it decides the
 * database and the shows those modules see.
 *
 * `faults` injects a failure or a delay into the next call of one operation
 * on one collection: faults['inquiries.insertOne'] = () => wait(300).
 */
process.env.SHOW_ID = 'LEX';
process.env.SHOWS = 'lex:LEX,lna:LNA';

const http = require('http');
const { Server } = require('socket.io');
const { io: connect } = require('socket.io-client');
const { fakeDb } = require('./fake-mongo');

const stand = (showId, n) => ({ showId, boothNumber: n, status: 'available', sqm: 9, listPrice: 5400,
  geometry: { x: 0, y: 0, w: 1, h: 1 }, assignment: { company: null, tags: [] } });

const db = fakeDb({
  booths: [stand('LEX', '101'), stand('LEX', '102'), stand('LEX', '103'), stand('LNA', '201')],
  sponsors: [{ showId: 'LEX', key: 'gold', name: 'Gold Package', tier: 'gold' },
             { showId: 'LNA', key: 'lna-only', name: 'North America Gold', tier: 'gold' }],
  users: [{ username: 'chris', role: 'admin', tokenVersion: 0 }],
});
const faults = {};
const realCollection = db.collection;
db.collection = (name) => {
  const c = realCollection(name);
  for (const op of ['insertOne', 'updateMany', 'insertMany']) {
    const orig = c[op];
    c[op] = async (...args) => {
      const f = faults[`${name}.${op}`];
      if (f) { delete faults[`${name}.${op}`]; await f(); }
      return orig(...args);
    };
  }
  return c;
};
const dbPath = require.resolve('../server/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => db } };

const config = require('../server/config');
config.trackingFlushMs = 60_000;   // tests flush by hand; no timer may race them
const sockets = require('../server/sockets');
const auth = require('../server/auth');

const wait = (ms) => new Promise(r => setTimeout(r, ms));

/** Start the server; resolves to { client, ask, close }. */
async function boot() {
  const server = http.createServer();
  const io = new Server(server, { maxHttpBufferSize: 3e6 });
  await sockets.refreshAll();
  sockets.register(io);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const opened = [];

  /** A connected client, once the server has sent its initial state. */
  const client = async ({ show = 'lex', sessionId = null, ip = null, admin = false } = {}) => {
    const extraHeaders = {};
    if (ip) extraHeaders['x-forwarded-for'] = ip;
    if (admin) {
      extraHeaders.cookie = `${auth.COOKIE}=${auth.signToken({ user: 'chris', role: 'admin', v: 0, exp: Date.now() + 3600e3 })}`;
    }
    const s = connect(base, { transports: ['websocket'], forceNew: true, reconnection: false,
      query: { show }, auth: sessionId ? { sessionId } : {}, extraHeaders });
    opened.push(s);
    await new Promise((resolve, reject) => { s.once('ready', resolve); s.once('connect_error', reject); });
    return s;
  };

  /** Emit with an acknowledgement; { timeout: true } if none comes. */
  const ask = (s, event, payload, ms = 3000) => new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timeout: true }), ms);
    s.emit(event, payload, (res) => { clearTimeout(t); resolve(res); });
  });

  const close = () => { opened.forEach(s => s.disconnect()); io.close(); };
  return { client, ask, close };
}

/** The usual check/report pair every suite here uses. */
function reporter() {
  const out = [];
  const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
  const finish = () => {
    const failed = out.filter(x => !x).length;
    console.log(failed ? `\n${failed} FAILED (${out.length} checks)` : `\nALL PASSED (${out.length} checks)`);
    process.exit(failed ? 1 : 0);
  };
  return { check, finish };
}

module.exports = { db, faults, boot, wait, reporter };
