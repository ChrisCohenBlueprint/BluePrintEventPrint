/**
 * Merging and splitting judged where a stand IS, not as its rectangle is written.
 *
 * Europe's artwork rotates whole rows of stands (Illustrator's translate +
 * rotate(90)), and a stand's stored geometry is the written box, because that
 * is what the page binds by. 651 and 653 are drawn flush side by side, and 649
 * spans beneath them; read as written, 653 sits 6 units away and 14 taller, so
 * every merge among them was refused. These run against the real Europe plan
 * with the seed's own geometry for those stands.
 */
const path = require('path');
const docs = [];
const clone = (d) => JSON.parse(JSON.stringify(d));
const match = (d, f) => Object.entries(f).every(([k, v]) => k === 'showId' || k === '$or'
  || (v && typeof v === 'object' && v.$in ? v.$in.includes(d[k]) : v && typeof v === 'object' && v.$nin ? !v.$nin.includes(d[k]) : d[k] === v));
const fake = { collection: (name) => name !== 'booths'
  ? { findOne: async () => null, updateOne: async () => ({}), insertOne: async () => ({}) }   // no stored artwork → the shipped Europe plan
  : {
    findOne: async (f) => docs.find(d => match(d, f) && (!f.$or || f.$or.some(o => match(d, o)))) || null,
    find: (f) => ({ toArray: async () => docs.filter(d => match(d, f || {})) }),
    updateOne: async (f, u) => { const d = docs.find(d => match(d, f)); if (!d) return { matchedCount: 0 }; Object.assign(d, u.$set || {}); Object.keys(u.$unset || {}).forEach(k => delete d[k]); return { matchedCount: 1 }; },
    insertOne: async (d) => { docs.push(clone(d)); },
    deleteOne: async (f) => { const i = docs.findIndex(d => match(d, f)); if (i > -1) docs.splice(i, 1); return { deletedCount: i > -1 ? 1 : 0 }; },
  } };
require.cache[require.resolve('../server/db')] = { id: 'db', filename: 'db', loaded: true, exports: { getDb: () => fake, connect: async () => {}, close: async () => {} } };
const booths = require('../server/models/booths');
const config = require('../server/config');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const near = (a, b, t = 0.05) => Math.abs(a - b) < t;
const sameBox = (a, b) => a && b && near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h);
const stand = (n, g, sqm) => ({ showId: config.showId, boothNumber: n, status: 'available', sqm, listPrice: sqm * 660, geometry: g, assignment: { company: null } });
// As the seed stores them: the written boxes of rotated rectangles.
const SEED = {
  651: { x: 925.46, y: 556.85, w: 40.66, h: 40.22 },
  653: { x: 972.65, y: 550.07, w: 40.66, h: 54.03 },
  649: { x: 945.94, y: 577.10, w: 53.86, h: 94.22 },
  752: { x: 844.99, y: 556.85, w: 40.66, h: 40.22 },
  750: { x: 858.47, y: 584.00, w: 53.86, h: 80.43 },
};
const seedAll = () => { docs.length = 0; docs.push(stand('651', SEED[651], 9), stand('653', SEED[653], 12), stand('649', SEED[649], 28), stand('752', SEED[752], 9), stand('750', SEED[750], 24)); };
const by = (n) => docs.find(d => d.boothNumber === n);

(async () => {
  // A T-shaped tiling of plain, unrotated stands — refused before by the pairwise rule.
  docs.length = 0;
  docs.push(stand('A', { x: 0, y: 0, w: 40, h: 40 }, 9), stand('B', { x: 40, y: 0, w: 40, h: 40 }, 9), stand('C', { x: 0, y: 40, w: 80, h: 60 }, 28));
  let r = await booths.consolidateMany(['A', 'B', 'C']);
  check('two stands over one wide stand merge as a block', r.ok, JSON.stringify(r.reason));
  check('the block is the tiled rectangle', sameBox(by('A').geometry, { x: 0, y: 0, w: 80, h: 100 }), JSON.stringify(by('A').geometry));
  docs.length = 0;
  docs.push(stand('A', { x: 0, y: 0, w: 40, h: 40 }, 9), stand('B', { x: 40, y: 0, w: 40, h: 40 }, 9), stand('C', { x: 0, y: 40, w: 40, h: 40 }, 9));
  r = await booths.consolidateMany(['A', 'B', 'C']);
  check('an L-shape is still refused', !r.ok && r.reason === 'not_contiguous', JSON.stringify(r));
  docs.length = 0;
  docs.push(stand('A', { x: 0, y: 0, w: 40, h: 40 }, 9), stand('B', { x: 60, y: 0, w: 40, h: 40 }, 9));
  r = await booths.consolidateMany(['A', 'B']);
  check('stands across an aisle are still refused', !r.ok, JSON.stringify(r));

  // The screenshots: 651 + 653, then 651 + 653 + 649, on the real Europe plan.
  seedAll();
  r = await booths.consolidateMany(['651', '653']);
  check('651 and 653 (rotated, drawn flush) merge', r.ok, JSON.stringify(r.reason));
  check('the merged block sits where the two stands appear', r.ok && sameBox(by('651').geometry, { x: 925.68, y: 556.62, w: 94.32, h: 40.79 }, 0.5), JSON.stringify(by('651') && by('651').geometry));
  check('sizes add up', by('651').sqm === 21);
  r = await booths.reset('651');
  check('reset restores 651 exactly as written', r.ok && sameBox(by('651').geometry, SEED[651]) && by('653') && sameBox(by('653').geometry, SEED[653]), JSON.stringify(r));

  seedAll();
  r = await booths.consolidateMany(['651', '653', '649']);
  check('651, 653 and 649 merge as one block', r.ok, JSON.stringify(r.reason));
  check('that block covers the three footprints', r.ok && sameBox(by('651').geometry, { x: 925.68, y: 556.62, w: 94.32, h: 94.52 }, 0.6), JSON.stringify(by('651') && by('651').geometry));
  check('649 and 653 were absorbed', !by('649') && !by('653'));
  r = await booths.reset('651');
  check('reset brings all three back as written', r.ok && sameBox(by('649').geometry, SEED[649]) && sameBox(by('653').geometry, SEED[653]), JSON.stringify(r));

  seedAll();
  r = await booths.consolidate('651', '653');
  check('the two-way tool merges 651 and 653 too', r.ok, JSON.stringify(r.reason));
  seedAll();
  r = await booths.consolidateMany(['651', '752']);
  check('651 and 752, two stands apart, are refused', !r.ok, JSON.stringify(r));

  // Splitting a rotated stand carves where it appears; reset puts the written box back.
  seedAll();
  r = await booths.split('653', { parts: 2, axis: 'vertical', firstSqm: 4 });
  check('a rotated stand splits', r.ok, JSON.stringify(r.reason));
  const c1 = by('653').geometry, c2 = by('653-2').geometry;
  check('its cells tile the footprint, not the written box', near(c1.x, 965.97) && near(c1.y, 556.75) && near(c1.w + c2.w, 54.03) && near(c1.h, 40.66), JSON.stringify([c1, c2]));
  r = await booths.reset('653');
  check('reset restores the written box', r.ok && sameBox(by('653').geometry, SEED[653]) && !by('653-2'), JSON.stringify(r));

  seedAll();
  r = await booths.splitCustom('649', { axis: 'horizontal', parts: [{ number: '649a', sqm: 14 }, { number: '649b', sqm: 14 }] });
  check('a custom split of a rotated stand carves the footprint', r.ok && near(by('649').geometry.w, 94.22) && near(by('649').geometry.y, 597.28), JSON.stringify(r.reason || by('649').geometry));
  r = await booths.reset('649');
  check('and its reset restores the written box', r.ok && sameBox(by('649').geometry, SEED[649]), JSON.stringify(r));

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
