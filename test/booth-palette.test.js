/**
 * A stand is painted in the colour its own plan was drawn in.
 *
 * Every event used to be repainted in one palette, so North America's plan —
 * light blue for sold, burgundy for its lounges — came out entirely yellow and
 * stopped looking like the plan that was approved.
 */
const { launch, listen } = require('./harness');
const path = require('path');
const fs = require('fs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'booth-colours.css'), 'utf8');
// The colours read out of North America's own artwork.
const NA = { available: '#fffcf8', sold: '#689abb', sponsored: '#7c1315' };

(async () => {
  const br = await launch();
  const page = await br.newPage();
  await page.setContent(`<style>${CSS}</style>
    <svg><rect id="a" class="booth-available"/><rect id="s" class="booth-sold"/>
         <rect id="h" class="booth-held"/><rect id="p" class="booth-sponsored"/></svg>`);
  await page.addScriptTag({ path: path.join(__dirname, '..', 'public', 'booth-palette.js') });

  const paint = (id) => page.evaluate(
    (i) => getComputedStyle(document.getElementById(i)).fill, id);

  console.log('\nWith no palette, the app\'s own colours');
  check('sold is the app yellow', (await paint('s')).includes('252, 223, 109'), await paint('s'));
  check('on hold is the app orange', (await paint('h')).includes('249, 115, 22'), await paint('h'));

  console.log('\nWith the plan\'s palette applied');
  await page.evaluate((p) => BoothPalette.apply(p), NA);
  check('sold is the plan\'s light blue', (await paint('s')).includes('104, 154, 187'), await paint('s'));
  check('empty is the plan\'s near-white', (await paint('a')).includes('255, 252, 248'), await paint('a'));
  check('a sponsorable area is the plan\'s burgundy',
        (await paint('p')).includes('124, 19, 21'), await paint('p'));
  // A hold starts and expires in the app, so it means the same on every event.
  check('on hold stays the app orange', (await paint('h')).includes('249, 115, 22'), await paint('h'));

  console.log('\nSwitching back to an event with no palette');
  await page.evaluate(() => BoothPalette.apply(null));
  check('the app\'s colours return', (await paint('s')).includes('252, 223, 109'), await paint('s'));
  check('rather than the last event\'s lingering', !(await paint('s')).includes('104, 154, 187'));

  console.log('\nEvery status can be asked for, not just the ones artwork sets');
  // held was missing from the lookup, so fillFor('held') fell through to the
  // available colour and the DOWNLOADED plan painted every held stand white —
  // on Europe, which nothing here was supposed to touch.
  await page.evaluate(() => BoothPalette.apply(null));
  check('held resolves to the app orange, not white',
        (await page.evaluate(() => BoothPalette.fillFor('held'))) === '#f97316',
        await page.evaluate(() => BoothPalette.fillFor('held')));
  await page.evaluate((p) => BoothPalette.apply(p), NA);
  check('and stays orange under an event palette',
        (await page.evaluate(() => BoothPalette.fillFor('held'))) === '#f97316');
  check('an unknown status does not silently become available',
        (await page.evaluate(() => BoothPalette.fillFor('nonsense'))) === '#ffffff');

  console.log('\nfillFor reports what is actually painted');
  await page.evaluate((p) => BoothPalette.apply(p), NA);
  const reported = await page.evaluate(() => BoothPalette.fillFor('sold'));
  check('so the legend and minimap match the plan', reported === '#689abb', reported);

  console.log('\nA palette read off the plan leaves the areas as drawn');
  await page.setContent(`<style>${CSS}</style>
    <svg><rect id="a" class="booth-available"/><rect id="s" class="booth-sold"/>
         <rect id="h" class="booth-held"/>
         <rect id="open" data-area="vip" style="fill:#7c1315"/>
         <rect id="taken" data-area="sales" class="area-taken" style="fill:#013149"/></svg>`);
  await page.addScriptTag({ path: path.join(__dirname, '..', 'public', 'booth-palette.js') });
  await page.evaluate((p) => BoothPalette.apply(p), { ...NA, source: 'artwork', areaTaken: '#00ff00' });
  check('an open area keeps the plan\'s burgundy', (await paint('open')).includes('124, 19, 21'), await paint('open'));
  check('a taken area keeps the plan\'s navy', (await paint('taken')).includes('1, 49, 73'), await paint('taken'));
  check('and the page does not claim to paint areas', !(await page.evaluate(() => BoothPalette.paintsAreas())));
  // A held colour on an artwork-sourced palette is ignored: nobody chose it.
  await page.evaluate((p) => BoothPalette.apply(p), { ...NA, source: 'artwork', held: '#00ff00' });
  check('on hold is not taken from a reading either', (await paint('h')).includes('249, 115, 22'), await paint('h'));

  console.log('\nA palette an admin chose paints everything it names');
  const CHOSEN = { available: '#ffffff', sold: '#111111', held: '#00ff00', sponsored: '#ff00ff', areaTaken: '#0000ff', source: 'admin' };
  await page.evaluate((p) => BoothPalette.apply(p), CHOSEN);
  check('on hold is the chosen colour', (await paint('h')).includes('0, 255, 0'), await paint('h'));
  check('an open area is the chosen colour', (await paint('open')).includes('255, 0, 255'), await paint('open'));
  check('a taken area is the chosen colour', (await paint('taken')).includes('0, 0, 255'), await paint('taken'));
  check('and the page says so', await page.evaluate(() => BoothPalette.paintsAreas()));
  check('fillFor knows the area colours too',
        (await page.evaluate(() => BoothPalette.fillFor('areaTaken'))) === '#0000ff');

  console.log('\nA chosen colour left unset means the app\'s own');
  await page.evaluate((p) => BoothPalette.apply(p), { sold: '#111111', source: 'admin' });
  check('on hold is back to the app orange', (await paint('h')).includes('249, 115, 22'), await paint('h'));
  check('the areas are left as drawn again', (await paint('open')).includes('124, 19, 21') &&
        !(await page.evaluate(() => BoothPalette.paintsAreas())));

  await br.close();
  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})();
