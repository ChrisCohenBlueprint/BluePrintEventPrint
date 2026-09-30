/**
 * Taking a stand off the plan, and the lines that have to survive it.
 *
 * A plan arrives with rectangles the show does not sell. Until now the only way
 * to be rid of one was to merge it into a neighbour — which lies about the
 * neighbour's size — or to re-import the artwork, which throws away everything
 * anyone has done since.
 *
 * Two things are under test, and they are different jobs:
 *
 *   the record — a stand comes off the plan only if it is plainly nobody's:
 *                available, unbooked, not half of a merge or a split. It is
 *                marked, never destroyed, so it can come straight back and its
 *                number stays reserved meanwhile.
 *
 *   the drawing — BoothMap.sharedEdges. A plan draws every stand as its own
 *                rectangle, so the line between two stands side by side is TWO
 *                strokes lying on each other. Paint one stand out and the paint
 *                covers both: the neighbour loses the wall it shares and reads
 *                as open floor. So the removed stand's outline is decided edge
 *                by edge — the parts its neighbours also draw stay, the parts
 *                facing nothing but aisle go. That is the whole feature, and it
 *                is pure geometry, so it is tested as geometry.
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
const stand = (n, extra = {}) => ({
  showId: SHOW, boothNumber: n, status: 'available', sqm: 9, listPrice: 5940,
  geometry: { x: 0, y: 0, w: 40, h: 40 },
  assignment: { company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null },
  ...extra,
});

// ─── The drawing ──────────────────────────────────────────────────────────────
// BoothMap is browser code, but sharedEdges touches no DOM: it is given boxes
// and returns lines. A window object is all it needs to load here.
global.window = global.window || {};
require('../public/booth-map.js');
const { sharedEdges } = global.window.BoothMap;

// A tidy 3×1 row of 40×40 stands, with a 40×80 stand beneath the middle one.
//
//    ┌────┬────┬────┐
//    │ A  │ B  │ C  │
//    └────┼────┼────┘
//         │ D  │
//         │    │
//         └────┘
const A = { x: 0,   y: 0,  w: 40, h: 40 };
const B = { x: 40,  y: 0,  w: 40, h: 40 };
const C = { x: 80,  y: 0,  w: 40, h: 40 };
const D = { x: 40,  y: 40, w: 40, h: 80 };
// Is this wall drawn? A kept side is run on by half a stroke where it meets
// another kept side, so the line may be a shade longer than the wall it stands
// for at either end — what is asserted is that it lies on the right line and
// covers the whole of it, not that it stops to the decimal.
const has = (edges, x1, y1, x2, y2, t = 1) => edges.some(e =>
  Math.abs(e.x1 - e.x2) < 0.01 === (Math.abs(x1 - x2) < 0.01) &&
  Math.abs(e.x1 - x1) < t && Math.abs(e.y1 - y1) < t &&
  Math.abs(e.x2 - x2) < t && Math.abs(e.y2 - y2) < t &&
  Math.min(e.x1, e.x2) <= Math.min(x1, x2) + 0.01 && Math.max(e.x2, e.x1) >= Math.max(x1, x2) - 0.01 &&
  Math.min(e.y1, e.y2) <= Math.min(y1, y2) + 0.01 && Math.max(e.y2, e.y1) >= Math.max(y1, y2) - 0.01);
const span = (edges) => edges.map(e => `${e.x1},${e.y1}→${e.x2},${e.y2}`).join(' ');

(async () => {
  console.log('\nThe lines around a stand that has gone');

  // B is surrounded on three sides. Its fourth (the top, against the aisle) is
  // its own line and nobody else's, so it goes with it.
  let e = sharedEdges(B, [A, C, D], 1.5);
  check('a stand between two others keeps the wall it shares with each',
        has(e, 40, 0, 40, 40) && has(e, 80, 0, 80, 40), span(e));
  check('and the wall it shares with the stand below it', has(e, 40, 40, 80, 40), span(e));
  check('but not the side that faced only aisle', !has(e, 40, 0, 80, 0), span(e));
  check('four sides, three of them kept', e.length === 3, span(e));

  // A is on the end of the row: one neighbour, one line.
  e = sharedEdges(A, [B, C, D], 1.5);
  check('a stand on the end of a row keeps one line', e.length === 1, span(e));
  check('and it is the one it shared with its neighbour', has(e, 40, 0, 40, 40), span(e));

  // A stand with nothing against it leaves nothing behind.
  e = sharedEdges({ x: 400, y: 400, w: 40, h: 40 }, [A, B, C, D], 1.5);
  check('a stand standing on its own leaves no lines at all', e.length === 0, span(e));

  // D is half the width of the run above it: only the part it actually touches.
  e = sharedEdges({ x: 0, y: 40, w: 120, h: 40 }, [A, B, C], 1.5);
  check('a wide stand under a row keeps the whole run it touches',
        has(e, 0, 40, 120, 40), span(e));
  e = sharedEdges(D, [A, C], 1.5);
  check('a stand keeps only the part of an edge a neighbour actually covers',
        e.length === 0, span(e));

  // Two removed stands next to each other: the caller leaves both out of the
  // survivor list, so the wall BETWEEN them goes too — the pair becomes one
  // clear space rather than two holes with a line down the middle.
  e = sharedEdges(B, [A, D], 1.5);
  check('the wall between two stands that both went is not kept',
        !has(e, 80, 0, 80, 40), span(e));
  check('while the walls against what remains still are',
        has(e, 40, 0, 40, 40) && has(e, 40, 40, 80, 40), span(e));

  // The removed stand's own rectangle must never count as its own neighbour —
  // that would keep the complete outline and the stand would not go at all.
  e = sharedEdges(B, [A, B, C, D], 1.5);
  check('a stand is not its own neighbour', e.length === 3, span(e));

  // Two stands stacked against one side contribute half the edge each; drawn
  // separately they leave a hairline where neither quite reaches.
  const top = { x: 40, y: 0, w: 40, h: 20 }, bottom = { x: 40, y: 20, w: 40, h: 20 };
  e = sharedEdges(A, [top, bottom], 1.5);
  check('two stands against one side make one line, not two',
        e.length === 1 && has(e, 40, 0, 40, 40), span(e));

  // Corners are closed where both sides are kept, so the join has no notch.
  e = sharedEdges(B, [A, C, D], 1.5);
  const left = e.find(l => Math.abs(l.x1 - 40) < 0.6 && Math.abs(l.x2 - 40) < 0.6);
  check('a kept side runs on past a corner the neighbouring side also reaches',
        left && left.y2 > 40, JSON.stringify(left));
  check('and stops dead at a corner nothing else reaches', left && Math.abs(left.y1 - 0) < 0.01,
        JSON.stringify(left));

  // ─── The record ─────────────────────────────────────────────────────────────
  console.log('\nWhat may be taken off the plan');

  db = fakeDb({ booths: [
    stand('101'),
    stand('102', { status: 'sold', assignment: { company: 'Acme', contactId: null, actualPrice: null, notes: '', tags: [], country: null } }),
    stand('103', { splitFrom: '101' }),
    stand('104', { mergeSnapshot: { self: {}, parts: [] } }),
  ] });

  let r = await run(() => booths.remove('101', { actor: 'chris' }));
  check('a plain available stand comes off the plan', r.ok, JSON.stringify(r));
  check('it is marked, not destroyed', !!now('101') && now('101').removed === true);
  check('its status says so too', now('101').status === 'removed');
  check('its shape is kept — the plan needs to know where the hole is',
        now('101').geometry && now('101').geometry.w === 40);
  check('and who took it off is recorded', now('101').removedBy === 'chris' && !!now('101').removedAt);

  r = await run(() => booths.remove('101'));
  check('removing it twice is refused', !r.ok && r.reason === 'already_removed', JSON.stringify(r));

  r = await run(() => booths.remove('102'));
  check('a sold stand is refused — a booking is not cancelled this way',
        !r.ok && r.reason === 'not_available', JSON.stringify(r));
  check('and it is untouched', now('102').status === 'sold' && now('102').removed === undefined);

  r = await run(() => booths.remove('103'));
  check('a split cell is refused — reset it first', !r.ok && r.reason === 'reset_first', JSON.stringify(r));
  r = await run(() => booths.remove('104'));
  check('so is a merged block', !r.ok && r.reason === 'reset_first', JSON.stringify(r));
  r = await run(() => booths.remove('999'));
  check('a stand that does not exist is refused', !r.ok && r.reason === 'missing_booth', JSON.stringify(r));

  console.log('\nA stand that is off the plan is out of reach');
  const booked = await run(() => booths.setStatus('101', 'sold', { company: 'Acme', actor: 'chris' }));
  check('it cannot be booked', booked === null, JSON.stringify(booked));
  check('and it did not quietly become sold', now('101').status === 'removed');
  check('an import counts it as handwork, so it is not put back by the next upload',
        await run(() => booths.countHandwork(SHOW)) >= 1);

  // The headline figures are computed ONLY in stats(), so this is the only
  // place that can say whether a stand off the plan has really left the hall.
  const st = await run(() => booths.stats());
  check('it leaves the hall totals — the count, the area and the revenue alike',
        st.totalBooths === 3 && st.totalSqm === 27 && st.totalRevenue === 3 * 5940,
        JSON.stringify({ n: st.totalBooths, sqm: st.totalSqm, rev: st.totalRevenue }));
  check('and it is not counted as space still for sale',
        st.availableBooths === 2 && st.availSqm === 18,
        JSON.stringify({ avail: st.availableBooths, sqm: st.availSqm }));

  console.log('\nPutting one back');
  r = await run(() => booths.restoreRemoved('101', { actor: 'chris' }));
  check('it returns', r.ok, JSON.stringify(r));
  check('available again', now('101').status === 'available' && now('101').removed === undefined);
  check('with its shape and price as they were',
        now('101').geometry.w === 40 && now('101').listPrice === 5940);
  check('and it can be booked once more',
        !!await run(() => booths.setStatus('101', 'sold', { company: 'Acme', actor: 'chris' })));

  r = await run(() => booths.restoreRemoved('102'));
  check('restoring a stand that never left is refused', !r.ok && r.reason === 'not_removed', JSON.stringify(r));

  console.log('\nThe list Tools offers');
  await run(() => booths.remove('103').catch(() => {}));      // refused — still a split cell
  const gone = await run(() => booths.removedStands());
  check('lists only what is actually off the plan', gone.length === 0, JSON.stringify(gone));

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
