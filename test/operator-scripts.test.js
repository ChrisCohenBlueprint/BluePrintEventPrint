/**
 * The operator scripts in scripts/, run as an operator runs them.
 *
 * Each script is started as its own process, exactly as from a terminal, with
 * the MongoDB driver swapped for the stand-in database (see script-db.js). So
 * the flags are parsed for real, connect() runs for real, and what comes back
 * is every operation the script performed, in order.
 *
 * What is asserted:
 *
 *   the contract   — a dry run writes NOTHING, index work included: connect()
 *                    used to run the server's index setup, which drops an index
 *                    and rewrites the activity TTL from whatever retention the
 *                    operator's own .env says. `--show=lna` names North America
 *                    (it used to mean the default event), and a show flag with
 *                    no value, or an unknown one, stops the script. After
 *                    --apply the operator is told to restart the service, which
 *                    is the only way the running server sees what was written.
 *
 *   migrate.js     — a dry run until --apply; it seeds an event nobody has
 *                    worked on and REFUSES one that has been sold from or laid
 *                    out by hand. On live Europe it used to un-merge a sold
 *                    block back to a 9 m² stand at half price, still sold, and
 *                    put the stand it absorbed back beside it, available — the
 *                    same floor sellable twice. A booth_state.json lying in the
 *                    project folder is never applied unless named with --state.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-scripts-'));

// Anything that changes the database — documents or indexes.
const WRITES = new Set(['insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany',
                        'bulkWrite', 'createIndex', 'createIndexes', 'dropIndex', 'command']);
const INDEX_WORK = new Set(['createIndex', 'createIndexes', 'dropIndex', 'command']);

// The shipped extraction, as stored stands on an event — the shape migrate and
// reseed write, so a test can start from "the plan as seeded".
const FILE = Object.values(require('../server/data/booth_data.json'));
const num = (b) => String(b.boothId).replace(/^booth-/, '');
const blank = () => ({ company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null });
const standsFor = (showId, rate = 600) => FILE.map(b => ({
  showId, boothNumber: num(b), svgElementId: b.boothId, geometry: { x: b.x, y: b.y, w: b.w, h: b.h },
  sqm: b.sqm, sqmSource: 'estimated', listPrice: Math.round(b.sqm * rate), status: 'available',
  assignment: blank(), clicks: 0, updatedBy: 'seed',
}));

// Europe as it really is: 778 and 780 merged into one block and sold.
function europeWithMergedSale() {
  const stands = standsFor('LEX');
  const a = stands.find(b => b.boothNumber === '778'), b = stands.find(x => x.boothNumber === '780');
  const merged = { ...a, geometry: { x: a.geometry.x, y: a.geometry.y, w: a.geometry.w + b.geometry.w, h: a.geometry.h },
                   sqm: a.sqm + b.sqm, listPrice: a.listPrice + b.listPrice, status: 'sold', updatedBy: 'chris',
                   assignment: { ...blank(), company: 'Acme Lubricants', actualPrice: 10000 },
                   mergedFrom: ['780'], mergeSnapshot: { self: { ...a }, parts: [{ ...b }] } };
  return stands.filter(x => x !== a && x !== b).concat(merged);
}

const SHOWS = [{ slug: 'lex', showId: 'LEX', name: 'Europe', active: true, order: 0 },
               { slug: 'lna', showId: 'LNA', name: 'North America', active: true, order: 1 }];

let runs = 0;
/** Run a script against `seed`; returns its exit code, output, and the database after. */
function run(script, args = [], seed = {}, env = {}) {
  const n = ++runs;
  const dbIn = path.join(TMP, `in-${n}.json`), dbOut = path.join(TMP, `out-${n}.json`);
  fs.writeFileSync(dbIn, JSON.stringify({ shows: SHOWS, ...seed }));
  const r = spawnSync(process.execPath, ['-r', path.join(__dirname, 'script-db.js'), path.join(ROOT, script), ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, MONGO_URI: 'mongodb://127.0.0.1:1', MONGO_DB: 'blueprint_test', SHOW_ID: 'LEX',
           SESSION_SECRET: 'test-secret-not-a-real-one-0123456789', ADMIN_USER: 'test', ADMIN_PASS: 'test',
           FAKE_DB_IN: dbIn, FAKE_DB_OUT: dbOut, ...env },
  });
  const after = fs.existsSync(dbOut) ? JSON.parse(fs.readFileSync(dbOut, 'utf8')) : { store: {}, calls: [] };
  return { code: r.status, out: `${r.stdout}${r.stderr}`, store: after.store, calls: after.calls,
           writes: after.calls.filter(c => WRITES.has(c[0])), indexWork: after.calls.filter(c => INDEX_WORK.has(c[0])) };
}

try {
  console.log('\nThe contract every script shares (scripts/lib/run.js)');
  const PROBE = 'test/fixtures/run-probe.js';

  const dry = run(PROBE, ['--show', 'lna']);
  check('a dry run succeeds', dry.code === 0, dry.out.slice(-300));
  check('and writes nothing at all — not even an index', dry.writes.length === 0,
        JSON.stringify(dry.writes.map(w => w.slice(0, 2))));
  check('--show lna names North America', /PROBE showId=LNA/.test(dry.out));
  check('a dry run does not ask for a restart', !/Restart the web service/.test(dry.out));

  const eq = run(PROBE, ['--show=lna']);
  check('--show=lna names North America too, not the default event', /PROBE showId=LNA/.test(eq.out), eq.out.match(/PROBE.*/)?.[0]);

  const bad = run(PROBE, ['--show=nope', '--apply']);
  check('an unknown event stops the script', bad.code === 2 && /No event matches "nope"/.test(bad.out));
  check('before anything is written', bad.writes.length === 0);

  for (const args of [['--show'], ['--show', '--apply'], ['--show=', '--apply']]) {
    const empty = run(PROBE, args);
    check(`"${args.join(' ')}" stops the script rather than meaning the default event`,
          empty.code === 2 && !/PROBE/.test(empty.out) && empty.writes.length === 0, empty.out.trim().split('\n').pop());
  }

  const applied = run(PROBE, ['--show', 'lna', '--apply']);
  check('--apply writes what the script writes, and no index work',
        applied.code === 0 && applied.writes.length === 1 && applied.writes[0][0] === 'insertOne' &&
        applied.indexWork.length === 0, JSON.stringify(applied.writes.map(w => w.slice(0, 2))));
  check('and then says to restart the service', /Restart the web service/.test(applied.out));

  const def = run(PROBE, []);
  check('with no --show, the default event', /PROBE showId=LEX/.test(def.out));

  console.log('\nmigrate.js seeds an event nobody has worked on');
  const MIGRATE = 'scripts/migrate.js';
  const fresh = { settings: [{ _id: 'LNA', ratePerSqm: 60 }], booths: [standsFor('LEX')[0]] };

  const mDry = run(MIGRATE, ['--show', 'lna'], fresh);
  check('a plain run is a dry run', mDry.code === 0 && /DRY RUN/.test(mDry.out), mDry.out.slice(-300));
  check('and writes nothing', mDry.writes.length === 0, JSON.stringify(mDry.writes.map(w => w.slice(0, 2))));
  check(`it says it would add the ${FILE.length} shipped stands`, new RegExp(`${FILE.length} to add`).test(mDry.out));

  const mApply = run(MIGRATE, ['--show=lna', '--apply'], fresh);
  const lna = (mApply.store.booths || []).filter(b => b.showId === 'LNA');
  check('--apply seeds the named event', mApply.code === 0 && lna.length === FILE.length, `${lna.length} stands`);
  check('every one available', lna.every(b => b.status === 'available'));
  check("priced at that event's own rate, not the file's",
        lna.every(b => b.listPrice === Math.round(b.sqm * 60)), String(lna[0] && lna[0].listPrice));
  check('the other event is untouched', (mApply.store.booths || []).filter(b => b.showId === 'LEX').length === 1);
  check('no index work', mApply.indexWork.length === 0);
  check('and the operator is told to restart', /Restart the web service/.test(mApply.out));

  console.log('\nmigrate.js refuses an event that has been sold from');
  const europe = europeWithMergedSale();
  for (const args of [['--apply'], ['--apply', '--force']]) {
    const r = run(MIGRATE, args, { booths: europe });
    check(`${args.join(' ')}: refused`, r.code === 1 && /REFUSED/.test(r.out), r.out.slice(-300));
    check(`${args.join(' ')}: nothing written — the sold block is still one block, and 780 is not back`,
          r.writes.length === 0 && (r.store.booths || []).length === europe.length &&
          !(r.store.booths || []).some(b => b.boothNumber === '780'));
  }
  const named = run(MIGRATE, [], { booths: europe });
  check('the refusal names the stand in the way', /778\s+sold\s+Acme Lubricants/.test(named.out));

  console.log('\nmigrate.js applies a legacy booth_state.json only when told to');
  const LEFT_BEHIND = path.join(ROOT, 'booth_state.json');
  const legacyState = { 'booth-777': { status: 'sold', company: 'Legacy Ltd', actualPrice: 4000, notes: 'from 2024' } };
  const placed = !fs.existsSync(LEFT_BEHIND);
  if (placed) fs.writeFileSync(LEFT_BEHIND, JSON.stringify(legacyState));
  try {
    const quiet = run(MIGRATE, ['--show', 'lna', '--apply'], fresh);
    const s777 = (quiet.store.booths || []).find(b => b.showId === 'LNA' && b.boothNumber === '777');
    check('a booth_state.json in the project folder is ignored', quiet.code === 0 && s777 && s777.status === 'available' &&
          !(quiet.store.meta || []).length, s777 && s777.status);
  } finally {
    if (placed) fs.rmSync(LEFT_BEHIND, { force: true });
  }
  const statePath = path.join(TMP, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(legacyState));
  const named777 = run(MIGRATE, ['--show', 'lna', '--state', statePath], fresh);
  check('named with --state, the dry run lists the bookings it would write',
        named777.writes.length === 0 && /777\s+sold\s+Legacy Ltd/.test(named777.out));
  const told = run(MIGRATE, ['--show', 'lna', '--state', statePath, '--apply'], fresh);
  const t777 = (told.store.booths || []).find(b => b.showId === 'LNA' && b.boothNumber === '777');
  check('and --apply writes them, once', t777 && t777.status === 'sold' && t777.assignment.company === 'Legacy Ltd' &&
        (told.store.meta || []).some(m => m._id === 'legacy-state-import-v1'));
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

const f = out.filter(x => !x).length;
console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
process.exit(f ? 1 : 0);
