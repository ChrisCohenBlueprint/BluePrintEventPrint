/**
 * What is in the enquiry is what can still be had — and the visitor is told
 * when something drops out.
 *
 * A visitor builds a shortlist and then takes their time over the form. In
 * that time other people are buying. Nothing on the page noticed:
 *
 *   • a stand that sold stayed green on the map — the shortlist fill is
 *     !important and beat the Taken colour — kept its chip, and was sent in
 *     the enquiry. So did one that went on hold, was merged into a neighbour
 *     or was taken off the plan;
 *   • a chip kept the number the stand had when it was added, after an admin
 *     renumbered it;
 *   • an area that was sponsored kept its chip, and its open panel went on
 *     saying "Available — Add to enquiry";
 *   • a sponsorship that sold out was quietly spliced out of what is SENT
 *     while its chip stayed on screen, so the visitor saw it in the enquiry
 *     and sales never did.
 *
 * And one panel quirk: removing an area's chip while a STAND was open swapped
 * the panel over to that area, with the stand still ringed on the map.
 *
 * Last, the recommendations themselves. One failed fetch rendered "No
 * sponsorship options available" — a claim about the inventory, not about the
 * network — and since the page then believed it was already showing the list
 * for that spend, nothing asked again until the shortlist's size changed.
 */
const { start, openPage, artworkRects, stand, reporter, wait } = require('./floorplan-stub');

const { check, finish } = reporter();

(async () => {
  let goldSoldOut = false;
  let recosDown = false;
  const srv = await start({
    recommend: (_req, res) => recosDown ? res.status(503).json({}) : res.json({ sponsors: [
      { key: 'gold-lanyards', name: 'Gold Lanyards', tier: 'gold', soldOut: goldSoldOut },
      { key: 'wifi', name: 'Wi-Fi Sponsor', tier: 'silver', soldOut: false },
    ] }),
  });
  const { page, errors } = await openPage(srv.browser, `${srv.base}/floorplan`);
  await wait(1200);

  const rects = await artworkRects(page, 60);
  const stands = rects.map((g, i) => stand(i, g));
  // A size nothing else has, so adding it asks for recommendations at a spend
  // the page has not already fetched (and cached) earlier in this run.
  stands[4] = stand(4, rects[4], { sqm: 12 });
  const areas = await page.evaluate(() => [...document.querySelectorAll('#svg-mount svg rect.cls-6, #svg-mount svg rect.cls-8')]
    .slice(0, 2).map((r, i) => ({ key: 'area' + i, label: 'Area ' + i, status: 'open', sponsor: null, logo: null,
      geometry: { x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') } })));
  await page.evaluate(s => window.__fire('state:full', s), stands);
  await wait(1200);
  await page.evaluate(a => window.__fire('areas:catalogue', a), areas);
  await wait(500);

  const addStand = async (n) => {
    await page.evaluate(n => selectBooth(n), n);
    await page.click('#shortlist-btn');
    await wait(150);
  };
  const addArea = async (k) => {
    await page.evaluate(k => selectArea(k), k);
    await page.click('#area-shortlist-btn');
    await wait(150);
  };
  const chips = () => page.evaluate(() =>
    [...document.querySelectorAll('#eq-shortlist button')].map(b => b.textContent.replace('×', '').trim()));
  const notice = () => page.evaluate(() => document.getElementById('eq-notice')?.textContent.replace(/\s+/g, ' ').trim() || '');

  for (const n of ['100', '101', '102', '103']) await addStand(n);
  await addArea('area0');
  await addArea('area1');
  await wait(400);
  check('the shortlist is built', (await chips()).length === 6, (await chips()).join(', '));

  console.log('\nStands that stop being available');
  const next = stands.map(s => ({ ...s }));
  next[0] = { ...next[0], status: 'sold', company: 'Rival Oils' };   // 100 sold
  next[1] = { ...next[1], status: 'held' };                          // 101 on hold
  next[3] = { ...next[3], displayNumber: '103A' };                   // 103 renumbered
  const without102 = next.filter(s => s.boothNumber !== '102');      // 102 merged away
  await page.evaluate(s => window.__fire('state:full', s), without102);
  await wait(600);

  let c = await chips();
  check('only what can still be had keeps a chip', c.filter(x => /^Stand/.test(x)).join(',') === 'Stand 103A', c.join(', '));
  check('and a renumbered stand\'s chip shows its new number', c.includes('Stand 103A'), c.join(', '));
  let n = await notice();
  check('the visitor is told the sold stand was removed, and why', /Stand 100 — now taken/.test(n), n);
  check('the held one', /Stand 101 — now on hold/.test(n), n);
  check('and the one that is no longer on the plan', /Stand 102 — no longer on the plan/.test(n), n);
  const look = await page.evaluate(() => {
    const el = document.querySelector('#svg-mount svg [data-booth="100"]');
    return { cls: el.getAttribute('class'), fill: getComputedStyle(el).fill,
             sold: getComputedStyle(document.documentElement).getPropertyValue('--booth-sold').trim() };
  });
  check('the sold stand is no longer marked as shortlisted', !/booth-shortlisted/.test(look.cls), look.cls);
  check('and is painted Taken, not green', look.fill === 'rgb(252, 223, 109)', `${look.fill} (sold is ${look.sold})`);

  console.log('\nAreas');
  // area1's panel is the one open (it was added last). It is sponsored now.
  const areas2 = [{ ...areas[0], label: 'Theatre One' }, { ...areas[1], status: 'taken', sponsor: 'Rival Oils' }];
  await page.evaluate(a => window.__fire('areas:catalogue', a), areas2);
  await wait(400);
  c = await chips();
  check('a sponsored area loses its chip', !c.includes('Area 1'), c.join(', '));
  check('a renamed one shows its new name', c.includes('Theatre One') && !c.includes('Area 0'), c.join(', '));
  n = await notice();
  check('and the visitor is told', /Area 1 — now sponsored/.test(n), n);
  const panel = await page.evaluate(() => document.getElementById('booth-panel').textContent.replace(/\s+/g, ' '));
  check('the open area panel says it is sponsored', /Sponsored/.test(panel) && !/Add to enquiry/.test(panel), panel.slice(0, 120));

  console.log('\nRemoving an area chip while a stand is open');
  await page.evaluate(() => selectBooth('103'));
  await wait(150);
  await page.click('#eq-shortlist [data-remove-area="area0"]');
  await wait(200);
  const after = await page.evaluate(() => ({
    panel: document.getElementById('booth-panel').textContent.replace(/\s+/g, ' '),
    ringed: document.querySelector('#svg-mount svg .booth-selected')?.getAttribute('data-booth') || null,
  }));
  check('the stand\'s panel stays open', /Stand 103A/.test(after.panel) && !/Theatre One/.test(after.panel), after.panel.slice(0, 80));
  check('and the stand stays ringed', after.ringed === '103', after.ringed);

  console.log('\nA sponsorship that sells out');
  await wait(400);
  await page.click('#sponsor-recos .sponsor-card:first-child .sc-add');
  await wait(200);
  c = await chips();
  check('the package is in the enquiry', c.includes('Gold Lanyards'), c.join(', '));
  goldSoldOut = true;
  await addStand('104');                     // a new spend: the list is fetched again
  await wait(600);
  c = await chips();
  check('once it sells out its chip goes', !c.includes('Gold Lanyards'), c.join(', '));
  n = await notice();
  check('and the visitor is told', /Gold Lanyards — sold out/.test(n), n);

  console.log('\nWhat is sent');
  await page.fill('#eq-first', 'Pat');
  await page.fill('#eq-email', 'pat@example.com');
  await page.evaluate(() => { window.__emits.length = 0; });
  await page.click('#eq-submit');
  await wait(300);
  const sent = await page.evaluate(() => window.__emits.find(x => x.e === 'inquiry:submit')?.p || null);
  check('the enquiry carries what the visitor can see',
        sent && sent.boothNumbers.join(',') === '103,104' && sent.areaKeys.length === 0 && sent.sponsorKeys.length === 0,
        JSON.stringify(sent && { b: sent.boothNumbers, a: sent.areaKeys, s: sent.sponsorKeys }));

  console.log('\nAfter the enquiry has gone');
  const confirmed = () => page.evaluate(() => !document.getElementById('eq-success').classList.contains('hidden')
    && !document.getElementById('enquiry-card').classList.contains('hidden'));
  check('the confirmation is showing', await confirmed());
  const soldAfter = without102.map(s => (s.boothNumber === '103' || s.boothNumber === '104')
    ? { ...s, status: 'sold', company: 'Later Buyer' } : s);
  await page.evaluate(s => window.__fire('state:full', s), soldAfter);
  await wait(400);
  check('a stand it named selling afterwards does not take the confirmation away', await confirmed());
  check('nor is the visitor told to look again at an enquiry already sent', !/Stand 104/.test(await notice()), await notice());
  const paint = await page.evaluate(() => getComputedStyle(document.querySelector('#svg-mount svg [data-booth="104"]')).fill);
  check('and the map still shows it Taken', paint === 'rgb(252, 223, 109)', paint);

  console.log('\nDismissing the notice');
  await page.click('#eq-again');
  await wait(150);
  check('starting another enquiry clears it', (await notice()) === '', await notice());

  console.log('\nRecommendations that fail to load');
  recosDown = true;
  const fresh = await openPage(srv.browser, `${srv.base}/floorplan`);
  const p2 = fresh.page;
  await wait(1200);
  await p2.evaluate(s => window.__fire('state:full', s), stands);
  await wait(800);
  const recos = () => p2.evaluate(() => document.getElementById('sponsor-recos').textContent.replace(/\s+/g, ' ').trim());
  await p2.evaluate(() => { selectBooth('110'); toggleShortlist('110'); });
  await wait(500);
  let shown = await recos();
  check('a failure says it failed', /could not be loaded/i.test(shown), shown);
  check('rather than that there are none', !/No sponsorship options available/.test(shown), shown);
  recosDown = false;
  await p2.click('#sponsor-recos button');
  await wait(500);
  shown = await recos();
  check('"Try again" brings them in', /Gold Lanyards/.test(shown), shown.slice(0, 80));

  recosDown = true;
  await p2.evaluate(() => { selectBooth('111'); toggleShortlist('111'); });
  await wait(500);
  shown = await recos();
  check('a second failure says so too', /could not be loaded/i.test(shown), shown);
  recosDown = false;
  // No button this time: opening another stand is enough for the page to ask
  // again, because it no longer believes it is showing that spend's list.
  await p2.evaluate(() => selectBooth('112'));
  await wait(500);
  shown = await recos();
  check('and the next open retries on its own', /Gold Lanyards/.test(shown), shown.slice(0, 80));
  check('that page raised no errors either', fresh.errors.length === 0, fresh.errors.slice(0, 2).join(' | '));

  check('the page raised no errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  await srv.close();
  finish();
})().catch((e) => { console.error(e); process.exit(1); });
