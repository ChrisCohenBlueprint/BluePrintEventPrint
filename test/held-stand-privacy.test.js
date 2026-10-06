/**
 * A stand on hold never says who is holding it.
 *
 * A hold is a provisional deal. Naming the company on one announces a booking
 * nobody has agreed to — to the prospect's competitors, on a page that is
 * public and embedded in the marketing site. The panel, the directory and the
 * accessible name already followed that rule; the plan itself did not. The
 * painter drew a name on any stand that was not available, so "Acme Holdings
 * Ltd" sat on the orange stand; the search matched a company whatever the
 * stand's status, so typing "acme" offered "Exhibitor: Acme Holdings Ltd —
 * Stand 102"; and the PNG download cloned the painted names, so it went into
 * the file as well.
 *
 * The server is to stop sending a held stand's company at all. That is not
 * relied on here: every row below carries one, because the page must hold the
 * line on its own. A stand that WAS sold and then goes on hold is covered too —
 * the page merges each broadcast into what it already had, so a company that
 * simply stops arriving would otherwise linger from the sold days.
 */
const { start, openPage, artworkRects, stand, reporter, wait } = require('./floorplan-stub');

const { check, finish } = reporter();

(async () => {
  const srv = await start();
  const { page, errors } = await openPage(srv.browser, `${srv.base}/floorplan`);
  await wait(1200);

  const rects = await artworkRects(page, 60);
  const stands = rects.map((g, i) => stand(i, g));
  stands[0] = stand(0, rects[0], { status: 'held', company: 'Acme Holdings Ltd' });
  stands[1] = stand(1, rects[1], { status: 'sold', company: 'Beta Lubricants' });
  await page.evaluate(s => window.__fire('state:full', s), stands);
  await wait(1500);

  const painted = () => page.evaluate(() =>
    [...document.querySelectorAll('#svg-mount svg [id^="text-booth-"]')].map(t => t.textContent).join(' | '));

  console.log('\nOn the plan');
  let names = await painted();
  check('a sold stand has its exhibitor painted on it', /Beta/.test(names), names);
  check('a held stand does not', !/Acme/.test(names), names);
  const aria = await page.evaluate(() =>
    document.querySelector('#svg-mount svg [data-booth="100"]')?.getAttribute('aria-label') || '');
  check('nor is it in the stand\'s accessible name', !/Acme/.test(aria), aria);

  console.log('\nIn the search');
  const typeIn = async (q) => {
    await page.fill('#fps-input', '');
    await page.type('#fps-input', q);
    await wait(150);
    return page.evaluate(() => ({
      suggest: document.getElementById('fps-suggest').textContent.replace(/\s+/g, ' ').trim(),
      count: document.getElementById('fps-count').textContent,
      lit: [...document.querySelectorAll('#svg-mount svg .booth-match')].map(e => e.getAttribute('data-booth')),
    }));
  };
  let r = await typeIn('beta');
  check('a sold exhibitor is offered by name', /Beta Lubricants/.test(r.suggest), r.suggest);
  r = await typeIn('acme');
  check('a held stand\'s company is not offered', !/Acme/.test(r.suggest), r.suggest || '(no suggestions)');
  check('and matches no stand', r.count === 'No stands match' && r.lit.length === 0, `${r.count}; lit ${r.lit}`);
  r = await typeIn('100');
  check('the held stand is still findable by its number', /Stand 100/.test(r.suggest), r.suggest);
  check('without its company beside it', !/Acme/.test(r.suggest), r.suggest);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await wait(300);
  const box = await page.evaluate(() => document.getElementById('fps-input').value);
  check('picking it does not put the company in the search box', !/Acme/.test(box), JSON.stringify(box));
  const panel = await page.evaluate(() => document.getElementById('booth-panel').textContent.replace(/\s+/g, ' '));
  check('and its panel does not name it', /Stand 100/.test(panel) && !/Acme/.test(panel), panel.slice(0, 120));
  await page.evaluate(() => document.getElementById('fps-clear').click());

  console.log('\nIn the directory');
  await page.click('#directory-toggle');
  await wait(200);
  const dir = await page.evaluate(() => document.getElementById('directory-list').textContent);
  check('the sold exhibitor is listed', /Beta Lubricants/.test(dir));
  check('the held company is not', !/Acme/.test(dir));
  await page.keyboard.press('Escape');

  console.log('\nIn the download');
  const xml = async () => {
    await page.evaluate(() => {
      window.__xml = null;
      const ser = XMLSerializer.prototype.serializeToString;
      XMLSerializer.prototype.serializeToString = function (n) { const s = ser.call(this, n); window.__xml = s; return s; };
      HTMLAnchorElement.prototype.click = function () { window.__download = this.download; };
    });
    await page.click('#download-plan');
    for (let i = 0; i < 40; i++) {
      if (await page.evaluate(() => !!window.__xml)) break;
      await wait(150);
    }
    return page.evaluate(() => window.__xml || '');
  };
  const file = await xml();
  check('the export was generated', file.length > 1000, `${file.length} chars`);
  check('the sold exhibitor is in it', /Beta Lubricants/.test(file));
  check('the held company is not', !/Acme/.test(file));

  console.log('\nA sold stand that goes on hold');
  // The server stops sending the company for a hold, so it simply is not in
  // this row. What the page already had must not be kept.
  const onHold = { ...stands[1], status: 'held' };
  delete onHold.company;
  await page.evaluate(s => window.__fire('state:full', s), [stands[0], onHold, ...stands.slice(2)]);
  await wait(600);
  names = await painted();
  check('loses the name it had while sold', !/Beta/.test(names), names || '(no names painted)');
  r = await typeIn('beta');
  check('and is no longer found by it', !/Beta/.test(r.suggest) && r.lit.length === 0, `${r.suggest}; lit ${r.lit}`);

  check('the page raised no errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  await srv.close();
  finish();
})().catch((e) => { console.error(e); process.exit(1); });
