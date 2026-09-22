/**
 * A plan re-issued after selling has started — the hall extended, a row
 * redrawn — has to land without moving a single booking.
 *
 * This is the "same event, new drawing" case, and it used to be a dead end:
 * the import refused any event with a sale on it, so a re-issued plan could
 * only be read onto an event by releasing every stand first. What is pinned
 * here is the `keep` mode: bookings stay, shapes follow the drawing, new
 * stands appear, phantoms go, and what the drawing dropped that is sold is
 * named rather than lost — plus the diff the admin sees before deciding.
 */
const { fakeDb } = require('./fake-mongo');

const dbPath = require.resolve('../server/db');
let db;
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => db } };

const showContext = require('../server/show-context');
const booths = require('../server/models/booths');
const { diffStands } = require('../server/lib/plan-diff');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${ok ? d : d || ''}` : ''}`); };

const SHOW = 'LNA';
const geom = (x, y, w = 2, h = 2) => ({ x, y, w, h });

// The event as it stands: stands from a first import, one of them sold to a
// real exhibitor since, one held by a person, one an admin gave a logo.
const first = (n, g, extra = {}) => ({
  showId: SHOW, boothNumber: n, status: 'available', source: booths.IMPORT_SOURCE, geometry: g, sqm: 100,
  listPrice: 60000, assignment: { company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null },
  ...extra,
});
const stored = () => [
  first('101', geom(1, 1), { status: 'sold', source: null, updatedBy: 'chris',
    assignment: { company: 'Real Exhibitor Ltd', contactId: 'c1', actualPrice: 55000, notes: 'signed', tags: [], country: 'DE' } }),
  first('102', geom(3, 1)),                                         // empty, will move
  first('103', geom(5, 1)),                                         // empty, the drawing drops it
  first('104', geom(7, 1), { status: 'sold', source: null,
    assignment: { company: 'Dropped But Sold GmbH', contactId: 'c2', actualPrice: 40000, notes: '', tags: [], country: null } }),
  first('105', geom(9, 1), { status: 'held' }),                     // held by a person (a hold row below)
  first('106', geom(11, 1), { sponsorLogo: 'data:image/png;base64,AAAA' }),  // hand-work, drawing drops it
];
const holds = () => [{ showId: SHOW, boothNumber: '105', company: 'Holder Inc', source: null }];

// The re-issued drawing: 101 moved, 102 moved, 103/104/106 gone, 105 resized,
// and three new stands in the extension.
const plan = [
  { number: '101', area: 100, areaSource: 'printed', geometry: geom(1, 3), status: 'available' },
  { number: '102', area: 100, areaSource: 'printed', geometry: geom(3, 3), status: 'available' },
  { number: '105', area: 200, areaSource: 'printed', geometry: geom(9, 1, 4, 2), status: 'available' },
  { number: '201', area: 100, areaSource: 'printed', geometry: geom(1, 9), status: 'available' },
  { number: '202', area: 100, areaSource: 'printed', geometry: geom(3, 9), status: 'sold', exhibitor: 'New On Plan Ltd' },
  { number: '203', area: 100, areaSource: 'printed', geometry: geom(5, 9), status: 'available' },
];

const byNumber = (n) => db.store.booths.find(b => b.showId === SHOW && b.boothNumber === n);

(async () => {
  console.log('\nWhat the admin is shown before deciding');
  const d = diffStands(plan, stored());
  check('the new stands are listed', d.summary.added === 3 && d.added.map(a => a.boothNumber).join() === '201,202,203');
  check('moved stands are listed', d.summary.moved === 2 && d.moved.map(a => a.boothNumber).join() === '101,102');
  check('a resized stand is listed with both sizes', d.summary.resized === 1 && d.resized[0].from === 100 && d.resized[0].to === 200);
  check('stands the drawing drops are listed', d.summary.missing === 3 && d.missing.map(m => m.boothNumber).join() === '103,104,106');
  check('and the SOLD one among them is flagged', d.summary.committedMissing === 1 &&
        d.missing.find(m => m.boothNumber === '104').committed === true &&
        d.missing.find(m => m.boothNumber === '104').company === 'Dropped But Sold GmbH');
  check('a stand that has not moved is not listed as moved', diffStands(plan, [first('101', geom(1, 3))]).summary.moved === 0);

  console.log('\nWithout asking to keep bookings, the selling event is still refused');
  db = fakeDb({ booths: stored(), holds: holds(), booths_snapshots: [] });
  const refused = await showContext.runAs(SHOW, () => booths.importFromArtwork(plan, { actor: 'chris' }));
  check('refused', refused.ok === false && refused.reason === 'has_bookings', JSON.stringify(refused.reason));

  console.log('\nUpdating from the re-issued plan, keeping bookings');
  db = fakeDb({ booths: stored(), holds: holds(), booths_snapshots: [] });
  const r = await showContext.runAs(SHOW, () => booths.importFromArtwork(plan, { actor: 'chris', keep: true }));
  check('it runs', r.ok === true, JSON.stringify(r.reason || r.mode));
  check('as an update, never a replace', r.mode === 'update');
  check('a snapshot was taken first', r.snapshot === true && db.store.booths_snapshots.some(d => d.header === true),
        `${db.store.booths_snapshots.length} snapshot rows`);

  const sold = byNumber('101');
  check('the sold stand keeps its exhibitor', sold && sold.assignment.company === 'Real Exhibitor Ltd');
  check('and its agreed price, notes and country', sold.assignment.actualPrice === 55000 && sold.assignment.notes === 'signed' && sold.assignment.country === 'DE');
  check('and stays sold', sold.status === 'sold');
  check('but takes its new position from the drawing', sold.geometry.y === 3, JSON.stringify(sold.geometry));

  const held = byNumber('105');
  check('the held stand stays held', held && held.status === 'held');
  check('and takes its new size from the drawing', held.sqm === 200 && held.geometry.w === 4, JSON.stringify(held.geometry));
  check('the person\'s hold is untouched', db.store.holds.some(h => h.boothNumber === '105' && h.company === 'Holder Inc'));

  check('the empty stand that moved is moved', byNumber('102').geometry.y === 3);
  check('the three new stands exist', ['201', '202', '203'].every(byNumber) && r.created === 3);
  check('a new stand the plan draws as sold carries its printed name', byNumber('202').assignment.company === 'New On Plan Ltd');

  console.log('\nWhat the drawing dropped');
  check('an empty stand nobody touched is removed — it is not inventory any more', !byNumber('103') && r.removed.includes('103'), JSON.stringify(r.removed));
  check('a SOLD stand the drawing dropped is kept', !!byNumber('104') && byNumber('104').assignment.company === 'Dropped But Sold GmbH');
  check('a stand with hand-work the drawing dropped is kept', !!byNumber('106'));
  check('and both are reported by number, status and company',
        r.kept.length === 2 && r.kept.some(k => k.boothNumber === '104' && k.status === 'sold' && k.company === 'Dropped But Sold GmbH')
        && r.kept.some(k => k.boothNumber === '106'), JSON.stringify(r.kept));
  check('nothing was deleted wholesale', !db.calls.some(c => c[0] === 'deleteMany' && c[1] === 'booths' && !c[2].boothNumber));

  console.log('\nKeeping bookings is scoped to the event asked for');
  db = fakeDb({ booths: [...stored(), first('999', geom(50, 50), { showId: 'LEX', status: 'sold', source: null })], holds: holds(), booths_snapshots: [] });
  await showContext.runAs(SHOW, () => booths.importFromArtwork(plan, { actor: 'chris', keep: true }));
  check('another event\'s stand is not touched', db.store.booths.some(b => b.showId === 'LEX' && b.boothNumber === '999' && b.geometry.x === 50));

  console.log('\nKeep does not excuse a plan whose colours cannot be read');
  db = fakeDb({ booths: stored(), holds: holds(), booths_snapshots: [] });
  const blind = plan.map(s => ({ ...s, fillUnknown: true }));
  const nope = await showContext.runAs(SHOW, () => booths.importFromArtwork(blind, { actor: 'chris', keep: true }));
  check('still refused', nope.ok === false && nope.reason === 'fills_unreadable', JSON.stringify(nope.reason));

  console.log('\nKeep and replace together means keep');
  db = fakeDb({ booths: stored(), holds: holds(), booths_snapshots: [] });
  const both = await showContext.runAs(SHOW, () => booths.importFromArtwork(plan, { actor: 'chris', keep: true, replace: true }));
  check('the inventory was not thrown away', both.ok && both.mode === 'update' && !!byNumber('101') && byNumber('101').assignment.company === 'Real Exhibitor Ltd');

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})();
