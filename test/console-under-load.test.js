/**
 * The console keeps up with a person who is quicker than the network.
 *
 * Each of these broke on an ordinary gesture made while something was still
 * on its way, or while a broadcast arrived:
 *
 *   - Floorplan opened twice before the plan had arrived (a double-click, or
 *     out and back in) fetched it twice; the second copy replaced the first
 *     untagged, and no stand on the plan answered a click until a reload.
 *   - A stand linked from the Activity Log, clicked before the plan had ever
 *     been opened, threw on the missing drawing.
 *   - The Team, Sponsors and partner tables, loaded twice at once, drew every
 *     row twice.
 *   - Tools → Shown Number put the stored number back on every keystroke.
 *   - A tag being renamed was rebuilt out from under the typing by any
 *     broadcast, and the rename never saved.
 *   - The Undo on a release was wiped by the next toast of any kind.
 *   - A logo larger than the server stores was sent anyway, dropped the
 *     connection on the way, and nothing was said.
 */
const fs = require('fs');
const path = require('path');
const { startConsole, seedStands, book, settle, toasts, emits, checker, launch } = require('./admin-console-harness');

const { check, finish } = checker();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SVG = fs.readFileSync(path.join(__dirname, '..', 'public', 'LEX27_Floorplan_Consolidated.svg'), 'utf8');

const stands = seedStands(30);
book(stands[1], { company: 'Acme Ltd', actualPrice: 5000, notes: 'signed' });      // 101
book(stands[2], { company: 'Logo Co', actualPrice: null });                          // 102
stands[2].sponsored = true;
stands[4].displayNumber = 'A4';                                                       // 104

(async () => {
  let svgFetches = 0;
  const restores = [];
  const { server, base } = await startConsole({ stands, routes(app) {
    // Slow enough that a second click lands while the first load is in flight.
    app.get('/floorplan.svg', async (_q, res) => { svgFetches++; await sleep(600); res.type('image/svg+xml').send(SVG); });
    app.get('/api/audit/actors', (_q, res) => res.json(['chris']));
    app.get('/api/audit', (_q, res) => res.json([{ type: 'booth.status_change', boothNumber: '101',
      ts: new Date().toISOString(), meta: { from: 'available', to: 'sold', company: 'Acme Ltd' }, actor: { userId: 'chris' } }]));
    app.get('/api/admins', async (_q, res) => { await sleep(400); res.json([
      { username: 'tester', role: 'owner', totpEnrolled: true }, { username: 'sam', role: 'admin' }, { username: 'rep', role: 'sales' }]); });
    app.get('/api/sponsors', async (_q, res) => { await sleep(400); res.json([
      { key: 'a', name: 'Lanyards', tier: 'gold', price: 5000 }, { key: 'b', name: 'Wi-Fi', tier: 'silver', price: 3000 },
      { key: 'c', name: 'Main stage', tier: 'platinum', price: 20000 }]); });
    app.get('/api/partners', async (_q, res) => { await sleep(400); res.json([
      { _id: 'p1', name: 'One', image: '/favicon.svg' }, { _id: 'p2', name: 'Two', image: '/favicon.svg' }]); });
    app.post('/api/booths/:n/restore', (req, res) => { restores.push(req.params.n); res.json({ ok: true }); });
  } });
  const br = await launch();
  const errs = [];

  try {
    console.log('\nAn Activity Log link, before the plan has ever been opened');
    const p1 = await br.newPage({ viewport: { width: 1400, height: 950 } });
    p1.on('pageerror', e => errs.push(`log page: ${String(e).slice(0, 200)}`));
    await p1.goto(`${base}/admin`, { waitUntil: 'networkidle', timeout: 30000 });
    await p1.click('[data-section="log"]');
    await p1.waitForSelector('#admin-log .log-entry.log-linked');
    const before = errs.length;
    await p1.click('#admin-log .log-entry.log-linked');
    await p1.waitForTimeout(1800);
    const opened = await p1.evaluate(() => ({
      section: document.querySelector('.admin-section.active')?.id,
      open: !document.getElementById('admin-booth-action').classList.contains('hidden'),
      title: document.getElementById('aba-id').textContent,
      selected: document.querySelector('#admin-svg-mount svg .booth-selected')?.getAttribute('data-booth') || null,
    }));
    check('nothing is thrown while the plan is on its way', errs.length === before, errs.slice(before).join(' | '));
    check('the plan opens, and on it the stand the log named', opened.section === 'section-floorplan' && opened.open &&
          /101/.test(opened.title) && opened.selected === '101', JSON.stringify(opened));
    await p1.close();

    console.log('\nFloorplan opened twice while the plan is still loading');
    svgFetches = 0;
    const page = await br.newPage({ viewport: { width: 1400, height: 950 } });
    page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
    page.on('dialog', d => d.dismiss());
    await page.goto(`${base}/admin`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.click('[data-section="floorplan"]');
    await page.click('[data-section="overview"]');
    await page.click('[data-section="floorplan"]');
    await page.dblclick('[data-section="floorplan"]');
    await page.waitForTimeout(1600);
    const plan = await page.evaluate(() => ({
      svgs: document.querySelectorAll('#admin-svg-mount svg').length,
      bound: document.querySelectorAll('#admin-svg-mount svg [data-booth]').length,
    }));
    check('the plan is fetched once, however often the tab is opened', svgFetches === 1, `${svgFetches} fetches`);
    check('and the plan on screen has its stands bound — they answer clicks', plan.svgs === 1 && plan.bound > 10, JSON.stringify(plan));
    await page.evaluate(() => {
      const el = document.querySelector('#admin-svg-mount svg [data-booth="105"]');
      if (!el) return;                       // unbound: the check below reports it
      const r = el.getBoundingClientRect();
      const at = { clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, bubbles: true, pointerId: 1 };
      el.dispatchEvent(new PointerEvent('pointerdown', at));
      el.dispatchEvent(new PointerEvent('pointerup', at));
    });
    await settle(page);
    check('clicking a stand opens it', await page.evaluate(() => !document.getElementById('admin-booth-action').classList.contains('hidden') &&
                                                            /105/.test(document.getElementById('aba-id').textContent)));
    await page.evaluate(() => document.getElementById('aba-close').click());

    console.log('\nTools → Shown Number');
    await page.click('[data-section="tools"]');
    await page.waitForTimeout(300);
    await page.selectOption('#number-stand', '103');
    await page.click('#number-value');
    await page.keyboard.type('10', { delay: 30 });
    await page.evaluate(() => { window.__stand('110').clicks = 9; window.__broadcast(); });
    await settle(page);
    await page.keyboard.type('37', { delay: 30 });
    let v = await page.$eval('#number-value', i => i.value);
    check('what is typed stays typed, through keystrokes and a broadcast', v === '1037', JSON.stringify(v));
    check('and the preview follows it', /1037/.test(await page.$eval('#number-preview', n => n.textContent)));
    await page.selectOption('#number-stand', '104');
    v = await page.$eval('#number-value', i => i.value);
    check('choosing another stand fills in that stand\'s shown number', v === 'A4', JSON.stringify(v));

    console.log('\nTools → Business Activities: renaming a tag');
    await page.evaluate(() => window.__fire('tags:catalogue', [
      { key: 'oil', label: 'Oil', color: '#ff8800' }, { key: 'additives', label: 'Additives', color: '#0088ff' }]));
    await page.waitForTimeout(100);
    const tagName = '#tag-list .tag-row:first-child .tag-name';
    await page.click(tagName, { clickCount: 3 });
    await page.keyboard.type('Base oi', { delay: 20 });
    await page.evaluate(() => { window.__stand('111').clicks = 4; window.__broadcast(); });
    await settle(page);
    await page.keyboard.type('ls', { delay: 20 });
    const typing = await page.evaluate(() => ({
      focused: document.activeElement?.classList.contains('tag-name') || false,
      value: document.activeElement?.value,
    }));
    check('a broadcast mid-rename leaves the field and the cursor where they were', typing.focused && typing.value === 'Base oils',
          JSON.stringify(typing));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    const renamed = (await emits(page, 'tags:update')).pop();
    check('and the rename is sent when it is finished', renamed && renamed.payload.key === 'oil' && renamed.payload.label === 'Base oils',
          JSON.stringify(renamed && renamed.payload));

    console.log('\nTables loaded twice at once');
    await page.dblclick('[data-section="team"]');
    await page.waitForTimeout(900);
    const team = await page.$$eval('#team-tbody tr', rows => rows.length);
    check('Team: each account once', team === 3, `${team} rows for 3 accounts`);
    await page.dblclick('[data-section="sponsors"]');
    await page.waitForTimeout(900);
    const sp = await page.evaluate(() => ({
      sponsors: document.querySelectorAll('#sponsors-admin-tbody tr').length,
      partners: document.querySelectorAll('#partners-tbody tr').length,
    }));
    check('Sponsors: each package once', sp.sponsors === 3, `${sp.sponsors} rows for 3 packages`);
    check('and each partner logo once', sp.partners === 2, `${sp.partners} rows for 2 logos`);

    console.log('\nThe Undo on a release outlives the toasts after it');
    await page.click('[data-section="floorplan"]');
    await page.waitForTimeout(300);
    await page.evaluate(() => selectAdminBooth('101'));
    await settle(page);
    await page.click('#aba-release');
    await page.waitForSelector('dialog.bp-dialog[open]');
    await page.fill('dialog.bp-dialog[open] input', 'pw');
    await page.evaluate(() => [...document.querySelectorAll('dialog.bp-dialog[open] button')].find(b => b.textContent === 'Release it').click());
    await settle(page);
    const undoShown = () => page.evaluate(() => {
      const btn = [...document.querySelectorAll('.toast-action')].find(b => b.textContent === 'Undo');
      const host = btn && btn.parentElement;
      return !!(btn && host && host.classList.contains('show'));
    });
    check('Undo is offered', await undoShown());
    await page.evaluate(() => window.__fire('inquiry:new', { id: 'x', name: 'Visitor', booths: ['120'] }));
    await page.waitForTimeout(150);
    check('a new enquiry arriving does not take it away', await undoShown(), await toasts(page));
    await page.evaluate(() => window.__fire('error:action', { message: 'Something unrelated was refused.' }));
    await page.waitForTimeout(250);
    check('nor does an unrelated refusal', await undoShown(), await toasts(page));
    const overlap = await page.evaluate(() => {
      const a = document.getElementById('admin-toast-action')?.getBoundingClientRect();
      const b = document.getElementById('admin-toast')?.getBoundingClientRect();
      return !a || !b ? 'missing' : (a.top < b.bottom && b.top < a.bottom) ? 'overlap' : 'apart';
    });
    check('the two sit one above the other, both readable', overlap === 'apart', overlap);
    await page.evaluate(() => [...document.querySelectorAll('.toast-action')].find(b => b.textContent === 'Undo').click());
    await page.waitForTimeout(300);
    check('and Undo still puts the booking back', restores.includes('101'), JSON.stringify(restores));

    console.log('\nA sponsor logo larger than the server stores');
    await page.evaluate(() => selectAdminBooth('102'));
    await settle(page);
    const big = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><!--${'x'.repeat(1_600_000)}--></svg>`);
    await page.setInputFiles('#aba-logo-file', { name: 'huge-logo.svg', mimeType: 'image/svg+xml', buffer: big });
    await page.waitForTimeout(400);
    check('is not sent at all', (await emits(page, 'booth:set-logo')).length === 0);
    check('and the admin is told why, and what to do instead', /too large/i.test(await toasts(page)) && /PNG/.test(await toasts(page)),
          await toasts(page));
    const fits = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><!--${'x'.repeat(1_400_000)}--></svg>`);
    await page.setInputFiles('#aba-logo-file', { name: 'detailed-logo.svg', mimeType: 'image/svg+xml', buffer: fits });
    await page.waitForTimeout(600);
    const sent = (await emits(page, 'booth:set-logo')).pop();
    check('one that fits under the cap is sent', sent && sent.payload.boothNumber === '102' && /^data:image\/svg\+xml/.test(sent.payload.logo) &&
          sent.payload.logo.length <= 2_000_000, sent ? `${sent.payload.logo.length} characters` : 'nothing sent');
    await page.evaluate(() => { window.__server['booth:set-logo'] = () => ({ ok: false, error: 'Could not save the logo — that image is too large — use a smaller logo.' }); });
    await page.setInputFiles('#aba-logo-file', { name: 'small.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') });
    await page.waitForTimeout(400);
    check('and the server\'s own refusal is shown when it gives one', /too large/i.test(await toasts(page)), await toasts(page));

    check('the page raised no errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    await br.close();
    server.close();
  }
  process.exit(finish());
})().catch((e) => { console.error(e); process.exit(1); });
