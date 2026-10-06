/**
 * A booking's life on one stand: held, sold, moved, released, expired.
 *
 * Each of these used to leave something behind it, or say something that was
 * not true:
 *
 *   private until sold — a hold is a provisional deal; its company is never
 *                        published, and the public projection used to send it
 *                        anyway.
 *   the deal is theirs — a price, notes and a contact belong to the exhibitor
 *                        they were agreed with. An expired hold, or a stand
 *                        re-booked to someone else, handed them to the next
 *                        company to take the stand.
 *   a sale has a name  — a stand sold to an empty prompt was booked as nobody.
 *
 * Driven through the real model, the real hold service and the real socket
 * handlers, against a filter-applying stand-in for the database.
 */
const { fakeDb } = require('./fake-mongo');

const dbPath = require.resolve('../server/db');
let db = fakeDb({});
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => db } };

// The password gate, stood in for: "pw" is right, anything else is wrong.
const usersPath = require.resolve('../server/models/users');
require.cache[usersPath] = { id: usersPath, filename: usersPath, loaded: true, exports: {
  findByUsername: async () => ({ username: 'chris', passwordHash: 'x' }),
  verifyPassword: async (pw) => pw === 'pw',
  absorbPassword: async () => {},
} };

const showContext = require('../server/show-context');
const booths = require('../server/models/booths');
const holds = require('../server/services/holds');
const sockets = require('../server/sockets');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const SHOW = 'LEX26';
const run = (fn) => showContext.runAs(SHOW, fn);
const now = (n) => db.store.booths.find(b => b.boothNumber === n);
const holdOf = (n) => (db.store.holds || []).filter(h => h.boothNumber === n);
const EMPTY = () => ({ company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null });
const stand = (n, extra = {}) => ({
  showId: SHOW, boothNumber: n, status: 'available', sqm: 9, listPrice: 5400,
  geometry: { x: 0, y: 0, w: 40, h: 40 }, assignment: EMPTY(), ...extra,
});
const past = () => new Date(Date.now() - 60_000);
const hours = (h) => new Date(Date.now() + h * 3600_000);

// ── An admin socket, connected to the real handlers ──────────────────────────
// A stand-in io that records what is emitted, and one socket that is already
// an authenticated admin. The handlers are the real ones from sockets/index.js.
const emitted = [];
const roomOf = (name) => ({ emit: (e, p) => emitted.push([name, e, p]), except: () => roomOf(name), to: (r) => roomOf(`${name}+${r}`) });
const io = { use() {}, on(ev, cb) { if (ev === 'connection') io.connect = cb; }, to: (r) => roomOf(r) };
const handlers = {};
const socket = {
  id: 'admin-1', data: { isAdmin: true, user: 'chris' },
  handshake: { query: { show: '' }, auth: {}, headers: {} },
  join() {}, emit(e, p) { emitted.push(['self', e, p]); }, on(e, h) { handlers[e] = h; },
};
const emit = (event, payload) => new Promise(res => handlers[event](payload, res));
const logged = () => emitted.filter(e => e[1] === 'log:entry').map(e => e[2].msg);

(async () => {
  // Registered against an empty hall, and the boot-time expiry sweep allowed
  // to finish, before any stand exists for it to touch.
  sockets.register(io);
  io.connect(socket);
  await new Promise(r => setTimeout(r, 20));

  console.log('\nA hold is not published; a sale is');
  const held = booths.toPublic(stand('101', { status: 'held',
    assignment: { ...EMPTY(), company: 'Negotiating Ltd', tags: ['oils'], country: 'DE' } }));
  check('a held stand reaches the public plan with no company', held.company === null, JSON.stringify(held.company));
  check('nor its tags or country', held.tags.length === 0 && held.country === null);
  check('but it does say it is held', held.status === 'held');
  const sold = booths.toPublic(stand('102', { status: 'sold',
    assignment: { ...EMPTY(), company: 'Exhibitor GmbH', tags: ['oils'], country: 'DE' } }));
  check('a sold stand names its exhibitor', sold.company === 'Exhibitor GmbH');
  check('with its tags and country', sold.tags.join() === 'oils' && sold.country === 'DE');
  const glitch = booths.toPublic(stand('103', { assignment: { ...EMPTY(), company: 'Left Behind Co' } }));
  check('a name left on an available stand is not published either', glitch.company === null);

  console.log('\nA hold that expires takes its whole deal with it');
  db = fakeDb({
    booths: [stand('201', { status: 'held', holdExpiresAt: past(),
      assignment: { company: 'Acme', contactId: 'c-acme', actualPrice: 9000, notes: 'Acme wants the corner',
                    tags: ['oils'], country: 'DE' } })],
    holds: [{ showId: SHOW, boothNumber: '201', company: 'Acme', expiresAt: past() }],
  });
  await run(() => holds.reconcile());
  const freed = now('201');
  check('the stand comes back', freed.status === 'available');
  check('with no price, notes or contact of the exhibitor who let it go',
        freed.assignment.actualPrice === null && freed.assignment.notes === '' && freed.assignment.contactId === null,
        JSON.stringify(freed.assignment));
  check('and no tags or country to read as hand-made work',
        freed.assignment.tags.length === 0 && freed.assignment.country === null);
  await run(() => booths.setStatus('201', 'sold', { company: 'Beta', actor: 'chris', expect: ['available', 'held'] }));
  check('so the next company to book it starts with a clean deal',
        now('201').assignment.company === 'Beta' && now('201').assignment.actualPrice === null &&
        now('201').assignment.notes === '', JSON.stringify(now('201').assignment));

  console.log('\nRe-booking a held stand to someone else does not hand them the deal');
  db = fakeDb({ booths: [stand('202', { status: 'held', holdExpiresAt: hours(5),
    assignment: { company: 'Acme', contactId: 'c-acme', actualPrice: 9000, notes: 'Acme notes', tags: ['oils'], country: 'DE' } })],
    holds: [] });
  await run(() => booths.setStatus('202', 'sold', { company: 'Beta', actor: 'chris', expect: ['available', 'held'] }));
  const beta = now('202').assignment;
  check('Beta does not inherit Acme\'s €9,000', beta.actualPrice === null, String(beta.actualPrice));
  check('nor Acme\'s notes or contact', beta.notes === '' && beta.contactId === null, JSON.stringify(beta));
  check('nor Acme\'s tags and country', beta.tags.length === 0 && beta.country === null);

  db = fakeDb({ booths: [stand('203', { status: 'held', holdExpiresAt: hours(5),
    assignment: { company: 'Acme', contactId: 'c-acme', actualPrice: 9000, notes: 'Acme notes', tags: ['oils'], country: 'DE' } })],
    holds: [] });
  await run(() => booths.setStatus('203', 'sold', { company: ' acme ', actor: 'chris', expect: ['available', 'held'] }));
  check('the same exhibitor converting their hold to a sale keeps every bit of it',
        now('203').assignment.actualPrice === 9000 && now('203').assignment.notes === 'Acme notes' &&
        now('203').assignment.contactId === 'c-acme' && now('203').assignment.country === 'DE',
        JSON.stringify(now('203').assignment));

  db = fakeDb({ booths: [stand('204', { status: 'held', holdExpiresAt: hours(5),
    assignment: { ...EMPTY(), company: 'Pending', actualPrice: 7000, notes: 'agreed on the phone' } })], holds: [] });
  await run(() => booths.setStatus('204', 'sold', { company: 'Gamma Oils', actor: 'chris', expect: ['available', 'held'] }));
  check('a placeholder hold that gets its real name is the same deal, and keeps its price',
        now('204').assignment.company === 'Gamma Oils' && now('204').assignment.actualPrice === 7000 &&
        now('204').assignment.notes === 'agreed on the phone', JSON.stringify(now('204').assignment));

  console.log('\nA sale is to somebody');
  db = fakeDb({ booths: [stand('301')], holds: [] });
  const blank = await run(() => booths.setStatus('301', 'sold', { company: '   ', actor: 'chris' }));
  check('the model refuses a sale with no name', blank && blank.changed === false && blank.error === 'no_company',
        JSON.stringify(blank && blank.error));
  check('and writes nothing', now('301').status === 'available');
  let ack = await emit('booth:book', { boothNumber: '301', company: '' });
  check('booth:book with an empty name is refused, in words', ack.ok === false && /name/.test(ack.error), JSON.stringify(ack));
  check('and the stand is still for sale', now('301').status === 'available');
  ack = await emit('booth:book', { boothNumber: '301', company: '  Delta Lubes  ' });
  check('a real name books it, trimmed', ack.ok === true && now('301').status === 'sold' &&
        now('301').assignment.company === 'Delta Lubes', JSON.stringify(now('301').assignment));
  ack = await emit('admin:setStatus', { boothNumber: '302', status: 'sold' });
  check('a forced sale on an unknown stand is not found', ack.ok === false);
  db.store.booths.push(stand('302'));
  ack = await emit('admin:setStatus', { boothNumber: '302', status: 'sold', company: ' ' });
  check('a forced sale with no name to fall back on is refused', ack.ok === false && /name/.test(ack.error),
        JSON.stringify(ack));
  const hold = await run(() => booths.setStatus('302', 'held', { company: '', actor: 'chris' }));
  check('but a hold may stay nameless', hold && hold.changed === true && now('302').status === 'held');

  console.log('\nA deal saved for one exhibitor cannot land on another\'s booking');
  db = fakeDb({ booths: [stand('401', { status: 'sold',
    assignment: { ...EMPTY(), company: 'Beta', actualPrice: 4000, notes: 'Beta notes' } })], holds: [] });
  ack = await emit('booth:update-deal', { boothNumber: '401', actualPrice: 9000, expectCompany: 'Acme' });
  check('refused when the stand has changed hands since the panel opened',
        ack.ok === false && ack.error === 'This stand has changed hands since you opened it — reopen it before saving.',
        JSON.stringify(ack));
  check('and Beta\'s deal is untouched', now('401').assignment.actualPrice === 4000);
  ack = await emit('booth:update-deal', { boothNumber: '401', notes: 'new notes', expectCompany: 'Beta' });
  check('the right exhibitor saves', ack.ok === true && now('401').assignment.notes === 'new notes', JSON.stringify(ack));
  check('and a price left out of the save is left alone', now('401').assignment.actualPrice === 4000,
        String(now('401').assignment.actualPrice));
  ack = await emit('booth:update-deal', { boothNumber: '401', actualPrice: null });
  check('while null still clears it', ack.ok === true && now('401').assignment.actualPrice === null);

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
