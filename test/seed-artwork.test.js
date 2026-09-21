/**
 * The repair that puts North America's plan back.
 *
 * It rewrites an event's inventory, so what it REFUSES to do matters more than
 * what it does. These assert the guards — and, since the repair has moved out
 * of the boot path, that the guards moved WITH it rather than being lost on the
 * way.
 *
 * It used to run on every boot behind a flag in `meta`. That flag was itself a
 * defect: a run that restored the plan and was then refused the import wrote it
 * anyway, so every later boot saw a healthy plan, skipped, and left the stands
 * broken for good. What replaces it is a script that is a dry run by default —
 * which is a stronger guard than the flag ever was, because the flag decided
 * unilaterally and this does not decide at all.
 */
const fs = require('fs');
const path = require('path');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const src = read('server', 'services', 'seed-artwork.js');
const script = read('scripts', 'seed-north-america.js');
const runner = read('scripts', 'lib', 'run.js');
const { extractStands } = require('../server/lib/extract-stands');

console.log('\nThe shipped plan is the one with the names in it');
const shipped = path.join(__dirname, '..', 'public', 'LNA27_Floorplan_Web-Format_24.svg');
check('it is in the repo, so the deploy carries it', fs.existsSync(shipped));
const r = extractStands(fs.readFileSync(shipped, 'utf8'));
check('and it still has its exhibitor names',
      r.stands.filter(s => s.exhibitor).length > 70,
      `${r.stands.filter(s => s.exhibitor).length} names`);
check('the six sponsorable areas are excluded from the stands',
      r.stands.filter(s => s.sponsored).length === 6);
check('leaving 93 sellable stands',
      r.stands.filter(s => !s.sponsored).length === 93,
      String(r.stands.filter(s => !s.sponsored).length));

console.log('\nIt is nobody\'s side effect any more');
// A deploy must not be able to rewrite an event's inventory unasked, and a
// flag in `meta` is not consent — nobody chose it and nobody saw it happen.
check('nothing runs at boot: the server does not reach for this seed',
      !/seed-artwork/.test(read('server.js')),
      'server.js still calls it');
check('it does nothing at all unless a person passes --apply',
      /apply = false/.test(src) && /if \(!apply\) return \{ ok: true, dryRun: true/.test(src));
check('and the script is a dry run by default too',
      /const apply = has\('--apply'\)/.test(runner) &&
      /DRY RUN — nothing will be written/.test(runner));
check('the meta row records what was done, and does not gate whether it runs',
      /NOT as a gate/.test(src) && !/if \(await meta\.findOne\(\{ _id: RAN \}\)\) return/.test(src));

console.log('\nGuards');
check('it is scoped to one named event', /slug === SLUG/.test(src) && /SLUG = 'lna'/.test(src));
check('every write happens inside that event\'s context',
      /showContext\.runAs\(show\.showId/.test(src));
// The refusal is what keeps Europe's sold stands and its holds safe.
check('the import\'s own refusal on real bookings is honoured, not bypassed',
      /booths\.importFromArtwork\(sellable, \{ actor, force \}\)/.test(src) &&
      /if \(!out\.ok\)/.test(src) && !/force: true/.test(src));
check('and force is something the person running it has to type',
      /force = false/.test(src) && /const force = has\('--force'\)/.test(runner));
check('the script says which database and which event before it does anything',
      /config\.dbName/.test(runner) && /event\s+\$\{showId\}/.test(runner));
check('the script prints the committed count, so a refusal is never a surprise',
      /r\.committed/.test(script) && /r\.customised/.test(script));
check('a refused import is reported as the guard working, not as a failure',
      /importRefused/.test(script) && /the guard doing its job/.test(script));

console.log('\nWhat it repairs, and how it decides');
// Restoring the plan and rebuilding the stands are separate repairs, and an
// earlier run did the first then had the second refused.
check('the stands are judged separately from the plan',
      /standsDiffer/.test(src) && /planNeedsRestoring/.test(src));
// Two earlier versions checked for specific symptoms — first whether the plan
// had names, then the stand count and whether ANY stand carried a company — and
// each time the defect actually present fell outside the check and the repair
// skipped itself. Comparing the whole tally catches whatever is wrong.
check('the stored stands are compared to the plan as a whole tally',
      /const tally = /.test(src) && /Object\.keys\(want\)\.some\(k => want\[k\] !== got\[k\]\)/.test(src));
check('and that tally counts every status, not just how many stands there are',
      /available:.*status\('available'\)/.test(src) && /sold:.*status\('sold'\)/.test(src) &&
      /held:.*status\('held'\)/.test(src) && /named:/.test(src));
// But a tally cannot tell a broken import from an admin merging two stands, so
// it reports the difference and leaves the decision to the person.
check('the tally is reported rather than deciding on its own',
      /This is now a REPORT, not a decision/.test(src) && /standsDiffer\b/.test(script));
check('the original is stored, and only the served copy loses its names',
      /floorplans\.save\(shipped/.test(src) && /setDisplaySvg/.test(src));
check('the plan\'s own sponsorable areas are stored against this event',
      /planAreas\.replaceFromArtwork\(areas/.test(src));

const f = out.filter(x => !x).length;
console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
process.exit(f ? 1 : 0);
