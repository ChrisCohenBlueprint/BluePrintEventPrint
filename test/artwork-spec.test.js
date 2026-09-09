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

console.log('\nA schedule can be supplied, and is judged');
const sched = validate(live, { scheduleText: 'stand_number,area_sqm,status\n101,30,available\n101,30,available' });
check('duplicate stand numbers are caught', sched.failedClauses.includes('R11'));
check('a supplied schedule stops R15 complaining it is missing',
      !sched.results.some(x => !x.ok && x.clause === 'R15' && /no schedule supplied/.test(x.detail)));

const f = out.filter(x => !x).length;
console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
process.exit(f ? 1 : 0);
