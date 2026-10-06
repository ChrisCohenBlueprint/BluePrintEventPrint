/**
 * The console counts money and floor the way the server now does.
 *
 *   - The overview summed LIST prices for revenue earned and on hold, so a
 *     stand sold at a discount was counted at a price nobody is paying, and
 *     its total row was every list price on the floor rather than the sum of
 *     the rows above it. It now uses the price agreed where there is one, and
 *     the total is earned + held + available — as stats() does.
 *   - A custom split's sizes stepped in whole units, and parts out by up to a
 *     whole unit were let through, for the server to refuse: it now wants them
 *     to add up exactly, to the hundredth.
 *   - The rate box stepped in whole units; the server keeps a rate's cents.
 */
const { startConsole, seedStands, book, settle, toasts, emits, checker, launch, press } = require('./admin-console-harness');

const { check, finish } = checker();

const stands = seedStands(12);
book(stands[1], { company: 'Discount Ltd', actualPrice: 4000 });             // 101, sold at an agreed price
book(stands[2], { company: 'List Price GmbH', actualPrice: null });          // 102, sold at list
book(stands[3], { status: 'held', company: 'Maybe AG', actualPrice: 1000 }); // 103, held at an agreed price

const agreed = (b) => (b.assignment.actualPrice != null ? b.assignment.actualPrice : b.listPrice);
const sum = (rows, f) => rows.reduce((s, b) => s + f(b), 0);
const earned = sum(stands.filter(b => b.status === 'sold'), agreed);
const held = sum(stands.filter(b => b.status === 'held'), agreed);
const avail = sum(stands.filter(b => b.status === 'available'), b => b.listPrice);
const digits = (s) => Number(String(s).replace(/[^\d]/g, ''));

(async () => {
  const { server, base } = await startConsole({ stands });
  const br = await launch();
  const page = await br.newPage({ viewport: { width: 1400, height: 950 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  page.on('dialog', d => d.dismiss());

  try {
    await page.goto(`${base}/admin`, { waitUntil: 'networkidle', timeout: 30000 });
    await settle(page);

    console.log('\nThe overview\'s revenue');
    const kpi = await page.evaluate(() => Object.fromEntries(['kpi-earned', 'rev-booked', 'rev-held', 'rev-avail', 'rev-total']
      .map(id => [id, document.getElementById(id).textContent])));
    check('earned is the price agreed where one was, list price where none was', digits(kpi['kpi-earned']) === earned &&
          digits(kpi['rev-booked']) === earned, `${kpi['kpi-earned']} vs ${earned}`);
    check('on hold likewise', digits(kpi['rev-held']) === held, `${kpi['rev-held']} vs ${held}`);
    check('still available is its list price', digits(kpi['rev-avail']) === avail, `${kpi['rev-avail']} vs ${avail}`);
    check('and the total is those three rows added up', digits(kpi['rev-total']) === earned + held + avail,
          `${kpi['rev-total']} vs ${earned + held + avail}`);

    console.log('\nA custom split, to the hundredth');
    await page.click('[data-section="tools"]');
    await page.waitForTimeout(300);
    const total = stands[5].sqm;
    await page.selectOption('#csplit-stand', '105');
    const rows = await page.$$('#csplit-rows .csplit-row');
    const step = await page.$eval('#csplit-rows .csplit-size', i => i.step);
    check('a part\'s size can be given in hundredths', step === '0.01', step);
    await rows[0].$eval('.csplit-num', i => { i.value = '105A'; });
    await rows[1].$eval('.csplit-num', i => { i.value = '105B'; });
    const a = Math.round((total - 4.75) * 100) / 100;
    await (await rows[0].$('.csplit-size')).fill(String(a));
    await (await rows[1].$('.csplit-size')).fill('4.74');
    await page.click('#csplit-form button[type=submit]');
    await page.waitForTimeout(250);
    check('parts a hundredth short are refused, before anything is sent', !(await emits(page, 'booth:split-custom')).length);
    check('saying they must add up exactly, and by how much they miss', /exactly/.test(await toasts(page)) && /0\.01/.test(await toasts(page)),
          await toasts(page));
    await (await rows[1].$('.csplit-size')).fill('4.75');
    const tally = await page.$eval('#csplit-tally', t => ({ text: t.textContent, ok: t.classList.contains('ok') }));
    check('the tally agrees once they do', tally.ok && /left 0\b/.test(tally.text), JSON.stringify(tally));
    await page.click('#csplit-form button[type=submit]');
    await page.waitForSelector('dialog.bp-dialog[open]');
    await press(page, 'Split it');
    await settle(page);
    const sent = (await emits(page, 'booth:split-custom')).pop();
    check('and parts that add up exactly are sent as given', sent && sent.payload.parts.map(p => p.sqm).join() === `${a},4.75`,
          JSON.stringify(sent && sent.payload.parts));

    console.log('\nThe rate');
    const rate = await page.evaluate(() => {
      const i = document.getElementById('rate-input');
      i.value = '612.50';
      return { step: i.step, min: i.min, valid: i.checkValidity() };
    });
    check('can be given to the cent, and not at or below zero', rate.step === '0.01' && rate.min === '0.01' && rate.valid,
          JSON.stringify(rate));

    check('the page raised no errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    await br.close();
    server.close();
  }
  process.exit(finish());
})().catch((e) => { console.error(e); process.exit(1); });
