/**
 * What a plan is allowed to LOOK like, and still be read.
 *
 * Each case here is something the designer brief or specification BEC-FP-01
 * promises a designer they may do, that the reader did not in fact do. None of
 * them failed loudly: a plan drawn exactly as the brief asks came back with no
 * areas on any stand, or with a corner stand missing altogether, and the
 * designer was told to correct artwork that was already correct.
 *
 *   - "30 m²" typed as one text object matched nothing, because only
 *     Illustrator's spelling — the ² as a separate scaled run — was read
 *   - text outside a tspan was thrown away, so a superscript inside the same
 *     text object left only the "²"
 *   - a corner stand drawn as a closed polygon, and a rounded stand exported as
 *     a path, were not shapes at all; their numbers were reported as strays
 *   - a row coloured by its LAYER had no fill on the rectangles, so the stands
 *     read as unreadable and were offered for sale
 *   - a white box tucked behind a stand number is smaller than the stand, so it
 *     took the number and the stand became an uncliquable sliver
 */
const { extractStands } = require('../server/lib/extract-stands');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const by = (r, n) => r.stands.find(s => s.number === n);

const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3000 1000">';
const labels = (i, n, size) =>
  `<text x="${i * 100 + 5}" y="12">${n}</text><text x="${i * 100 + 60}" y="55">${size}</text>`;
const stand = (i, n, { size = '30 sqm', fill = '#ffffff' } = {}) =>
  `<rect x="${i * 100}" y="0" width="100" height="60" fill="${fill}" stroke="#000"/>` + labels(i, n, size);
/** Six ordinary stands, so the plan has a median stand to judge anything against. */
const row = (opts) => [0, 1, 2, 3, 4, 5].map(i => stand(i, 400 + i, opts)).join('');
const plan = (body) => extractStands(HEAD + body + '</svg>');

console.log('\nEvery spelling of a printed area the brief allows');
for (const [written, area, unit] of [
  ['30 m²', 30, 'sqm'],
  ['30 m<tspan x="1">²</tspan>', 30, 'sqm'],          // superscript, same text object
  ['30 m<tspan y="50">²</tspan>', 30, 'sqm'],         // superscript on its own baseline
  ['30 m2', 30, 'sqm'],
  ['30 sqm', 30, 'sqm'],
  ['30.5 m²', 30.5, 'sqm'],
  ['1,200 m²', 1200, 'sqm'],
  ['300 ft²', 300, 'sqft'],
]) {
  const r = plan(row({ size: written }));
  const s = by(r, '400');
  check(`"${written.replace(/<[^>]+>/g, '')}" reads as ${area} ${unit}`,
        !!s && s.printedArea === area && r.unit === unit,
        s ? `got ${s.printedArea} ${r.unit}` : 'no stand');
}

console.log('\nA name split across lines is still one name');
const named = plan(row() +
  '<text x="20" y="30"><tspan x="20" y="30">Networking</tspan><tspan x="20" y="44">Lounge</tspan></text>');
check('two baselines become a space, not a join',
      by(named, '400') && by(named, '400').exhibitor === 'Networking Lounge',
      JSON.stringify(by(named, '400') && by(named, '400').exhibitor));

console.log('\nShapes that are not <rect>');
const poly = plan(row() +
  '<polygon points="600,0 700,0 700,60 650,60 650,30 600,30" fill="#ffffff" stroke="#000"/>' + labels(6, '499', '20 sqm'));
check('a corner stand drawn as a closed polygon is a stand', !!by(poly, '499'),
      poly.stands.map(s => s.number).join(','));
check('and it is stored at the box it is drawn in',
      by(poly, '499') && by(poly, '499').geometry.x === 600 && by(poly, '499').geometry.w === 100,
      JSON.stringify(by(poly, '499') && by(poly, '499').geometry));

const closed = plan(row() + '<path d="M600,0 H700 V60 H600 Z" fill="#ffffff" stroke="#000"/>' + labels(6, '498', '30 sqm'));
check('a closed path is a stand', !!by(closed, '498'), closed.stands.map(s => s.number).join(','));

const open = plan(row() + '<path d="M600,0 H700 V60 H600" fill="#ffffff"/>' + labels(6, '497', '30 sqm'));
check('an OPEN path is not — it has no inside (R7)', !by(open, '497'));
check('and its number is reported as a stray rather than lost',
      open.issues.orphans.includes('497'), open.issues.orphans.join(','));

console.log('\nColour may be set on the stand, on its layer, or in the stylesheet');
const layered = plan('<g fill="#fcdf6d">' +
  [0, 1, 2].map(i => `<rect x="${i * 100}" y="0" width="100" height="60" stroke="#000"/>` + labels(i, 400 + i, '30 sqm')).join('') +
  '</g>' + [3, 4, 5, 6, 7, 8].map(i => stand(i, 400 + i)).join(''));
check('a stand takes the fill its layer gives it',
      by(layered, '400') && by(layered, '400').fill === '#fcdf6d',
      JSON.stringify(by(layered, '400') && by(layered, '400').fill));
check('so it is sold, not offered for sale',
      by(layered, '400') && by(layered, '400').status === 'sold',
      by(layered, '400') && by(layered, '400').status);
check('and nothing is counted as unreadable', layered.unreadableFills === 0, String(layered.unreadableFills));

const nofill = plan(row() + '<rect x="600" y="0" width="100" height="60" fill="none" stroke="#000"/>' + labels(6, '496', '30 sqm'));
check('a stand with fill="none" has no colour to read', by(nofill, '496') && by(nofill, '496').fill === null);
check('and is treated as available, never as sold',
      by(nofill, '496') && by(nofill, '496').status === 'available',
      by(nofill, '496') && by(nofill, '496').status);

console.log('\nShapes that cannot be a stand do not get to be one');
const boxed = plan(row() +
  '<rect x="600" y="0" width="100" height="60" fill="#fff" stroke="#000"/>' +
  '<rect x="603" y="3" width="18" height="12" fill="#fff"/>' + labels(6, '495', '30 sqm'));
check('a backing box behind a number does not take the number',
      by(boxed, '495') && by(boxed, '495').geometry.w === 100,
      JSON.stringify(by(boxed, '495') && by(boxed, '495').geometry));
check('and the artwork problem is reported', boxed.issues.implausible.includes('495'),
      boxed.issues.implausible.join(','));

const hall = plan(row() + '<rect x="-10" y="-10" width="2000" height="900" fill="none" stroke="#000"/>' +
  '<text x="900" y="700">494</text>');
check('a hall outline does not swallow a stray number', !by(hall, '494'));
check('the stray is reported as a stray', hall.issues.orphans.includes('494'), hall.issues.orphans.join(','));

const big = plan(row() + '<rect x="600" y="0" width="400" height="300" fill="#122830" stroke="#000"/>' +
  '<text x="605" y="12">493</text><text x="900" y="290">1200 sqm</text>');
check('a large feature area IS a stand — size alone never disqualifies one',
      !!by(big, '493'), big.stands.map(s => s.number).join(','));

const f = out.filter(x => !x).length;
console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
process.exit(f ? 1 : 0);
