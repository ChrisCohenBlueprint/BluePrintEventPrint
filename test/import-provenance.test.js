/**
 * Who wrote a stand's booking: the plan, or a person.
 *
 * Every import decision rests on that one question — what a re-import may
 * rewrite, what the guard counts as a booking, what an update may correct —
 * and it was answered wrongly both ways:
 *
 *   the admin is not the plan — an import run from the console stamped the
 *       admin's name on every stand it wrote, so the plan's own sold stands
 *       read as a person's bookings from then on: every later import refused,
 *       and ?mode=update could not correct a misread status.
 *   the plan is not the admin — a forced deploy re-import re-stamped a
 *       person's booking with 'deploy' while re-reading its outline, turning
 *       it into "import output" that the next import set available.
 *
 * And four smaller ways an import changed what it had no business changing:
 * a merged-away stand drawn again came back on top of its block; a stand taken
 * off the plan counted as a booking; a plan with no readable areas wrote 0 m²
 * and no price over every stand; and a failed replace put back the stands but
 * not their holds.
 */
const { fakeDb } = require('./fake-mongo');

const dbPath = require.resolve('../server/db');
let db;
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => db } };

const showContext = require('../server/show-context');
const booths = require('../server/models/booths');
const holds = require('../server/services/holds');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const SHOW = 'LNA';
const run = (fn) => showContext.runAs(SHOW, fn);
const now = (n) => db.store.booths.find(b => b.boothNumber === n);
const EMPTY = () => ({ company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null });
const fresh = () => { db = fakeDb({ booths: [], holds: [], booths_snapshots: [], settings: [{ _id: SHOW, ratePerSqm: 600 }] }); };

const PLAN = (over = {}) => [
  { number: '101', area: 9, areaSource: 'printed', geometry: { x: 0, y: 0, w: 40, h: 40 }, exhibitor: 'Acme Oils', status: 'sold' },
  { number: '102', area: 9, areaSource: 'printed', geometry: { x: 40, y: 0, w: 40, h: 40 }, exhibitor: null, status: 'available' },
  { number: '103', area: 9, areaSource: 'printed', geometry: { x: 80, y: 0, w: 40, h: 40 }, exhibitor: null, status: 'available' },
  { number: '105', area: 9, areaSource: 'printed', geometry: { x: 0, y: 40, w: 40, h: 40 }, exhibitor: 'Reserved Co', status: 'held' },
].map(s => ({ ...s, ...(over[s.number] || {}) }));

(async () => {
  console.log('\nAn import run by a person is still the plan\'s');
  fresh();
  let r = await run(() => booths.importFromArtwork(PLAN(), { actor: 'chris' }));
  check('the import lands', r.ok, JSON.stringify(r.reason));
  check('the stands it wrote are stamped as the import\'s', now('101').updatedBy === 'import', now('101').updatedBy);
  check('and say who ran it', now('101').importedBy === 'chris', now('101').importedBy);
  check('so the plan\'s own sold and held stands are not counted as bookings',
        await run(() => booths.countCommitted(SHOW)) === 0);
  r = await run(() => booths.importFromArtwork(PLAN({ 101: { status: 'available', exhibitor: null } }), { actor: 'chris' }));
  check('a second import from the console is not refused', r.ok, JSON.stringify(r.reason));
  check('and corrects a status the first one misread', now('101').status === 'available' && !now('101').assignment.company,
        `${now('101').status} ${now('101').assignment.company}`);

  r = await run(() => booths.importFromArtwork(PLAN({ 105: { status: 'available', exhibitor: null } }), { actor: 'chris', keep: true }));
  check('?mode=update corrects a misread hold too', r.ok && now('105').status === 'available',
        `${r.reason || ''} ${now('105').status}`);

  console.log('\nA rate change by a person does not turn the plan\'s stands into bookings');
  fresh();
  await run(() => booths.importFromArtwork(PLAN(), { actor: 'chris' }));
  await run(() => booths.recomputeListPrices(650, { actor: 'chris' }));
  check('still nothing committed', await run(() => booths.countCommitted(SHOW)) === 0);

  console.log('\nA person\'s booking is never re-stamped as import output');
  fresh();
  await run(() => booths.importFromArtwork(PLAN(), { actor: 'deploy' }));
  // A person turns the plan's reservation into a sale for the same exhibitor.
  await run(() => holds.drop('105'));
  await run(() => booths.setStatus('105', 'sold', { company: 'Reserved Co', actor: 'chris', expect: ['available', 'held'] }));
  check('the sale counts as a booking', await run(() => booths.countCommitted(SHOW)) === 1);
  r = await run(() => booths.importFromArtwork(PLAN(), { actor: 'deploy', force: true }));
  check('a forced deploy re-import re-reads its outline', r.ok && (r.reshapedNumbers || []).includes('105'),
        JSON.stringify(r.reshapedNumbers));
  check('but leaves who booked it alone', now('105').updatedBy === 'chris', now('105').updatedBy);
  check('so it still counts as a booking', await run(() => booths.countCommitted(SHOW)) === 1);
  r = await run(() => booths.importFromArtwork(PLAN({ 105: { status: 'available', exhibitor: null } }), { actor: 'deploy' }));
  check('and the next import is refused rather than setting it available',
        !r.ok && r.reason === 'has_bookings' && now('105').status === 'sold', `${r.reason} ${now('105').status}`);

  console.log('\nA stand merged away is not drawn back on top of its block');
  fresh();
  await run(() => booths.importFromArtwork(PLAN(), { actor: 'chris' }));
  await run(() => booths.consolidate('102', '103', { actor: 'chris' }));
  check('102 and 103 are one 18 m² block', !now('103') && now('102').sqm === 18);
  r = await run(() => booths.importFromArtwork(PLAN(), { actor: 'chris', keep: true }));
  check('an update from a plan still drawing 103 lands', r.ok, JSON.stringify(r.reason));
  check('without creating 103 again', !now('103'), JSON.stringify(now('103') && now('103').geometry));
  check('and says where it went', (r.absorbed || []).some(a => a.boothNumber === '103' && a.into === '102'),
        JSON.stringify(r.absorbed));
  const hall = db.store.booths.filter(b => !b.removed).reduce((s, b) => s + b.sqm, 0);
  check('so the hall holds 36 m², not 45', hall === 36, `${hall} m²`);

  console.log('\nA stand taken off the plan is not a booking');
  fresh();
  await run(() => booths.importFromArtwork(PLAN({ 101: { status: 'available', exhibitor: null },
                                                   105: { status: 'available', exhibitor: null } }), { actor: 'chris' }));
  await run(() => booths.remove('103', { actor: 'chris' }));
  check('nothing counts as committed', await run(() => booths.countCommitted(SHOW)) === 0,
        String(await run(() => booths.countCommitted(SHOW))));
  r = await run(() => booths.importFromArtwork(PLAN({ 101: { status: 'available', exhibitor: null },
                                                       105: { status: 'available', exhibitor: null } }), { actor: 'chris' }));
  check('a re-import is held back for the hand-made removal, not for a booking that is not there',
        !r.ok && r.reason === 'has_customisations', JSON.stringify(r.reason));

  console.log('\nA plan with no readable areas does not empty every stand');
  fresh();
  await run(() => booths.importFromArtwork(PLAN(), { actor: 'chris' }));
  await run(() => booths.setStatus('102', 'sold', { company: 'Paying Co', actor: 'chris' }));
  const blind = PLAN().map(s => ({ ...s, area: null, areaSource: 'derived' }));
  r = await run(() => booths.importFromArtwork(blind, { actor: 'chris', keep: true }));
  check('the re-issue lands', r.ok, JSON.stringify(r.reason));
  check('a sold stand keeps its size and price', now('102').sqm === 9 && now('102').listPrice === 5400,
        `${now('102').sqm} m², ${now('102').listPrice}`);
  check('and so does every other', ['101', '103', '105'].every(n => now(n).sqm === 9 && now(n).listPrice === 5400),
        JSON.stringify(['101', '103', '105'].map(n => [now(n).sqm, now(n).listPrice])));
  r = await run(() => booths.importFromArtwork(blind, { actor: 'chris', replace: true, force: true }));
  check('a replace from it keeps the sizes it already knew', r.ok && now('101').sqm === 9 && now('101').listPrice === 5400,
        `${r.reason || ''} ${now('101') && now('101').sqm}`);

  console.log('\nA failed replace puts the holds back with the stands');
  fresh();
  db.store.booths.push({ showId: SHOW, boothNumber: '201', status: 'held', sqm: 9, listPrice: 5400,
                         holdExpiresAt: new Date(Date.now() + 3600_000),
                         assignment: { ...EMPTY(), company: 'Holding Co' } });
  db.store.holds.push({ showId: SHOW, boothNumber: '201', company: 'Holding Co', expiresAt: new Date(Date.now() + 3600_000) });
  const plain = db;
  db = { ...plain, collection: (name) => {
    const c = plain.collection(name);
    return name === 'booths' ? { ...c, insertMany: async (rows) => {
      if (rows.some(d => d.boothNumber === '101')) throw new Error('E11000 duplicate key');
      return c.insertMany(rows);
    } } : c;
  } };
  r = await run(() => booths.importFromArtwork(PLAN(), { actor: 'chris', replace: true, force: true }));
  db = plain;
  check('the replace fails and says so', !r.ok && r.reason === 'insert_failed', JSON.stringify(r.reason));
  check('the held stand is back', now('201') && now('201').status === 'held');
  check('and so is its hold, so the sweep does not release it',
        db.store.holds.some(h => h.boothNumber === '201' && h.company === 'Holding Co'),
        JSON.stringify(db.store.holds));

  console.log('\nAn import that could not be finished is undone, and a booking made meanwhile is kept');
  // The hall before: a person's sale at its old size, a stand the previous
  // import holds for the plan, and an empty stand only a previous import wrote.
  const OLD = { x: 0, y: 0, w: 20, h: 20 };
  const undoHall = () => fakeDb({
    booths: [
      { showId: SHOW, boothNumber: '101', status: 'sold', sqm: 4, listPrice: 2400, geometry: OLD, updatedBy: 'chris',
        assignment: { ...EMPTY(), company: 'Real Exhibitor Ltd', contactId: 'c1', actualPrice: 2000 } },
      { showId: SHOW, boothNumber: '102', status: 'available', sqm: 9, listPrice: 5400, geometry: PLAN()[1].geometry,
        assignment: EMPTY() },
      { showId: SHOW, boothNumber: '105', status: 'held', sqm: 9, listPrice: 5400, geometry: PLAN()[3].geometry,
        source: 'artwork-import', updatedBy: 'import', holdExpiresAt: null,
        assignment: { ...EMPTY(), company: 'Reserved Co', notes: booths.IMPORT_NOTE } },
      { showId: SHOW, boothNumber: '107', status: 'available', sqm: 9, listPrice: 5400, geometry: { x: 200, y: 0, w: 40, h: 40 },
        source: 'artwork-import', updatedBy: 'import', assignment: EMPTY() },
    ],
    holds: [{ showId: SHOW, boothNumber: '105', company: 'Reserved Co', source: 'artwork-import' }],
    booths_snapshots: [], settings: [{ _id: SHOW, ratePerSqm: 600 }],
  });
  const reissue = PLAN({ 102: { status: 'sold', exhibitor: 'Plan Co' }, 105: { status: 'available', exhibitor: null } });
  const shapeOf = () => db.store.booths.map(b => `${b.boothNumber}:${b.status}:${JSON.stringify(b.geometry)}:${b.assignment.company || ''}`)
    .sort().join('|');

  db = undoHall();
  const beforeImport = shapeOf();
  r = await run(() => booths.importFromArtwork(reissue, { actor: 'chris', keep: true }));
  check('(the re-issue moves the sale, sells 102, adds 103, releases 105 and drops 107)',
        r.ok && JSON.stringify(now('101').geometry) !== JSON.stringify(OLD) && now('102').status === 'sold' &&
        !!now('103') && now('105').status === 'available' && !now('107'), JSON.stringify(r.reason));
  // A person sells 102 to someone else over a socket while the import is
  // still finishing — no plan lock stands in the way of that.
  await run(() => booths.setStatus('102', 'sold', { company: 'Walk-in Buyer', actor: 'chris' }));
  const pointsBefore = (db.store.booths_snapshots || []).filter(s => s.header && s.history).length;
  let undo = await run(() => booths.restoreSnapshot(r.snapshotId, { apply: true, undoImport: true, actor: 'chris' }));
  check('the undo succeeds', undo.ok, JSON.stringify(undo.reason || undo.kept));
  check('the sold stand is back at the size it was sold at, still sold to its exhibitor',
        JSON.stringify(now('101').geometry) === JSON.stringify(OLD) && now('101').sqm === 4 &&
        now('101').status === 'sold' && now('101').assignment.company === 'Real Exhibitor Ltd',
        JSON.stringify([now('101').geometry, now('101').sqm]));
  check('the sale a person made meanwhile is kept, on the stand\'s old shape',
        now('102').status === 'sold' && now('102').assignment.company === 'Walk-in Buyer',
        `${now('102').status} ${now('102').assignment.company}`);
  check('the stand the import created is gone', !now('103'));
  check('the plan\'s hold the import released is held again, with its document',
        now('105').status === 'held' && now('105').holdExpiresAt === null &&
        db.store.holds.some(h => h.boothNumber === '105' && h.source === 'artwork-import'),
        JSON.stringify(db.store.holds.map(h => h.boothNumber)));
  check('the stand it dropped is back', !!now('107') && now('107').status === 'available');
  check('and no history point is written for it', (db.store.booths_snapshots || []).filter(s => s.header && s.history).length === pointsBefore);

  db = undoHall();
  await run(() => booths.importFromArtwork(reissue, { actor: 'chris', keep: true }));
  // This time the person's sale lands on a stand the import itself created.
  const snapId = db.store.booths_snapshots.find(s => s.header).snapshotId;
  await run(() => booths.setStatus('103', 'sold', { company: 'New Stand Buyer', actor: 'chris' }));
  const afterImport = shapeOf();
  undo = await run(() => booths.restoreSnapshot(snapId, { apply: true, undoImport: true, actor: 'chris' }));
  check('an undo that would delete a stand a person has since booked is refused, naming it',
        !undo.ok && undo.reason === 'booked_since' && undo.conflicts.map(c => c.boothNumber).join() === '103',
        JSON.stringify(undo));
  check('before anything is written', shapeOf() === afterImport && shapeOf() !== beforeImport);

  console.log('\nA booking made while an import runs is not overwritten by it');
  db = undoHall();
  const quiet = db;
  let raced = false;
  db = { ...quiet, collection: (name) => {
    const c = quiet.collection(name);
    if (name !== 'booths') return c;
    // A person sells 102 in the instant between the import reading the hall
    // and writing it.
    return { ...c, bulkWrite: async (ops) => {
      if (!raced) { raced = true; await booths.setStatus('102', 'sold', { company: 'Quick Buyer', actor: 'chris' }); }
      return c.bulkWrite(ops);
    } };
  } };
  r = await run(() => booths.importFromArtwork(reissue, { actor: 'chris', keep: true }));
  db = quiet;
  check('the import runs', r.ok && raced, JSON.stringify(r.reason));
  check('and the sale stands, not the plan\'s reading of the stand',
        now('102').status === 'sold' && now('102').assignment.company === 'Quick Buyer' && now('102').source === undefined,
        `${now('102').status} ${now('102').assignment.company}`);

  console.log('\nThe blank plan is Europe\'s, and rebuilds nobody else');
  // server/data/booth_data.json is Europe's hall. Every event used to be
  // rebuilt from it, at the rate the file was priced at.
  fresh();
  await run(() => booths.importFromArtwork(PLAN({ 101: { status: 'available', exhibitor: null },
                                                   105: { status: 'available', exhibitor: null } }), { actor: 'chris' }));
  r = await run(() => booths.resetToBlankLayout({ apply: true, force: true }));
  check('North America is refused, not rebuilt as a copy of Europe',
        !r.ok && r.reason === 'wrong_event' && db.store.booths.length === 4, JSON.stringify([r.reason, r.belongsTo]));
  r = await run(() => booths.restoreOriginalLayout({ apply: true, force: true }));
  check('and so is the original-layout rebuild', !r.ok && r.reason === 'wrong_event', JSON.stringify(r.reason));
  const EUROPE = require('../server/config').defaultShow;
  db = fakeDb({ booths: [], holds: [], booths_snapshots: [], settings: [{ _id: EUROPE, ratePerSqm: 660 }] });
  r = await showContext.runAs(EUROPE, () => booths.resetToBlankLayout({ apply: true }));
  const rebuilt = db.store.booths;
  check('Europe is rebuilt from it', r.ok && rebuilt.length > 200, JSON.stringify(r.reason || rebuilt.length));
  check('priced at Europe\'s rate now, not the rate the file was made at',
        rebuilt.every(b => b.listPrice === Math.round(b.sqm * 660)),
        JSON.stringify(rebuilt.slice(0, 2).map(b => [b.sqm, b.listPrice])));

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
