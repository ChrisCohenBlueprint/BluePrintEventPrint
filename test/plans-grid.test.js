// Settings shows every event side by side, each with its own plan preview and
// its own upload/download/remove — targeting that event, not the one on screen.
const { chromium } = require('playwright-core');
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
  const server = app.listen(3333);
  const br = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await br.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 });
  await page.route('**/api/shows', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify(PLANS.map(p => ({ slug: p.slug, showId: p.showId, name: p.name, active: true }))) }));
  await page.route('**/api/floorplans', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify(PLANS) }));

  const uploads = [];
  await page.route('**/api/floorplan', r => {
    const req = r.request();
    uploads.push({ method: req.method(), show: req.headers()['x-show'],
                   pw: req.headers()['x-confirm-password'] });
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, removed: [] }) });
  });

  await page.goto('http://127.0.0.1:3333/admin', { waitUntil: 'networkidle', timeout: 30000 });
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
  check('the event being viewed is marked', cards.filter(c => c.current).length <= 1);

  // The part that matters: uploading from this page must target the card's
  // event, not whichever event the page is scoped to.
  page.on('dialog', d => d.accept('my-password'));
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
  await page.waitForTimeout(1500);
  const posted = uploads.find(u => u.method === 'POST');
  check('uploading from a card targets THAT event', posted && posted.show === 'lme',
        JSON.stringify(posted));
  check('and sends the password', posted && posted.pw === 'my-password');

  await br.close();
  server.close();
  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})();
