/**
 * Run every suite and report all of them.
 *
 * The test script used to be a chain of `&&`, which stops at the first failure —
 * so one broken suite hid the state of the nine behind it, and a run told you
 * about one problem at a time. This runs each suite in its own process, prints a
 * line per suite, and exits non-zero if any failed.
 *
 * It also fixes the environment each suite starts in. `server/config.js` calls
 * dotenv at require time, so every test loaded the real `.env` — including the
 * production Atlas connection string. Nothing connects today, but a test that
 * one day reaches `db.connect()` would have written to the live database with no
 * warning. dotenv does not overwrite variables that are already set, so setting
 * them here is enough to make that impossible: MONGO_URI points at a closed port
 * on localhost, and the secrets are obvious throwaways.
 */
const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');

const DIR = __dirname;
const suites = fs.readdirSync(DIR)
  .filter(f => f.endsWith('.test.js'))
  .sort();

// A suite named on the command line runs alone: `npm test -- holds` runs every
// suite whose name contains "holds".
const filter = process.argv.slice(2).filter(a => !a.startsWith('-'));
const chosen = filter.length
  ? suites.filter(s => filter.some(f => s.includes(f)))
  : suites;

const env = {
  ...process.env,
  // Unreachable on purpose: a closed port on loopback fails fast and cannot be
  // a real database. Never a hostname that might resolve to something live.
  MONGO_URI: process.env.MONGO_URI_TEST || 'mongodb://127.0.0.1:1',
  MONGO_DB: 'blueprint_test',
  NODE_ENV: 'test',
  SESSION_SECRET: process.env.SESSION_SECRET || 'test-secret-not-a-real-one-0123456789',
  ADMIN_USER: process.env.ADMIN_USER || 'test-admin',
  ADMIN_PASS: process.env.ADMIN_PASS || 'test-password',
  // Never let a test fire the real enquiry webhook.
  NOTIFY_WEBHOOK: '',
};

const run = (file) => new Promise((resolve) => {
  const started = Date.now();
  const child = spawn(process.execPath, [path.join(DIR, file)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.on('close', (code) => {
    const line = (out.match(/^(ALL PASSED.*|\d+ FAILED.*)$/m) || [])[0] || '';
    const checks = (line.match(/\((\d+) checks?\)/) || [])[1];
    resolve({ file, code, out, line, checks: Number(checks || 0), ms: Date.now() - started });
  });
});

(async () => {
  const results = [];
  for (const file of chosen) {
    const r = await run(file);
    results.push(r);
    const status = r.code === 0 ? 'PASS' : 'FAIL';
    const detail = r.line || (r.code === 0 ? '' : 'crashed — no result line');
    console.log(`${status}  ${file.padEnd(34)} ${String(r.checks || '').padStart(3)} checks  ${String(r.ms / 1000).slice(0, 4)}s  ${r.code === 0 ? '' : detail}`);
    // Only the failing output is worth reading; a passing suite's detail is noise.
    if (r.code !== 0) console.log(r.out.split('\n').filter(l => /FAIL|Error|error:/.test(l)).slice(0, 12).map(l => `        ${l}`).join('\n'));
  }

  const failed = results.filter(r => r.code !== 0);
  const checks = results.reduce((n, r) => n + r.checks, 0);
  console.log(`\n${results.length} suites, ${checks} checks — ${failed.length ? `${failed.length} SUITE(S) FAILED: ${failed.map(f => f.file).join(', ')}` : 'all green'}`);
  process.exit(failed.length ? 1 : 0);
})();
