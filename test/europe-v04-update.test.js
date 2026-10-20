/**
 * Europe's next upload, rehearsed on a hall shaped like Europe's.
 *
 * On 13 Oct 2026 the v02 drawing went live over the hall Europe had been
 * seeded with (265 stands, no import mark on any of them). The update kept
 * ten empty placeholders the drawing no longer had — P014 to P150 — because
 * only an import's own empty stands were removed, and it created an available
 * 825 on the floor of 926-2, sold to Setral and renumbered 825 by hand. Every
 * one of those sat over a real stand on the public map, clickable.
 *
 * This runs the corrected drawing (v04: 1249 the strip above, 1247 the square
 * below it, the stray 857 gone) over that state and asserts what the
 * update removes, what it keeps, and that the check shown beforehand says the
 * same. The fixtures are the files themselves.
 */
const fs = require('fs');
const path = require('path');
const { fakeDb } = require('./fake-mongo');

const dbPath = require.resolve('../server/db');
let db;
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => db } };

const config = require('../server/config');
const showContext = require('../server/show-context');
const booths = require('../server/models/booths');
const { extractStands } = require('../server/lib/extract-stands');
const { diffStands } = require('../server/lib/plan-diff');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const SHOW = config.defaultShow;
const run = (fn) => showContext.runAs(SHOW, fn);
const now = (n) => db.store.booths.find(b => b.boothNumber === n);
const EMPTY = () => ({ company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null });

// The hall as seeded: the shipped stand list, no import mark on any row.
const seeded = () => Object.values(require('../server/data/booth_data.json')).map(b => ({
  showId: SHOW, boothNumber: b.boothId.replace('booth-', ''), status: 'available',
  sqm: b.sqm, sqmSource: 'printed', listPrice: b.price, geometry: { x: b.x, y: b.y, w: b.w, h: b.h },
  assignment: EMPTY(), clicks: 0, createdAt: new Date(), updatedAt: new Date(),
}));
const read = (f) => extractStands(fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8')).stands.filter(s => !s.sponsored);

const PLACEHOLDERS = ['P014', 'P046', 'P076', 'P095', 'P096', 'P098', 'P126', 'P139', 'P150'];

(async () => {
  db = fakeDb({ booths: seeded(), holds: [], booths_snapshots: [], settings: [{ _id: SHOW, ratePerSqm: 660 }] });

  console.log('\nThe hall before v02: what Sales and Operations had done to it');
  await run(() => booths.split('926', { parts: 2, actor: 'sales' }));
  await run(() => booths.setStatus('926-2', 'sold', { company: 'Setral Specialty Lubricants', actor: 'sales', expect: ['available'] }));
  let r = await run(() => booths.setDisplayNumber('926-2', '825', { actor: 'sales' }));
  check('926-2 is sold to Setral and shows as 825', r.ok && now('926-2').status === 'sold' && now('926-2').displayNumber === '825');
  for (const n of ['761', '771', '1051']) {
    await run(() => booths.setStatus(n, 'held', { company: 'Unavailable', actor: 'ops', expect: ['available'] }));
    db.store.holds.push({ showId: SHOW, boothNumber: n, company: 'Unavailable', source: null });
  }
  check('761, 771 and 1051 are held as Unavailable by a person', ['761', '771', '1051'].every(n => now(n).status === 'held'));

  console.log('\nv02 goes live with bookings kept, as it did on 13 Oct');
  r = await run(() => booths.importFromArtwork(read('LEX27_Floorplan_v02.svg'), { actor: 'chris', keep: true }));
  check('it lands', r.ok, JSON.stringify(r.reason));
  check('825 is read as Setral\'s renumbered stand, not created', !now('825') && (r.renumbered || []).some(x => x.boothNumber === '825' && x.stand === '926-2'),
        JSON.stringify(r.renumbered));
  check('the placeholders the drawing no longer has are removed', PLACEHOLDERS.every(n => !now(n) && r.removed.includes(n)), JSON.stringify(r.removed));
  check('751, empty and seeded, goes with them', !now('751') && r.removed.includes('751'));
  check('the three Unavailable holds are kept and reported', ['761', '771', '1051'].every(n => now(n) && now(n).status === 'held' && r.kept.some(k => k.boothNumber === n)),
        JSON.stringify(r.kept.map(k => k.boothNumber)));

  // The live hall is not that, though: the update that ran had neither fix.
  // Put it in the state the site is actually in.
  console.log('\nThe hall as the live site has it: the placeholders still there, a second 825 on Setral\'s floor');
  for (const b of seeded()) if (PLACEHOLDERS.includes(b.boothNumber) || b.boothNumber === '751') db.store.booths.push(b);
  db.store.booths.push({ showId: SHOW, boothNumber: '825', status: 'available', source: booths.IMPORT_SOURCE, svgElementId: 'booth-825',
    geometry: { x: 603.14, y: 1135.56, w: 54.19, h: 54.19 }, sqm: 18, sqmSource: 'printed', listPrice: 11880,
    assignment: EMPTY(), clicks: 0, createdAt: new Date(), updatedAt: new Date(), updatedBy: 'import', importedBy: 'chris' });
  const before = db.store.booths.length;

  console.log('\nThe check before v04 goes live');
  const v04 = read('LEX27_Floorplan_v04.svg');
  const d = diffStands(v04, db.store.booths);
  check('825 is listed as Setral\'s, with the empty 825 going', d.renumbered.some(x => x.boothNumber === '825' && x.stand === '926-2' && x.over === '825'),
        JSON.stringify(d.renumbered));
  check('the empty 825 and the placeholders are among what the drawing drops, none of them flagged as booked',
        ['825', '751', ...PLACEHOLDERS].every(n => d.missing.some(m => m.boothNumber === n && !m.committed)),
        d.missing.filter(m => !m.committed).map(m => m.boothNumber).join(' '));
  check('the Unavailable holds are flagged as kept', ['761', '771', '1051'].every(n => d.missing.some(m => m.boothNumber === n && m.committed)));
  check('1249 is listed as resized from the guessed 17 to the 8 m² strip', d.resized.some(x => x.boothNumber === '1249' && x.to === 8),
        JSON.stringify(d.resized.filter(x => x.boothNumber === '1249')));
  check('1247, the square below it, is the one new stand', d.added.length === 1 && d.added[0].boothNumber === '1247' && d.added[0].area === 9,
        JSON.stringify(d.added));

  console.log('\nv04 goes live with bookings kept');
  r = await run(() => booths.importFromArtwork(v04, { actor: 'chris', keep: true }));
  check('it lands', r.ok, JSON.stringify(r.reason));
  const expected = ['825', '751', ...PLACEHOLDERS].sort();
  check('exactly the eleven leftover stands are removed', JSON.stringify([...r.removed].sort()) === JSON.stringify(expected), JSON.stringify(r.removed));
  check('and are gone from the hall', expected.every(n => !now(n)));
  check('Setral keeps 825', now('926-2').status === 'sold' && now('926-2').displayNumber === '825' && now('926-2').assignment.company === 'Setral Specialty Lubricants');
  check('926, the other half, is untouched', now('926') && now('926').splitSnapshot && now('926').sqm === 16);
  check('the Unavailable holds stand', ['761', '771', '1051'].every(n => now(n).status === 'held'));
  check('1249 is 8 m² at the matching price', now('1249').sqm === 8 && now('1249').listPrice === 8 * 660, `${now('1249').sqm} m², ${now('1249').listPrice}`);
  check('1247 is a new 9 m² stand, for sale', now('1247') && now('1247').sqm === 9 && now('1247').status === 'available' && r.created === 1,
        JSON.stringify(now('1247') && { sqm: now('1247').sqm, status: now('1247').status, created: r.created }));
  check('eleven stands gone, one new, and no more', db.store.booths.length === before - 10, `${before} → ${db.store.booths.length}`);
  check('a snapshot was taken first', r.snapshot === true && db.store.booths_snapshots.some(s => s.header === true));

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
