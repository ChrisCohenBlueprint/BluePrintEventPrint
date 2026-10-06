/**
 * The events on Settings and in Tools → Events say what is true, and do it.
 *
 *   - The Add an event card promised the URL name "can be changed later under
 *     Tools → Events", which offered a name field and Retire and nothing else.
 *   - An event added from Tools → Events did not appear in the event switcher
 *     or on Settings — where its plan is uploaded — until a reload.
 *   - "Start from" an event suggested the next edition by adding one, even
 *     where that edition already existed: the suggestion was the event already
 *     on the page, and the add was refused.
 *   - Remove on a Settings card kept the old plan as an earlier version "so it
 *     can be put back", and took away Versions, the only way to put it back.
 */
const { startConsole, seedStands, toasts, checker, launch } = require('./admin-console-harness');

const { check, finish } = checker();

const shows = [
  { slug: 'lex', showId: 'LEX', name: 'Lubricant Expo Europe', active: true },
  { slug: 'lex28', showId: 'LEX28', name: 'Lubricant Expo Europe 2028', active: true },
  { slug: 'lna', showId: 'LNA27', name: 'Lubricant Expo North America 2027', active: true },
  { slug: 'lme', showId: 'LME27', name: 'Lubricant Expo Middle East', active: true },
  { slug: 'lex26', showId: 'LEX26', name: 'Lubricant Expo Europe 2026', active: false },
];
// What each event's plan is, beyond what the event list says.
const plan = {
  LEX: { uploaded: true, label: 'LEX27', filename: 'LEX27_Floorplan.svg', bytes: 400000, uploadedAt: '2026-09-01T09:00:00Z', boothCount: 262 },
  LEX26: { uploaded: true, label: 'LEX26', filename: 'LEX26_Floorplan.svg', bytes: 380000, uploadedAt: '2025-09-01T09:00:00Z', boothCount: 240 },
};
// LME's uploaded plan was removed from its card: nothing live, one earlier version kept.
const revisions = { lme: [{ revisionId: 'r-lme-1', label: 'LME27', status: 'superseded', filename: 'LME27 hall.svg',
                            uploadedAt: '2026-08-01T09:00:00Z', uploadedBy: 'chris' }] };

(async () => {
  const patches = [], posts = [], headers = [];
  let showsReads = 0, plansReads = 0;
  const { server, base } = await startConsole({ stands: seedStands(20), routes(app) {
    app.get('/api/shows', (_q, res) => { showsReads++; res.json(shows); });
    app.post('/api/shows', (req, res) => {
      posts.push(req.body);
      const sh = { slug: req.body.slug, showId: req.body.showId, name: req.body.name || req.body.showId, active: true };
      shows.push(sh);
      res.status(201).json(sh);
    });
    app.patch('/api/shows/:id', (req, res) => {
      patches.push({ id: req.params.id, body: req.body });
      const sh = shows.find(s => s.showId === req.params.id);
      Object.assign(sh, req.body);
      res.json(sh);
    });
    app.get('/api/floorplans', (_q, res) => { plansReads++; res.json(shows.map(sh => ({
      slug: sh.slug, showId: sh.showId, name: sh.name, active: sh.active !== false,
      uploaded: false, label: null, draft: null, filename: '/LEX27_Floorplan_Consolidated.svg', bytes: null,
      uploadedAt: null, spec: null, boothCount: 0, ...(plan[sh.showId] || {}),
    }))); });
    app.get('/api/floorplan/revisions', (req, res) => res.json(revisions[req.get('X-Show')] || []));
    app.get('/api/palette', (req, res) => {
      headers.push({ path: '/api/palette', show: req.get('X-Show') });
      if (req.get('X-Show') === 'gone') return res.status(409).json({ error: 'This event is no longer at that address. Reload the page.' });
      res.json({ ok: true, palette: null, fromArtwork: null, fills: [] });
    });
  } });
  const br = await launch();
  const page = await br.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  const dialog = () => page.evaluate(() => {
    const d = document.querySelector('dialog.bp-dialog[open]');
    return d ? { text: d.textContent, buttons: [...d.querySelectorAll('button')].map(b => b.textContent) } : null;
  });
  const press = (label) => page.evaluate((l) =>
    [...document.querySelectorAll('dialog.bp-dialog[open] button')].find(b => b.textContent === l).click(), label);
  const switcher = () => page.$$eval('#show-switch option', os => os.map(o => o.value));

  try {
    await page.goto(`${base}/admin`, { waitUntil: 'networkidle', timeout: 30000 });

    console.log('\nTools → Events: the URL name can be changed, as the Add an event card says');
    await page.click('[data-section="tools"]');
    await page.waitForSelector('#show-list .show-slug-input');
    const slugs = await page.$$eval('#show-list .show-slug-input', is => is.map(i => i.value));
    check('every event shows its URL name, editable', slugs.join() === shows.map(s => s.slug).join(), slugs.join());

    const lnaSlug = '#show-list .area-card:nth-child(3) .show-slug-input';
    await page.fill(lnaSlug, 'Bad Slug!');
    await page.press(lnaSlug, 'Enter');
    await page.waitForTimeout(200);
    check('a URL name the server would refuse is explained, not sent', patches.length === 0 && /lowercase/.test(await toasts(page)),
          await toasts(page));
    check('and the field goes back to the real one', (await page.$eval(lnaSlug, i => i.value)) === 'lna');

    showsReads = 0; plansReads = 0;
    await page.fill(lnaSlug, 'lna27');
    await page.press(lnaSlug, 'Enter');
    await page.waitForSelector('dialog.bp-dialog[open]');
    const ask = await dialog();
    check('moving an event says the old address stops working', /\/floorplan\/lna\b/.test(ask.text) && /404/.test(ask.text), ask.text);
    await press('Move it');
    await page.waitForTimeout(500);
    check('and moves it', patches.length === 1 && patches[0].id === 'LNA27' && patches[0].body.slug === 'lna27', JSON.stringify(patches));
    check('the switcher and Settings are refreshed, not only this list', showsReads >= 2 && plansReads >= 1 && (await switcher()).includes('lna27'),
          `shows ${showsReads}, plans ${plansReads}, switcher ${(await switcher()).join()}`);

    console.log('\nAn event added from Tools → Events');
    showsReads = 0; plansReads = 0;
    await page.fill('#show-name', 'Lubricant Expo Asia');
    await page.fill('#show-slug', 'lea');
    await page.fill('#show-id', 'LEA27');
    await page.click('#show-form button[type=submit]');
    await page.waitForTimeout(600);
    check('is created', posts.length === 1 && posts[0].showId === 'LEA27', JSON.stringify(posts));
    check('and appears in the event switcher straight away', (await switcher()).includes('lea'), (await switcher()).join());
    await page.click('[data-section="settings"]');
    await page.waitForTimeout(400);
    const names = await page.$$eval('.plan-card:not(.plan-add) .plan-name', ns => ns.map(n => n.textContent));
    check('and on Settings, where its plan is uploaded', names.includes('Lubricant Expo Asia'), names.join(' | '));

    console.log('\nStart from: the next edition that does not exist yet');
    await page.click('.plan-add-open');
    await page.selectOption('.plan-add-form select[name=copyFrom]', 'LEX');
    let form = await page.evaluate(() => { const f = document.querySelector('.plan-add-form').elements; return { id: f.showId.value, slug: f.slug.value, name: f.name.value }; });
    check('Europe is on LEX27 and LEX28 is already an event, so it suggests LEX29', form.id === 'LEX29' && form.slug === 'lex29',
          JSON.stringify(form));
    check('named for 2029', form.name === 'Lubricant Expo Europe 2029', form.name);
    await page.selectOption('.plan-add-form select[name=copyFrom]', 'LNA27');
    form = await page.evaluate(() => { const f = document.querySelector('.plan-add-form').elements; return { id: f.showId.value, name: f.name.value }; });
    check('from LNA27 — an id that carries its year — LNA28, replacing the earlier suggestion', form.id === 'LNA28', JSON.stringify(form));
    check('and its year is moved on, not added to: "… 2028", not "… 2027 2028"', form.name === 'Lubricant Expo North America 2028', form.name);
    const hint = await page.$eval('.plan-add-form .settings-hint', p => p.textContent);
    check('the card still says where the URL name is changed — which is now true', /Tools → Events/.test(hint), hint);
    await page.click('.plan-add-form [data-cancel]');

    console.log('\nVersions after a plan has been removed');
    await page.waitForTimeout(300);
    const cards = await page.evaluate(() => [...document.querySelectorAll('.plan-card:not(.plan-add)')].map(c => ({
      name: c.querySelector('.plan-name').textContent,
      buttons: [...c.querySelectorAll('.plan-actions .admin-btn')].filter(b => !b.hidden).map(b => b.textContent),
      retired: c.classList.contains('is-retired'),
      note: c.querySelector('.plan-retired-note')?.textContent || '',
      opacity: getComputedStyle(c).opacity,
    })));
    const lme = cards.find(c => /Middle East/.test(c.name));
    const lea = cards.find(c => /Asia/.test(c.name));
    check('an event whose plan was removed still offers Versions — the way to put it back', lme && lme.buttons.includes('Versions'),
          lme && lme.buttons.join());
    check('an event that has never had a plan still does not', lea && !lea.buttons.includes('Versions'), lea && lea.buttons.join());
    await page.evaluate(() => {
      const card = [...document.querySelectorAll('.plan-card')].find(c => /Middle East/.test(c.querySelector('.plan-name')?.textContent || ''));
      [...card.querySelectorAll('.plan-actions .admin-btn')].find(b => b.textContent === 'Versions').click();
    });
    await page.waitForSelector('#revisions-panel');
    const rev = await page.$eval('#revisions-panel', p => p.textContent);
    check('and Versions lists the removed plan with the way to make it live again', /LME27/.test(rev) && /Make live again/.test(rev), rev.slice(0, 160));
    await page.click('#revisions-panel .admin-btn');

    console.log('\nMoving the event this console is showing');
    const p2 = await br.newPage({ viewport: { width: 1400, height: 900 } });
    p2.on('pageerror', e => errs.push(String(e).slice(0, 200)));
    await p2.goto(`${base}/admin`, { waitUntil: 'networkidle', timeout: 30000 });
    await p2.click('[data-section="tools"]');
    await p2.waitForSelector('#show-list .show-slug-input');
    await p2.fill('#show-list .area-card:first-child .show-slug-input', 'lex-europe');
    await p2.press('#show-list .area-card:first-child .show-slug-input', 'Enter');
    await p2.waitForSelector('dialog.bp-dialog[open]');
    const here = await p2.evaluate(() => document.querySelector('dialog.bp-dialog[open]').textContent);
    check('says the console itself will reopen at the new address', /reopens at \/admin\/lex-europe/.test(here), here);
    await Promise.all([
      p2.waitForURL(/\/admin\/lex-europe$/, { timeout: 5000 }).catch(() => null),
      p2.evaluate(() => [...document.querySelectorAll('dialog.bp-dialog[open] button')].find(b => b.textContent === 'Move it').click()),
    ]);
    check('and does', /\/admin\/lex-europe$/.test(p2.url()), p2.url());

    check('the pages raised no errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    await br.close();
    server.close();
  }
  process.exit(finish());
})().catch((e) => { console.error(e); process.exit(1); });
