/**
 * The downloaded plan is the plan on screen, named after its event.
 *
 * Two ways it was not.
 *
 * Every download was called Floorplan-Floorplan-<date>.png. The filename was
 * meant to start with the event's id (LEX, LNA), read from window.__SHOW.showId
 * — but the server injects { slug, id, name }, so there was never a showId and
 * the fallback won every time. Three events, one filename.
 *
 * And an event whose admin chose colours for its sponsorable areas got them
 * on screen and not in the file. On the page those fills come from a
 * stylesheet rule (.has-area-palette [data-area]); the export rasterises a
 * standalone copy of the SVG that carries none of the page's CSS, and only
 * the stands' fills were written into it. The areas came out in the
 * designer's colours, under a key that did not mention them.
 */
const { start, openPage, artworkRects, stand, reporter, wait } = require('./floorplan-stub');

const { check, finish } = reporter();

(async () => {
  const srv = await start({ show: { slug: 'lna', id: 'LNA', name: 'LubesNA' } });
  const { page, errors } = await openPage(srv.browser, `${srv.base}/floorplan`);
  await wait(1200);

  const rects = await artworkRects(page, 30);
  await page.evaluate(s => window.__fire('state:full', s), rects.map((g, i) => stand(i, g)));
  const areas = await page.evaluate(() => [...document.querySelectorAll('#svg-mount svg rect.cls-6, #svg-mount svg rect.cls-8')]
    .slice(0, 2).map((r, i) => ({ key: 'area' + i, label: 'Area ' + i, status: i ? 'taken' : 'open',
      sponsor: i ? 'Someone' : null, logo: null,
      geometry: { x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') } })));
  await wait(800);

  const exportPlan = async () => {
    await page.evaluate(() => {
      window.__xml = null; window.__download = null;
      if (!window.__hooked) {
        window.__hooked = true;
        const ser = XMLSerializer.prototype.serializeToString;
        XMLSerializer.prototype.serializeToString = function (n) { const s = ser.call(this, n); window.__xml = s; return s; };
        HTMLAnchorElement.prototype.click = function () { window.__download = this.download; };
      }
    });
    await page.click('#download-plan');
    for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__download)); i++) await wait(150);
    return page.evaluate(() => {
      const doc = new DOMParser().parseFromString(window.__xml || '<svg/>', 'image/svg+xml');
      const fillOf = (k) => doc.querySelector(`[data-area="${k}"]`)?.style.getPropertyValue('fill') || '';
      const keyText = [...doc.querySelectorAll('svg > text')].map(t => t.textContent);
      return { name: window.__download, open: fillOf('area0'), taken: fillOf('area1'), keyText };
    });
  };

  console.log('\nThe filename');
  let r = await exportPlan();
  const today = new Date();
  const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  check('starts with the event\'s id', r.name === `LNA-Floorplan-${stamp}.png`, r.name);

  console.log('\nAreas the plan draws in its own colours');
  await page.evaluate(() => window.__fire('settings', { palette: { source: 'artwork', available: '#ffffff', sold: '#689abb' } }));
  await page.evaluate(a => window.__fire('areas:catalogue', a), areas);
  await wait(400);
  r = await exportPlan();
  check('are left exactly as drawn', r.open === '' && r.taken === '', `${r.open} / ${r.taken}`);

  console.log('\nAreas an admin chose colours for');
  await page.evaluate(() => window.__fire('settings', { palette: { source: 'admin', sponsored: '#123456', areaTaken: '#654321' } }));
  await wait(300);
  const onScreen = await page.evaluate(() => [...document.querySelectorAll('#svg-mount svg [data-area]')]
    .map(e => getComputedStyle(e).fill));
  r = await exportPlan();
  check('an open area is painted as it is on screen', r.open === 'rgb(18, 52, 86)' && onScreen[0] === r.open,
        `${r.open} (screen ${onScreen[0]})`);
  check('and a taken one', r.taken === 'rgb(101, 67, 33)' && onScreen[1] === r.taken, `${r.taken} (screen ${onScreen[1]})`);
  check('and the key says what they are', r.keyText.includes('Sponsorship area') && r.keyText.includes('Sponsored area'),
        r.keyText.join(', '));

  check('the page raised no errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  await srv.close();
  finish();
})().catch((e) => { console.error(e); process.exit(1); });
