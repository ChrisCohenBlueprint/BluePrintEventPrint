/**
 * Clicking a stand selects it. It does not move the hall.
 *
 * Nothing on the click path ever called panToBooth. What moved the map was the
 * FOCUS handler: a stand is a button for keyboard users, so it carries
 * tabindex, and clicking a focusable element focuses it. The handler that
 * exists to bring a tabbed-to stand into view therefore ran on every mouse
 * click as well — and on a whole-hall view, clicking a small stand zoomed to
 * nearly the 8x maximum and slid the plan across the frame.
 *
 * Both halves are asserted here, because fixing one by deleting the other is
 * the obvious wrong repair: a keyboard user who cannot see the stand they have
 * focused has no way to know where they are.
 *
 * The zoom itself is pinned too. It used to aim for 30% of the frame — 220px
 * for one stand — which is a single-step jump to near maximum zoom from a view
 * of the whole hall.
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
  const page = await br.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${base}/floorplan`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);

  // Real artwork cells, so the stands bind to the plan rather than to nothing.
  const stands = await page.evaluate(() => [...document.querySelectorAll('#svg-mount svg rect.cls-10')]
    .slice(0, 60).map((r, i) => ({ boothNumber: String(100 + i), status: 'available', sqm: 9,
      geometry: { x: +r.getAttribute('x'), y: +r.getAttribute('y'),
                  w: +r.getAttribute('width'), h: +r.getAttribute('height') },
      displayNumber: null, sponsored: false, tags: [] })));
  await page.evaluate(s => window.__fire('state:full', s), stands);
  await page.waitForTimeout(1500);

  const transform = () => page.evaluate(() => document.getElementById('map-inner').style.transform || 'none');
  const smallStand = (skipFocused) => page.evaluate((skip) => {
    const els = [...document.querySelectorAll('#svg-mount svg [data-booth]')].filter(e => {
      const r = e.getBoundingClientRect();
      return r.width > 6 && r.width < 90 && r.height > 6;
    });
    // Refocusing the element that is already focused fires no focus event, which
    // would read as "the keyboard does nothing" and is an artefact of the test.
    const e = skip ? els.find(x => x !== document.activeElement) : els[0];
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { n: e.getAttribute('data-booth'), x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, skipFocused);

  console.log('\nA mouse click');
  const before = await transform();
  const target = await smallStand(false);
  check('there is a stand to click', !!target, JSON.stringify(target));
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(1500);
  const afterClick = await transform();
  const selected = await page.evaluate(() =>
    document.querySelector('#svg-mount svg .booth-selected')?.getAttribute('data-booth') || null);

  check('selects the stand', selected === target.n, `${selected} vs ${target.n}`);
  check('and leaves the hall exactly where it was',
        afterClick === before, `${before} -> ${afterClick}`);

  console.log('\nKeyboard focus');
  const kb = await page.evaluate(async () => {
    const before = document.getElementById('map-inner').style.transform || 'none';
    const els = [...document.querySelectorAll('#svg-mount svg [data-booth]')].filter(e => {
      const r = e.getBoundingClientRect();
      return r.width > 6 && r.width < 90 && r.height > 6;
    });
    // Any stand not already focused. Deliberately NOT filtered by size: when
    // the click has already zoomed the hall (the bug), every stand is larger
    // than any size filter and this block would crash rather than report.
    const any = [...document.querySelectorAll('#svg-mount svg [data-booth]')];
    const e = els.find(x => x !== document.activeElement) || any.find(x => x !== document.activeElement);
    if (!e) return { before, after: before, scale: null, offCentre: 9999, sizePx: 0, noStand: true };
    // Tab is what tells the page this focus is a keyboard focus.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    e.focus();
    await new Promise(r => setTimeout(r, 1800));
    const f = document.getElementById('map-frame').getBoundingClientRect();
    const r = e.getBoundingClientRect();
    const t = document.getElementById('map-inner').style.transform || 'none';
    const m = /matrix\(([-\d.]+)/.exec(t);
    return { before, after: t, scale: m ? parseFloat(m[1]) : null,
             offCentre: Math.round(Math.hypot(r.x + r.width / 2 - (f.x + f.width / 2),
                                              r.y + r.height / 2 - (f.y + f.height / 2))),
             sizePx: Math.round(Math.max(r.width, r.height)) };
  });

  check('brings the focused stand into view', kb.after !== kb.before, `${kb.before} -> ${kb.after}`);
  check('centred in the frame', kb.offCentre <= 12, `${kb.offCentre}px off centre`);
  check('zoomed enough to read', kb.sizePx >= 40, `${kb.sizePx}px on screen`);
  check('and not thrown to the zoom limit — 4x is the cap, 8x is the maximum',
        kb.scale !== null && kb.scale <= 4.001, `scale ${kb.scale}`);
  // The scale panzoom actually applied must be the one the pan was computed
  // for. It silently drops a zoom whose bounds check adjusts the transform
  // first, and a pan computed for a zoom that never happened lands nowhere.
  check('the pan agrees with the scale that actually took effect', kb.offCentre <= 12);

  await br.close();
  server.close();
  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})();
