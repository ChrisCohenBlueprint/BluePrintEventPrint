/**
 * The uploaded artwork is never overwritten.
 *
 * The names printed inside stands are removed from the copy we SHOW, because
 * we draw those ourselves. Doing that to the STORED plan destroyed the only
 * copy of them: the next import read a plan with no names left in it and
 * produced 99 stands with no exhibitors, silently, recoverable only by
 * re-uploading the file. These assertions exist so that cannot recur.
 */
const fs = require('fs');
const path = require('path');
const { extractStands, stripExhibitorNames } = require('../server/lib/extract-stands');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const original = fs.readFileSync(path.join(__dirname, 'fixtures', 'plan-to-spec.svg'), 'utf8');

console.log('\nStripping is not destructive to the source');
const first = extractStands(original);
const names = first.stands.map(s => s.exhibitor).filter(Boolean);
const display = stripExhibitorNames(original, names).svg;

check('the display copy has the names taken out',
      extractStands(display).stands.every(s => !s.exhibitor));
check('the original still has them', extractStands(original).stands.some(s => s.exhibitor));
check('so importing again reads the same names',
      extractStands(original).stands.filter(s => s.exhibitor).length === names.length,
      `${names.length} names`);
// Re-importing from the display copy is the failure this guards against.
check('whereas importing from the display copy would lose every name',
      extractStands(display).stands.filter(s => s.exhibitor).length === 0);

console.log('\nThe model keeps them in separate fields');
const model = fs.readFileSync(path.join(__dirname, '..', 'server', 'models', 'floorplans.js'), 'utf8');
check('a display copy is stored under its own field', /displaySvg/.test(model));
check('setDisplaySvg never touches the uploaded svg',
      /setDisplaySvg[\s\S]*?\$set:\s*\{[\s\S]*?\}/.test(model) &&
      !/setDisplaySvg[\s\S]*?\$set:\s*\{[^}]*\bsvg:/.test(model));
const route = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'api.js'), 'utf8');
check('the import extracts from the original, not the display copy',
      /extractStands\(f\.svg\)/.test(route) && !/extractStands\(f\.displaySvg/.test(route));

const f = out.filter(x => !x).length;
console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
process.exit(f ? 1 : 0);
