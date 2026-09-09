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
const { extractStands, repairMojibake, stripExhibitorNames } = require('../server/lib/extract-stands');

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
// Two boxes, and the difference is load-bearing. The page binds a stand to its
// shape by reading the element's x/y/width/height attributes WITHOUT applying
// the element's own transform, so `geometry` must be the authored box or a
// rotated stand never binds and is silently unclickable. `visual` is where the
// shape actually appears, and is the only space the text labels can be matched
// in.
check('the stored box is the one authored on the element',
      rot && rot.geometry.x === 70 && rot.geometry.y === 10 && rot.geometry.w === 25 && rot.geometry.h === 50,
      JSON.stringify(rot && rot.geometry));
check('the on-screen box has the rotation resolved',
      rot && rot.visual.x === 70 && rot.visual.y === 10 && rot.visual.w === 50 && rot.visual.h === 25,
      JSON.stringify(rot && rot.visual));
check('and its labels were found in that on-screen space', rot.area === 200);

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

console.log('\nStatus comes from the colour the plan is drawn in');
// The fills are how a plan says what a stand IS. Inferring it from whether a
// name is printed got 79 North American stands sold where the artwork said 70.
const coloured = extractStands(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <style>
    .empty { fill: #fffcf8; stroke: #013149; }
    .taken { fill: #689abb; stroke: #013149; }
    .flag  { fill: #689abb; stroke: #ed1c24; }
    .area  { fill: #7c1315; stroke: #013149; }
  </style>
  <rect class="empty" x="10" y="10" width="25" height="25"/>
  <rect class="taken" x="35" y="10" width="25" height="25"/>
  <rect class="taken" x="60" y="10" width="25" height="25"/>
  <rect class="taken" x="85" y="10" width="25" height="25"/>
  <rect class="flag"  x="10" y="40" width="25" height="25"/>
  <rect class="area"  x="35" y="40" width="25" height="25"/>
  <text transform="translate(11 16)"><tspan x="0" y="0">101</tspan></text>
  <text transform="translate(36 16)"><tspan x="0" y="0">102</tspan></text>
  <text transform="translate(61 16)"><tspan x="0" y="0">103</tspan></text>
  <text transform="translate(86 16)"><tspan x="0" y="0">104</tspan></text>
  <text transform="translate(11 46)"><tspan x="0" y="0">105</tspan></text>
  <text transform="translate(36 46)"><tspan x="0" y="0">106</tspan></text>
</svg>`);
const st = (n) => coloured.stands.find(x => x.number === n);
check('a near-white stand is empty', st('101').status === 'available', st('101').status);
check('the plan\'s ordinary fill is sold', st('102').status === 'sold', st('102').status);
check('a stand outlined differently is on hold', st('105').status === 'held', st('105').status);
check('a dark fill used by only a few shapes is a sponsorable area',
      st('106').sponsored === true && st('106').status === 'sold');
check('the ordinary sold colour is not mistaken for a sponsorable area',
      st('102').sponsored === false);
check('the colour groups are reported so the mapping can be checked',
      coloured.fills.length === 4 && coloured.fills[0].count === 3,
      JSON.stringify(coloured.fills.map(f => `${f.fill}:${f.count}:${f.status}`)));

console.log('\nStripping the artwork\'s own exhibitor names');
// Names belong in the database: baked into the drawing they are wrong the
// moment a stand changes hands, and correcting one means a new export.
const { svg: stripped, removed } = stripExhibitorNames(fixture, r.stands.map(s => s.exhibitor));
const afterStrip = extractStands(stripped);
check('the names are gone', removed === 2 && afterStrip.stands.every(s => !s.exhibitor),
      `${removed} removed`);
check('but every stand is still there', afterStrip.stands.length === 4);
check('and its number and area are untouched',
      afterStrip.stands.find(x => x.number === '104').area === 200);

console.log('\nA number printed on two shapes cannot be two stands');
// Left in, this aborts an import partway and leaves the event half-filled:
// the stand number is the key each stand is stored under.
const twice = extractStands(fixture.replace('>102<', '>101<'));
check('the repeat is dropped', twice.stands.length === 3 && new Set(twice.stands.map(x => x.number)).size === 3,
      twice.stands.map(x => x.number).join(','));
check('and named so the artwork can be corrected',
      twice.warnings.some(w => /printed on two different shapes/.test(w)));
check('a plan with no names to strip is returned unchanged',
      stripExhibitorNames(fixture, []).svg === fixture);

console.log('\nIt reports rather than silently averaging');
check('too little data to calibrate is said out loud',
      r.warnings.some(w => /calibrate/i.test(w)));

const f = out.filter(x => !x).length;
console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
process.exit(f ? 1 : 0);
