/**
 * Each event's plan must be reachable by a URL of its own.
 *
 * Every event used to request the same /floorplan.svg and rely on an X-Show
 * header to tell them apart. Caches key on the URL, so one event's plan was
 * served for another's — the North America plan uploaded successfully and the
 * page kept showing Europe's.
 */
// The registry is database-backed; with no database it falls back to SHOWS, so
// the three events are declared here rather than seeded.
process.env.SHOWS = 'lex:LEX,lna:LNA,lme:LME';
process.env.SHOW_ID = 'LEX';

const { chromium } = require('playwright-core');
const path = require('path');
const express = require('express');
const { sendPage } = require('../server/lib/send-page');
const { showMiddleware, showForRequest } = require('../server/show-middleware');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

// Distinct artwork per event, so serving the wrong one is visible.
const ART = {
  lex: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect id="EUROPE" width="10" height="10"/></svg>',
  lna: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect id="NORTHAMERICA" width="10" height="10"/></svg>',
};

(async () => {
  const app = express();
  app.use(showMiddleware());
  const served = [];
  app.get('/floorplan.svg', (req, res) => {
    served.push({ query: req.query.show || null, header: req.get('X-Show') || null });
    // Deliberately keyed on the QUERY only — a cache that ignores headers
    // behaves exactly like this.
    const which = ART[req.query.show] || ART.lex;
    res.type('image/svg+xml').set('Vary', 'X-Show').send(which);
  });
  app.get('/floorplan/:show', (req, res) => sendPage(res, 'floorplan.html', showForRequest(req)));
  app.get('/floorplan', (req, res) => sendPage(res, 'floorplan.html', showForRequest(req)));
  app.get('/socket.io/socket.io.js', (_q, res) => res.type('application/javascript')
    .send('window.io=function(){return{on(){},emit(){},off(){},get connected(){return true}}};'));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  const server = app.listen(3334);

  const br = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await br.newPage();

  // Europe first, so its plan is the one a cache would hold.
  await page.goto('http://127.0.0.1:3334/floorplan', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  let drawn = await page.evaluate(() => document.querySelector('#svg-mount svg')?.innerHTML || '');
  check('Europe draws Europe', /EUROPE/.test(drawn) && !/NORTHAMERICA/.test(drawn));

  // Then North America, in the SAME browser — the case that failed.
  await page.goto('http://127.0.0.1:3334/floorplan/lna', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  drawn = await page.evaluate(() => document.querySelector('#svg-mount svg')?.innerHTML || '');
  check('North America draws North America, not the cached Europe',
        /NORTHAMERICA/.test(drawn) && !/EUROPE/.test(drawn),
        drawn.slice(0, 70));

  check('the event travels in the URL, not only a header',
        served.every(s => s.query !== null), JSON.stringify(served));

  await br.close();
  server.close();
  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})();
