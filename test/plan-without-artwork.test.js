/**
 * The list and the search open a stand whether or not the plan is there.
 *
 * The A–Z directory exists to be the keyboard and screen-reader route into
 * the hall, and the search's Enter-on-one-match is the other. Both end in
 * selectBooth(), which marked the stand on the plan with
 * svgDoc.querySelector(...) — and while the artwork has failed to load, or is
 * still downloading (it is 2 MB, and usually arrives after the stands do),
 * svgDoc is null. So that line threw, the panel was never drawn, and the
 * route meant for when the map is no use died exactly when the map was no
 * use. The panel is built from the stand's data and never needed the plan;
 * the mark on the map is put on when the plan is there.
 */
const { start, openPage, fileRects, stand, reporter, wait } = require('./floorplan-stub');

const { check, finish } = reporter();

(async () => {
  const srv = await start();
  const rects = fileRects(20);
  const stands = rects.map((g, i) => stand(i, g, i === 5 ? { status: 'held' } : {}));
  const openDirectory = async (page) => {
    if (await page.evaluate(() => document.getElementById('fp-directory').hidden)) await page.click('#directory-toggle');
  };
  const panelText = (page) => page.evaluate(() => document.getElementById('booth-panel').textContent.replace(/\s+/g, ' ').trim());

  console.log('\nThe artwork failed to load');
  srv.state.svgStatus = 500;
  const a = await openPage(srv.browser, `${srv.base}/floorplan`);
  await wait(500);
  check('the page says the plan could not be loaded',
        await a.page.evaluate(() => !!document.querySelector('.load-error')));
  await a.page.evaluate(s => window.__fire('state:full', s), stands);
  await wait(300);

  await openDirectory(a.page);
  await a.page.click('#directory-list [data-dir="101"]');
  await wait(200);
  check('a directory row opens its stand', /Stand 101/.test(await panelText(a.page)), (await panelText(a.page)).slice(0, 60));

  await a.page.fill('#fps-input', '');
  await a.page.type('#fps-input', '102');
  await a.page.keyboard.press('Enter');
  await wait(200);
  check('Enter on the one search match opens it', /Stand 102/.test(await panelText(a.page)), (await panelText(a.page)).slice(0, 60));

  await a.page.fill('#fps-input', '');
  await a.page.type('#fps-input', '103');
  await a.page.keyboard.press('ArrowDown');
  await a.page.keyboard.press('Enter');
  await wait(200);
  check('picking a suggestion opens it', /Stand 103/.test(await panelText(a.page)), (await panelText(a.page)).slice(0, 60));

  await a.page.evaluate(() => document.getElementById('fps-clear').click());
  await openDirectory(a.page);
  await a.page.click('#directory-list [data-dir="105"]');
  await wait(200);
  const alt = await a.page.evaluate(() => document.querySelector('#booth-panel [data-alt]')?.getAttribute('data-alt'));
  check('a taken stand offers alternatives', !!alt, alt);
  if (alt) await a.page.click(`#booth-panel [data-alt="${alt}"]`);
  await wait(200);
  check('and an alternative opens', alt && new RegExp(`Stand ${alt}`).test(await panelText(a.page)),
        (await panelText(a.page)).slice(0, 60));
  check('without a single error', a.errors.length === 0, a.errors.slice(0, 2).join(' | '));

  console.log('\nThe artwork still downloading');
  srv.state.svgStatus = 200;
  srv.state.svgDelay = 2500;
  const b = await openPage(srv.browser, `${srv.base}/floorplan`, { waitUntil: 'domcontentloaded' });
  await wait(200);
  await b.page.evaluate(s => window.__fire('state:full', s), stands);
  await openDirectory(b.page);
  await b.page.click('#directory-list [data-dir="101"]');
  await wait(200);
  check('a directory row opens its stand', /Stand 101/.test(await panelText(b.page)), (await panelText(b.page)).slice(0, 60));
  check('and the plan is still on its way', await b.page.evaluate(() => !document.querySelector('#svg-mount svg')));
  await wait(4000);
  const ringed = await b.page.evaluate(() =>
    document.querySelector('#svg-mount svg [data-booth="101"]')?.classList.contains('booth-selected') || false);
  check('once it arrives, the stand is marked on it', ringed);
  check('without a single error', b.errors.length === 0, b.errors.slice(0, 2).join(' | '));

  await srv.close();
  finish();
})().catch((e) => { console.error(e); process.exit(1); });
