/**
 * Does the page a URL serves actually work?
 *
 * Not "does the route resolve" — an earlier version of this asserted only that
 * a URL mapped to the right show, and a page that resolved perfectly and then
 * rendered as unstyled plain text passed it. That shipped. These assertions are
 * about the rendered page: styles applied, scripts running, no asset missing,
 * and nothing served as the wrong content type.
 */
const { chromium } = require('playwright-core');
const { app } = require('./serve-pages');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

async function health(br, url) {
  const page = await br.newPage({ viewport: { width: 1400, height: 900 } });
  const bad = [], wrongType = [];
  // Only the page's OWN assets: this harness serves no data endpoints, so
  // /api/* 404s by design. A missing stylesheet is the failure worth catching.
  const isAsset = (u) => /\.(css|js|svg|png|jpe?g|woff2?)$/.test(u) && !u.startsWith('/socket.io/');
  page.on('response', (r) => {
    const u = new URL(r.url()).pathname;
    if (!isAsset(u)) return;
    if (r.status() >= 400) bad.push(`${r.status()} ${u}`);
    const ct = r.headers()['content-type'] || '';
    if (/\.css$/.test(u) && !/text\/css/.test(ct)) wrongType.push(`${u} → ${ct.split(';')[0]}`);
    if (/\.js$/.test(u) && !/javascript/.test(ct)) wrongType.push(`${u} → ${ct.split(';')[0]}`);
  });
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1200);
  const r = await page.evaluate(() => ({
    styled: getComputedStyle(document.body).fontFamily.includes('Raleway'),
    // The page's own script, not just the injected bootstrap.
    scriptsRan: typeof window.BoothMap !== 'undefined' || typeof window.loadPlans === 'function',
  }));
  await page.close();
  return { ...r, bad: [...new Set(bad)], wrongType: [...new Set(wrongType)] };
}

(async () => {
  const server = app.listen(3333);
  const br = await chromium.launch({ channel: 'chrome', headless: true });
  // Every URL shape the app answers on. The trailing-slash forms are here
  // because relative asset paths broke exactly those, live.
  for (const p of ['/floorplan', '/floorplan/', '/floorplan/lex26', '/admin', '/admin/']) {
    const h = await health(br, `http://127.0.0.1:3333${p}`);
    check(`${p.padEnd(18)} styles load`, h.styled);
    check(`${p.padEnd(18)} scripts run`, h.scriptsRan);
    check(`${p.padEnd(18)} no asset 404s`, h.bad.length === 0, h.bad.join(', '));
    check(`${p.padEnd(18)} no asset served as HTML`, h.wrongType.length === 0, h.wrongType.join(', '));
  }
  await br.close();
  server.close();
  const f = out.filter((x) => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})();
