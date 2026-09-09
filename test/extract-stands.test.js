/**
 * Reading stands from artwork that meets the spec.
 *
 * The point of these is that NOTHING here is event-specific. The extractor is
 * given a plan and works out the unit, the scale and which shapes are stands
 * from the file itself — because a constant measured on one event's artwork
 * (LEX's 283 units per m²) is wrong on every other event's.
 */
const fs = require('fs');
const path = require('path');
const { extractStands, repairMojibake } = require('../server/lib/extract-stands');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'plan-to-spec.svg'), 'utf8');
const r = extractStands(fixture);
const by = (n) => r.stands.find(s => s.number === n);

console.log('\nReading a plan that meets the spec');
check('every stand is found', r.stands.length === 4, `${r.stands.length} of 4`);
check('the unit is read from the plan, not assumed', r.unit === 'sqft', String(r.unit));
check('printed areas are used as printed', by('101').area === 100 && by('101').areaSource === 'printed');

console.log('\nGeometry the drawing tool made awkward');
const rot = by('104');
check('a rotate(90) stand resolves to real x/y/w/h',
      rot && rot.geometry.x === 70 && rot.geometry.y === 10 && rot.geometry.w === 50 && rot.geometry.h === 25,
      JSON.stringify(rot && rot.geometry));

console.log('\nLabels');
check('a multi-line name keeps its spaces', by('103').exhibitor === 'Networking Lounge',
      JSON.stringify(by('103').exhibitor));
check('a unit superscript is not mistaken for a label', by('101').exhibitor === null);
check('mojibake from a re-encoded export is repaired', by('104').exhibitor === 'Klüber',
      JSON.stringify(by('104').exhibitor));
check('repair leaves clean text alone', repairMojibake('Klüber') === 'Klüber');

console.log('\nA label must not steal its neighbour\'s shape');
// 101 and 102 are drawn edge to edge. A generous containment tolerance lets
// 102's number fall inside 101's shape and claim it, orphaning a real stand.
check('adjacent stands each keep their own number',
      by('101').geometry.x === 10 && by('102').geometry.x === 35);

console.log('\nArtwork it cannot read');
const outlined = extractStands(
  fs.readFileSync(path.join(__dirname, '..', 'public', 'LEX27_Floorplan_Consolidated.svg'), 'utf8'));
check('outlined text yields no stands rather than wrong ones', outlined.stands.length === 0,
      `${outlined.stands.length} stands`);
check('and says why, in words a person can act on',
      /outlines/i.test(outlined.warnings.join(' ')), outlined.warnings[0]);

console.log('\nIt reports rather than silently averaging');
check('too little data to calibrate is said out loud',
      r.warnings.some(w => /calibrate/i.test(w)));

const f = out.filter(x => !x).length;
console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
process.exit(f ? 1 : 0);
