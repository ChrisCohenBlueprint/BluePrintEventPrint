/**
 * The sponsorship spreadsheet import says what each row would change.
 *
 * The dry run listed the packages it would update by name alone, so a file
 * that moved one price read exactly like a file that rewrote every package,
 * and a re-uploaded catalogue that changed nothing at all was reported as
 * updating all of it. The server now says, per update, what changes (a
 * `detail` line), and lists the rows that change nothing apart (`unchanged`).
 * This is the console's half: show each change, count what is untouched, and
 * still say "Nothing to apply" when nothing would be.
 */
const { startConsole, seedStands, checker, launch } = require('./admin-console-harness');

const { check, finish } = checker();

const REPORTS = {
  // One price moved, one package changed two fields, two rows untouched.
  mixed: { ok: true, created: [], removed: [], errors: [], removalsBlocked: false,
    updated: [
      { key: 'lanyards', name: 'Lanyards', changes: [{ field: 'price', from: 5000, to: 5500 }], detail: 'price €5,000 → €5,500' },
      { key: 'wifi', name: 'Wi-Fi', changes: [{ field: 'tier', from: 'silver', to: 'gold' }, { field: 'availability', from: '', to: 'Exclusive' }],
        detail: 'tier silver → gold; availability — → Exclusive' },
    ],
    unchanged: [{ key: 'stage', name: 'Main stage' }, { key: 'bags', name: 'Bags' }] },
  // A catalogue uploaded again exactly as it was.
  same: { ok: true, created: [], updated: [], removed: [], errors: [], removalsBlocked: false,
    unchanged: [{ key: 'stage', name: 'Main stage' }, { key: 'bags', name: 'Bags' }, { key: 'wifi', name: 'Wi-Fi' }] },
};

(async () => {
  let applied = 0;
  const { server, base } = await startConsole({ stands: seedStands(10), routes(app) {
    app.post('/api/sponsors/import', (req, res) => {
      const which = /same/.test(req.body.csv) ? 'same' : 'mixed';
      if (!req.body.dryRun) applied++;
      res.json({ dryRun: req.body.dryRun, ...REPORTS[which] });
    });
  } });
  const br = await launch();
  const page = await br.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  // The apply step still asks with the browser's confirm(); say yes to it.
  page.on('dialog', d => d.accept());
  const report = () => page.$$eval('#csv-report > div', ds => ds.map(d => d.textContent));

  try {
    await page.goto(`${base}/admin`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.click('[data-section="sponsors"]');
    await page.waitForTimeout(300);
    // Every report the page shows, kept: the dry run's is replaced by the
    // result the moment the import is applied.
    await page.evaluate(() => {
      window.__reports = [];
      new MutationObserver(() => window.__reports.push([...document.querySelectorAll('#csv-report > div')].map(d => d.textContent)))
        .observe(document.getElementById('csv-report'), { childList: true });
    });
    const dryRun = () => page.evaluate(() => (window.__reports.find(r => r[0] === 'Ready to apply:' || r[0] === 'Nothing to apply from that file.') || []));

    console.log('\nA file that changes two packages and leaves two alone');
    await page.setInputFiles('#csv-file', { name: 'catalogue.csv', mimeType: 'text/csv', buffer: Buffer.from('name,price\nLanyards,5500\n') });
    await page.waitForTimeout(500);
    let lines = await dryRun();
    check('each update is shown with what it changes', lines.includes('Lanyards: price €5,000 → €5,500') &&
          lines.includes('Wi-Fi: tier silver → gold; availability — → Exclusive'), lines.join(' | '));
    check('and the untouched rows are counted, not listed as updates', lines.some(l => /^Unchanged: 2 rows match/.test(l)) &&
          !lines.some(l => /Main stage/.test(l)), lines.join(' | '));
    check('the import is applied', applied === 1, `${applied} applies`);
    check('and the result names the changes and the untouched rows', (await report()).some(l => /2 updated, 2 unchanged/.test(l)),
          (await report()).join(' | '));

    console.log('\nThe same catalogue uploaded again');
    await page.evaluate(() => { window.__reports = []; });
    await page.setInputFiles('#csv-file', { name: 'catalogue-same.csv', mimeType: 'text/csv', buffer: Buffer.from('name\nsame\n') });
    await page.waitForTimeout(500);
    lines = await report();
    check('says there is nothing to apply', lines[0] === 'Nothing to apply from that file.', lines.join(' | '));
    check('and why: every row already matches', lines.some(l => /^Unchanged: 3 rows match/.test(l)), lines.join(' | '));
    check('and applies nothing', applied === 1, `${applied} applies`);

    check('the page raised no errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    await br.close();
    server.close();
  }
  process.exit(finish());
})().catch((e) => { console.error(e); process.exit(1); });
