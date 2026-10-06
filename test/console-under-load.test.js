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

    check('the page raised no errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    await br.close();
    server.close();
  }
  process.exit(finish());
})().catch((e) => { console.error(e); process.exit(1); });
