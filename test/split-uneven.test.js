/**
 * The uneven two-way split behind the admin's draggable divider.
 *
 * One divider makes exactly two stands. The first keeps `firstSqm` (whole m²),
 * the second takes the rest, the price follows pro rata, and the footprint is
 * cut in the same proportion — so the line lands on the plan where it was
 * dragged. Anything that would empty a side, or ask for three parts, is refused
 * before anything is written.
 */
const path = require('path');

// Stand in for Mongo: one show, a handful of stands, writes recorded.
const docs = [];
const writes = [];
const fake = {
  collection: () => ({
    findOne: async (f) => docs.find(d => d.boothNumber === f.boothNumber && (!f.showId || d.showId === f.showId)) || null,
    find: () => ({ toArray: async () => docs.slice() }),
    updateOne: async (f, u) => {
      const d = docs.find(x => x.boothNumber === f.boothNumber && (!f.status || x.status === f.status));
      writes.push(['update', f, u]);
      if (!d) return { matchedCount: 0 };
      Object.assign(d, u.$set || {});
      return { matchedCount: 1 };
    },
    insertOne: async (d) => { writes.push(['insert', d]); docs.push(d); },
  }),
};
require.cache[require.resolve('../server/db')] = { id: 'db', filename: 'db', loaded: true, exports: { getDb: () => fake, connect: async () => {}, close: async () => {} } };
const booths = require('../server/models/booths');
const config = require('../server/config');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const reset = () => {
  docs.length = 0; writes.length = 0;
  docs.push({ showId: config.showId, boothNumber: '700', status: 'available', sqm: 100, listPrice: 10000,
              geometry: { x: 10, y: 20, w: 80, h: 40 }, assignment: { company: null } });
};

(async () => {
  reset();
  let r = await booths.split('700', { parts: 2, axis: 'vertical', firstSqm: 30 });
  check('30/70 left-right split succeeds', r.ok, JSON.stringify(r));
  check('reports the two sizes', JSON.stringify(r.sizes) === '[30,70]', JSON.stringify(r.sizes));
  const a = docs.find(d => d.boothNumber === '700'), b = docs.find(d => d.boothNumber === '700-2');
  check('first keeps 30 m², second gets 70', a.sqm === 30 && b && b.sqm === 70, `${a.sqm} / ${b && b.sqm}`);
  check('price follows pro rata and still sums', a.listPrice === 3000 && b.listPrice === 7000, `${a.listPrice} / ${b.listPrice}`);
  check('footprint cut at 30% of the width', Math.abs(a.geometry.w - 24) < 1e-9 && Math.abs(b.geometry.x - 34) < 1e-9 && Math.abs(b.geometry.w - 56) < 1e-9,
        JSON.stringify([a.geometry, b.geometry]));
  check('both cells keep the full height', a.geometry.h === 40 && b.geometry.h === 40);
  check('snapshot restores the whole stand', a.splitSnapshot && a.splitSnapshot.self.sqm === 100 && a.splitSnapshot.self.geometry.w === 80);

  reset();
  r = await booths.split('700', { parts: 2, axis: 'horizontal', firstSqm: 75 });
  const a2 = docs.find(d => d.boothNumber === '700'), b2 = docs.find(d => d.boothNumber === '700-2');
  check('75/25 top-bottom cuts the height', r.ok && a2.geometry.h === 30 && b2.geometry.y === 50 && b2.geometry.h === 10 && b2.geometry.w === 80,
        JSON.stringify([a2.geometry, b2 && b2.geometry]));

  reset();
  r = await booths.split('700', { parts: 2, axis: 'vertical', firstSqm: 100 });
  check('a side of 0 m² is refused', !r.ok && r.reason === 'bad_ratio', JSON.stringify(r));
  r = await booths.split('700', { parts: 2, axis: 'vertical', firstSqm: 0 });
  check('a first cell of 0 m² is refused', !r.ok && r.reason === 'bad_ratio', JSON.stringify(r));
  r = await booths.split('700', { parts: 2, axis: 'vertical', firstSqm: 'abc' });
  check('a non-numeric size is refused', !r.ok && r.reason === 'bad_ratio', JSON.stringify(r));
  r = await booths.split('700', { parts: 3, axis: 'vertical', firstSqm: 30 });
  check('an uneven split of three is refused', !r.ok && r.reason === 'uneven_needs_two', JSON.stringify(r));
  check('a refused split writes nothing', writes.length === 0, `${writes.length} writes`);

  reset();
  r = await booths.split('700', { parts: 2, axis: 'vertical' });
  check('without firstSqm the split is still equal', r.ok && JSON.stringify(r.sizes) === '[50,50]', JSON.stringify(r));

  reset();
  docs[0].status = 'held';
  r = await booths.split('700', { parts: 2, axis: 'vertical', firstSqm: 30 });
  check('a held stand cannot be split unevenly either', !r.ok && r.reason === 'not_available', JSON.stringify(r));

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
