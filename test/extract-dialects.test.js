/**
 * Reading a plan that was NOT drawn in Illustrator.
 *
 * The extractor was written against one export's dialect and it showed. None of
 * these failures announced themselves — each one silently lost or corrupted
 * stands and then reported a clean import:
 *
 *   - `x=` matched inside `rx=`, so every ROUNDED rectangle took its corner
 *     radius as its position and landed at the top-left of the hall
 *   - only double-quoted attributes were read at all
 *   - fills were read only through CSS classes, so a plan colouring by
 *     attribute or inline style gave every stand a null fill — and every stand
 *     imported as SOLD
 *   - text was only found when positioned by transform="translate(...)", so an
 *     Inkscape or Figma plan yielded no stands and the organiser was told the
 *     designer had converted the text to outlines
 *   - only rotate(90) written one exact way was resolved; rotate(-90),
 *     matrix(...) and a transform on an enclosing <g> were ignored, putting the
 *     shape in a coordinate space no label could reach
 *   - entities were never decoded, so "Barentz &amp; Co" was stored as the
 *     exhibitor's name
 */
const { extractStands } = require('../server/lib/extract-stands');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const by = (r, n) => r.stands.find(s => s.number === n);

console.log('\nA rounded rectangle is where it is drawn, not where its corner radius is');
const rounded = extractStands(`<svg xmlns="http://www.w3.org/2000/svg">
  <rect rx="4" ry="4" x="100" y="200" width="50" height="50" fill="#ffffff"/>
  <text x="110" y="220">101</text>
</svg>`);
check('the stand is found', rounded.stands.length === 1, `${rounded.stands.length} found`);
check('at the position the plan actually gives it',
      rounded.stands.length && by(rounded, '101').geometry.x === 100 && by(rounded, '101').geometry.y === 200,
      JSON.stringify(rounded.stands[0] && rounded.stands[0].geometry));

console.log('\nSingle quotes are quotes');
const quoted = extractStands(`<svg xmlns='http://www.w3.org/2000/svg'>
  <rect x='10' y='10' width='30' height='30' fill='#ffffff'/>
  <text x='15' y='20'>202</text>
</svg>`);
check('a single-quoted plan reads the same as a double-quoted one',
      quoted.stands.length === 1 && by(quoted, '202').geometry.w === 30,
      `${quoted.stands.length} found`);

console.log('\nText positioned by x/y, which is what everything except Illustrator writes');
const xy = extractStands(`<svg xmlns="http://www.w3.org/2000/svg">
  <style>.e{fill:#fffcf8;stroke:#013149}.s{fill:#689abb;stroke:#013149}</style>
  <rect class="e" x="0" y="0" width="30" height="30"/>
  <rect class="s" x="30" y="0" width="30" height="30"/>
  <text x="5" y="10">301</text>
  <text x="5" y="20">100m</text>
  <text x="35" y="10">302</text>
  <text x="35" y="20"><tspan x="35" y="20">Barentz &amp; Co</tspan></text>
</svg>`);
check('both stands are found', xy.stands.length === 2, `${xy.stands.length} found`);
check('and nobody is told the artwork was converted to outlines',
      !xy.warnings.some(w => /outlines/i.test(w)), xy.warnings.join(' | '));
check('the printed area is read', by(xy, '301').area === 100 && by(xy, '301').areaSource === 'printed');
check('entities are decoded, so the exhibitor is named as they are named',
      by(xy, '302').exhibitor === 'Barentz & Co', JSON.stringify(by(xy, '302').exhibitor));

console.log('\nA plan with no live text at all still says so plainly');
const outlined = extractStands(`<svg xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="30" height="30"/><path d="M0 0h10v10z"/></svg>`);
check('no stands rather than wrong ones', outlined.stands.length === 0);
check('and outlines are named as the likely cause',
      /outlines/i.test(outlined.warnings.join(' ')), outlined.warnings[0]);

console.log('\nBut text that is simply unreadable is not blamed on the designer');
const noNumbers = extractStands(`<svg xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="30" height="30"/>
  <text x="5" y="10">ENTRANCE</text><text x="5" y="20">Cloakroom</text></svg>`);
check('the message reports what was actually seen',
      /2 text runs were found/.test(noNumbers.warnings[0]), noNumbers.warnings[0]);
check('and does not claim the text was converted to outlines',
      !/outlines/i.test(noNumbers.warnings.join(' ')));

console.log('\nFills stated by attribute and by inline style');
// Read only through CSS classes, every one of these had a null fill — and a
// null fill fell through to "everything else", which is SOLD. A whole hall
// imported as sold is a hall nobody can sell.
const painted = extractStands(`<svg xmlns="http://www.w3.org/2000/svg">
  <rect x="0"  y="0" width="20" height="20" fill="#fffcf8" stroke="#013149"/>
  <rect x="20" y="0" width="20" height="20" style="fill:#689abb;stroke:#013149"/>
  <rect x="40" y="0" width="20" height="20" fill="rgb(104,154,187)" stroke="#013149"/>
  <rect x="60" y="0" width="20" height="20" fill="white" stroke="#013149"/>
  <text x="5"  y="10">401</text><text x="25" y="10">402</text>
  <text x="45" y="10">403</text><text x="65" y="10">404</text>
</svg>`);
check('a white attribute fill is an empty stand', by(painted, '401').status === 'available', by(painted, '401').status);
check('an inline style fill is read', by(painted, '402').status === 'sold', by(painted, '402').status);
check('so is an rgb() fill', by(painted, '403').status === 'sold', by(painted, '403').status);
check('and the colour keyword "white"', by(painted, '404').status === 'available', by(painted, '404').status);
check('none of them is flagged as unreadable', painted.unreadableFills === 0);

console.log('\nA stand whose colour cannot be read defaults to AVAILABLE, and is counted');
// The two failures are not symmetrical: a stand wrongly available is corrected
// in a click, a stand wrongly sold is invisible to sales for the whole show.
const unknown = extractStands(`<svg xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="20" height="20"/><text x="5" y="10">501</text></svg>`);
check('it is available, not sold', by(unknown, '501').status === 'available', by(unknown, '501').status);
check('it is marked so the import can refuse the plan', by(unknown, '501').fillUnknown === true);
check('and the count is reported', unknown.unreadableFills === 1);
check('with a warning that says what to check',
      unknown.warnings.some(w => /no fill colour/.test(w) && /treated as available/.test(w)),
      unknown.warnings.join(' | '));

console.log('\nRotation, however the tool spelled it');
// One shape, four spellings of the same placement. The stored geometry is
// always the AUTHORED box — the page binds a stand by reading x/y/width/height
// without applying the transform — while the label has to be matched in the
// space the shape actually appears in.
const spellings = {
  'rotate(90)':   'transform="translate(130 -60) rotate(90)"',
  'rotate(-90)':  'transform="translate(60 105) rotate(-90)"',
  'matrix(...)':  'transform="matrix(0 1 -1 0 130 -60)"',
};
for (const [name, t] of Object.entries(spellings)) {
  const r2 = extractStands(`<svg xmlns="http://www.w3.org/2000/svg">
    <rect x="70" y="10" width="25" height="50" fill="#ffffff" ${t}/>
    <text x="0" y="0" transform="translate(75 20)">601</text>
  </svg>`);
  const s = by(r2, '601');
  check(`${name} places the shape where its label is`, !!s, `${r2.stands.length} stands`);
  if (s) check(`${name} stores the authored box, which is what the page binds on`,
               s.geometry.x === 70 && s.geometry.w === 25,
               JSON.stringify(s.geometry));
}

console.log('\nA transform on an enclosing group belongs to what is inside it');
// Exports commonly wrap the whole plan in one translated <g>. Read without it,
// every shape sits hundreds of units from its own label and the plan reads as
// empty.
const grouped = extractStands(`<svg xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(500 400)">
    <g transform="translate(0 100)">
      <rect x="0" y="0" width="40" height="40" fill="#ffffff"/>
      <text x="5" y="10">701</text>
    </g>
  </g>
  <rect x="0" y="0" width="40" height="40" fill="#ffffff"/>
  <text x="5" y="10">702</text>
</svg>`);
check('a stand inside two nested groups is still found', !!by(grouped, '701'),
      grouped.stands.map(s => s.number).join(','));
check('and one outside them is not confused with it', !!by(grouped, '702'));
check('the stored box is still the one authored on the element',
      by(grouped, '701') && by(grouped, '701').geometry.x === 0,
      JSON.stringify(by(grouped, '701') && by(grouped, '701').geometry));

const f = out.filter(x => !x).length;
console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
process.exit(f ? 1 : 0);
