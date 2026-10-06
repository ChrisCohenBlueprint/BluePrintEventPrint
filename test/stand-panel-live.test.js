/**
 * The stand panel says what the stand is NOW, and saves only what was typed.
 *
 * The panel was written once, when a stand was clicked, and the broadcasts
 * that followed repainted only its tags and buttons. Production acknowledges an
 * action and sends the state ~80 ms later, so everything else on it — status,
 * company, size, the deal price — stayed as it was at the click:
 *
 *   - Mark Sold, and the panel went on reading "Available".
 *   - A split or a merge left the old size on show.
 *   - The deal fields were filled once and Save sent BOTH of them, so a note
 *     saved after a colleague had changed the price put the old price back —
 *     and after a release and a fresh booking from the same panel, the new
 *     exhibitor's booking was written with the old exhibitor's price.
 *   - A stand merged away by a colleague stayed open, live, offering actions
 *     on a stand that no longer existed.
 *
 * And Tools → Reset, given a split cell, has to undo the split the way the
 * panel's own Reset does, not delete the cell; when the server answers a
 * cell's reset by undoing its parent's split, it is the parent that is named
 * and opened.
 *
 * The socket answers in production's order — ack first, state ~80 ms later —
 * because the other order hides every one of these. See admin-console-harness.
 */
const { startConsole, seedStands, book, openFloorplan, settle, toasts, emits, checker, launch,
        panelState: panel, clickStand, colleague, dialogState: dialog, press, confirmIt, fillField } = require('./admin-console-harness');

const { check, finish } = checker();

const stands = seedStands(40);
book(stands[1], { company: 'Acme Ltd', actualPrice: 5000, notes: '' });             // 101
book(stands[2], { company: 'Oldco', actualPrice: 3000, notes: '' });                // 102
// 120 split once: its parent keeps the number, the cell is 120B.
stands[20].splitSnapshot = { created: ['120B'], at: '2026-10-01T10:00:00Z', self: { sqm: stands[20].sqm } };
// No shape of its own here: only the Tools list needs it, and a second stand
// on 121's rectangle would only muddle the binding of the plan.
stands.push({ ...stands[21], boothNumber: '120B', splitFrom: '120', geometry: null });
// 130B is a cell of 130 that this console's copy of 130 does not list — so the
// console asks the server about the cell, and the server answers for 130.
stands[30].splitSnapshot = { created: [], at: '2026-10-01T10:00:00Z', self: { sqm: stands[30].sqm } };
stands.push({ ...stands[31], boothNumber: '130B', splitFrom: '130', geometry: null });

(async () => {
  const { server, base } = await startConsole({ stands });
  const br = await launch();
  const page = await br.newPage({ viewport: { width: 1400, height: 950 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  page.on('dialog', d => d.dismiss());
  const stored = (n) => page.evaluate((num) => window.__clone(window.__stand(num).assignment), n);

  try {
    await openFloorplan(page, base);

    console.log('\nA colleague changes the price; this admin saves a note');
    await clickStand(page, '101');
    await settle(page);
    let p = await panel(page);
    check('the panel opens on stand 101 at €5000', p.open && /101/.test(p.id) && p.price === '5000', JSON.stringify(p));
    await colleague(page, "stand('101').assignment.actualPrice = 6000;");
    await settle(page);
    p = await panel(page);
    check('the price field follows the colleague\'s 6000 — nobody had touched it', p.price === '6000', p.price);
    await page.fill('#aba-notes', 'Call back on Tuesday');
    await page.click('#aba-save-deal');
    await settle(page);
    let sent = (await emits(page, 'booth:update-deal')).pop();
    check('only the note is sent — the untouched price is not', sent && !('actualPrice' in sent.payload) && sent.payload.notes === 'Call back on Tuesday',
          JSON.stringify(sent && sent.payload));
    check('with the company the form was filled for', sent && sent.payload.expectCompany === 'Acme Ltd', JSON.stringify(sent && sent.payload));
    let srv = await stored('101');
    check('so the stand keeps 6000, and has the note', srv.actualPrice === 6000 && srv.notes === 'Call back on Tuesday', JSON.stringify(srv));

    console.log('\nA field being typed in is never overwritten by a broadcast');
    await page.fill('#aba-actual-price', '7250');
    await colleague(page, "stand('101').assignment.notes = 'Colleague note';");
    await settle(page);
    p = await panel(page);
    check('the price being typed stays as typed', p.price === '7250', p.price);
    check('while the field nobody touched follows the broadcast', p.notes === 'Colleague note', p.notes);
    await page.click('#aba-save-deal');
    await settle(page);
    sent = (await emits(page, 'booth:update-deal')).pop();
    check('Save sends the price alone', sent && sent.payload.actualPrice === '7250' && !('notes' in sent.payload), JSON.stringify(sent && sent.payload));
    srv = await stored('101');
    check('and the colleague\'s note survives it', srv.notes === 'Colleague note' && srv.actualPrice === 7250, JSON.stringify(srv));

    console.log('\nReleased and re-booked from the same open panel');
    await page.click('#aba-release');
    await page.waitForSelector('dialog.bp-dialog[open]');
    await page.fill('dialog.bp-dialog[open] input', 'pw');
    await press(page, 'Release it');
    await settle(page);
    p = await panel(page);
    check('the panel reads Available once the state arrives', p.status === 'Available' && p.company === '—', JSON.stringify(p));
    check('and the deal fields are empty, as the stand now is', p.price === '' && p.notes === '', JSON.stringify(p));
    await page.click('#aba-book');
    await page.waitForSelector('dialog.bp-dialog[open]');
    await fillField(page, 'company', 'Newco GmbH');
    await confirmIt(page);
    await settle(page);
    p = await panel(page);
    check('Mark Sold: the panel reads Sold to Newco GmbH, not Available', p.status === 'Sold' && p.company === 'Newco GmbH', JSON.stringify(p));
    await page.fill('#aba-notes', 'Invoice to Hamburg office');
    await page.click('#aba-save-deal');
    await settle(page);
    srv = await stored('101');
    check('Newco\'s booking carries no price from the exhibitor before them', srv.company === 'Newco GmbH' && srv.actualPrice === null,
          JSON.stringify(srv));
    check('only the note was written', srv.notes === 'Invoice to Hamburg office', JSON.stringify(srv));

    console.log('\nThe stand changes hands while a note is being typed');
    await clickStand(page, '102');
    await settle(page);
    await page.fill('#aba-notes', 'Meant for Oldco');
    await colleague(page, "stand('102').assignment = { company: 'Other Ltd', actualPrice: null, notes: '', tags: [], country: null };");
    await settle(page);
    p = await panel(page);
    check('the panel shows the new exhibitor', p.company === 'Other Ltd', p.company);
    check('without throwing away what was typed', p.notes === 'Meant for Oldco', p.notes);
    check('and says the form was filled for the exhibitor before', await page.evaluate(() => {
      const n = document.getElementById('aba-deal-note');
      return !!n && !n.hidden && /changed hands/.test(n.textContent) && /Oldco/.test(n.textContent);
    }));
    await page.click('#aba-save-deal');
    await settle(page);
    srv = await stored('102');
    check('the note is not written onto Other Ltd\'s booking', srv.notes === '' && srv.company === 'Other Ltd', JSON.stringify(srv));
    check('and the admin is told why', /changed hands/i.test(await toasts(page)), await toasts(page));

    console.log('\nThe panel after an action taken from it');
    await clickStand(page, '103');
    await settle(page);
    await page.click('#aba-split');
    await page.waitForTimeout(100);
    const first = await page.evaluate(() => splitUI.first);
    await page.evaluate(() => {
      // The server's split: the parent keeps its number and the first share.
      window.__server['booth:split'] = function (p) {
        var b = window.__stand(p.boothNumber);
        var rest = b.sqm - p.firstSqm;
        b.sqm = p.firstSqm; b.listPrice = p.firstSqm * 660;
        b.splitSnapshot = { created: [b.boothNumber + 'B'], at: new Date().toISOString() };
        window.__state.push(Object.assign(window.__clone(b), { boothNumber: b.boothNumber + 'B', sqm: rest, splitFrom: b.boothNumber, splitSnapshot: undefined }));
        window.__broadcast();
        return { ok: true, created: [b.boothNumber + 'B'] };
      };
    });
    await page.click('#split-bar-apply');
    await settle(page);
    p = await panel(page);
    check('a split: the panel shows the size the stand now has', p.sqm === `${first} m²`, `${p.sqm} vs ${first} m²`);

    await page.evaluate(() => {
      window.__server['booth:consolidate-many'] = function (p) {
        var keep = window.__stand(p.boothNumbers[0]);
        p.boothNumbers.slice(1).forEach(function (n) {
          var b = window.__stand(n);
          keep.sqm += b.sqm; keep.listPrice += b.listPrice;
          window.__state = window.__state.filter(function (x) { return x.boothNumber !== n; });
        });
        keep.mergedFrom = p.boothNumbers.slice(1);
        keep.mergeSnapshot = { at: new Date().toISOString(), parts: [] };
        window.__fire('booth:consolidated', { primary: keep.boothNumber, absorbed: p.boothNumbers.slice(1) });
        window.__broadcast();
        return { ok: true, primary: keep.boothNumber, absorbed: p.boothNumbers.slice(1) };
      };
    });
    const sizes = await page.evaluate(() => ({ a: booths['105'].sqm, b: booths['106'].sqm }));
    // Closed first: a shift-click grows the selection from the stand already open.
    await page.click('#aba-close');
    await page.evaluate(() => { toggleMultiSelect('105'); toggleMultiSelect('106'); });
    await page.click('#multi-consolidate');
    await page.waitForSelector('dialog.bp-dialog[open]');
    await press(page, 'Merge them');
    await settle(page, 500);
    // The merge asks for a name for the block; leaving it changes nothing.
    if (await dialog(page)) await press(page, 'Cancel');
    p = await panel(page);
    check('a merge: the panel shows the merged block\'s whole size', p.sqm === `${sizes.a + sizes.b} m²`,
          `${p.sqm} vs ${sizes.a + sizes.b} m²`);

    console.log('\nA colleague merges away the stand that is open');
    await clickStand(page, '108');
    await settle(page);
    await colleague(page, `
      var gone = stand('108'), keep = stand('107');
      keep.sqm += gone.sqm; keep.mergedFrom = ['108']; keep.mergeSnapshot = { at: new Date().toISOString(), parts: [] };
      state.splice(state.indexOf(gone), 1);`);
    await page.evaluate(() => window.__fire('booth:consolidated', { primary: '107', secondary: '108' }));
    await settle(page);
    p = await panel(page);
    check('its panel closes — there is no stand 108 to act on', !p.open && p.selected === null, JSON.stringify(p));
    check('with a note saying where it went', /108/.test(await toasts(page)) && /107/.test(await toasts(page)), await toasts(page));

    await clickStand(page, '109');
    await settle(page);
    await colleague(page, "stand('109').removed = true; stand('109').status = 'removed';");
    await settle(page);
    p = await panel(page);
    check('likewise a stand a colleague takes off the plan', !p.open && /109/.test(await toasts(page)), `${JSON.stringify(p)} ${await toasts(page)}`);

    console.log('\nTools → Reset on a split cell');
    await page.click('[data-section="tools"]');
    await page.waitForTimeout(300);
    await page.selectOption('#reset-stand', '120B');
    await page.click('#reset-form button[type=submit]');
    await page.waitForSelector('dialog.bp-dialog[open]');
    const d = await dialog(page);
    check('says it undoes the split of 120', d && /Reset stand 120$/.test(d.title) && /undo the split of stand 120/.test(d.text), JSON.stringify(d));
    await press(page, 'Reset it');
    await settle(page);
    sent = (await emits(page, 'booth:reset')).pop();
    check('and resets the parent, 120, as the panel always did', sent && sent.payload.boothNumber === '120', JSON.stringify(sent && sent.payload));

    console.log('\nA reset the server answers for the stand it actually changed');
    await page.click('[data-section="floorplan"]');
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      window.__server['booth:reset'] = function (p) {
        if (p.boothNumber !== '130B') return { ok: false, error: 'Not this one.' };
        window.__state = window.__state.filter(function (x) { return x.boothNumber !== '130B'; });
        delete window.__stand('130').splitSnapshot;
        window.__broadcast();
        return { ok: true, type: 'unsplit', parent: '130', removed: ['130B'] };
      };
      selectAdminBooth('130B');
    });
    await settle(page);
    await page.click('#aba-reset');
    await page.waitForSelector('dialog.bp-dialog[open]');
    await press(page, 'Reset it');
    await settle(page);
    p = await panel(page);
    check('the toast names the stand whose split was undone, not the cell asked about',
          /Stand 130 un-split — removed 130B/.test(await toasts(page)), await toasts(page));
    check('and the panel moves to that stand rather than closing on a stand that is gone',
          p.open && p.selected === '130' && /^Stand 130$/.test(p.id), JSON.stringify(p));

    check('the page raised no errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    await br.close();
    server.close();
  }
  process.exit(finish());
})().catch((e) => { console.error(e); process.exit(1); });
