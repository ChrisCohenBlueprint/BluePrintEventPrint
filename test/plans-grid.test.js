// Settings shows every event side by side, each with its own plan preview and
// its own upload/download/remove — targeting that event, not the one on screen.
const { launch, listen } = require('./harness');
const { app } = require('./serve-pages');
const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const PLANS = [
  { slug: 'lex', showId: 'LEX27', name: 'Lubricant Expo Europe', active: true,
    uploaded: false, filename: '/LEX27_Floorplan_Consolidated.svg', boothCount: 262 },
  { slug: 'lna', showId: 'LNA27', name: 'Lubricant Expo North America', active: true,
    uploaded: true, filename: 'lna-hall.svg', bytes: 512000,
    uploadedAt: '2026-09-09T04:00:00Z', boothCount: 0 },
  { slug: 'lme', showId: 'LME27', name: 'Lubricant Expo Middle East', active: true,
    uploaded: false, filename: '/LEX27_Floorplan_Consolidated.svg', boothCount: 0 },
];

(async () => {
  const { server, base } = await listen(app);
  const br = await launch();
  const page = await br.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 });
  await page.route('**/api/shows', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify(PLANS.map(p => ({ slug: p.slug, showId: p.showId, name: p.name, active: true }))) }));
  await page.route('**/api/floorplans', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify(PLANS) }));

  // What follows an upload: the stands preview (with its diff against the
  // event) and the colour picker. Both are opened for the admin rather than
  // left to be found, so both are stubbed here.
  const paletteWrites = [];
  await page.route('**/api/palette', r => {
    if (r.request().method() === 'PUT') {
      paletteWrites.push({ show: r.request().headers()['x-show'], body: r.request().postDataJSON() });
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, palette: null }) });
    }
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ok: true, palette: null,
      fromArtwork: { available: '#fffcf8', sold: '#689abb', held: null, sponsored: '#7c1315', areaTaken: null, source: 'artwork' },
      fills: [{ fill: '#689abb', stroke: '#013149', count: 70, status: 'sold', sponsored: false },
              { fill: '#fffcf8', stroke: '#013149', count: 19, status: 'available', sponsored: false },
              { fill: '#7c1315', stroke: '#013149', count: 3, status: 'sold', sponsored: true }],
    }) });
  });
  await page.route('**/api/stands/preview', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ok: true, stands: 96, named: 70, byStatus: { available: 22, sold: 70, held: 4 }, sponsored: 3, areas: ['VIP Lounge'],
    fills: [], unit: 'sqft', totalArea: 12000, warnings: [], committed: 12, handwork: 0, existing: 93,
    sample: [{ number: '101', area: 100, exhibitor: 'Acme', status: 'sold' }],
    diff: { added: [{ boothNumber: '501' }, { boothNumber: '502' }, { boothNumber: '503' }],
            moved: [{ boothNumber: '101' }], resized: [], unchanged: [],
            missing: [{ boothNumber: '140', status: 'sold', company: 'Gone GmbH', committed: true },
                      { boothNumber: '141', status: 'available', company: null, committed: false }],
            summary: { added: 3, moved: 1, resized: 0, unchanged: 89, missing: 2, committedMissing: 1 } },
  }) }));

  // The stand schedule handed to a designer before a re-issue. Fetched rather
  // than linked, because the event is named in a header an <a href> cannot
  // send — so what this asserts is that the right event's schedule is asked
  // for, not merely that a button exists.
  const schedules = [];
  await page.route('**/api/stands/schedule.csv', r => {
    schedules.push({ show: r.request().headers()['x-show'] });
    r.fulfill({ status: 200, contentType: 'text/csv; charset=utf-8',
                body: 'stand_number,area,unit,status,exhibitor,note\r\n101,30,sqm,taken,Acme,\r\n' });
  });

  const uploads = [];
  await page.route('**/api/floorplan', r => {
    const req = r.request();
    uploads.push({ method: req.method(), show: req.headers()['x-show'],
                   pw: req.headers()['x-confirm-password'] });
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, removed: [] }) });
  });

  await page.goto(`${base}/admin`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(800);
  await page.click('[data-section="settings"]');
  await page.waitForTimeout(1200);

  const cards = await page.evaluate(() => [...document.querySelectorAll('.plan-card')].map(c => ({
    name: c.querySelector('.plan-name')?.textContent,
    current: c.classList.contains('is-current'),
    previewSrc: c.querySelector('.plan-preview')?.getAttribute('src') || null,
    emptyState: c.querySelector('.plan-preview-empty')?.textContent || null,
    meta: c.querySelector('.plan-meta')?.textContent || '',
    warn: c.querySelector('.plan-warn')?.textContent || '',
    buttons: [...c.querySelectorAll('.plan-actions .admin-btn')].filter(b => !b.hidden)
             .map(b => b.textContent.trim()),
    downloadHref: c.querySelector('a.admin-btn')?.getAttribute('href'),
  })));

  check('all three events are shown side by side', cards.length === 3, cards.map(c => c.name).join(' | '));
  check('each card names its event',
        cards.map(c => c.name).join('|') === 'Lubricant Expo Europe|Lubricant Expo North America|Lubricant Expo Middle East');

  const lex = cards[0], lna = cards[1], lme = cards[2];
  check('an event with stands previews its plan', !!lex.previewSrc && /show=lex/.test(lex.previewSrc), lex.previewSrc);
  check('an uploaded plan previews too', !!lna.previewSrc && /show=lna/.test(lna.previewSrc), lna.previewSrc);
  // Every card previews a plan, uploaded or not: an event with nothing uploaded
  // still falls back to the shipped artwork, so there is always something to
  // show. An empty state here read as "this event has no floorplan" for an
  // event that plainly had one.
  check('an event with nothing uploaded still previews the shipped plan',
        !!lme.previewSrc && /show=lme/.test(lme.previewSrc), lme.previewSrc || lme.emptyState);
  check('all three cards show a preview',
        cards.every(c => !!c.previewSrc), cards.map(c => c.previewSrc ? 'y' : 'n').join(''));

  check('each download targets its own event', lex.downloadHref.includes('show=lex') &&
        lna.downloadHref.includes('show=lna'), `${lex.downloadHref} / ${lna.downloadHref}`);
  check('the warning appears only where stands could be lost',
        /262 stands/.test(lex.warn) && lna.warn === '' && lme.warn === '',
        `lex:"${lex.warn.slice(0, 24)}" lna:"${lna.warn}" lme:"${lme.warn}"`);
  check('Remove is offered only where something was uploaded',
        !lex.buttons.includes('Remove') && lna.buttons.includes('Remove'),
        `lex ${lex.buttons.join(',')} | lna ${lna.buttons.join(',')}`);
  check('an uploaded plan says Replace, one without says Upload',
        lna.buttons[0] === 'Replace' && lme.buttons[0] === 'Upload',
        `${lna.buttons[0]} / ${lme.buttons[0]}`);
  check('every event offers its colours, uploaded or not',
        cards.every(c => c.buttons.includes('Colours')), cards.map(c => c.buttons.join(',')).join(' | '));
  check('the event being viewed is marked', cards.filter(c => c.current).length <= 1);

  // The part that matters: uploading from this page must target the card's
  // event, not whichever event the page is scoped to.
  //
  // The password is typed into an in-page <dialog>, not window.prompt. Chrome's
  // native prompt renders the value in clear text and keeps it in dialog
  // history, which is no way to collect a password — so the console asks for it
  // with a real password field instead. A page.on('dialog') handler no longer
  // fires for it, because there is no native dialog to fire for.
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.plan-card')][2]
      .querySelectorAll('.plan-actions .admin-btn');
    // Stub the picker so no OS dialog opens; drive the same code path.
    const orig = document.createElement.bind(document);
    document.createElement = (t) => {
      const el = orig(t);
      if (t === 'input') {
        setTimeout(() => {
          Object.defineProperty(el, 'files', { value: [new File(['<svg><rect/></svg>'], 'me.svg',
            { type: 'image/svg+xml' })] });
          el.onchange && el.onchange();
        }, 10);
        el.click = () => {};
      }
      return el;
    };
    btns[0].click();
  });
  // Wait for the dialog, fill it, confirm — then give the upload time to post.
  await page.waitForSelector('dialog.bp-dialog input[type=password]', { timeout: 5000 });
  await page.fill('dialog.bp-dialog input[type=password]', 'my-password');
  await page.click('dialog.bp-dialog .bp-dialog-btn.primary');
  await page.waitForTimeout(1200);
  const posted = uploads.find(u => u.method === 'POST');
  check('uploading from a card targets THAT event', posted && posted.show === 'lme',
        JSON.stringify(posted));
  check('and sends the password', posted && posted.pw === 'my-password');

  // The upload is followed through: what the drawing changes, and the colours.
  await page.waitForSelector('#palette-panel', { timeout: 5000 }).catch(() => {});
  const after = await page.evaluate(() => ({
    palette: !!document.getElementById('palette-panel'),
    rows: [...document.querySelectorAll('#palette-panel .palette-row')].map(r => ({
      label: r.querySelector('.palette-label')?.textContent,
      value: r.querySelector('input[type=color]')?.value,
      status: r.querySelector('.palette-status')?.textContent })),
    swatches: document.querySelectorAll('#palette-panel .palette-swatch').length,
    report: document.getElementById('stand-report')?.textContent || '',
    go: document.querySelector('#stand-report .admin-btn.primary')?.textContent || '',
  }));
  check('the colour picker opens after an upload', after.palette);
  check('with the five kinds of space', after.rows.length === 5 && after.rows[0].label === 'Stand — available' &&
        after.rows[2].label === 'Stand — on hold' && after.rows[4].label === 'Area — sponsored',
        after.rows.map(r => r.label).join(' | '));
  check('starting from the colours the plan is drawn in', after.rows[1].value === '#689abb' && after.rows[3].value === '#7c1315',
        `${after.rows[1].value} / ${after.rows[3].value}`);
  check('a colour not yet chosen says so', after.rows[1].status === 'app default', after.rows[1].status);
  check('the plan\'s own colours are offered as swatches', after.swatches === 3, String(after.swatches));
  check('the stands preview opens too, with what the drawing changes',
        /3 new, 1 moved/.test(after.report) && /2 no longer drawn/.test(after.report), after.report.slice(0, 200));
  check('and names the sold stand the drawing dropped', /140 \(Gone GmbH\)/.test(after.report));
  check('offering an update that keeps the bookings', /Update from this plan — keeps 12 bookings/.test(after.go), after.go);

  // Choosing a colour and saving sends the choice for THAT event.
  await page.evaluate(() => {
    const input = document.querySelector('#palette-panel input[data-palette-key="sold"]');
    input.value = '#112233';
    input.dispatchEvent(new Event('input'));
    [...document.querySelectorAll('#palette-panel .spec-report-head .admin-btn')].find(b => b.textContent === 'Save colours').click();
  });
  await page.waitForTimeout(600);
  const w = paletteWrites[0];
  check('saving the colours targets the card\'s event', w && w.show === 'lme', JSON.stringify(w && w.show));
  check('sends the chosen colour and leaves the rest unset',
        w && w.body.palette.sold === '#112233' && w.body.palette.held === null && w.body.palette.available === null,
        JSON.stringify(w && w.body));

  console.log('\nThe stand schedule, for a plan that is already selling');
  const schedButtons = await page.evaluate(() => [...document.querySelectorAll('.plan-card')].map(c => ({
    name: c.querySelector('.plan-name')?.textContent,
    offered: [...c.querySelectorAll('.plan-actions .admin-btn')]
      .some(b => !b.hidden && b.textContent.trim() === 'Stand schedule'),
  })));
  check('offered on the event that has stands positioned against its plan',
        schedButtons.find(c => /Europe/.test(c.name)).offered,
        JSON.stringify(schedButtons));
  check('and not on an event with no stands yet — there is nothing to schedule',
        !schedButtons.find(c => /North America/.test(c.name)).offered);

  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.plan-card')]
      .find(c => /Europe/.test(c.querySelector('.plan-name')?.textContent || ''));
    [...card.querySelectorAll('.plan-actions .admin-btn')]
      .find(b => b.textContent.trim() === 'Stand schedule').click();
  });
  await page.waitForTimeout(600);
  check('downloading it asks for THAT event\'s stands',
        schedules.length === 1 && schedules[0].show === 'lex', JSON.stringify(schedules));

  await br.close();
  server.close();
  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})();
