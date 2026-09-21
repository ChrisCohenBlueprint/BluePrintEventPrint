/**
 * The lounges and theatres must answer a click.
 *
 * They stopped for a fortnight and nobody noticed. attach() ends with a pass
 * that switches pointer events off on every artwork rectangle that did not bind
 * a stand — catering, toilets, logo boxes, things that must never look
 * interactive. When the second-chance pool was added, that pass started
 * iterating EVERY rectangle in the plan rather than the stand-styled ones, and
 * the sponsorable areas are rectangles too. Both pages went on wiring their
 * click handlers; the elements simply stopped receiving the clicks.
 *
 * Nothing caught it because every test asked about stands. The areas are the
 * most valuable thing on the plan — a theatre sponsorship is worth more than a
 * stand — so they get their own assertion here.
 *
 * The order below matters and is the whole point: state:full runs attach(),
 * which is where the inert pass lives, and only then does areas:catalogue tag
 * the hosts. Firing the catalogue alone passes whether the bug is present or
 * not, because the pass never runs.
 */
const express = require('express');
const path = require('path');
const fs   = require('fs');
const { launch, listen } = require('./harness');

const SVG = path.join(__dirname, '..', 'public', 'LEX27_Floorplan_Consolidated.svg');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

(async () => {
  const app = express();
  app.get('/socket.io/socket.io.js', (_q, res) => res.type('application/javascript').send(`
    window.__h={};window.io=function(){return{on:function(e,f){(window.__h[e]=window.__h[e]||[]).push(f);return this},
      emit:function(e,p,cb){if(typeof cb==='function')cb({ok:true});return this},off:function(){return this},
      get connected(){return true}}};
    window.__fire=function(e,p){(window.__h[e]||[]).forEach(function(f){f(p)})};`));
  app.get('/floorplan.svg', (_q, res) => res.type('image/svg+xml').send(fs.readFileSync(SVG, 'utf8')));
  app.get('/countries', (_q, res) => res.json([]));
  app.get('/partners',  (_q, res) => res.json([]));
  app.get(/^\/sponsors\//, (_q, res) => res.json([]));
  app.get('/floorplan', (_q, res) => require('../server/lib/send-page')
    .sendPage(res, 'floorplan.html', { slug: 'lex', id: 'LEX', name: 'LEX' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const { server, base } = await listen(app);
  const br = await launch();
  const page = await br.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).slice(0, 160)));

  await page.goto(`${base}/floorplan`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);

  // Fixtures come from the REAL artwork: the stands are the white cells the
  // plan draws, the area hosts are the two blue fills. Invented geometry would
  // bind to nothing and the run would pass without touching the plan.
  const fx = await page.evaluate(() => {
    const g = r => ({ x: +r.getAttribute('x'), y: +r.getAttribute('y'),
                      w: +r.getAttribute('width'), h: +r.getAttribute('height') });
    return {
      stands: [...document.querySelectorAll('#svg-mount svg rect.cls-10')].slice(0, 60)
        .map((r, i) => ({ boothNumber: String(100 + i), status: 'available', sqm: 9,
                          geometry: g(r), displayNumber: null, sponsored: false, tags: [] })),
      areas: [...document.querySelectorAll('#svg-mount svg rect.cls-6, #svg-mount svg rect.cls-8')]
        .map((r, i) => ({ key: 'area' + i, label: 'Area ' + i,
                          sponsor: null, logo: null, package: null, geometry: g(r) })),
    };
  });

  check('the plan carries stands and sponsorable areas',
        fx.stands.length > 0 && fx.areas.length > 0,
        `${fx.stands.length} stands, ${fx.areas.length} areas`);

  await page.evaluate(d => window.__fire('state:full', d.stands), fx);
  await page.waitForTimeout(1200);
  await page.evaluate(d => window.__fire('areas:catalogue', d.areas), fx);
  await page.waitForTimeout(1500);

  const rep = await page.evaluate(() => ({
    bound: document.querySelectorAll('#svg-mount svg [data-booth]').length,
    areas: [...document.querySelectorAll('#svg-mount svg [data-area]')]
      .map(r => ({ key: r.getAttribute('data-area'), pe: getComputedStyle(r).pointerEvents })),
  }));

  check('stands still bind to the artwork', rep.bound > 0, `${rep.bound} bound`);
  check('every area is tagged', rep.areas.length === fx.areas.length,
        `${rep.areas.length} of ${fx.areas.length}`);

  const inert = rep.areas.filter(a => a.pe === 'none');
  check('no area was made inert by the hall-furniture pass', inert.length === 0,
        inert.length ? `${inert.length} inert: ${inert.map(a => a.key).join(', ')}` : 'all clickable');

  check('the page raised no errors', errs.length === 0, errs.slice(0, 2).join(' | '));

  await br.close();
  server.close();
  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})();
