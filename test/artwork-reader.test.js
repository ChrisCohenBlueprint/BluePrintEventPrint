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

const f = out.filter(x => !x).length;
console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
process.exit(f ? 1 : 0);
