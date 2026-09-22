/**
 * The artwork check reports; it never gates.
 *
 * The plan currently running Europe scores 3/8 against this spec, so a hard
 * reject would refuse a live show's own artwork. These assertions pin that
 * behaviour down, because "reject bad artwork" is the obvious thing to write
 * and it would take the running event off the air.
 */
const fs = require('fs');
const path = require('path');
const { validate, SPEC } = require('../server/lib/artwork-spec');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const live = fs.readFileSync(path.join(__dirname, '..', 'public', 'LEX27_Floorplan_Consolidated.svg'), 'utf8');

console.log('\nThe spec is a report, not a gate');
const r = validate(live);
check('the artwork running a live show does not pass the spec',
      r.passed < r.total, `${r.passed}/${r.total}, failing ${r.failedClauses.join(', ')}`);
check('which is exactly why upload must not reject on it', r.failedClauses.includes('R1'));

console.log('\nWhat the report has to contain to be actionable');
check('every result names its clause', r.results.every(x => /^R\d+$/.test(x.clause)));
check('every failure explains itself', r.results.filter(x => !x.ok).every(x => x.detail && x.detail.length > 10));
check('the spec is identified by version', /BEC-FP-01/.test(SPEC), SPEC);

console.log('\nIt reads real problems, not noise');
const outlined = validate('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L1 1"/></svg>');
check('outlined text is caught', outlined.failedClauses.includes('R1'));
const withText = validate('<svg xmlns="http://www.w3.org/2000/svg"><text>101</text><rect width="10" height="10"/></svg>');
check('live text passes R1', !withText.failedClauses.includes('R1'),
      withText.failedClauses.join(', '));

console.log('\nA live-text plan is judged on the stands the reader actually finds');
// The stand-fill table knows only Europe's colours. On North America's light
// blue it found no stands, and every geometry clause passed on an empty set —
// a 7/8 for a plan with a stale label, an overlap and a stand with no area.
const na = fs.readFileSync(path.join(__dirname, '..', 'public', 'LNA27_Floorplan_Web-Format_24.svg'), 'utf8');
const rn = validate(na);
check('live text passes R1', !rn.failedClauses.includes('R1'));
check('two numbers in one shape is caught (R4)', rn.failedClauses.includes('R4') &&
      /134\/138/.test(rn.results.find(x => x.clause === 'R4').detail), rn.results.find(x => x.clause === 'R4').detail);
check('a number printed on two shapes is caught (R11)', rn.failedClauses.includes('R11'));
check('a stand with no printed area is caught (R10)', rn.failedClauses.includes('R10') &&
      /108/.test(rn.results.find(x => x.clause === 'R10').detail));
check('its one near-white is NOT flagged as a variant — it is the available colour', !rn.failedClauses.includes('R12'),
      (rn.results.find(x => x.clause === 'R12') || {}).detail);
const twoWhites = validate(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>.a{fill:#ffffff}.b{fill:#fbfbf7}.c{fill:#689abb}</style>
  <rect class="a" x="0" y="0" width="10" height="10"/><rect class="b" x="12" y="0" width="10" height="10"/><rect class="c" x="24" y="0" width="10" height="10"/>
  <rect class="c" x="36" y="0" width="10" height="10"/><rect class="c" x="48" y="0" width="10" height="10"/><rect class="c" x="60" y="0" width="10" height="10"/>
  <text x="1" y="3">101</text><text x="5" y="9">30m</text><text x="13" y="3">102</text><text x="17" y="9">30m</text>
  <text x="25" y="3">103</text><text x="29" y="9">30m</text><text x="37" y="3">104</text><text x="41" y="9">30m</text>
  <text x="49" y="3">105</text><text x="53" y="9">30m</text><text x="61" y="3">106</text><text x="65" y="9">30m</text></svg>`);
check('two different near-whites on stands IS flagged', twoWhites.failedClauses.includes('R12'),
      (twoWhites.results.find(x => x.clause === 'R12') || {}).detail);

console.log('\nA schedule can be supplied, and is judged');
const sched = validate(live, { scheduleText: 'stand_number,area_sqm,status\n101,30,available\n101,30,available' });
check('duplicate stand numbers are caught', sched.failedClauses.includes('R11'));
check('a supplied schedule stops R15 complaining it is missing',
      !sched.results.some(x => !x.ok && x.clause === 'R15' && /no schedule supplied/.test(x.detail)));

const f = out.filter(x => !x).length;
console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
process.exit(f ? 1 : 0);
