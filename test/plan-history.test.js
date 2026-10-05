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
 */
const { fakeDb } = require('./fake-mongo');

const dbPath = require.resolve('../server/db');
let db;
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => db } };

const showContext = require('../server/show-context');
const booths = require('../server/models/booths');

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

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
