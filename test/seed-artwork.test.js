/**
 * The one-shot repair that puts North America's plan back.
 *
 * It writes to a live database at boot, so what it REFUSES to do matters more
 * than what it does. These assert the three guards: it runs once, it only acts
 * on the event it names, and it cannot touch an event that has real bookings.
 */
const fs = require('fs');
const path = require('path');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'seed-artwork.js'), 'utf8');
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

console.log('\nGuards');
check('a meta flag stops it running twice', /meta\.findOne\(\{\s*_id:\s*FLAG/.test(src));
check('it is scoped to one named event', /slug === SLUG/.test(src) && /SLUG = 'lna'/.test(src));
check('every write happens inside that event\'s context',
      /showContext\.runAs\(show\.showId/.test(src));
// The refusal is what keeps Europe's 71 sold stands and 19 holds safe.
check('the import\'s own refusal on real bookings is honoured, not bypassed',
      /importFromArtwork\(sellable, \{ actor: 'deploy' \}\)/.test(src) &&
      /if \(!out\.ok\)/.test(src) && !/force: true/.test(src));
// Restoring the plan and rebuilding the stands are separate repairs, and an
// earlier run did the first then had the second refused. Deciding on the plan
// alone then meant every later boot saw a healthy plan and skipped, leaving the
// stands broken with no way back.
check('the stands are judged separately from the plan',
      /standsNeedRebuilding/.test(src) && /planNeedsRestoring/.test(src));
// Two earlier versions checked for specific symptoms — first whether the plan
// had names, then the stand count and whether ANY stand carried a company — and
// each time the defect actually present fell outside the check and the repair
// skipped itself. Comparing the whole tally catches whatever is wrong.
check('the stored stands are compared to the plan as a whole tally',
      /const tally = /.test(src) && /Object\.keys\(want\)\.some\(k => want\[k\] !== got\[k\]\)/.test(src));
check('and that tally counts every status, not just how many stands there are',
      /available:.*status\('available'\)/.test(src) && /sold:.*status\('sold'\)/.test(src) &&
      /held:.*status\('held'\)/.test(src) && /named:/.test(src));
check('and it stands down only when both are already right',
      /!planNeedsRestoring && !standsNeedRebuilding/.test(src));
check('the original is stored, and only the served copy loses its names',
      /floorplans\.save\(shipped/.test(src) && /setDisplaySvg/.test(src));

const f = out.filter(x => !x).length;
console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
process.exit(f ? 1 : 0);
