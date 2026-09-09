/**
 * A stand is painted in the colour its own plan was drawn in.
 *
 * Every event used to be repainted in one palette, so North America's plan —
 * light blue for sold, burgundy for its lounges — came out entirely yellow and
 * stopped looking like the plan that was approved.
 */
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'booth-colours.css'), 'utf8');
// The colours read out of North America's own artwork.
const NA = { available: '#fffcf8', sold: '#689abb', sponsored: '#7c1315' };

(async () => {
  const br = await chromium.launch({ channel: 'chrome', headless: true });
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

  console.log('\nfillFor reports what is actually painted');
  await page.evaluate((p) => BoothPalette.apply(p), NA);
  const reported = await page.evaluate(() => BoothPalette.fillFor('sold'));
  check('so the legend and minimap match the plan', reported === '#689abb', reported);

  await br.close();
  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})();
