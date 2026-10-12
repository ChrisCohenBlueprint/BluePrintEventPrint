/**
 * Who may change the floorplan.
 *
 * Operations own the plan: its stands' shape, size, number and status have to
 * agree with the technical plan used for mark-out on site. While every console
 * account could merge, split and renumber, the plan in the system drifted from
 * the one Operations and the designer were working to, and bookings went
 * round naming stands that did not match.
 *
 * So there is an 'operations' role, and what an 'admin' may do on the plan is
 * holds and holds only:
 *
 *   hold, extend, let go — an admin puts an available stand on hold, extends
 *                          it, and takes a hold off again.
 *   never sell, never un-sell — marking sold, moving a booking, and releasing
 *                          a SOLD stand are refused, before the password is
 *                          asked for.
 *   nothing to the shape — split, merge, reset, remove, renumber, tags,
 *                          sponsor marks and the settings are refused.
 *   nor to the artwork   — upload, publish, discard, palette, import, remove
 *                          and the history are refused over REST.
 *   and said why         — every refusal names Operations, is acknowledged
 *                          so the console can show it, is recorded, and does
 *                          NOT end the session: the admin stays connected.
 *   operations may       — the same events and routes go through for an
 *                          operations account; the owner is unchanged.
 *   from the database    — a role read live: an admin promoted to operations
 *                          gains the plan on the console they already have open.
 *
 * Driven through a real Socket.IO server with the real auth and socket layer,
 * and the real routes, against the in-memory database.
 */
process.env.SHOW_ID = 'LEX';
process.env.SHOWS = 'lex:LEX';

const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { io: connect } = require('socket.io-client');
const { fakeDb } = require('./fake-mongo');

const SHOW = 'LEX';
const EMPTY = () => ({ company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null });
const stand = (n, extra = {}) => ({
  showId: SHOW, boothNumber: n, status: 'available', sqm: 9, listPrice: 5400,
  geometry: { x: 0, y: 0, w: 40, h: 40 }, assignment: EMPTY(), ...extra,
});
const hall = () => [
  stand('101'),
  stand('102'),
  stand('201', { status: 'held', assignment: { ...EMPTY(), company: 'Thinking Ltd' } }),
  stand('301', { status: 'sold', assignment: { ...EMPTY(), company: 'Bought Ltd' } }),
  stand('302', { status: 'sold', assignment: { ...EMPTY(), company: 'Bought Too Ltd' } }),
];

let db = fakeDb({ users: [], revokedTokens: [], activity: [], booths: hall(), holds: [
  { showId: SHOW, boothNumber: '201', company: 'Thinking Ltd', expiresAt: new Date(Date.now() + 3600e3), createdAt: new Date() },
] });
const dbPath = require.resolve('../server/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => db } };

const config   = require('../server/config');
config.trackingFlushMs = 60_000;
const users    = require('../server/models/users');
const auth     = require('../server/auth');
const sockets  = require('../server/sockets');
const tracking = require('../server/services/tracking');
const showContext = require('../server/show-context');
const api      = require('../server/routes/api');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const now = (n) => db.store.booths.find(b => b.boothNumber === n);
const refusal = (r) => r && r.ok === false && /Only Operations/.test(r.error || '');

function cookieFor(user) {
  let header = '';
  auth.setSessionCookie({ setHeader: (_k, v) => { header = v; } }, user);
  return header.split(';')[0];
}

(async () => {
  const server = http.createServer();
  const io = new Server(server, { maxHttpBufferSize: 3e6 });
  await sockets.refreshAll();
  sockets.register(io);
  server.listen(0);
  await new Promise(r => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const opened = [];

  async function client(cookie) {
    const c = connect(url, { query: { show: 'lex' }, extraHeaders: cookie ? { cookie } : {},
                             transports: ['websocket'], forceNew: true, reconnection: false });
    c.log = { authErrors: 0, actionErrors: [] };
    c.on('error:auth', () => { c.log.authErrors++; });
    c.on('error:action', (e) => c.log.actionErrors.push(e));
    opened.push(c);
    await new Promise((resolve, reject) => {
      c.once('ready', resolve); c.once('connect_error', reject);
      setTimeout(() => reject(new Error('no ready within 5s')), 5000);
    });
    return c;
  }
  const ask = (c, event, payload) => new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timeout: true }), 3000);
    c.emit(event, payload, (r) => { clearTimeout(t); resolve(r); });
  });

  const admin = await users.upsert({ username: 'sam', password: 'sam-password', role: 'admin' });
  const ops   = await users.upsert({ username: 'laura', password: 'laura-password', role: 'operations' });
  const owner = await users.upsert({ username: 'chris', password: 'chris-password', role: 'owner' });
  check('the operations role is stored as given', (await users.findByUsername('laura')).role === 'operations');
  check('and an unknown role still falls back to admin',
        (await users.upsert({ username: 'odd', password: 'x', role: 'wizard' })).role === 'admin');

  console.log('\nAn admin may hold, extend, and let a hold go');
  const sam = await client(cookieFor(admin));
  let r = await ask(sam, 'booth:hold', { boothNumber: '101', company: 'Maybe Ltd', hours: 24 });
  check('an admin puts an available stand on hold', r && r.ok === true && now('101').status === 'held', JSON.stringify(r));
  r = await ask(sam, 'admin:setStatus', { boothNumber: '102', status: 'held', company: 'Perhaps Ltd' });
  check('and may force a hold through the status picker', r && r.ok === true && now('102').status === 'held', JSON.stringify(r));
  r = await ask(sam, 'admin:setStatus', { boothNumber: '102', status: 'held', company: 'Perhaps Renamed Ltd' });
  check('and rename who a hold is for', r && r.ok === true && now('102').assignment.company === 'Perhaps Renamed Ltd', JSON.stringify(r));
  r = await ask(sam, 'booth:release', { boothNumber: '201', password: 'sam-password' });
  check('an admin takes a hold off again', r && r.ok === true && now('201').status === 'available', JSON.stringify(r));
  check('and the hold document went with it', !db.store.holds.some(h => h.boothNumber === '201'));
  r = await ask(sam, 'admin:setStatus', { boothNumber: '102', status: 'available', password: 'sam-password' });
  check('or through the status picker', r && r.ok === true && now('102').status === 'available', JSON.stringify(r));

  console.log('\nBut never sells, and never un-sells');
  r = await ask(sam, 'booth:book', { boothNumber: '102', company: 'Sold By Sam Ltd' });
  check('marking a stand sold is refused', refusal(r) && now('102').status === 'available', JSON.stringify(r));
  r = await ask(sam, 'admin:setStatus', { boothNumber: '102', status: 'sold', company: 'Forced Ltd' });
  check('so is forcing it sold', refusal(r) && now('102').status === 'available', JSON.stringify(r));
  r = await ask(sam, 'admin:setStatus', { boothNumber: '101', status: 'sold' });
  check('and converting a hold to a sale', refusal(r) && now('101').status === 'held', JSON.stringify(r));
  r = await ask(sam, 'booth:release', { boothNumber: '301', password: 'sam-password' });
  check('releasing a SOLD stand is refused', refusal(r) && now('301').status === 'sold' &&
        now('301').assignment.company === 'Bought Ltd', JSON.stringify(r));
  r = await ask(sam, 'booth:release', { boothNumber: '302', password: 'wrong' });
  check('before the password is checked — a wrong one is not counted', refusal(r) && !/incorrect/.test(r.error), JSON.stringify(r));
  r = await ask(sam, 'admin:setStatus', { boothNumber: '301', status: 'held' });
  check('a sale cannot be turned into a hold', refusal(r) && now('301').status === 'sold', JSON.stringify(r));
  r = await ask(sam, 'admin:setStatus', { boothNumber: '301', status: 'available', password: 'sam-password' });
  check('nor forced back to available', refusal(r) && now('301').status === 'sold', JSON.stringify(r));
  r = await ask(sam, 'booth:move', { from: '301', to: '102' });
  check('nor moved', refusal(r) && now('301').status === 'sold' && now('102').status === 'available', JSON.stringify(r));
  r = await ask(sam, 'booth:update-deal', { boothNumber: '301', actualPrice: 1, notes: 'cheap' });
  check('nor repriced', refusal(r) && now('301').assignment.actualPrice === null, JSON.stringify(r));

  console.log('\nNothing to the shape of the plan');
  const shape = [
    ['booth:split', { boothNumber: '102', parts: 2 }],
    ['booth:split-custom', { boothNumber: '102', axis: 'x', parts: [4, 5] }],
    ['booth:consolidate', { primary: '101', secondary: '102' }],
    ['booth:consolidate-many', { boothNumbers: ['101', '102'] }],
    ['booth:reset', { boothNumber: '102' }],
    ['booth:remove', { boothNumber: '102' }],
    ['booth:restore-stand', { boothNumber: '102' }],
    ['booth:set-number', { boothNumber: '102', displayNumber: 'A1' }],
    ['booth:set-tags', { boothNumber: '301', tags: [] }],
    ['booth:set-country', { boothNumber: '301', country: 'DE' }],
    ['booth:set-sponsored', { boothNumber: '301', sponsored: true }],
    ['booth:set-logo', { boothNumber: '301', logo: null }],
    ['tags:create', { label: 'Oils', color: '#ff0000' }],
    ['tags:update', { key: 'oils', label: 'Oil', color: '#ff0000' }],
    ['tags:delete', { key: 'oils' }],
    ['sponsor:set-floorplan', { name: 'Big Oil', color: '#ff0000' }],
    ['area:set-logo', { key: 'vip-lounge', logo: null }],
    ['area:set-package', { key: 'vip-lounge', sponsorKey: null }],
    ['area:set-sponsor', { key: 'vip-lounge', sponsor: 'X', status: 'taken' }],
    ['area:set-label', { key: 'vip-lounge', label: 'Lounge' }],
    ['settings:set-rate', { rate: 1, password: 'sam-password' }],
    ['settings:set-currency', { currency: 'USD' }],
    ['settings:set-unit', { unit: 'ft' }],
  ];
  const before = JSON.stringify(db.store.booths);
  for (const [event, payload] of shape) {
    r = await ask(sam, event, payload);
    check(`${event} is refused`, refusal(r), JSON.stringify(r));
  }
  check('and the hall is exactly as it was', JSON.stringify(db.store.booths) === before);
  check('the admin is still connected — a refusal is not a sign-out', sam.connected && sam.log.authErrors === 0,
        `authErrors=${sam.log.authErrors}`);
  r = await ask(sam, 'booth:hold', { boothNumber: '102', company: 'Still Here Ltd' });
  check('and may still hold', r && r.ok === true && now('102').status === 'held', JSON.stringify(r));
  await new Promise((resolve) => { sam.emit('booth:split', { boothNumber: '102', parts: 2 }); setTimeout(resolve, 100); });
  check('a refusal with no acknowledgement to answer is sent as an action error',
        sam.log.actionErrors.some(e => e.event === 'booth:split' && /Only Operations/.test(e.message)),
        JSON.stringify(sam.log.actionErrors.slice(-1)));
  await tracking.flush();
  const denied = db.store.activity.filter(a => a.type === 'security.denied' && a.meta?.reason === 'plan');
  check('every refusal is on the record, with the role that was refused',
        denied.length >= shape.length && denied.every(a => a.meta.role === 'admin' && a.actor?.userId === 'sam'),
        `${denied.length} recorded`);

  console.log('\nNor to the artwork, over REST');
  const app = express();
  app.use(express.json());
  let who = { user: 'sam', role: 'admin' };
  app.use((req, _res, next) => { req.admin = { ...who }; showContext.runAs(SHOW, next); });
  app.use('/api', api);
  const rest = app.listen(0);
  await new Promise(r => rest.once('listening', r));
  const base = `http://127.0.0.1:${rest.address().port}/api`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers },
                                           body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: json };
  };
  const routes = [
    ['POST', '/floorplan', '<svg/>', { 'Content-Type': 'image/svg+xml' }],
    ['POST', '/floorplan/revisions/abc/publish', {}],
    ['POST', '/floorplan/revisions/abc/discard', {}],
    ['DELETE', '/floorplan', {}],
    ['PUT', '/palette', { available: '#fff' }],
    ['POST', '/stands/import', {}],
    ['POST', '/history/abc/restore', {}],
    ['POST', '/booths/301/restore', { status: 'sold', assignment: { company: 'X' } }, { 'X-Confirm-Password': 'sam-password' }],
  ];
  for (const [method, path, body, headers] of routes) {
    const res = await call(method, path, body, headers);
    check(`${method} ${path} answers 403 to an admin`, res.status === 403 && /Only Operations/.test(res.body?.error || ''),
          `${res.status} ${JSON.stringify(res.body)}`);
  }
  let res = await call('POST', '/holds/102/extend', { hours: 24 });
  check('but extending a hold goes through', res.status === 200 && res.body?.ok === true, `${res.status} ${JSON.stringify(res.body)}`);
  res = await call('GET', '/booths');
  check('and the plan is still readable', res.status === 200 && Array.isArray(res.body), `${res.status}`);
  res = await call('GET', '/history');
  check('history included', res.status === 200, `${res.status}`);

  console.log('\nOperations may; so may the owner');
  const laura = await client(cookieFor(ops));
  r = await ask(laura, 'booth:book', { boothNumber: '101', company: 'Ops Sold Ltd' });
  check('operations marks a held stand sold', r && r.ok === true && now('101').status === 'sold', JSON.stringify(r));
  r = await ask(laura, 'booth:set-number', { boothNumber: '101', displayNumber: 'A1' });
  check('and renumbers it', r && r.ok === true && now('101').displayNumber === 'A1', JSON.stringify(r));
  r = await ask(laura, 'booth:release', { boothNumber: '301', password: 'laura-password' });
  check('and releases a sold stand, with the password', r && r.ok === true && now('301').status === 'available', JSON.stringify(r));
  r = await ask(laura, 'booth:split', { boothNumber: '301', parts: 2 });
  check('and splits one', r && r.ok === true && db.store.booths.some(b => b.splitFrom === '301'), JSON.stringify(r));
  who = { user: 'laura', role: 'operations' };
  res = await call('PUT', '/palette', { available: '#ffffff' });
  check('and recolours the plan over REST', res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);
  const chris = await client(cookieFor(owner));
  r = await ask(chris, 'booth:book', { boothNumber: '102', company: 'Owner Sold Ltd' });
  check('the owner is unchanged', r && r.ok === true && now('102').status === 'sold', JSON.stringify(r));

  console.log('\nThe role is read live, so a promotion reaches an open console');
  r = await ask(sam, 'booth:set-number', { boothNumber: '102', displayNumber: 'B2' });
  check('(still refused as an admin)', refusal(r));
  await users.setRole('sam', 'operations');
  const sam2 = await client(cookieFor(await users.findByUsername('sam')));
  r = await ask(sam2, 'booth:set-number', { boothNumber: '102', displayNumber: 'B2' });
  check('promoted to operations, the same event goes through', r && r.ok === true && now('102').displayNumber === 'B2', JSON.stringify(r));
  await users.setRole('sam', 'admin');
  const sam3 = await client(cookieFor(await users.findByUsername('sam')));
  r = await ask(sam3, 'booth:set-number', { boothNumber: '102', displayNumber: 'C3' });
  check('and demoted again, it is refused again', refusal(r) && now('102').displayNumber === 'B2', JSON.stringify(r));

  console.log('\nThe Team page offers the role');
  who = { user: 'chris', role: 'owner' };
  res = await call('POST', '/admins', { username: 'hannah', password: 'hannah-password-1', role: 'operations' });
  check('the owner creates an operations account', res.status === 200 && res.body?.role === 'operations', `${res.status} ${JSON.stringify(res.body)}`);
  check('stored as such', (await users.findByUsername('hannah')).role === 'operations');
  res = await call('PATCH', '/admins/hannah/role', { role: 'admin' });
  check('and can change it to admin', res.status === 200 && (await users.findByUsername('hannah')).role === 'admin', `${res.status}`);
  res = await call('PATCH', '/admins/hannah/role', { role: 'operations' });
  check('and back to operations', res.status === 200 && (await users.findByUsername('hannah')).role === 'operations', `${res.status}`);
  res = await call('PATCH', '/admins/hannah/role', { role: 'wizard' });
  check('anything else is refused', res.status === 400, `${res.status}`);
  res = await call('GET', '/sales-team');
  check('operations are on the roster leads can be sent to', res.status === 200 &&
        (res.body?.team || []).some(m => m.username === 'laura' && m.role === 'operations'), JSON.stringify(res.body).slice(0, 200));

  opened.forEach(c => c.disconnect());
  io.close(); rest.close();
  await wait(50);

  const failed = out.filter(x => !x).length;
  console.log(failed ? `\n${failed} FAILED (${out.length} checks)` : `\nALL PASSED (${out.length} checks)`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
