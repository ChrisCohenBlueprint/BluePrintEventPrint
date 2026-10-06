/**
 * An admin socket is only as good as the session behind it — on every event.
 *
 * The socket layer decided who was an admin once, at the handshake, and every
 * admin event after that read the answer it had stored. A console left open
 * therefore kept full admin rights after its user signed out, was demoted to
 * sales, was deleted, had their password or 2FA reset, or simply ran past the
 * twelve hours their session was issued for — for as long as the tab stayed
 * connected.
 *
 * What is asserted here, through a real Socket.IO server and client:
 *
 *   every event re-asks   — each way a session can end refuses the very next
 *                           admin event, unread, as for an anonymous socket.
 *   and the console knows — it is dropped, reconnects at once, and comes back
 *                           without admin.
 *   and an idle one too  — the sweep drops a console that sends nothing.
 *   an outage is not an ending — the action is refused, the admin is kept.
 *   in flight, in its show — the handler is counted for shutdown, and a
 *                           refusal is filed under the socket's own event.
 */
const http = require('http');
const { Server } = require('socket.io');
const { io: connect } = require('socket.io-client');
const { fakeDb } = require('./fake-mongo');

let db = fakeDb({ users: [], revokedTokens: [], activity: [] });
let dbDown = false;
const dbPath = require.resolve('../server/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  getDb: () => { if (dbDown) throw new Error('database unavailable'); return db; },
} };

const config   = require('../server/config');
const users    = require('../server/models/users');
const auth     = require('../server/auth');
const inFlight = require('../server/lib/in-flight');
const tracking = require('../server/services/tracking');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const SHOW = 'LNA27';

/**
 * A session cookie for an account, minted the way the login flow mints it —
 * optionally with a lifetime short enough to watch it run out. (Moving the
 * clock instead would also trip Socket.IO's own heartbeat, which reads it.)
 */
function cookieFor(user, ttlMs) {
  const usual = config.adminTokenTtlMs;
  if (ttlMs) config.adminTokenTtlMs = ttlMs;
  let header = '';
  try { auth.setSessionCookie({ setHeader: (_k, v) => { header = v; } }, user); }
  finally { config.adminTokenTtlMs = usual; }
  return header.split(';')[0];
}

(async () => {
  const server = http.createServer();
  const io = new Server(server);
  const sockets = [];
  let runs = 0, countDuring = null, showDuring = null;
  io.use(auth.socketAuth);
  io.on('connection', (socket) => {
    socket.data.showId = String(socket.handshake.query.show || '') || null;
    sockets.push(socket);
    socket.on('admin:ping', auth.requireAdmin(socket, 'admin:ping', async () => {
      runs++;
      countDuring = inFlight.count();
      showDuring = config.showId;
      await wait(5);
      return { pong: true };
    }));
  });
  server.listen(0);
  await new Promise(r => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}`;

  /** A client, with what it has been told recorded alongside it. */
  async function client(cookie) {
    const c = connect(url, {
      query: { show: SHOW }, extraHeaders: cookie ? { cookie } : {},
      transports: ['websocket'], reconnectionDelay: 20, reconnectionDelayMax: 50,
    });
    c.log = { connects: 0, disconnects: [], authErrors: 0 };
    c.on('connect', () => { c.log.connects++; });
    c.on('disconnect', (reason) => c.log.disconnects.push(reason));
    c.on('error:auth', () => { c.log.authErrors++; });
    await new Promise((resolve, reject) => { c.once('connect', resolve); c.once('connect_error', reject); });
    return c;
  }
  const ping = (c) => new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timeout: true }), 2000);
    c.emit('admin:ping', {}, (r) => { clearTimeout(t); resolve(r); });
  });
  const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await wait(10); return fn(); };
  const serverSide = () => sockets[sockets.length - 1];

  async function account(name) {
    await users.upsert({ username: name, password: `${name}-password`, role: 'admin' });
    return users.findByUsername(name);
  }

  /** Open an admin console, end its session one way, and see what happens. */
  async function endedBy(label, name, end, ttlMs) {
    console.log(`\n${label}`);
    const user = await account(name);
    const cookie = cookieFor(user, ttlMs);
    const c = await client(cookie);
    const first = await ping(c);
    check('the console works while the session is good', first.ok === true && first.pong === true, JSON.stringify(first));
    await end(user, cookie.split('=')[1]);
    const before = runs;
    const r = await ping(c);
    check('the next admin event is refused', r.ok === false && r.error === 'Administrator access required.', JSON.stringify(r));
    check('without the handler running', runs === before);
    check('and the console is told', c.log.authErrors === 1);
    await until(() => c.log.connects >= 2);
    check('the connection is dropped and comes straight back',
          c.log.disconnects[0] === 'transport close' && c.log.connects === 2, JSON.stringify(c.log));
    check('without admin this time', serverSide().data.isAdmin === false && serverSide().data.user === null);
    const again = await ping(c);
    check('so it stays refused', again.ok === false && runs === before);
    c.close();
  }

  try {
    console.log('\nA live session');
    const live = await client(cookieFor(await account('ada')));
    const r = await ping(live);
    check('the handler runs and acknowledges', r.ok === true && r.pong === true, JSON.stringify(r));
    check('counted as in flight while it runs, for shutdown to wait on', countDuring === 1, String(countDuring));
    check('and no longer once it has answered', inFlight.count() === 0);
    check('inside the socket\'s own show', showDuring === SHOW, String(showDuring));

    await endedBy('Signed out', 'bea', async (_u, token) => { await auth.revokeToken(token); });
    await endedBy('Demoted to sales', 'cat', async (u) => { await users.setRole(u.username, 'sales'); });
    await endedBy('Deleted', 'dot', async (u) => { await users.remove(u.username); });
    await endedBy('Password reset', 'eve', async (u) => { await users.setPassword(u.username, 'a-new-password'); });
    await endedBy('2FA reset', 'fay', async (u) => { await users.resetTotp(u.username); });
    await endedBy('Run out', 'gil', async () => { await wait(600); }, 500);

    console.log('\nPromoted while connected');
    const hal = await account('hal');
    const promoted = await client(cookieFor(hal));
    db.store.users.find(u => u.username === 'hal').role = 'owner';
    const p = await ping(promoted);
    check('still allowed', p.ok === true);
    check('and the socket carries the new role at once', serverSide().data.role === 'owner', serverSide().data.role);
    promoted.close();

    console.log('\nThe database is down');
    const ivy = await client(cookieFor(await account('ivy')));
    const before = runs;
    dbDown = true;
    const down = await ping(ivy);
    dbDown = false;
    check('the action is refused unread', down.ok === false && runs === before, JSON.stringify(down));
    check('as a failed action, not a lost session', down.error === 'That action could not be completed.' && ivy.log.authErrors === 0);
    await wait(100);
    check('and the admin keeps the connection', ivy.connected && ivy.log.disconnects.length === 0 && serverSide().data.isAdmin === true);
    const back = await ping(ivy);
    check('so the next event, with the database back, goes through', back.ok === true);
    ivy.close();

    console.log('\nAn idle console, swept');
    const jo = await client(cookieFor(await account('jo')));
    const kit = await client(cookieFor(await account('kit')));
    await users.setRole('jo', 'sales');
    const swept = await auth.sweepAdminSockets(io);
    await until(() => jo.log.connects >= 2);
    check('a console whose session has ended is dropped without sending anything',
          swept === 1 && jo.log.disconnects[0] === 'transport close' && jo.log.authErrors === 1, JSON.stringify(jo.log));
    check('and comes back without admin', sockets[sockets.length - 1].data.isAdmin === false);
    check('one whose session is good is left alone', kit.connected && kit.log.disconnects.length === 0);
    dbDown = true;
    const duringOutage = await auth.sweepAdminSockets(io);
    dbDown = false;
    check('and an outage drops nobody', duringOutage === 0 && kit.connected);
    jo.close(); kit.close();

    console.log('\nAn anonymous socket');
    db.store.activity = [];
    const anon = await client(null);
    const denied = await ping(anon);
    check('is refused', denied.ok === false && denied.error === 'Administrator access required.');
    await tracking.flush();
    const rec = (db.store.activity || []).find(a => a.type === 'security.denied');
    check('and the refusal is filed under the event the socket was on',
          rec && rec.showId === SHOW, rec ? rec.showId : 'not recorded');
    anon.close();
    live.close();
  } finally {
    io.close();
    server.close();
  }

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
