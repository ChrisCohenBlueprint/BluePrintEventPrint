#!/usr/bin/env node
/**
 * Drives the real pages in Chrome: public floorplan and admin dashboard.
 * Uses the installed browser, so nothing is downloaded.
 *
 *   node scripts/browser-check.js [--headed]
 */
const { chromium } = require('playwright-core');

// Guard: this seeds a hostile-test booking, so it must never run against a
// production Atlas database.
if ((process.env.MONGO_URI || '').includes('mongodb+srv')) {
  console.error('Refusing to run: MONGO_URI points at a hosted (Atlas) database.');
  console.error('Run against local Mongo only. Unset the Atlas MONGO_URI first.');
  process.exit(2);
}

const BASE   = process.env.BASE || 'http://127.0.0.1:3000';
const USER   = process.env.ADMIN_USER || 'admin';
const PASS   = process.env.ADMIN_PASS || 'localdev-change-me';
const HEADED = process.argv.includes('--headed');

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: !HEADED });

  // ── Public floorplan ────────────────────────────────────────────────────────
  console.log('\nPublic floorplan:');
  const pub = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await pub.newPage();

  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', r => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });

  await page.goto(`${BASE}/floorplan`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#svg-mount svg', { timeout: 20000 });

  const boothCount = await page.locator('[data-booth]').count();
  check('floorplan SVG rendered and booths tagged', boothCount > 200, `${boothCount} booths`);

  // Consent gate
  const consentVisible = await page.locator('#consent-bar').isVisible();
  check('consent bar shown before any tracking', consentVisible);

  await page.click('#consent-accept');
  await page.waitForTimeout(400);
  check('consent bar dismissed on accept', !(await page.locator('#consent-bar').isVisible()));

  // Booking controls must be gone
  const holdBtn = await page.locator('#hold-btn').count();
  const bookBtn = await page.locator('.btn-book:has-text("Book Now")').count();
  check('Hold / Book Now controls removed from public page', holdBtn === 0 && bookBtn === 0);

  // Tap an available stand. Pointer events are dispatched on the element
  // itself rather than at a viewport coordinate, because panzoom can place a
  // given stand outside the visible frame.
  const tap = (index) => page.evaluate((i) => {
    const el = document.querySelectorAll('[data-booth].booth-available')[i];
    if (!el) return null;
    const opts = { bubbles: true, cancelable: true, clientX: 100, clientY: 100 };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    return el.getAttribute('data-booth');
  }, index);

  const first = await tap(0);
  await page.waitForTimeout(700);

  const standTitle = (await page.locator('.stand-id').first().textContent().catch(() => '')) || '';
  check('tapping a stand opens its detail panel', standTitle.includes(first), standTitle.trim());

  // Shortlist
  await page.click('#shortlist-btn');
  await page.waitForTimeout(400);
  check('stand added to enquiry shortlist', (await page.locator('.eq-chip').count()) === 1);

  // Add a second stand
  await tap(1);
  await page.waitForTimeout(500);
  await page.click('#shortlist-btn');
  await page.waitForTimeout(400);
  check('multi-select shortlist works', (await page.locator('.eq-chip').count()) === 2);

  // Removing a chip takes it back off the shortlist
  await page.locator('.eq-chip').first().click();
  await page.waitForTimeout(400);
  check('removing a stand from the shortlist works', (await page.locator('.eq-chip').count()) === 1);
  await tap(1);
  await page.waitForTimeout(400);
  if (await page.locator('#shortlist-btn:not(.in-list)').count()) await page.click('#shortlist-btn');
  await page.waitForTimeout(300);

  // Validation
  await page.fill('#eq-contact', '');
  await page.fill('#eq-email', 'nonsense');
  await page.click('#eq-submit');
  await page.waitForTimeout(900);
  const errVisible = await page.locator('#eq-errors').isVisible();
  check('invalid enquiry shows server validation errors', errVisible,
        (await page.locator('#eq-errors').textContent().catch(() => ''))?.trim().slice(0, 60));

  // Real submission, with a hostile company name
  await page.fill('#eq-contact', 'Jane Tester');
  await page.fill('#eq-email', 'jane@example.com');
  await page.fill('#eq-company', `<script>window.__pwned=1<\/script>Hostile Ltd`);
  await page.fill('#eq-message', 'Interested in a corner stand.');
  await page.click('#eq-submit');
  await page.waitForSelector('#eq-success:not(.hidden)', { timeout: 10000 });
  check('enquiry submitted and confirmation shown', true);

  check('no uncaught JS errors on public page', errors.length === 0, errors.slice(0, 2).join(' | '));

  // ── Seed a hostile booking so the admin assertions are self-contained ───────
  const XSS_COMPANY = `<img src=x onerror="window.__pwned=1">Hostile & Co`;
  {
    const { io } = require('socket.io-client');
    const res = await fetch(`${BASE}/admin`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') },
    });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const s = io(BASE, { transports: ['websocket'], extraHeaders: { Cookie: cookie } });
    await new Promise(ok => s.on('connect', ok));
    const state = await new Promise(ok => s.once('state:full', ok));
    const victim = state.find(b => b.status === 'available');
    s.emit('booth:book', { boothNumber: victim.boothNumber, company: XSS_COMPANY });
    await new Promise(r => setTimeout(r, 400));
    s.emit('booth:update-deal', { boothNumber: victim.boothNumber, actualPrice: 999, notes: `<b>bold</b>` });
    await new Promise(r => setTimeout(r, 900));
    s.close();
  }

  // ── Admin dashboard ─────────────────────────────────────────────────────────
  console.log('\nAdmin dashboard:');
  const adm = await browser.newContext({
    httpCredentials: { username: USER, password: PASS },
    viewport: { width: 1500, height: 950 },
  });
  const apage = await adm.newPage();
  const aerrors = [];
  apage.on('pageerror', e => aerrors.push(e.message));
  apage.on('console', m => { if (m.type() === 'error') aerrors.push(m.text()); });

  await apage.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });

  // The XSS payload booked earlier must render as text, never execute.
  await apage.click('.nav-link[data-section="bookings"]');
  await apage.waitForTimeout(1200);

  const rowCount = await apage.locator('#bookings-tbody tr').count();
  check('bookings table populated', rowCount > 200, `${rowCount} rows`);

  const pwned = await apage.evaluate(() => window.__pwned === 1);
  check('injected <script> did not execute', !pwned);

  const injectedImg = await apage.locator('#bookings-tbody img[src="x"]').count();
  check('injected <img onerror> not parsed as markup', injectedImg === 0);

  // Confirm the payload is present as literal text somewhere in the table
  const hasLiteral = await apage.evaluate(() =>
    Array.from(document.querySelectorAll('#bookings-tbody td'))
      .some(td => td.textContent.includes('<img src=x')));
  check('hostile company name displayed as literal text', hasLiteral);

  // Notes go into an input value, a separate injection surface from cell text.
  const noteLiteral = await apage.evaluate(() =>
    Array.from(document.querySelectorAll('#bookings-tbody input[data-field="notes"]'))
      .some(i => i.value === '<b>bold</b>'));
  check('hostile note preserved as literal input value', noteLiteral);
  check('no <b> element injected from notes',
        (await apage.locator('#bookings-tbody b').count()) === 0);

  const resetBtn = await apage.locator('#reset-btn').count();
  check('bulk reset control removed', resetBtn === 0);

  check('no uncaught JS errors on admin page', aerrors.length === 0, aerrors.slice(0, 2).join(' | '));

  if (HEADED) await apage.waitForTimeout(8000);
  await browser.close();

  const failed = results.filter(r => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('\nBrowser check errored:', e.message); process.exit(1); });
