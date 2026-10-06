/**
 * Every change to the shape of the hall leaves a point you can go back to.
 *
 * A per-action undo is not a mechanism, it is a courtesy. The removal toast
 * carried an Undo for ten seconds; the first person to delete a stand came back
 * to it an hour later and had nothing. The stand was recoverable — but only by
 * someone who already knew a list of removed stands existed and where it lived,
 * and that is not a way back, it is a thing you have to have been told.
 *
 * So each reshaping records the WHOLE hall as it stood immediately before it,
 * under an id of its own. Undoing the last change and winding the plan back to
 * where it was this morning become the same operation, and neither depends on a
 * countdown, on a tool being found, or on anyone having been told anything.
 *
 * What is asserted here:
 *
 *   a point per change  — and only for changes that actually happened; a
 *                         refused operation reshaped nothing and must not leave
 *                         a step backwards that moves nothing.
 *   one step, not two   — an operation built out of others (merging a whole
 *                         split, which the model performs as a reset) is ONE
 *                         step back for the person who did it.
 *   long after the fact — a point from any distance back restores exactly, with
 *                         no window and no expiry.
 *   itself reversible   — going back is a change too, so going back is undoable.
 *   bounded             — the collection cannot grow without end.
 *   shape, not bookings — going back puts the hall's shape back and leaves every
 *                         sale and hold as it is now; a point that would move or
 *                         take away a booked stand is refused, naming it.
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

const SHOW = 'LEX26';
const run = (fn) => showContext.runAs(SHOW, fn);
const now = (n) => db.store.booths.find(b => b.boothNumber === n);
const live = () => db.store.booths.filter(b => !b.removed);
const numbers = () => live().map(b => b.boothNumber).sort().join(',');
const totalSqm = () => live().reduce((s, b) => s + (b.sqm || 0), 0);
const near = (a, b) => Math.abs(a - b) < 0.01;
const sameBox = (a, b) => !!a && !!b && near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h);

const RATE = 660;
const stand = (n, box, sqm) => ({
  showId: SHOW, boothNumber: n, status: 'available', sqm, listPrice: sqm * RATE, geometry: box,
  assignment: { company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null },
});
const ROW = () => [
  stand('A', { x: 0, y: 0, w: 40, h: 40 }, 9),
  stand('B', { x: 40, y: 0, w: 40, h: 40 }, 9),
  stand('C', { x: 80, y: 0, w: 40, h: 40 }, 9),
  stand('D', { x: 120, y: 0, w: 40, h: 40 }, 9),
];
const seed = () => { db = fakeDb({ booths: ROW() }); };

// Snapshot ids carry a timestamp to the millisecond, and these operations run
// inside one. Without a nudge between them two points share an id, which is a
// collision the real thing (where a person clicks) cannot produce but which
// would make this test lie about ordering.
const tick = () => new Promise(r => setTimeout(r, 3));

(async () => {
  console.log('\nA point for every change, and none for a refusal');
  seed();
  check('nothing has happened yet', (await run(() => booths.history())).length === 0);

  await run(() => booths.consolidateMany(['A', 'B'], { actor: 'chris' })); await tick();
  await run(() => booths.split('A', { parts: 2, axis: 'vertical', actor: 'chris' })); await tick();
  let h = await run(() => booths.history());
  check('two changes, two points', h.length === 2, JSON.stringify(h.map(p => p.op)));
  check('newest first', h[0].op === 'split' && h[1].op === 'consolidateMany', h.map(p => p.op).join(' < '));
  check('each says what it was, in words', h[0].label === 'Stand split' && h[1].label === 'Stands merged',
        h.map(p => p.label).join(' | '));
  check('and who did it', h.every(p => p.actor === 'chris'), JSON.stringify(h.map(p => p.actor)));
  // reset() took no actor at all until the history needed one, so its row read
  // "unknown" beside everybody else's name.
  await run(() => booths.reset('A', { actor: 'chris' })); await tick();
  check('a reset carries a name too', (await run(() => booths.history()))[0].actor === 'chris');
  check('and which stands it touched', h[1].boothNumbers.join(',') === 'A,B', JSON.stringify(h[1].boothNumbers));

  const refused = await run(() => booths.consolidateMany(['A', 'D'], { actor: 'chris' }));
  check('a merge across the hall is refused', !refused.ok, JSON.stringify(refused.reason));
  check('and leaves no point behind it — there is nothing to go back from',
        (await run(() => booths.history())).length === 3);

  console.log('\nOne operation is one step back, however the model performs it');
  seed();
  await run(() => booths.split('A', { parts: 3, axis: 'vertical', actor: 'chris' })); await tick();
  // The model undoes this by calling reset() internally. That inner call must
  // not leave a point of its own, or the admin's single action would take two
  // presses to walk back.
  await run(() => booths.consolidateMany(['A', 'A-2', 'A-3'], { actor: 'chris' })); await tick();
  h = await run(() => booths.history());
  check('splitting then putting it back together is two points, not three',
        h.length === 2, JSON.stringify(h.map(p => p.op)));

  console.log('\nGoing back, long after the fact');
  seed();
  const before = { numbers: numbers(), sqm: totalSqm() };
  await run(() => booths.remove('C', { actor: 'chris' })); await tick();
  check('the stand is off the plan', now('C').removed === true && !numbers().includes('C'));
  // Several more changes on top, as a day's work would put them.
  await run(() => booths.consolidateMany(['A', 'B'], { actor: 'chris' })); await tick();
  await run(() => booths.split('A', { parts: 2, axis: 'vertical', actor: 'chris' })); await tick();
  await run(() => booths.setDisplayNumber('D', 'D1', { actor: 'chris' })); await tick();
  h = await run(() => booths.history());
  check('four changes are recorded', h.length === 4, JSON.stringify(h.map(p => p.op)));

  // The point stored BY the removal is the hall as it was before it — which is
  // the one to go back to in order to undo the removal and nothing else.
  const removalPoint = h.find(p => p.op === 'remove');
  const dry = await run(() => booths.restoreSnapshot(removalPoint.id));
  check('a point can be inspected before it is applied', dry.ok && dry.dryRun === true && dry.stands === 4,
        JSON.stringify({ stands: dry.stands, replacing: dry.replacing }));
  check('and nothing has moved just by looking', numbers() !== before.numbers);

  const r = await run(() => booths.restoreSnapshot(removalPoint.id, { apply: true, actor: 'chris' }));
  check('applying it puts the hall back exactly as it stood before that change',
        r.ok && numbers() === before.numbers && totalSqm() === before.sqm,
        `${numbers()} · ${totalSqm()} m²`);
  check('the deleted stand is on the plan again, with its own shape and size',
        now('C') && now('C').removed === undefined && now('C').sqm === 9 &&
        sameBox(now('C').geometry, { x: 80, y: 0, w: 40, h: 40 }),
        JSON.stringify(now('C') && now('C').geometry));
  check('and so is everything the later changes had reshaped',
        !now('A-2') && now('A').sqm === 9 && !now('D').displayNumber,
        JSON.stringify(live().map(b => [b.boothNumber, b.sqm])));

  console.log('\nGoing back is itself a change, so it too can be undone');
  check('the hall as it was a moment ago was stored first',
        !!r.previousSnapshot, JSON.stringify(r.previousSnapshot));
  const afterRestore = await run(() => booths.history());
  check('the restore takes its own place in the history',
        afterRestore.some(p => p.op === 'restore'), JSON.stringify(afterRestore.map(p => p.op)));
  check('so the way back out of it is in the same list, not only in the return value',
        afterRestore[0].op === 'restore' && afterRestore[0].id === r.previousSnapshot,
        JSON.stringify(afterRestore[0] && afterRestore[0].id));

  const back = await run(() => booths.restoreSnapshot(r.previousSnapshot, { apply: true, actor: 'chris' }));
  check('so the restore can be walked back out of', back.ok, JSON.stringify(back.reason));
  check('and the day\'s work returns', !!now('A-2') && now('D').displayNumber === 'D1',
        JSON.stringify(live().map(b => b.boothNumber)));

  console.log('\nThe record is bounded');
  seed();
  // More changes than the history keeps, to prove it sheds the oldest rather
  // than growing for ever on a plan that is worked on all day.
  const KEEP = Number(process.env.HISTORY_KEEP || 200);
  for (let i = 0; i < 6; i++) {
    await run(() => booths.split('D', { parts: 2, axis: 'vertical', actor: 'chris' }));
    await run(() => booths.reset('D'));
    await tick();
  }
  h = await run(() => booths.history({ limit: 100 }));
  check('every change is kept while there is room', h.length === 12, String(h.length));
  const pruned = await run(() => booths.pruneHistory());
  check(`nothing is shed below the ${KEEP} kept`, pruned === 0, String(pruned));
  const rows = db.store.booths_snapshots.filter(d => d.header);
  check('one header per point, and the stands stored under it',
        rows.length === 12 && db.store.booths_snapshots.length > 12,
        `${rows.length} headers, ${db.store.booths_snapshots.length} rows`);

  // ─── Shape, not bookings ────────────────────────────────────────────────────
  console.log('\nGoing back puts the shape back, and keeps every booking as it is now');
  seed();
  db.store.holds = [];
  await run(() => booths.setStatus('D', 'held', { company: 'Was Holding Co', actor: 'chris',
                                                  holdExpiresAt: new Date(Date.now() - 86_400_000) }));
  await run(() => booths.consolidateMany(['A', 'B'], { actor: 'chris' })); await tick();
  const mergePoint = (await run(() => booths.history()))[0];
  // Since the point: D's old hold is released, C is sold with a deal, and D is
  // held again by someone else with a live hold document.
  await run(() => booths.setStatus('D', 'available', { actor: 'chris' }));
  await run(() => booths.setStatus('C', 'sold', { company: 'Acme', actor: 'chris' }));
  await run(() => booths.updateDeal('C', { actualPrice: 9000, notes: 'corner deal', actor: 'chris' }));
  const placed = await run(() => holds.create({ boothNumber: 'D', company: 'Beta', actor: 'chris' }));
  check('(a hold is placed on D since the point)', placed.ok, JSON.stringify(placed));
  let dryRun = await run(() => booths.restoreSnapshot(mergePoint.id));
  check('the dry run says what changes and that two bookings ride through',
        dryRun.ok && dryRun.bookingsKept === 2 && dryRun.conflicts.length === 0 &&
        dryRun.changes.added.join() === 'B' && dryRun.changes.reshaped.join() === 'A',
        JSON.stringify({ kept: dryRun.bookingsKept, changes: dryRun.changes }));
  let back2 = await run(() => booths.restoreSnapshot(mergePoint.id, { apply: true, actor: 'chris' }));
  check('the merge is undone', back2.ok && numbers() === 'A,B,C,D' && totalSqm() === 36, `${numbers()} ${totalSqm()}`);
  check('the sale made since is still a sale, deal and all',
        now('C').status === 'sold' && now('C').assignment.company === 'Acme' &&
        now('C').assignment.actualPrice === 9000 && now('C').assignment.notes === 'corner deal',
        JSON.stringify(now('C').assignment));
  check('the hold made since is still held, by Beta, to its own expiry',
        now('D').status === 'held' && now('D').assignment.company === 'Beta' &&
        +now('D').holdExpiresAt === +placed.expiresAt, `${now('D').status} ${now('D').assignment.company}`);
  check('with its hold document beside it, so stand and holds still agree',
        db.store.holds.length === 1 && db.store.holds[0].boothNumber === 'D' && db.store.holds[0].company === 'Beta');
  check('and the hold the point remembers, long expired, does not come back with it',
        (await run(() => holds.reconcile())).length === 0 && now('D').status === 'held');

  console.log('\nA point that would take a booking away is refused, naming it');
  seed();
  await run(() => booths.split('A', { parts: 2, axis: 'vertical', actor: 'chris' })); await tick();
  const splitPoint = (await run(() => booths.history()))[0];
  await run(() => booths.setStatus('A-2', 'sold', { company: 'Cell Buyer Ltd', actor: 'chris' }));
  dryRun = await run(() => booths.restoreSnapshot(splitPoint.id));
  check('the dry run names the booked stand that would disappear',
        dryRun.ok && dryRun.conflicts.length === 1 && dryRun.conflicts[0].boothNumber === 'A-2' &&
        dryRun.conflicts[0].why === 'gone' && dryRun.conflicts[0].company === 'Cell Buyer Ltd',
        JSON.stringify(dryRun.conflicts));
  const historyBefore = (await run(() => booths.history())).length;
  back2 = await run(() => booths.restoreSnapshot(splitPoint.id, { apply: true, actor: 'chris' }));
  check('applying it is refused', !back2.ok && back2.reason === 'bookings_in_the_way', JSON.stringify(back2.reason));
  check('and nothing moved — the sale is where it was', now('A-2') && now('A-2').status === 'sold' && now('A').sqm === 5,
        `${numbers()} ${now('A').sqm}`);
  check('nor did it leave a point for a change that did not happen',
        (await run(() => booths.history())).length === historyBefore);

  seed();
  await run(() => booths.consolidateMany(['C', 'D'], { actor: 'chris' })); await tick();
  await run(() => booths.split('A', { parts: 2, axis: 'vertical', actor: 'chris' })); await tick();
  const blockPoint = (await run(() => booths.history()))[0];      // C is an 18 m² block here
  await run(() => booths.reset('C', { actor: 'chris' }));
  await run(() => booths.setStatus('C', 'held', { company: 'Wants C', actor: 'chris' }));
  dryRun = await run(() => booths.restoreSnapshot(blockPoint.id));
  check('a booked stand whose size the point would change is named too',
        dryRun.conflicts.length === 1 && dryRun.conflicts[0].boothNumber === 'C' && dryRun.conflicts[0].why === 'resized',
        JSON.stringify(dryRun.conflicts));

  console.log('\nA logo inside a merged block survives the trip');
  seed();
  Object.assign(now('D'), { sponsored: true, sponsorLogo: 'data:image/png;base64,LOGO' });
  await run(() => booths.consolidateMany(['C', 'D'], { actor: 'chris' })); await tick();
  await run(() => booths.split('A', { parts: 2, axis: 'vertical', actor: 'chris' })); await tick();
  const withBlock = (await run(() => booths.history()))[0];        // C carries D, logo and all
  await run(() => booths.reset('C', { actor: 'chris' }));             // D is back on its own
  dryRun = await run(() => booths.restoreSnapshot(withBlock.id));
  check('nothing is reported lost: D\'s logo is still on the plan to carry back in',
        dryRun.logosNotRestored.length === 0, JSON.stringify(dryRun.logosNotRestored));
  await run(() => booths.restoreSnapshot(withBlock.id, { apply: true, actor: 'chris' }));
  const inside = (now('C').mergeSnapshot.parts || []).find(p => p.boothNumber === 'D');
  check('the block holds D again, with its logo and no marker left on it',
        inside && inside.sponsorLogo === 'data:image/png;base64,LOGO' && inside.sponsorLogoOmitted === undefined,
        JSON.stringify(inside && Object.keys(inside)));
  await run(() => booths.reset('C', { actor: 'chris' }));
  check('so resetting the block brings D back with it', now('D') && now('D').sponsorLogo === 'data:image/png;base64,LOGO');

  console.log('\nTwo points in one millisecond are two points');
  const ids = new Set();
  for (let i = 0; i < 5; i++) ids.add((await run(() => booths.snapshot('burst', []))).snapshotId);
  check('each has an id of its own', ids.size === 5, [...ids].join(' '));

  console.log('\nA restore that loses a race undoes all of itself');
  seed();
  await run(() => booths.consolidateMany(['A', 'B'], { actor: 'chris' })); await tick();
  await run(() => booths.consolidateMany(['C', 'D'], { actor: 'chris' })); await tick();
  const twoBlocks = (await run(() => booths.history())).find(p => p.op === 'consolidateMany' && p.boothNumbers.join() === 'A,B');
  const plain = db;
  db = { ...plain, collection: (name) => {
    const c = plain.collection(name);
    if (name !== 'booths') return c;
    // C is changed by somebody else in the instant before the restore reaches it.
    return { ...c, updateOne: async (f, u, o) => (f.boothNumber === 'C' && f.shapeRev !== undefined
      ? { matchedCount: 0, modifiedCount: 0 } : c.updateOne(f, u, o)) };
  } };
  const before2 = { nums: numbers(), sqm: totalSqm(), a: JSON.stringify(now('A').geometry) };
  const pointsBefore = (await run(() => booths.history())).length;
  back2 = await run(() => booths.restoreSnapshot(twoBlocks.id, { apply: true, actor: 'chris' }));
  db = plain;
  check('it says a stand changed under it', !back2.ok && back2.reason === 'changed_meanwhile' && back2.boothNumber === 'C',
        JSON.stringify([back2.reason, back2.boothNumber]));
  check('and the hall is exactly as it was before it started',
        numbers() === before2.nums && totalSqm() === before2.sqm && JSON.stringify(now('A').geometry) === before2.a,
        `${numbers()} ${totalSqm()}`);
  check('with no point left behind for it', (await run(() => booths.history())).length === pointsBefore);

  console.log('\nGoing back to an earlier drawing puts its lounges and unit back too');
  const styled = require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'plan-to-spec.svg'), 'utf8')
    .replace(/(<svg[^>]*>)/, '$1<style>.a{fill:#ffffff}.b{fill:#5a1030}</style>');
  db = fakeDb({
    booths: ROW(),
    floorplans: [{ showId: SHOW, svg: '<svg/>', revisionId: 'r2', label: 'LEX27.1', version: 'v2' }],
    floorplan_revisions: [
      { showId: SHOW, revisionId: 'r1', seq: 1, label: 'LEX27', status: 'superseded', svg: styled, filename: 'a.svg', bytes: 1 },
      { showId: SHOW, revisionId: 'r2', seq: 2, label: 'LEX27.1', status: 'live', svg: '<svg/>', filename: 'b.svg', bytes: 1 },
    ],
    planAreas: [{ showId: SHOW, key: 'newer-lounge', geometry: { x: 1, y: 1, w: 1, h: 1 }, fromArtwork: true, artworkLabel: 'Newer Lounge' }],
    settings: [{ _id: SHOW, unit: 'm' }],
  });
  const onR1 = await run(() => booths.snapshot('publish', db.store.booths.map(b => ({ ...b })), { revisionId: 'r1' }));
  back2 = await run(() => booths.restoreSnapshot(onR1.snapshotId, { apply: true, actor: 'chris' }));
  check('the drawing goes back', back2.ok && back2.artwork && back2.artwork.label === 'LEX27' &&
        db.store.floorplans[0].revisionId === 'r1', JSON.stringify(back2.artwork));
  const areas = db.store.planAreas.filter(a => a.geometry && a.fromArtwork).map(a => a.key);
  check('its lounge is the one on the plan, not the newer plan\'s', areas.join() === 'networking-lounge', areas.join());
  check('and its unit, which it prints in ft²', db.store.settings[0].unit === 'ft', db.store.settings[0].unit);

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
