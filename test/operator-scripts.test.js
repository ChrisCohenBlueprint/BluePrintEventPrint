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
 *
 *   reseed.js      — a dry run until --apply (it used to be the other way
 *                    round); a renumbered extraction carries EVERY field a stand
 *                    has — it used to keep six and lose tags, country, shown
 *                    numbers, sponsor flags and logos, and removed flags — and
 *                    follows holds, leads and proposals to the new numbers. It
 *                    snapshots first, refuses what it cannot carry (a merged
 *                    stand, a booking with nowhere to go) and needs --force on
 *                    an event that has sold.
 *
 *   seed-sponsors  — a dry run until --apply. It seeds an event with no
 *                    catalogue; on one that has a catalogue it changes nothing
 *                    unless told to — every run used to revert the admin's and
 *                    the CSV's edits and bring deleted packages back — and it
 *                    creates no index of its own to clash with the server's.
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

  console.log('\nreseed.js carries every stand across a renumbered extraction');
  const RESEED = 'scripts/reseed.js';
  // The same hall, numbered differently: what a fresh extraction looks like.
  const renumbered = () => {
    const stands = standsFor('LEX').map(b => ({ ...b, boothNumber: `X${b.boothNumber}` }));
    const at = (n) => stands.find(b => b.boothNumber === n);
    Object.assign(at('X777'), {
      status: 'sold', updatedBy: 'chris', displayNumber: 'A1', displayNumberKey: 'a1', sponsored: true,
      sponsorLogo: 'data:image/png;base64,AAAA',
      assignment: { company: 'Acme Lubricants', contactId: 'c-1', actualPrice: 5000, notes: 'signed',
                    tags: ['base-oils'], country: 'DE' },
    });
    Object.assign(at('X780'), { status: 'held', updatedBy: 'chris', assignment: { ...blank(), company: 'Holdco' } });
    Object.assign(at('X679'), { removed: true, removedAt: '2026-09-01', removedBy: 'chris' });
    return stands;
  };
  const world = () => ({
    booths: renumbered(),
    holds: [{ showId: 'LEX', boothNumber: 'X780', company: 'Holdco' }],
    inquiries: [{ showId: 'LEX', company: 'Lead Ltd', boothsOfInterest: ['X777', 'X780'] }],
    menus: [{ showId: 'LEX', ref: 'LEX-P001', owner: 'rep', boothNumbers: ['X778'] }],
  });

  const rDry = run(RESEED, [], world());
  check('a plain run is a dry run, and writes nothing', rDry.code === 0 && /DRY RUN/.test(rDry.out) &&
        rDry.writes.length === 0, JSON.stringify(rDry.writes.map(w => w.slice(0, 2))));
  check('it shows where each booking goes', /X777\s+→ 777\s+sold\s+Acme Lubricants/.test(rDry.out));

  const rNoForce = run(RESEED, ['--apply'], world());
  check('on an event that has sold, --apply alone is refused', rNoForce.code === 1 && /REFUSED/.test(rNoForce.out) &&
        rNoForce.writes.length === 0);

  const r = run(RESEED, ['--apply', '--force'], world());
  const lex = (r.store.booths || []).filter(b => b.showId === 'LEX');
  const s777 = lex.find(b => b.boothNumber === '777');
  check('--apply --force rebuilds the event from the file', r.code === 0 && lex.length === FILE.length &&
        !lex.some(b => /^X/.test(b.boothNumber)), `${lex.length} stands`);
  check('the sale is carried: status, company, contact, agreed price, notes',
        s777 && s777.status === 'sold' && s777.assignment.company === 'Acme Lubricants' &&
        s777.assignment.contactId === 'c-1' && s777.assignment.actualPrice === 5000 && s777.assignment.notes === 'signed');
  check('and everything else it had: tags, country, shown number, sponsor flag and logo',
        s777 && s777.assignment.tags.join() === 'base-oils' && s777.assignment.country === 'DE' &&
        s777.displayNumber === 'A1' && s777.displayNumberKey === 'a1' && s777.sponsored === true &&
        s777.sponsorLogo === 'data:image/png;base64,AAAA', JSON.stringify(s777));
  check('a stand taken off the plan stays off it', lex.find(b => b.boothNumber === '679')?.removed === true);
  check('the hold follows its stand', (r.store.holds || []).every(h => h.boothNumber === '780'));
  check('so do the lead and the proposal',
        r.store.inquiries[0].boothsOfInterest.join() === '777,780' && r.store.menus[0].boothNumbers.join() === '778',
        `${r.store.inquiries[0].boothsOfInterest} / ${r.store.menus[0].boothNumbers}`);
  const snapAt = r.calls.findIndex(c => c[1] === 'booths_snapshots' && c[0] === 'insertMany');
  const delAt = r.calls.findIndex(c => c[1] === 'booths' && c[0] === 'deleteMany');
  check('the old stands were snapshotted before anything was deleted', snapAt > -1 && snapAt < delAt, `${snapAt} < ${delAt}`);
  check('and the operator is told to restart', /Restart the web service/.test(r.out));

  const merged = run(RESEED, ['--apply', '--force'], { booths: europeWithMergedSale() });
  check('a merged stand cannot be carried, so even --force is refused',
        merged.code === 1 && /merged or split/.test(merged.out) && merged.writes.length === 0);

  const lost = world();
  lost.booths.find(b => b.boothNumber === 'X777').geometry = { x: -900, y: -900, w: 40, h: 40 };
  const stranded = run(RESEED, ['--apply', '--force'], lost);
  check('a booking that matches no stand in the file is refused, not dropped',
        stranded.code === 1 && /match no stand/.test(stranded.out) && stranded.writes.length === 0);

  const both = { booths: [...standsFor('LEX'), ...standsFor('LNA').map(b => ({ ...b, boothNumber: `N${b.boothNumber}` }))] };
  const na = run(RESEED, ['--show=lna', '--apply'], both);
  const after = na.store.booths || [];
  check('--show lna re-seeds North America only', na.code === 0 &&
        after.filter(b => b.showId === 'LNA' && !/^N/.test(b.boothNumber)).length === FILE.length &&
        after.filter(b => b.showId === 'LEX').length === FILE.length, na.out.slice(-200));

  console.log('\nseed-sponsors.js seeds a catalogue, and leaves an edited one alone');
  const SEED = 'scripts/seed-sponsors.js';
  const sDry = run(SEED, ['--show', 'lna']);
  check('a plain run is a dry run, and writes nothing', sDry.code === 0 && sDry.writes.length === 0 &&
        /14 to add/.test(sDry.out), sDry.out.slice(-300));
  const sNew = run(SEED, ['--show', 'lna', '--apply']);
  const lnaPk = (sNew.store.sponsors || []).filter(p => p.showId === 'LNA');
  check('--apply seeds an event with no catalogue', sNew.code === 0 && lnaPk.length === 14, `${lnaPk.length}`);
  check('creating no index of its own', sNew.indexWork.length === 0, JSON.stringify(sNew.indexWork));
  check('and the operator is told to restart', /Restart the web service/.test(sNew.out));

  // Europe's catalogue as an admin left it: Conference renamed, re-tiered and
  // re-priced; Lanyards and the rest deleted.
  const edited = () => ({ sponsors: [
    { showId: 'LEX', key: 'conference', name: 'Conference Sponsorship 2027', tier: 'gold', price: 42000,
      blurb: 'Rewritten by sales.', perks: ['30 VIP passes'], active: true, soldOut: false },
    { showId: 'LEX', key: 'bags', name: 'Bags', tier: 'silver', price: 12950,
      blurb: 'Branded bags handed out at registration.', perks: [], active: true, soldOut: true },
  ] });
  const conf = (r) => (r.store.sponsors || []).find(p => p.showId === 'LEX' && p.key === 'conference');
  const lexCount = (r) => (r.store.sponsors || []).filter(p => p.showId === 'LEX').length;

  const keep = run(SEED, ['--apply'], edited());
  check('on an event with a catalogue, --apply adds nothing — deleted packages stay deleted',
        keep.code === 0 && lexCount(keep) === 2 && /NOT added/.test(keep.out), `${lexCount(keep)} packages`);
  check("and reverts none of the admin's edits", conf(keep).name === 'Conference Sponsorship 2027' &&
        conf(keep).tier === 'gold' && conf(keep).blurb === 'Rewritten by sales.');

  const add = run(SEED, ['--apply', '--add-missing'], edited());
  check('--add-missing adds the packages the event lacks', lexCount(add) === 14, `${lexCount(add)}`);
  check('still without touching the edited one', conf(add).name === 'Conference Sponsorship 2027' && conf(add).price === 42000);

  const over = run(SEED, ['--apply', '--overwrite'], edited());
  check('--overwrite resets the wording to the file', conf(over).name === 'Conference Sponsorship' &&
        conf(over).tier === 'platinum');
  check('but never the price or sold-out state', conf(over).price === 42000 &&
        (over.store.sponsors || []).find(p => p.key === 'bags').soldOut === true);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

const f = out.filter(x => !x).length;
console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
process.exit(f ? 1 : 0);
