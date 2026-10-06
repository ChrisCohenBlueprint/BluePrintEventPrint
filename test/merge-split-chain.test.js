/**
 * Merge then split, and split then merge.
 *
 * Both were refused. You could merge, or you could split, and to do the other
 * one you had to undo the first — which is not how a hall is laid out. A row of
 * small stands becomes one block, the block turns out to be two stands of an
 * awkward size, and that is one continuous decision, not two that cancel.
 *
 * The one case that was allowed — a custom re-carve of a merged block — was the
 * dangerous one: it threw the merge away, and with it the full records of every
 * stand the block had absorbed. Those stands could never come back. The chain
 * now keeps both shapings and `reset` unwinds them one at a time, newest first.
 *
 * The arithmetic is the point, so it is what is asserted:
 *
 *   conservation — the hall's total area and list price are the same after any
 *                  chain as before it. A split divides exactly (floor plus
 *                  remainder) and a merge sums, so nothing may drift, however
 *                  many times the two are alternated.
 *   tiling       — cells tile their parent exactly; a merged block is exactly
 *                  the bounding box of its parts. No gaps, no overlaps.
 *   reversal     — every chain walks back, step by step, to precisely the
 *                  stands it started from: same numbers, same boxes, same sizes.
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
const near = (a, b, t = 0.01) => Math.abs(a - b) < t;
const sameBox = (a, b) => !!a && !!b && near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h);
const g = (b) => b && b.geometry;
const live = () => db.store.booths.filter(b => !b.removed);
const totalSqm = () => live().reduce((s, b) => s + (b.sqm || 0), 0);
const totalPrice = () => live().reduce((s, b) => s + (b.listPrice || 0), 0);
const numbers = () => live().map(b => b.boothNumber).sort().join(',');

const RATE = 660;
const stand = (n, box, sqm) => ({
  showId: SHOW, boothNumber: n, status: 'available', sqm, listPrice: sqm * RATE, geometry: box,
  assignment: { company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null },
});

// Four stands in a row, each 40 wide and 40 tall, 9 m² apiece.
//   ┌────┬────┬────┬────┐
//   │ A  │ B  │ C  │ D  │
//   └────┴────┴────┴────┘
const ROW = () => [
  stand('A', { x: 0,   y: 0, w: 40, h: 40 }, 9),
  stand('B', { x: 40,  y: 0, w: 40, h: 40 }, 9),
  stand('C', { x: 80,  y: 0, w: 40, h: 40 }, 9),
  stand('D', { x: 120, y: 0, w: 40, h: 40 }, 9),
];
const seed = () => { db = fakeDb({ booths: ROW() }); };

/** Do these boxes tile `box` exactly — no gap, no overlap, nothing outside? */
function tiles(box, parts) {
  const area = parts.reduce((s, p) => s + p.w * p.h, 0);
  if (!near(area, box.w * box.h, 0.5)) return false;
  for (const p of parts) {
    if (p.x < box.x - 0.01 || p.y < box.y - 0.01) return false;
    if (p.x + p.w > box.x + box.w + 0.01 || p.y + p.h > box.y + box.h + 0.01) return false;
  }
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i], b = parts[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 0.01 && oy > 0.01) return false;
    }
  }
  return true;
}

(async () => {
  const START_SQM = 36, START_PRICE = 36 * RATE, START_NUMS = 'A,B,C,D';

  // ─── Merge, then split ──────────────────────────────────────────────────────
  console.log('\nMerge a pair, then divide the block');
  seed();
  let r = await run(() => booths.consolidateMany(['A', 'B']));
  check('two stands merge', r.ok, JSON.stringify(r.reason));
  check('the block is their bounding box', sameBox(g(now('A')), { x: 0, y: 0, w: 80, h: 40 }), JSON.stringify(g(now('A'))));
  check('and carries both their sizes', now('A').sqm === 18 && now('A').listPrice === 18 * RATE);

  r = await run(() => booths.split('A', { parts: 2, axis: 'vertical' }));
  check('the merged block then divides — it used to be refused outright', r.ok, JSON.stringify(r.reason));
  check('into cells that tile the block exactly',
        tiles({ x: 0, y: 0, w: 80, h: 40 }, [g(now('A')), g(now('A-2'))]),
        JSON.stringify([g(now('A')), g(now('A-2'))]));
  check('sizes divide exactly, with nothing lost to rounding',
        now('A').sqm + now('A-2').sqm === 18 && now('A').listPrice + now('A-2').listPrice === 18 * RATE,
        `${now('A').sqm} + ${now('A-2').sqm}`);
  check('the hall still holds what it held', totalSqm() === START_SQM && totalPrice() === START_PRICE,
        `${totalSqm()} m², ${totalPrice()}`);

  r = await run(() => booths.reset('A'));
  check('the first reset undoes the SPLIT, being the later of the two',
        r.ok && r.type === 'unsplit', JSON.stringify(r));
  check('the block is back whole', sameBox(g(now('A')), { x: 0, y: 0, w: 80, h: 40 }) && now('A').sqm === 18);
  check('and the cell it made is gone', !now('A-2'));

  r = await run(() => booths.reset('A'));
  check('the second reset undoes the MERGE', r.ok && r.type === 'unmerge', JSON.stringify(r));
  check('both original stands are back, exactly as they were',
        sameBox(g(now('A')), { x: 0, y: 0, w: 40, h: 40 }) && sameBox(g(now('B')), { x: 40, y: 0, w: 40, h: 40 }) &&
        now('A').sqm === 9 && now('B').sqm === 9);
  check('the hall is precisely where it started',
        numbers() === START_NUMS && totalSqm() === START_SQM && totalPrice() === START_PRICE,
        `${numbers()} · ${totalSqm()} m²`);

  // ─── Merge, then RE-CARVE (the one that used to destroy the originals) ──────
  console.log('\nMerge a block, then re-carve it into stands of your own');
  seed();
  await run(() => booths.consolidateMany(['A', 'B', 'C']));
  check('three stands make a 27 m² block', now('A').sqm === 27 && sameBox(g(now('A')), { x: 0, y: 0, w: 120, h: 40 }));
  r = await run(() => booths.splitCustom('A', { axis: 'vertical', parts: [{ number: '10', sqm: 12 }, { number: '11', sqm: 15 }] }));
  check('the block re-carves into two stands of chosen sizes', r.ok, JSON.stringify(r.reason));
  check('the carve is proportional to the sizes asked for',
        near(g(now('A')).w, 120 * 12 / 27, 0.5) && near(g(now('A-2')).w, 120 * 15 / 27, 0.5),
        JSON.stringify([g(now('A')).w, g(now('A-2')).w]));
  check('and still tiles the block', tiles({ x: 0, y: 0, w: 120, h: 40 }, [g(now('A')), g(now('A-2'))]));
  check('the merge was NOT thrown away — this is what used to lose the originals',
        !!now('A').mergeSnapshot && (now('A').mergeSnapshot.parts || []).length === 2,
        JSON.stringify(Object.keys(now('A'))));
  check('the hall total is unchanged', totalSqm() === START_SQM, `${totalSqm()} m²`);

  await run(() => booths.reset('A'));
  check('one reset gives the block back', now('A').sqm === 27 && !now('A-2'));
  await run(() => booths.reset('A'));
  check('and the next gives back the three stands it was made from',
        numbers() === START_NUMS && totalSqm() === START_SQM && totalPrice() === START_PRICE,
        `${numbers()} · ${totalSqm()} m²`);

  // ─── Split, then merge a cell into the stand next door ──────────────────────
  console.log('\nSplit a stand, then merge a cell into its neighbour');
  seed();
  r = await run(() => booths.split('B', { parts: 2, axis: 'vertical' }));
  check('B divides in two', r.ok && now('B').sqm + now('B-2').sqm === 9, JSON.stringify(r.reason));
  const rightCell = g(now('B-2'));
  check('the right-hand cell sits against C', near(rightCell.x + rightCell.w, 80), JSON.stringify(rightCell));

  r = await run(() => booths.consolidateMany(['B-2', 'C']));
  check('a split cell merges into the stand beside it — refused before now', r.ok, JSON.stringify(r.reason));
  const survivor = now('B-2') ? 'B-2' : 'C';
  check('the survivor is the left-hand of the two', survivor === 'B-2', survivor);
  check('and covers both exactly', sameBox(g(now('B-2')), { x: 60, y: 0, w: 60, h: 40 }), JSON.stringify(g(now('B-2'))));
  check('carrying both sizes', now('B-2').sqm === 4 + 9 || now('B-2').sqm === 5 + 9, String(now('B-2').sqm));
  check('with the hall total untouched', totalSqm() === START_SQM && totalPrice() === START_PRICE,
        `${totalSqm()} m², ${totalPrice()}`);

  r = await run(() => booths.reset('B'));
  check('the parent refuses to un-split while its cell has swallowed a neighbour',
        !r.ok && r.reason === 'child_merged', JSON.stringify(r));

  r = await run(() => booths.reset('B-2'));
  check('un-merging the cell first is allowed', r.ok && r.type === 'unmerge', JSON.stringify(r));
  check('C comes back where it was', sameBox(g(now('C')), { x: 80, y: 0, w: 40, h: 40 }) && now('C').sqm === 9);
  r = await run(() => booths.reset('B'));
  check('and now the split undoes too', r.ok && r.type === 'unsplit', JSON.stringify(r));
  check('leaving the row exactly as it began',
        numbers() === START_NUMS && totalSqm() === START_SQM && totalPrice() === START_PRICE,
        `${numbers()} · ${totalSqm()} m²`);

  // ─── Split, then put the same cells back together ───────────────────────────
  console.log('\nSplit a stand, then put its own cells back together');
  seed();
  await run(() => booths.split('A', { parts: 3, axis: 'vertical' }));
  check('A divides three ways', !!now('A-2') && !!now('A-3'));
  check('the three cells tile A', tiles({ x: 0, y: 0, w: 40, h: 40 }, [g(now('A')), g(now('A-2')), g(now('A-3'))]));
  r = await run(() => booths.consolidateMany(['A', 'A-2', 'A-3']));
  check('selecting the whole split and merging it undoes the split', r.ok && r.unsplit === true, JSON.stringify(r));
  check('so the stand gets its OWN box back, not a bounding box wearing a cell label',
        sameBox(g(now('A')), { x: 0, y: 0, w: 40, h: 40 }) && now('A').sqm === 9 && !now('A').splitSnapshot,
        JSON.stringify(g(now('A'))));
  check('and the cells are gone', !now('A-2') && !now('A-3'));
  check('with nothing added to or taken from the hall',
        numbers() === START_NUMS && totalSqm() === START_SQM && totalPrice() === START_PRICE,
        `${numbers()} · ${totalSqm()} m²`);

  // A PARTIAL selection of the same split is an ordinary merge, not an undo.
  seed();
  await run(() => booths.split('A', { parts: 3, axis: 'vertical' }));
  r = await run(() => booths.consolidateMany(['A-2', 'A-3']));
  check('merging only SOME of a split\'s cells is a plain merge', r.ok && !r.unsplit, JSON.stringify(r));
  check('the two cells become one block', !now('A-3') && now('A-2').sqm === 6, String(now('A-2') && now('A-2').sqm));
  check('and the hall total is still right', totalSqm() === START_SQM, `${totalSqm()} m²`);

  // ─── Nothing may nest ───────────────────────────────────────────────────────
  console.log('\nWhat is still refused');
  seed();
  await run(() => booths.consolidateMany(['A', 'B']));
  r = await run(() => booths.consolidateMany(['A', 'C']));
  check('a merged block may still GROW', r.ok, JSON.stringify(r.reason));
  check('and growing it twice still walks all the way back in one reset',
        await (async () => {
          // The snapshot must be EXTENDED, not replaced. Replacing it recorded
          // the block as its own original and stranded whatever it had already
          // absorbed — B would never have come back.
          seed();
          await run(() => booths.consolidateMany(['A', 'B']));
          await run(() => booths.consolidateMany(['A', 'C']));
          await run(() => booths.consolidateMany(['A', 'D']));
          if (now('A').sqm !== 36) return false;
          const r2 = await run(() => booths.reset('A'));
          return r2.ok && numbers() === START_NUMS && totalSqm() === START_SQM && totalPrice() === START_PRICE;
        })(), numbers());

  seed();
  await run(() => booths.consolidateMany(['A', 'B']));
  await run(() => booths.consolidateMany(['C', 'D']));
  r = await run(() => booths.consolidate('A', 'C'));
  check('but one merged block cannot be swallowed by another — its own merge would go with it',
        !r.ok && r.reason === 'reset_first', JSON.stringify(r));
  seed();
  await run(() => booths.split('A', { parts: 2, axis: 'vertical' }));
  r = await run(() => booths.split('A', { parts: 2, axis: 'vertical' }));
  check('a stand already split is not split again — re-carving is splitCustom\'s job',
        !r.ok && r.reason === 'reset_first', JSON.stringify(r));

  // ─── A longer chain, for the arithmetic alone ───────────────────────────────
  console.log('\nA longer chain: merge, split, merge, split');
  seed();
  await run(() => booths.consolidateMany(['A', 'B']));            // 18 m² block
  await run(() => booths.split('A', { parts: 2, axis: 'vertical' }));   // 9 + 9
  await run(() => booths.consolidateMany(['A-2', 'C']));          // cell + neighbour
  await run(() => booths.split('A-2', { parts: 3, axis: 'vertical' }));
  check('four shapings, and the hall still holds exactly what it held',
        totalSqm() === START_SQM && totalPrice() === START_PRICE,
        `${totalSqm()} m² / ${totalPrice()} across ${live().length} stands`);
  const boxes = live().map(b => g(b));
  let overlap = false;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (ox > 0.01 && oy > 0.01) overlap = true;
  }
  check('and no two stands are standing on the same floor', !overlap,
        JSON.stringify(boxes));

  // Walk the whole chain back.
  const order = ['A-2', 'A-2', 'A', 'A'];
  for (const n of order) await run(() => booths.reset(n));
  check('unwound step by step, the row comes back exactly',
        numbers() === START_NUMS && totalSqm() === START_SQM && totalPrice() === START_PRICE,
        `${numbers()} · ${totalSqm()} m²`);
  check('each stand at its original size and box',
        ['A', 'B', 'C', 'D'].every((n, i) => now(n).sqm === 9 && sameBox(g(now(n)), { x: i * 40, y: 0, w: 40, h: 40 })),
        JSON.stringify(live().map(b => [b.boothNumber, b.sqm, g(b)])));

  // ─── Merge, split, merge again on the same stand ────────────────────────────
  // Growing a block reused its old merge record, whose `self` described the
  // hall before the FIRST merge, and re-stamped it as the newest shaping. So
  // the next Reset un-merged straight through a live split: X came back on
  // top of A-2, and the hall held 36 m² of floor in 27 m² of stands.
  //   ┌────┬────┐
  //   │ A  │ X  │
  //   ├────┼────┘
  //   │ B  │
  //   └────┘
  console.log('\nMerge, split, then merge the same stand again');
  const ELL = () => [stand('A', { x: 0, y: 0, w: 40, h: 40 }, 9), stand('X', { x: 40, y: 0, w: 40, h: 40 }, 9),
                     stand('B', { x: 0, y: 40, w: 40, h: 40 }, 9)];
  db = fakeDb({ booths: ELL() });
  const ELL_SQM = 27, ELL_PRICE = 27 * RATE;
  const conserved = () => totalSqm() === ELL_SQM && totalPrice() === ELL_PRICE;
  const noOverlap = () => {
    const bs = live().map(g);
    for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i], b = bs[j];
      if (Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.01 &&
          Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.01) return false;
    }
    return true;
  };
  r = await run(() => booths.consolidateMany(['A', 'X']));
  check('A and X merge', r.ok && now('A').sqm === 18, JSON.stringify(r.reason));
  r = await run(() => booths.split('A', { parts: 2, axis: 'vertical' }));
  check('the block splits back into two cells, A-2 on X\'s floor', r.ok && sameBox(g(now('A-2')), { x: 40, y: 0, w: 40, h: 40 }));
  r = await run(() => booths.consolidateMany(['A', 'B']));
  check('the left cell merges with B below it', r.ok && now('A').sqm === 18, JSON.stringify(r.reason));
  check('the hall still holds 27 m²', conserved(), `${totalSqm()} m²`);
  const steps = [];
  for (let i = 0; i < 3; i++) {
    r = await run(() => booths.reset('A'));
    steps.push(`${r.ok ? r.type : r.reason}: ${numbers()} ${totalSqm()} m²`);
    check(`reset ${i + 1} keeps the hall at 27 m² with nothing standing on anything`,
          r.ok && conserved() && noOverlap(), steps[i]);
  }
  check('undone newest first: the second merge, then the split, then the first merge',
        steps.map(s => s.split(':')[0]).join(',') === 'unmerge,unsplit,unmerge', steps.join(' | '));
  check('and the three stands are back exactly as they started',
        numbers() === 'A,B,X' && sameBox(g(now('A')), { x: 0, y: 0, w: 40, h: 40 }) &&
        sameBox(g(now('X')), { x: 40, y: 0, w: 40, h: 40 }) && sameBox(g(now('B')), { x: 0, y: 40, w: 40, h: 40 }),
        JSON.stringify(live().map(b => [b.boothNumber, g(b)])));

  // A record the old code already wrote — the pre-merge stands under a later
  // split — is refused rather than walked through.
  db = fakeDb({ booths: ELL() });
  await run(() => booths.consolidateMany(['A', 'X']));
  await run(() => booths.split('A', { parts: 2, axis: 'vertical' }));
  await run(() => booths.consolidateMany(['A', 'B']));
  const tangled = now('A');
  tangled.mergeSnapshot = { self: { geometry: { x: 0, y: 0, w: 40, h: 40 }, sqm: 9, listPrice: 9 * RATE },
                            parts: [{ ...stand('X', { x: 40, y: 0, w: 40, h: 40 }, 9) },
                                    { ...stand('B', { x: 0, y: 40, w: 40, h: 40 }, 9) }],
                            at: new Date(Date.now() + 1000) };
  r = await run(() => booths.reset('A'));
  check('a stored record that would put X back over A-2 is refused, not applied',
        !r.ok && r.reason === 'overlap' && r.part === 'X' && r.with === 'A-2', JSON.stringify(r));
  check('and the hall is left as it was', conserved() && !now('X'), `${numbers()} ${totalSqm()} m²`);

  // ─── Two admins at once ─────────────────────────────────────────────────────
  console.log('\nTwo merges into the same block at the same moment');
  // A+B and A+C, both read before either writes. The second used to overwrite
  // the first's record: C deleted, in no record, and Reset unable to bring it.
  db = fakeDb({ booths: ELL().map(s => s.boothNumber === 'X' ? { ...s, boothNumber: 'C' } : s) });
  const [m1, m2] = await run(() => Promise.all([booths.consolidate('A', 'C'), booths.consolidate('A', 'B')]));
  check('exactly one of them lands', [m1, m2].filter(x => x.ok).length === 1, JSON.stringify([m1.reason, m2.reason]));
  check('the other says the stand changed, and does nothing', [m1, m2].some(x => !x.ok && x.reason === 'changed'));
  check('every square metre is still on the plan', conserved(), `${numbers()} ${totalSqm()} m²`);
  r = await run(() => booths.reset('A'));
  check('and one reset gives back all three stands', r.ok && numbers() === 'A,B,C' && conserved(), `${numbers()} ${totalSqm()} m²`);

  console.log('\nTwo splits of the same stand at the same moment');
  seed();
  const [s1, s2] = await run(() => Promise.all([booths.split('A', { parts: 2, axis: 'vertical' }),
                                                 booths.split('A', { parts: 3, axis: 'vertical' })]));
  check('one split lands and the other is refused', [s1, s2].filter(x => x.ok).length === 1,
        JSON.stringify([s1.reason, s2.reason]));
  check('no cell exists twice and nothing is half-split',
        new Set(live().map(b => b.boothNumber)).size === live().length && totalSqm() === START_SQM,
        `${numbers()} ${totalSqm()} m²`);

  console.log('\nA rate change racing a merge');
  // The repricing reads every stand, then writes every stand — and a merge in
  // between used to have its record written back from before it.
  seed();
  const plain = db;
  let raced = false;
  db = { ...plain, collection: (name) => {
    const c = plain.collection(name);
    if (name !== 'booths') return c;
    return { ...c, bulkWrite: async (ops) => {
      if (!raced) { raced = true; await booths.consolidate('A', 'B'); }
      return c.bulkWrite(ops);
    } };
  } };
  await run(() => booths.recomputeListPrices(700));
  db = plain;
  check('the merge in the middle happened', raced && now('A').sqm === 18 && !now('B'));
  check('the block is priced at the new rate for its whole size', now('A').listPrice === 18 * 700, String(now('A').listPrice));
  check('and its record still holds B, repriced', (now('A').mergeSnapshot.parts || []).length === 1 &&
        now('A').mergeSnapshot.parts[0].listPrice === 9 * 700, JSON.stringify(now('A').mergeSnapshot.parts));
  r = await run(() => booths.reset('A'));
  check('so a reset brings B back, at the new rate', r.ok && now('B') && now('B').listPrice === 9 * 700);

  console.log('\nA merge that fails half-way puts the block back as it was');
  seed();
  await run(() => booths.consolidateMany(['A', 'B']));
  const intact = db;
  db = { ...intact, collection: (name) => {
    const c = intact.collection(name);
    if (name !== 'booths') return c;
    // C is booked in the instant between the block growing and C being absorbed.
    return { ...c, deleteOne: async (f) => {
      if (f.boothNumber === 'C') { const d = intact.store.booths.find(b => b.boothNumber === 'C'); d.status = 'sold'; d.assignment.company = 'Fast Co'; }
      return c.deleteOne(f);
    } };
  } };
  r = await run(() => booths.consolidate('A', 'C'));
  db = intact;
  check('the merge is refused', !r.ok && r.reason === 'not_available', JSON.stringify(r));
  check('the block is its old size again', now('A').sqm === 18 && sameBox(g(now('A')), { x: 0, y: 0, w: 80, h: 40 }));
  check('and its record is the one it had — B alone, not B and the stand that got away',
        (now('A').mergeSnapshot.parts || []).map(p => p.boothNumber).join(',') === 'B',
        JSON.stringify((now('A').mergeSnapshot.parts || []).map(p => p.boothNumber)));
  check('the booking stands', now('C').status === 'sold' && now('C').assignment.company === 'Fast Co');

  // ─── Reset on a split cell ──────────────────────────────────────────────────
  console.log('\nReset asked of a split cell');
  seed();
  await run(() => booths.split('A', { parts: 2, axis: 'vertical' }));
  r = await run(() => booths.reset('A-2'));
  check('it undoes the split the cell belongs to, rather than deleting the cell',
        r.ok && r.type === 'unsplit' && r.parent === 'A', JSON.stringify(r));
  check('so A is whole and the hall keeps its floor', !now('A-2') && now('A').sqm === 9 &&
        sameBox(g(now('A')), { x: 0, y: 0, w: 40, h: 40 }) && totalSqm() === START_SQM, `${numbers()} ${totalSqm()} m²`);

  // A's left cell, with a stand of its own width beneath it to merge with.
  db = fakeDb({ booths: [stand('A', { x: 0, y: 0, w: 40, h: 40 }, 8), stand('L', { x: 0, y: 40, w: 20, h: 40 }, 4)] });
  await run(() => booths.split('A', { parts: 2, axis: 'vertical' }));
  r = await run(() => booths.consolidateMany(['A', 'L']));    // a merge laid over the split
  check('(the left cell merges with the stand beneath it)', r.ok, JSON.stringify(r.reason));
  r = await run(() => booths.reset('A-2'));
  check('with a merge laid over that split, it names the parent instead', !r.ok && r.reason === 'cell_of' && r.parent === 'A',
        JSON.stringify(r));
  check('and deletes nothing', !!now('A-2') && totalSqm() === 12, `${numbers()} ${totalSqm()} m²`);

  db = fakeDb({ booths: [stand('P', { x: 0, y: 0, w: 40, h: 40 }, 9),
                         { ...stand('P-2', { x: 20, y: 0, w: 20, h: 40 }, 4), splitFrom: 'P' }] });
  r = await run(() => booths.reset('P-2'));
  check('a true leftover — unlisted, on floor its parent already covers — is cleared',
        r.ok && r.type === 'remove-cell' && !now('P-2'), JSON.stringify(r));
  db = fakeDb({ booths: [{ ...stand('Q-2', { x: 0, y: 0, w: 20, h: 40 }, 4), splitFrom: 'Q' }] });
  r = await run(() => booths.reset('Q-2'));
  check('but a cell whose parent is gone is the only record of its floor, and stays',
        !r.ok && r.reason === 'orphan_cell' && !!now('Q-2'), JSON.stringify(r));

  // ─── Arithmetic that adds up ────────────────────────────────────────────────
  console.log('\nSplits that add back to the stand, to the hundredth');
  db = fakeDb({ booths: [{ ...stand('H', { x: 0, y: 0, w: 50, h: 40 }, 12.5), listPrice: 8250 }] });
  r = await run(() => booths.split('H', { parts: 2, axis: 'vertical' }));
  // Shared at the precision the stand is stored to, exactly as 9 m² splits
  // 5 + 4: the tenth left over goes to the first cell.
  check('12.5 m² in two is 6.3 + 6.2, not 7 + 6 = 13', r.ok && now('H').sqm === 6.3 && now('H-2').sqm === 6.2,
        JSON.stringify(r.sizes || r.reason));
  check('and the price halves exactly', now('H').listPrice + now('H-2').listPrice === 8250);
  db = fakeDb({ booths: [{ ...stand('T', { x: 0, y: 0, w: 60, h: 40 }, 12.3), listPrice: 1001 }] });
  r = await run(() => booths.split('T', { parts: 3, axis: 'vertical' }));
  const tSqm = ['T', 'T-2', 'T-3'].map(n => now(n).sqm);
  check('12.3 m² in three is 4.1 each, not 13 in all', r.ok && tSqm.every(s => s === 4.1) &&
        Math.round(tSqm.reduce((s, v) => s + v, 0) * 100) / 100 === 12.3, JSON.stringify(tSqm));
  check('and €1,001 in thirds is still €1,001',
        ['T', 'T-2', 'T-3'].reduce((s, n) => s + now(n).listPrice, 0) === 1001,
        JSON.stringify(['T', 'T-2', 'T-3'].map(n => now(n).listPrice)));

  db = fakeDb({ booths: [{ ...stand('K', { x: 0, y: 0, w: 60, h: 40 }, 30), listPrice: 1001 }] });
  r = await run(() => booths.splitCustom('K', { axis: 'vertical', parts: [{ number: 'K1', sqm: 15 }, { number: 'K2', sqm: 16 }] }));
  check('a custom split that adds up to 31 of 30 m² is refused', !r.ok && r.reason === 'size_mismatch', JSON.stringify(r));
  r = await run(() => booths.splitCustom('K', { axis: 'vertical',
    parts: [{ number: 'K1', sqm: 10 }, { number: 'K2', sqm: 10 }, { number: 'K3', sqm: 10 }] }));
  check('one that adds up is carved', r.ok, JSON.stringify(r.reason));
  check('and its prices add back to the stand\'s €1,001',
        ['K', 'K-2', 'K-3'].reduce((s, n) => s + now(n).listPrice, 0) === 1001,
        JSON.stringify(['K', 'K-2', 'K-3'].map(n => now(n).listPrice)));
  db = fakeDb({ booths: [{ ...stand('D5', { x: 0, y: 0, w: 50, h: 40 }, 12.5), listPrice: 8250 }] });
  r = await run(() => booths.splitCustom('D5', { axis: 'vertical', parts: [{ number: 'D5a', sqm: 6 }, { number: 'D5b', sqm: 6.5 }] }));
  check('a decimal stand can be carved to the half metre', r.ok && now('D5').sqm + now('D5-2').sqm === 12.5, JSON.stringify(r.reason));

  // ─── A custom split whose cell takes the parent's old shown number ──────────
  console.log('\nResetting a custom split whose cell reuses the parent\'s shown number');
  // The real database holds shown numbers unique; this stand-in is made to as
  // well, because the failure is the unique index refusing a write.
  const unique = (base) => ({ ...base, collection: (name) => {
    const c = base.collection(name);
    if (name !== 'booths') return c;
    const taken = (key, except) => base.store.booths.some(b => b.displayNumberKey === key && b !== except);
    const dup = () => Object.assign(new Error('E11000 duplicate key error index: show_shown_number_unique'), { code: 11000 });
    return { ...c,
      insertOne: async (d) => { if (d.displayNumberKey && taken(d.displayNumberKey)) throw dup(); return c.insertOne(d); },
      updateOne: async (f, u, o) => {
        const key = u && u.$set && u.$set.displayNumberKey;
        const target = (await c.find(f).toArray())[0];
        if (key && target && taken(key, target)) throw dup();
        return c.updateOne(f, u, o);
      } };
  } });
  db = unique(fakeDb({ booths: [{ ...stand('500', { x: 0, y: 0, w: 60, h: 40 }, 18), displayNumber: 'A1', displayNumberKey: 'a1' }] }));
  r = await run(() => booths.splitCustom('500', { axis: 'vertical', parts: [{ number: 'A1b', sqm: 9 }, { number: 'A1', sqm: 9 }] }));
  check('the cell may take the number the parent showed', r.ok && now('500-2').displayNumber === 'A1', JSON.stringify(r.reason));
  let threw = null;
  try { r = await run(() => booths.reset('500')); } catch (e) { threw = e.message; }
  check('and the reset succeeds on a database that holds shown numbers unique', !threw && r.ok, threw || JSON.stringify(r));
  check('putting the parent back under its own number', now('500').displayNumber === 'A1' &&
        now('500').displayNumberKey === 'a1' && !now('500-2') && now('500').sqm === 18,
        JSON.stringify(now('500') && [now('500').displayNumber, now('500').displayNumberKey]));

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
