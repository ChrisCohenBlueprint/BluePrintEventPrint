/**
 * The reader does what the two designer documents say it does.
 *
 * BEC-FP-01 and the designer brief are promises to someone outside the
 * company: draw it this way and it will be read. Each section below is one of
 * those promises the reader was not keeping, held to it — and each is checked
 * against the real shipped plans too, because a fix that changes how a live
 * event's plan reads is not a fix.
 */
const fs = require('fs');
const path = require('path');
const { extractStands, stripExhibitorNames } = require('../server/lib/extract-stands');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const LNA = fs.readFileSync(path.join(__dirname, '..', 'public', 'LNA27_Floorplan_Web-Format_24.svg'), 'utf8');

/**
 * A row of stands, one per entry: [number, fill, stroke, name?]. Drawn 100
 * wide, numbered top-left, sized bottom-right, named in the middle — exactly
 * as the brief asks.
 */
function plan(cells, { style = '', extra = '' } = {}) {
  const body = cells.map(([n, fill, stroke, name], i) => {
    const x = (i % 20) * 100, y = Math.floor(i / 20) * 80;
    const paint = `${fill ? ` fill="${fill}"` : ''}${stroke ? ` stroke="${stroke}"` : ''}`;
    return `<rect x="${x}" y="${y}" width="100" height="80"${paint}/>` +
      `<text x="${x + 4}" y="${y + 12}">${n}</text>` +
      (name ? `<text x="${x + 30}" y="${y + 40}">${name}</text>` : '') +
      `<text x="${x + 60}" y="${y + 74}">30 m²</text>`;
  }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2000 800">${style}${body}${extra}</svg>`;
}
const read = (svg) => {
  const r = extractStands(svg);
  r.by = (n) => r.stands.find(s => s.number === n);
  r.count = (status) => r.stands.filter(s => s.status === status && !s.sponsored).length;
  return r;
};

console.log('\nA hold is the taken fill with a different stroke (R12, brief §5)');
{
  // The case that was wrong: available stands are the majority and outlined
  // in grey, taken stands in black. "Outlined differently to most stands"
  // made every taken stand a hold, and the import wrote a no-expiry hold on
  // each of them.
  const cells = [];
  for (let i = 0; i < 30; i++) cells.push([String(100 + i), '#ffffff', '#999999']);
  for (let i = 0; i < 8; i++) cells.push([String(200 + i), '#fcdf6d', '#000000', `Exhibitor ${i}`]);
  let r = read(plan(cells));
  check('taken stands outlined unlike the available ones are sold, not held',
        r.count('sold') === 8 && r.count('held') === 0, JSON.stringify(r.fills.map(f => `${f.fill}/${f.stroke}:${f.status}`)));

  cells.push(['300', '#fcdf6d', '#ed1c24', 'Reserved Co'], ['301', '#fcdf6d', '#ed1c24', 'Also Reserved']);
  r = read(plan(cells));
  check('a taken-fill stand in the red stroke is held', r.by('300').status === 'held' && r.by('301').status === 'held');
  check('and the taken stands around it are still sold', r.count('sold') === 8, String(r.count('sold')));
  check('and the available ones available', r.count('available') === 30);

  // An early issue: nothing much sold yet, more holds than sales. The stroke
  // the taken stands share is the one the rest of the plan is outlined in.
  const early = [];
  for (let i = 0; i < 30; i++) early.push([String(100 + i), '#ffffff', '#013149']);
  early.push(['200', '#fcdf6d', '#013149', 'Sold Ltd'], ['201', '#fcdf6d', '#013149', 'Sold Too']);
  early.push(['300', '#fcdf6d', '#ed1c24', 'A'], ['301', '#fcdf6d', '#ed1c24', 'B'], ['302', '#fcdf6d', '#ed1c24', 'C']);
  r = read(plan(early));
  check('on an early issue with more holds than sales, the holds are the red ones',
        ['300', '301', '302'].every(n => r.by(n).status === 'held') &&
        ['200', '201'].every(n => r.by(n).status === 'sold'),
        ['200', '300'].map(n => `${n}:${r.by(n).status}`).join(' '));

  // A lounge drawn dark with no outline: different stroke, but not the taken
  // fill, so it is a sponsorable area — not a held stand.
  const lounge = cells.concat([['501', '#122830', 'none', 'VIP Lounge'], ['502', '#122830', 'none', 'Speaker Prep']]);
  r = read(plan(lounge));
  check('a lounge drawn dark with no stroke is an area, not a hold',
        r.by('501').sponsored === true && r.by('501').status !== 'held' && r.by('502').sponsored === true,
        `${r.by('501').status}/${r.by('501').sponsored}`);
  check('and no area is ever counted as a held stand',
        r.stands.filter(s => s.sponsored && s.status === 'held').length === 0);
}

console.log('\nNorth America\'s plan reads exactly as it did');
{
  const r = read(LNA);
  const tally = r.stands.reduce((a, s) => { const k = s.sponsored ? 'area' : s.status; a[k] = (a[k] || 0) + 1; return a; }, {});
  check('99 shapes: 19 available, 70 sold, 4 held, 6 areas',
        r.stands.length === 99 && tally.available === 19 && tally.sold === 70 && tally.held === 4 && tally.area === 6,
        JSON.stringify(tally));
  check('the four holds are the red-stroked taken stands',
        ['124', '128', '429', '625'].every(n => r.by(n).status === 'held'));
}

console.log('\nArea names stay on the plan; only exhibitor names come off');
{
  const cells = [];
  for (let i = 0; i < 20; i++) cells.push([String(100 + i), '#ffffff', '#000000']);
  for (let i = 0; i < 10; i++) cells.push([String(200 + i), '#fcdf6d', '#000000', `Exhibitor ${i}`]);
  cells.push(['501', '#122830', '#000000', 'VIP Lounge'], ['502', '#122830', '#000000', 'Conference Track 1']);
  const svg = plan(cells);
  const r = read(svg);
  check('the areas are read as areas', r.by('501').sponsored && r.by('502').sponsored);
  check('their names are not queued to be stripped',
        !r.printedNames.includes('VIP Lounge') && !r.printedNames.includes('Conference Track 1'),
        JSON.stringify(r.printedNames.filter(n => !/^Exhibitor/.test(n))));
  check('every exhibitor name is', r.printedNames.filter(n => /^Exhibitor/.test(n)).length === 10);
  const shown = stripExhibitorNames(svg, r.printedNames).svg;
  check('the copy shown keeps the area names', /VIP Lounge/.test(shown) && /Conference Track 1/.test(shown));
  check('and loses the exhibitor names', !/Exhibitor \d/.test(shown));

  const lna = read(LNA);
  const shownLna = stripExhibitorNames(LNA, lna.printedNames).svg;
  const areas = lna.stands.filter(s => s.sponsored).map(s => s.exhibitor);
  check('on North America\'s plan all six area names survive the strip',
        areas.length === 6 && areas.every(a => read(shownLna).stands.some(s => s.exhibitor === a)),
        JSON.stringify(areas));
  check('while every exhibitor name on a stand comes off',
        read(shownLna).stands.filter(s => !s.sponsored && s.exhibitor).length === 0);
}

console.log('\nA stylesheet is read the way CSS applies it (R12 note, brief §5 and §9)');
{
  // A row drawn with class="…" only, so the stylesheet is the only place a
  // colour can come from.
  const row = (classes) => classes.map((cls, i) =>
    `<rect class="${cls}" x="${i * 100}" y="0" width="100" height="80"/>` +
    `<text x="${i * 100 + 4}" y="12">${100 + i}</text><text x="${i * 100 + 60}" y="74">30 m²</text>`).join('');
  const svg = (style, classes) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 100"><style>${style}</style>${row(classes)}</svg>`;

  // CorelDRAW writes one class for the fill and another for the stroke.
  let r = read(svg('.fil0{fill:#ffffff}.fil1{fill:#fcdf6d}.str0{stroke:#000000}.str1{stroke:#ed1c24}',
                   ['fil0 str0', 'fil0 str0', 'fil0 str0', 'fil1 str0', 'fil1 str0', 'fil1 str0', 'fil1 str1']));
  check('class="fil1 str0" takes its fill from one rule and its stroke from the other',
        r.by('103').fill === '#fcdf6d' && r.by('103').stroke === '#000000',
        `${r.by('103').fill} / ${r.by('103').stroke}`);
  check('so the plan reads: available, sold and held',
        r.by('100').status === 'available' && r.by('103').status === 'sold' && r.by('106').status === 'held',
        ['100', '103', '106'].map(n => r.by(n).status).join(' '));
  check('and no stand is left without a colour', r.unreadableFills === 0, String(r.unreadableFills));

  // Two classes setting the same property: the LATER rule wins, whatever
  // order the classes are written in on the element.
  r = read(svg('.base{fill:#ffffff}.sold{fill:#fcdf6d}', ['sold base', 'base', 'base', 'base', 'base']));
  check('where two classes both set the fill, the later rule wins', r.by('100').fill === '#fcdf6d', r.by('100').fill);

  // Illustrator and Inkscape can wrap the stylesheet in CDATA, which made the
  // first selector "<![CDATA[ .st0" and lost the first rule.
  r = read(svg('<![CDATA[\n  .st0{fill:#FFFFFF;stroke:#000}\n  .st1{fill:#FCDF6D;stroke:#000}\n]]>',
               ['st0', 'st0', 'st1', 'st1', 'st1']));
  check('a stylesheet wrapped in CDATA keeps its first rule',
        r.by('100').fill === '#ffffff' && r.by('100').status === 'available', `${r.by('100').fill}`);
  check('and its last', r.by('102').fill === '#fcdf6d' && r.by('102').status === 'sold');

  r = read(svg('/* stands { colours } */ .st0{fill:#ffffff} /* taken */ .st1{fill:#fcdf6d}', ['st0', 'st1', 'st1']));
  check('a comment in the stylesheet does not swallow a rule', r.by('100').fill === '#ffffff' && r.by('101').fill === '#fcdf6d',
        `${r.by('100').fill} ${r.by('101').fill}`);
}

console.log('\nSplit cells are read under the numbers the schedule gives them (R20, R23)');
{
  // The app names the cells of a split stand 105, 105-2, 105-3, and that is
  // what the stand schedule sent to the designer lists. A designer following
  // R23 draws exactly that — and every cell came back "missing".
  const cells = [];
  for (let i = 0; i < 10; i++) cells.push([String(200 + i), '#ffffff', '#000000']);
  cells.push(['105', '#ffffff', '#000000'], ['105-2', '#ffffff', '#000000'], ['105-3', '#fcdf6d', '#000000', 'Cell Three Ltd']);
  cells.push(['106a', '#ffffff', '#000000'], ['106b', '#ffffff', '#000000']);
  const r = read(plan(cells));
  check('105-2 and 105-3 are stand numbers', !!r.by('105-2') && !!r.by('105-3'),
        r.stands.map(s => s.number).filter(n => /^10[56]/.test(n)).join(','));
  check('with their own exhibitor and status', r.by('105-3').exhibitor === 'Cell Three Ltd' && r.by('105-3').status === 'sold');
  check('and none of them is read as a name', !r.stands.some(s => /^10[56]/.test(s.exhibitor || '')));
  check('a lower-case letter suffix is read, as a capital', !!r.by('106A') && !!r.by('106B'),
        r.stands.map(s => s.number).filter(n => /^106/.test(n)).join(','));

  const { diffStands } = require('../server/lib/plan-diff');
  const at = (n) => r.by(n).geometry;
  const existing = ['105', '105-2', '105-3'].map(n => ({ boothNumber: n, status: 'available', geometry: at(n) }));
  const d = diffStands(r.stands.filter(s => !s.sponsored), existing);
  check('so a re-issue drawn from the schedule finds every cell where it was',
        d.summary.missing === 0 && d.unchanged.length === 3, JSON.stringify(d.summary));

  const brief = fs.readFileSync(path.join(__dirname, '..', 'docs', 'floorplan-designer-brief.html'), 'utf8');
  const spec = fs.readFileSync(path.join(__dirname, '..', 'docs', 'floorplan-artwork-spec.html'), 'utf8');
  check('the brief names the form the app uses, not 105a', /105-2/.test(brief) && !/105a/.test(brief));
  check('and so does the specification', /105-2/.test(spec));
}

console.log('\nA decimal comma is a decimal (R20, brief §3)');
{
  const cells = [];
  for (let i = 0; i < 6; i++) cells.push([String(100 + i), '#ffffff', '#000000']);
  const svg = plan(cells)
    .replace('>30 m²<', '>30,5 m²<')
    .replace('>30 m²<', '>30.5 m²<')
    .replace('>30 m²<', '>1,250 m²<')
    .replace('>30 m²<', '>12,75 m²<');
  const r = read(svg);
  check('"30,5 m²" is thirty and a half', r.by('100').printedArea === 30.5, String(r.by('100').printedArea));
  check('as "30.5 m²" is', r.by('101').printedArea === 30.5, String(r.by('101').printedArea));
  check('a comma before three digits still separates thousands', r.by('102').printedArea === 1250,
        String(r.by('102').printedArea));
  check('two decimals with a comma read too', r.by('103').printedArea === 12.75, String(r.by('103').printedArea));
}

console.log('\nA rectangle placed only by its transform is read (R17, brief §9)');
{
  // x and y default to 0 in SVG, so a rect positioned entirely by
  // transform="translate(…)" is a perfectly good shape — and was dropped,
  // leaving its number outside every stand.
  const cells = [];
  for (let i = 0; i < 5; i++) cells.push([String(100 + i), '#ffffff', '#000000']);
  const svg = plan(cells, { extra:
    '<rect transform="translate(600 0)" width="100" height="80" fill="#fcdf6d" stroke="#000000"/>' +
    '<text x="604" y="12">777</text><text x="660" y="74">30 m²</text>' });
  const r = read(svg);
  check('the stand is found', !!r.by('777'), r.warnings.join(' | '));
  check('where it appears', r.by('777') && r.by('777').visual.x === 600 && r.by('777').visual.w === 100,
        JSON.stringify(r.by('777') && r.by('777').visual));
  check('and its number is not reported as astray', !r.issues.orphans.includes('777'));
}

console.log('\nTwo stands that are one rectangle in two placed groups are reported');
{
  // The page binds a stand to its shape by the rectangle's own attributes,
  // before any group transform. Two stands drawn as copies of one rectangle,
  // moved apart only by their groups, look identical to it, and the second
  // would answer to the first. The reader cannot fix that without changing
  // how every existing plan binds, so it says so, by number.
  const rowOf = (ty, base) => `<g transform="translate(0 ${ty})">` +
    [0, 1, 2, 3].map(i => `<rect x="${i * 100}" y="0" width="100" height="80" fill="#ffffff" stroke="#000"/>` +
      `<text x="${i * 100 + 4}" y="12">${base + i}</text><text x="${i * 100 + 60}" y="74">30 m²</text>`).join('') + '</g>';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">${rowOf(0, 101)}${rowOf(100, 201)}</svg>`;
  const r = read(svg);
  check('every stand is still read, where it appears', r.stands.length === 8 && r.by('201').visual.y === 100);
  check('the shared shapes are listed as an issue', Array.isArray(r.issues.sharedShape) &&
        r.issues.sharedShape.some(p => /101/.test(p) && /201/.test(p)), JSON.stringify(r.issues.sharedShape));
  const w = r.warnings.find(x => /same rectangle/.test(x)) || '';
  check('and the preview says which stands, and what it means', /101/.test(w) && /201/.test(w) && /first/.test(w), w);

  const lna = read(LNA);
  check('North America\'s plan has none of this', (lna.issues.sharedShape || []).length === 0,
        JSON.stringify(lna.issues.sharedShape));
}

const f = out.filter(x => !x).length;
console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
process.exit(f ? 1 : 0);
