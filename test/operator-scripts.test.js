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
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

const f = out.filter(x => !x).length;
console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
process.exit(f ? 1 : 0);
