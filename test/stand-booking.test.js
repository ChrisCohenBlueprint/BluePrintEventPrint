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
 *   a hold keeps time  — moving a held booking reset its countdown to 24 hours
 *                        and dropped its contact; a length of 1e10 hours was
 *                        stored as 1970.
 *   the truth, in order — a release that released nothing reported success;
 *                        a booking dropped its hold before writing the sale;
 *                        a forced hold on a removed stand wrote its document
 *                        before anything said the stand was gone; a released
 *                        booking was put back with tags deleted since.
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

  console.log('\nMoving a held booking moves its hold, countdown and all');
  const sevenDayHold = hours(30);          // a 7-day hold with a day and a bit left
  db = fakeDb({
    booths: [stand('501', { status: 'held', holdExpiresAt: sevenDayHold,
                            assignment: { ...EMPTY(), company: 'Mover Co', contactId: 'c-mover' } }),
             stand('502')],
    holds: [{ showId: SHOW, boothNumber: '501', company: 'Mover Co', contactId: 'c-mover', sessionId: 'sess-1',
              createdAt: new Date(Date.now() - 6 * 86_400_000), expiresAt: sevenDayHold, createdBy: 'chris' }],
  });
  ack = await emit('booth:move', { from: '501', to: '502' });
  check('the move lands', ack.ok === true && now('502').status === 'held' && now('501').status === 'available',
        JSON.stringify(ack.error || ack.status));
  check('with the day it had left, not a fresh 24 hours',
        +now('502').holdExpiresAt === +sevenDayHold, String(now('502').holdExpiresAt));
  check('its hold document follows it, contact and session intact',
        holdOf('502').length === 1 && holdOf('502')[0].contactId === 'c-mover' &&
        holdOf('502')[0].sessionId === 'sess-1' && +holdOf('502')[0].expiresAt === +sevenDayHold,
        JSON.stringify(db.store.holds));
  check('and nothing is left behind on the stand it left', holdOf('501').length === 0);

  db = fakeDb({
    booths: [stand('503', { status: 'held', holdExpiresAt: null, assignment: { ...EMPTY(), company: 'Plan Reserved Co' } }),
             stand('504')],
    holds: [{ showId: SHOW, boothNumber: '503', company: 'Plan Reserved Co', source: 'artwork-import' }],
  });
  await emit('booth:move', { from: '503', to: '504' });
  check('a hold that never expires still never expires after a move',
        now('504').status === 'held' && now('504').holdExpiresAt === null && holdOf('504').length === 1 &&
        holdOf('504')[0].expiresAt === undefined, String(now('504').holdExpiresAt));

  db = fakeDb({
    booths: [stand('505', { status: 'held', holdExpiresAt: past(), assignment: { ...EMPTY(), company: 'Lapsed Co' } }),
             stand('506')],
    holds: [{ showId: SHOW, boothNumber: '505', company: 'Lapsed Co', expiresAt: past() }],
  });
  await emit('booth:move', { from: '505', to: '506' });
  check('and a hold that had already run out is not revived by moving it',
        (await run(() => holds.reconcile())).join() === '506' && now('506').status === 'available');

  console.log('\nA stand taken off the plan is not a booking to move, nor a place to move one');
  db = fakeDb({ booths: [stand('601', { status: 'removed', removed: true }), stand('602'),
                         stand('603', { status: 'sold', assignment: { ...EMPTY(), company: 'Real Co' } }),
                         stand('604', { status: 'removed', removed: true })], holds: [] });
  let mv = await run(() => booths.move('601', '602', { actor: 'chris' }));
  check('moving from a removed stand is refused', !mv.ok && mv.reason === 'nothing_to_move', JSON.stringify(mv));
  check('and both stands are as they were', now('601').status === 'removed' && now('602').status === 'available');
  mv = await run(() => booths.move('603', '604', { actor: 'chris' }));
  check('moving onto a removed stand is refused', !mv.ok && mv.reason === 'to_not_available', JSON.stringify(mv));
  check('and the booking stays put', now('603').status === 'sold' && now('604').status === 'removed');

  console.log('\nForcing a hold onto a stand off the plan writes nothing');
  db = fakeDb({ booths: [stand('701', { status: 'removed', removed: true })], holds: [] });
  ack = await emit('admin:setStatus', { boothNumber: '701', status: 'held', company: 'Ghost Co' });
  check('it is refused as not found', ack.ok === false && /not found/.test(ack.error), JSON.stringify(ack));
  check('with no hold document written for it', holdOf('701').length === 0, JSON.stringify(db.store.holds));
  check('and no expiry stamped on it', now('701').holdExpiresAt === undefined);

  console.log('\nA hold is as long as it says, within reason');
  db = fakeDb({ booths: [stand('801'), stand('802'), stand('803'), stand('804')], holds: [] });
  ack = await emit('booth:hold', { boothNumber: '801', company: 'Long Co', hours: 1e10 });
  const longest = now('801').holdExpiresAt;
  check('an enormous length is cut to 30 days, not stored as 1970',
        ack.ok === true && longest instanceof Date && !isNaN(longest) &&
        Math.abs(longest - Date.now() - 30 * 86_400_000) < 60_000, String(longest));
  ack = await emit('booth:hold', { boothNumber: '802', company: 'Forever Co', hours: Infinity });
  check('Infinity is refused, not an Invalid Date', ack.ok === false && now('802').status === 'available', JSON.stringify(ack));
  ack = await emit('booth:hold', { boothNumber: '803', company: 'Words Co', hours: 'soon' });
  check('so is a length that is not a number', ack.ok === false && now('803').status === 'available');
  ack = await emit('booth:hold', { boothNumber: '804', company: 'Default Co' });
  check('no length at all is the usual 24 hours', ack.ok === true &&
        Math.abs(now('804').holdExpiresAt - Date.now() - 86_400_000) < 60_000);
  check('and no log line promises a hold "until Invalid Date"', !logged().some(m => /Invalid Date/.test(m)));

  console.log('\nA release that released nothing says so');
  db = fakeDb({ booths: [stand('901'), stand('902', { status: 'removed', removed: true }),
                         stand('903', { status: 'held', holdExpiresAt: hours(3), assignment: { ...EMPTY(), company: 'Let Go Co' } })],
                holds: [{ showId: SHOW, boothNumber: '903', company: 'Let Go Co', expiresAt: hours(3) }] });
  const logsBefore = logged().length;
  ack = await emit('booth:release', { boothNumber: '901', password: 'pw' });
  check('an available stand is not "released"', ack.ok === false && /nothing to release/.test(ack.error), JSON.stringify(ack));
  ack = await emit('booth:release', { boothNumber: '902', password: 'pw' });
  check('nor one taken off the plan', ack.ok === false && now('902').status === 'removed', JSON.stringify(ack));
  ack = await emit('booth:release', { boothNumber: '999', password: 'pw' });
  check('nor one that does not exist', ack.ok === false && /not found/.test(ack.error), JSON.stringify(ack));
  check('and none of them was logged as released', logged().length === logsBefore, logged().slice(logsBefore).join(' | '));
  ack = await emit('booth:release', { boothNumber: '903', password: 'pw' });
  check('a real hold is released, and says so', ack.ok === true && now('903').status === 'available' &&
        holdOf('903').length === 0 && logged().some(m => /Stand 903 released/.test(m)),
        JSON.stringify(ack));

  console.log('\nBooking a held stand writes the sale before it lets go of the hold');
  db = fakeDb({ booths: [stand('951', { status: 'held', holdExpiresAt: null, assignment: { ...EMPTY(), company: 'Plan Co' } })],
                holds: [{ showId: SHOW, boothNumber: '951', company: 'Plan Co', source: 'artwork-import' }] });
  ack = await emit('booth:book', { boothNumber: '951', company: 'Plan Co' });
  const sale = db.calls.findIndex(c => c[0] === 'updateOne' && c[1] === 'booths' && c[3] && c[3].$set && c[3].$set.status === 'sold');
  const dropped = db.calls.findIndex(c => c[0] === 'deleteMany' && c[1] === 'holds');
  check('the sale lands and the hold goes', ack.ok === true && now('951').status === 'sold' && holdOf('951').length === 0);
  check('in that order, so a stop between them never leaves a hold with no document',
        sale > -1 && dropped > sale, `sale@${sale} drop@${dropped}`);

  console.log('\nPutting a released booking back checks its tags against the catalogue');
  const express = require('express');
  const api = require('../server/routes/api');
  db = fakeDb({ booths: [stand('981')], holds: [],
                tags: [{ showId: SHOW, key: 'oils', label: 'Oils' }, { showId: SHOW, key: 'additives', label: 'Additives' }] });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.admin = { user: 'chris' }; showContext.runAs(SHOW, next); });
  app.use('/api', api);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/booths/981/restore`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Confirm-Password': 'pw' },
      body: JSON.stringify({ status: 'sold', assignment: { company: 'Back Again Ltd', tags: ['oils', 'deleted-since', 'additives'] } }),
    });
    const body = await res.json();
    check('the booking comes back', res.status === 200 && now('981').status === 'sold' &&
          now('981').assignment.company === 'Back Again Ltd', JSON.stringify(body));
    check('with the tags that still exist', now('981').assignment.tags.join() === 'oils,additives',
          JSON.stringify(now('981').assignment.tags));
    check('and the deleted one is named, not restored', (body.tagsDropped || []).join() === 'deleted-since',
          JSON.stringify(body.tagsDropped));
  } finally { server.close(); }

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
