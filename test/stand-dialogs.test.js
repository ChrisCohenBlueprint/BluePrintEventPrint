/**
 * The stand panel asks its questions in the console's own dialog, and means
 * the answers.
 *
 * Book, hold and naming a merged stand asked with window.prompt(), and the
 * answers were taken whatever they were:
 *
 *   - Cancel on "Hold for how many hours?" still held the stand — for 24
 *     hours, because `parseFloat(null) || 24` is 24 — and "Infinity" or "1e10"
 *     went through as a number of hours.
 *   - OK on an empty "Company name:" booked the stand to "Admin".
 *   - "Move to Sold" on a hold taken without a name offered the placeholder
 *     "Pending", so Enter sold the stand to it. Tools → Bulk Status could sell
 *     an empty stand to nobody at all.
 *
 * And Escape, pressed to cancel one of the console's confirm dialogs, also
 * closed the stand panel behind it.
 */
const { startConsole, seedStands, openFloorplan, settle, toasts, emits, checker, launch,
        panelState, clickStand, dialogState, press, confirmIt, fillField } = require('./admin-console-harness');

const { check, finish } = checker();

(async () => {
  const { server, base } = await startConsole({ stands: seedStands(30) });
  const br = await launch();
  const page = await br.newPage({ viewport: { width: 1400, height: 950 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  // A raw browser prompt() or confirm() would be dismissed here and read as a
  // cancel — none is expected on any path below, so any that appears is noted.
  const raw = [];
  page.on('dialog', d => { raw.push(`${d.type()}: ${d.message()}`); d.dismiss(); });
  const server110 = () => page.evaluate(() => window.__clone(window.__stand('110')));

  try {
    await openFloorplan(page, base);

    console.log('\nEscape answers the dialog, not the panel behind it');
    await clickStand(page, '110');
    await settle(page);
    await page.click('#aba-remove');
    await page.waitForSelector('dialog.bp-dialog[open]');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    const p = await panelState(page);
    check('the dialog is cancelled', !(await dialogState(page)));
    check('and the stand panel is still open', p.open && /110/.test(p.id), JSON.stringify(p));
    check('and the stand was not removed', !(await emits(page, 'booth:remove')).length);

    console.log('\nPut on Hold');
    await page.click('#aba-hold');
    await page.waitForSelector('dialog.bp-dialog[open]');
    let d = await dialogState(page);
    check('asks in the console\'s own dialog, for a company and the hours',
          !!d && d.fields.some(f => f.name === 'hours') && d.fields.some(f => f.name === 'company'), JSON.stringify(d));
    await press(page, 'Cancel');
    await settle(page, 150);
    check('Cancel holds nothing', !(await emits(page, 'booth:hold')).length && (await server110()).status === 'available');

    await page.click('#aba-hold');
    await page.waitForSelector('dialog.bp-dialog[open]');
    for (const bad of ['Infinity', '1e10', '0', '-5', 'soon']) {
      await fillField(page, 'hours', bad);
      await confirmIt(page);
      await page.waitForTimeout(60);
      d = await dialogState(page);
      check(`"${bad}" hours is refused, in the dialog`, !!d && /hour/i.test(d.error), d && d.error);
    }
    check('and nothing is sent while it is', !(await emits(page, 'booth:hold')).length);
    await fillField(page, 'hours', '48');
    await confirmIt(page);
    await settle(page);
    let sent = (await emits(page, 'booth:hold')).pop();
    check('48 hours is sent as 48, and no name is needed for a hold', sent && sent.payload.hours === 48 && sent.payload.boothNumber === '110',
          JSON.stringify(sent && sent.payload));

    console.log('\nMove to Sold, and Mark Sold');
    await page.click('#aba-book');
    await page.waitForSelector('dialog.bp-dialog[open]');
    d = await dialogState(page);
    check('a nameless hold offers an empty name, not the "Pending" placeholder', d && d.fields.find(f => f.name === 'company')?.value === '',
          JSON.stringify(d && d.fields));
    await confirmIt(page);
    await page.waitForTimeout(60);
    d = await dialogState(page);
    check('and will not sell without a name', !!d && d.error.length > 0 && !(await emits(page, 'booth:book')).length, d && d.error);
    await fillField(page, 'company', 'Pending');
    await confirmIt(page);
    await page.waitForTimeout(60);
    d = await dialogState(page);
    check('nor as "Pending" typed in', !!d && d.error.length > 0, d && d.error);
    await fillField(page, 'company', 'Real Exhibitor AG');
    await confirmIt(page);
    await settle(page);
    sent = (await emits(page, 'booth:book')).pop();
    check('a real name sells it', sent && sent.payload.company === 'Real Exhibitor AG' &&
          (await server110()).assignment.company === 'Real Exhibitor AG', JSON.stringify(sent && sent.payload));

    await clickStand(page, '111');
    await settle(page);
    await page.click('#aba-book');
    await page.waitForSelector('dialog.bp-dialog[open]');
    await confirmIt(page);
    await page.waitForTimeout(60);
    check('Mark Sold with no name is refused rather than booked as "Admin"',
          !!(await dialogState(page)) && !(await emits(page, 'booth:book')).some(e => e.payload.boothNumber === '111'));
    await press(page, 'Cancel');

    await page.click('[data-section="tools"]');
    await page.waitForTimeout(300);
    await page.selectOption('#status-stand', '111');
    await page.selectOption('#status-new', 'sold');
    await page.fill('#status-company', '');
    await page.click('#status-form button[type=submit]');
    await page.waitForTimeout(200);
    check('nor can Tools → Bulk Status sell an empty stand to nobody', !(await emits(page, 'admin:setStatus')).length &&
          /exhibitor's name/.test(await toasts(page)), await toasts(page));

    console.log('\nNaming a merged stand');
    await page.click('[data-section="floorplan"]');
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      window.__server['booth:consolidate-many'] = function (p) {
        var keep = window.__stand(p.boothNumbers[0]);
        p.boothNumbers.slice(1).forEach(function (n) {
          keep.sqm += window.__stand(n).sqm;
          window.__state = window.__state.filter(function (x) { return x.boothNumber !== n; });
        });
        window.__broadcast();
        return { ok: true, primary: keep.boothNumber, absorbed: p.boothNumbers.slice(1) };
      };
      closeStandPanel();
      toggleMultiSelect('112'); toggleMultiSelect('113');
    });
    await page.click('#multi-consolidate');
    await page.waitForSelector('dialog.bp-dialog[open]');
    await press(page, 'Merge them');
    await page.waitForTimeout(300);
    d = await dialogState(page);
    check('the number to show is asked for in the console\'s dialog, offering the one it has',
          !!d && d.fields.find(f => f.name === 'number')?.value === '112', JSON.stringify(d));
    await fillField(page, 'number', 'A12');
    await confirmIt(page);
    await settle(page);
    sent = (await emits(page, 'booth:set-number')).pop();
    check('and what is typed there is what the stand is called', sent && sent.payload.boothNumber === '112' && sent.payload.displayNumber === 'A12',
          JSON.stringify(sent && sent.payload));

    check('no raw browser prompt or confirm on any of these paths', raw.length === 0, raw.join(' | '));
    check('the page raised no errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    await br.close();
    server.close();
  }
  process.exit(finish());
})().catch((e) => { console.error(e); process.exit(1); });
