/**
 * A plan's lounges and theatres keep their sponsors when a new drawing goes
 * live.
 *
 * Europe, 13 Oct 2026. Its areas were the shipped catalogue — Networking
 * Lounge (West), (East), Conference Track 1 and 2 — and Shell sponsored one.
 * The re-issued plan prints NETWORKING LOUNGE on three shapes and CONFERENCE
 * on two, and the import keyed areas by printed name: the second and third of
 * each were dropped (unclickable), and every area got a new key, so Shell's
 * sponsorship, stored on the old key, stopped being shown.
 */
const { fakeDb } = require('./fake-mongo');

const dbPath = require.resolve('../server/db');
let db;
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => db } };

const config = require('../server/config');
const showContext = require('../server/show-context');
const planAreas = require('../server/models/plan-areas');
const catalogue = require('../server/data/plan-areas');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const EUROPE = config.defaultShow;
const run = (fn) => showContext.runAs(EUROPE, fn);
const geo = (k) => catalogue.get(k).geometry;

// What the extractor reads off LEX27_Floorplan_v02.svg: every shipped area in
// its old place, under the plan's own words, plus a new lounge top left.
const V02 = [
  { number: '1164', exhibitor: 'NETWORKING LOUNGE', geometry: { x: 373.8, y: 327.99, w: 121.18, h: 107.72 } },
  { number: '270',  exhibitor: 'CONFERENCE',        geometry: geo('conference-track-2') },
  { number: '642',  exhibitor: null,                geometry: geo('discovery-theatre') },
  { number: '320',  exhibitor: 'NETWORKING LOUNGE', geometry: geo('networking-lounge-east') },
  { number: '1200', exhibitor: 'CONFERENCE',        geometry: geo('conference-track-1') },
  { number: '1201', exhibitor: 'SPEAKER PREP',      geometry: geo('speaker-prep') },
  { number: '1120', exhibitor: 'NETWORKING LOUNGE', geometry: geo('networking-lounge-west') },
  { number: '841',  exhibitor: 'VIP',               geometry: geo('vip-lounge') },
].map(a => ({ ...a, sponsored: true, status: 'sold' }));

(async () => {
  console.log('\nEvery area the plan draws is stored, and the sponsored one keeps its sponsor');
  db = fakeDb({ planAreas: [] });
  await run(() => planAreas.setSponsor('networking-lounge-west', { sponsor: 'Shell', status: 'taken' }, { actor: 'chris' }));
  const r = await run(() => planAreas.replaceFromArtwork(V02, { actor: 'chris' }));
  const areas = await run(() => planAreas.all());
  check('all eight are listed', areas.length === 8, areas.map(a => a.key).join(', '));
  check('all three lounges', areas.filter(a => /lounge/i.test(a.label) && !/vip/i.test(a.label)).length === 3,
        areas.map(a => a.label).join(', '));
  const west = areas.find(a => a.key === 'networking-lounge-west');
  check('the West lounge keeps its key and Shell', west && west.sponsor === 'Shell' && west.status === 'taken',
        JSON.stringify(west));
  check('and its name tells it apart', west && west.label === 'Networking Lounge (West)', west && west.label);
  check('the theatre is the Discovery Theatre, not "Area 642"',
        areas.some(a => a.key === 'discovery-theatre' && a.label === 'Discovery Theatre'));
  check('the new lounge gets a key of its own', areas.some(a => a.key === 'networking-lounge'), r.keys.join(', '));

  console.log('\nA hall already imported under the old keying is put right by reading it again');
  db = fakeDb({ planAreas: [] });
  await run(() => planAreas.setSponsor('networking-lounge-west', { sponsor: 'Shell', status: 'taken' }, { actor: 'chris' }));
  // What the first import wrote: five rows keyed by printed name.
  const first = new Set();
  for (const a of V02) {
    const key = a.exhibitor ? a.exhibitor.toLowerCase().replace(/[^a-z0-9]+/g, '-') : `area-${a.number}`;
    if (first.has(key)) continue;
    first.add(key);
    db.store.planAreas.push({ showId: EUROPE, key, geometry: a.geometry, artworkLabel: a.exhibitor || `Area ${a.number}`, fromArtwork: true });
  }
  await run(() => planAreas.replaceFromArtwork(V02, { actor: 'chris' }));
  const again = await run(() => planAreas.all());
  check('eight areas again', again.length === 8, again.map(a => a.key).join(', '));
  check('Shell is back on the West lounge', again.some(a => a.key === 'networking-lounge-west' && a.sponsor === 'Shell'));
  check('one area per shape', new Set(again.map(a => JSON.stringify(a.geometry))).size === 8);

  // The live site after the fix deployed: the rows were still the old reading,
  // and nobody re-imports a plan to mend a lounge. Boot does it.
  console.log('\nAt boot, an event\'s areas are brought into line with the plan it shows');
  db = fakeDb({ planAreas: [] });
  await run(() => planAreas.setSponsor('networking-lounge-west', { sponsor: 'Shell', status: 'taken' }, { actor: 'chris' }));
  for (const a of V02) {
    const key = a.exhibitor ? a.exhibitor.toLowerCase().replace(/[^a-z0-9]+/g, '-') : `area-${a.number}`;
    if (db.store.planAreas.some(r => r.key === key && r.geometry)) continue;
    db.store.planAreas.push({ showId: EUROPE, key, geometry: a.geometry, artworkLabel: a.exhibitor || `Area ${a.number}`, fromArtwork: true });
  }
  const svg = require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'LEX27_Floorplan_v02.svg'), 'utf8');
  let rr = await run(() => planAreas.reconcileWithArtwork(svg));
  check('the old reading is replaced', rr.ok && rr.changed === true && rr.before === 5, JSON.stringify(rr));
  const booted = await run(() => planAreas.all());
  check('eight areas, from the real drawing', booted.length === 8, booted.map(a => a.key).join(', '));
  check('Shell is on the West lounge', booted.some(a => a.key === 'networking-lounge-west' && a.sponsor === 'Shell'));
  check('and the East lounge is listed', booted.some(a => a.key === 'networking-lounge-east'));
  rr = await run(() => planAreas.reconcileWithArtwork(svg));
  check('the next boot writes nothing', rr.ok && rr.changed === false && rr.areas === 8, JSON.stringify(rr));
  rr = await run(() => planAreas.reconcileWithArtwork('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect x="0" y="0" width="5" height="5" fill="#fff"/></svg>'));
  check('a drawing with no readable areas changes nothing', rr.changed === false && (await run(() => planAreas.all())).length === 8,
        JSON.stringify(rr));

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
