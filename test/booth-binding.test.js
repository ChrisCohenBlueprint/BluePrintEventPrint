/**
 * Do stands actually bind to the shapes in the artwork?
 *
 * This is the difference between a floorplan and a picture of one. A stand
 * that does not bind takes no clicks, shows no name, and counts for nothing in
 * the stats — with no error anywhere to say so. That is exactly what happened
 * to North America: BoothMap's selector names the fill classes EUROPE's plan
 * uses, and in North America's plan those same class names are text styles.
 */
const { chromium } = require('playwright-core');
const path = require('path');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

// Europe's classes, as BoothMap's selector names them.
const EUROPE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <rect class="cls-10" x="10" y="10" width="25" height="25"/>
  <rect class="cls-10" x="35" y="10" width="25" height="25"/>
  <rect class="cls-8"  x="0"  y="0"  width="200" height="200"/>
</svg>`;

// North America's: the stands are cls-15/16, and cls-9 is the TEXT style for a
// stand number — so the selector matches a text element and no stand at all.
const NORTH_AMERICA = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <rect class="cls-15" x="10" y="10" width="25" height="25"/>
  <rect class="cls-16" x="35" y="10" width="25" height="25"/>
  <rect class="cls-16" x="70" y="10" width="25" height="50" transform="translate(130 -60) rotate(90)"/>
  <text class="cls-9" transform="translate(11 16)"><tspan x="0" y="0">101</tspan></text>
</svg>`;

const BOOTHS = [
  { boothNumber: '101', geometry: { x: 10, y: 10, w: 25, h: 25 }, status: 'available' },
  { boothNumber: '102', geometry: { x: 35, y: 10, w: 25, h: 25 }, status: 'sold' },
];
// Stored as authored, transform not applied — the way the page reads it back.
const ROTATED = { boothNumber: '104', geometry: { x: 70, y: 10, w: 25, h: 50 }, status: 'available' };

async function bind(br, svg, booths) {
  const page = await br.newPage();
  await page.setContent(`<div id="host">${svg}</div>`);
  await page.addScriptTag({ path: path.join(__dirname, '..', 'public', 'booth-map.js') });
  return page.evaluate(({ booths }) => {
    const doc = document.getElementById('host');
    const r = BoothMap.attach(doc, booths, {});
    return {
      placed: Object.keys(r.placed || {}),
      unplaced: (r.unplaced || []).map(b => b.boothNumber),
      tagged: [...doc.querySelectorAll('[data-booth]')].map(e => ({
        n: e.getAttribute('data-booth'), cls: e.getAttribute('class'), tag: e.tagName.toLowerCase(),
      })),
    };
  }, { booths });
}

(async () => {
  const br = await chromium.launch({ channel: 'chrome', headless: true });

  console.log('\nEurope binds exactly as it did');
  const eu = await bind(br, EUROPE, BOOTHS);
  check('both stands bind', eu.placed.length === 2, eu.placed.join(','));
  check('to their own fill shapes, not the hall outline',
        eu.tagged.every(t => t.cls === 'cls-10'), JSON.stringify(eu.tagged));

  console.log('\nNorth America binds too, though its classes are different');
  const na = await bind(br, NORTH_AMERICA, BOOTHS);
  check('both stands bind', na.placed.length === 2, `placed ${na.placed.join(',')} / unplaced ${na.unplaced.join(',')}`);
  check('none is left unbound', na.unplaced.length === 0);
  check('and each is bound to a rect, never to a text label',
        na.tagged.length === 2 && na.tagged.every(t => t.tag === 'rect'), JSON.stringify(na.tagged));

  console.log('\nA rotated stand binds on its authored box');
  const rot = await bind(br, NORTH_AMERICA, [ROTATED]);
  check('the rotated stand binds', rot.placed.includes('104'),
        `placed ${rot.placed.join(',')} / unplaced ${rot.unplaced.join(',')}`);

  await br.close();
  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})();
