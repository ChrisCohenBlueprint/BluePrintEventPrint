/**
 * A stand taken off the real plan, in a real browser.
 *
 * The geometry is proved on its own in remove-stand.test.js. What this asks is
 * the thing that only the page can answer: that a removal actually reaches the
 * drawing. The plan is the SHIPPED LEX27 artwork and the stands are the
 * rectangles it really draws, so a fixture cannot flatter the result by
 * inventing a tidy grid that the plan does not contain.
 *
 * Three claims, and the middle one is the feature:
 *
 *   1. the removed stand is painted out — hall floor over its rectangle, and
 *      it answers no clicks (it is not a stand any more, so it must not behave
 *      like one).
 *   2. the wall it shared with the stand next door is still drawn. Take that
 *      away and the neighbour reads as open floor running into the aisle —
 *      which is what happens if a removal is nothing more than hiding a rect.
 *   3. putting it back leaves the plan as it was, with no paint left behind.
 *
 * A removal also has to REACH the page at all: the map repaints only when its
 * structural fingerprint changes, and a stand coming off the plan changes
 * nothing else about it. The assertions below fail if that is ever lost.
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

  // Stands straight off the artwork, and a pair of them that genuinely stand
  // side by side — found here, in the drawing, rather than assumed.
  const fx = await page.evaluate(() => {
    const g = r => ({ x: +r.getAttribute('x'), y: +r.getAttribute('y'),
                      w: +r.getAttribute('width'), h: +r.getAttribute('height') });
    const rects = [...document.querySelectorAll('#svg-mount svg rect.cls-10')].slice(0, 120)
      .map(g).filter(b => b.w > 0 && b.h > 0);
    const stands = rects.map((b, i) => ({ boothNumber: String(100 + i), status: 'available',
                                          sqm: 9, geometry: b, displayNumber: null, sponsored: false, tags: [] }));
    // Two stands flush along a vertical wall, with their rows lined up.
    let pair = null;
    for (let i = 0; i < rects.length && !pair; i++) {
      for (let j = 0; j < rects.length; j++) {
        if (i === j) continue;
        const a = rects[i], b = rects[j];
        const rowsLineUp = Math.abs(a.y - b.y) < 1 && Math.abs(a.h - b.h) < 1;
        if (rowsLineUp && Math.abs((a.x + a.w) - b.x) < 1) { pair = { left: i, right: j }; break; }
      }
    }
    return { stands, pair, rects };
  });

  check('the plan carries stands', fx.stands.length > 10, `${fx.stands.length} stands`);
  check('and two of them stand side by side', !!fx.pair, JSON.stringify(fx.pair));
  if (!fx.pair) { await br.close(); server.close(); process.exit(1); }

  const victim   = fx.stands[fx.pair.left].boothNumber;
  const neighbour = fx.stands[fx.pair.right].boothNumber;
  const wall = fx.rects[fx.pair.left].x + fx.rects[fx.pair.left].w;   // the x they share

  await page.evaluate(d => window.__fire('state:full', d.stands), fx);
  await page.waitForTimeout(1200);

  const before = await page.evaluate(n => ({
    bound: document.querySelectorAll('#svg-mount svg [data-booth]').length,
    victimBound: !!document.querySelector(`#svg-mount svg [data-booth="${n}"]`),
  }), victim);
  check('every stand binds to the artwork first', before.bound > 10 && before.victimBound,
        `${before.bound} bound`);

  // Take it off the plan, exactly as a broadcast would.
  await page.evaluate(d => window.__fire('state:full',
    d.stands.map(s => (s.boothNumber === d.victim ? { ...s, status: 'removed', removed: true } : s))),
    { stands: fx.stands, victim });
  await page.waitForTimeout(1500);

  const after = await page.evaluate(d => {
    const svg = document.querySelector('#svg-mount svg');
    const masks = [...svg.querySelectorAll(`[data-removed-mask="${d.victim}"]`)];
    const edges = [...svg.querySelectorAll(`[data-removed-edge="${d.victim}"]`)].map(l => ({
      x1: +l.getAttribute('x1'), y1: +l.getAttribute('y1'),
      x2: +l.getAttribute('x2'), y2: +l.getAttribute('y2'),
      w: +l.getAttribute('stroke-width'),
    }));
    return {
      masks: masks.length,
      maskFill: masks[0] ? getComputedStyle(masks[0]).fill : null,
      // What the artwork itself draws under the stands — LEX27's aisles are one
      // pale blue shape, NOT white paper, so this is the colour a removed stand
      // has to become. White here was the first thing the preview caught.
      hallFill: (function () {
        var hall = svg.querySelector('polygon.cls-9, rect.cls-9');
        return hall ? getComputedStyle(hall).fill : null;
      })(),
      maskInert: masks[0] ? getComputedStyle(masks[0]).pointerEvents === 'none' : false,
      edges,
      victimStillBound: !!svg.querySelector(`[data-booth="${d.victim}"]`),
      neighbourStillBound: !!svg.querySelector(`[data-booth="${d.neighbour}"]`),
      // The stand's own rectangle has to leave the DRAWING, not merely be
      // painted over. The artwork strokes a stand down the centre of its edge,
      // so paint has to stop within a whisker of where that stroke stops, and
      // at that distance the paint's anti-aliased edge blends what is beneath:
      // the stand came off the plan wearing a faint grey outline of itself.
      srcHidden: (function () {
        var el = svg.querySelector(`[data-removed-src="${d.victim}"]`);
        return !!el && getComputedStyle(el).display === 'none';
      })(),
    };
  }, { victim, neighbour });

  check('the removed stand is painted out', after.masks === 1, `${after.masks} masks`);
  check('in the colour the artwork draws the hall floor in, not a guess at white',
        !!after.hallFill && after.maskFill === after.hallFill,
        `mask ${after.maskFill} vs hall ${after.hallFill}`);
  check('and the paint answers no clicks', after.maskInert);
  check('the stand itself is no longer bound to the artwork', !after.victimStillBound);
  check('and its rectangle is out of the drawing, not just painted over', after.srcHidden);
  check('its neighbour still is', after.neighbourStillBound);

  const onWall = after.edges.filter(e => Math.abs(e.x1 - wall) < 1 && Math.abs(e.x2 - wall) < 1);
  check('the wall it shared with its neighbour is still drawn', onWall.length === 1,
        `${after.edges.length} lines, ${onWall.length} on x=${wall.toFixed(1)}`);
  check('at the weight the plan strokes a stand', onWall[0] && onWall[0].w > 0 && onWall[0].w <= 2,
        onWall[0] && String(onWall[0].w));
  check('and its own four sides were not simply kept', after.edges.length < 4,
        `${after.edges.length} lines`);

  // Back on the plan — and nothing of the removal left behind.
  await page.evaluate(d => window.__fire('state:full', d.stands), fx);
  await page.waitForTimeout(1500);
  const restored = await page.evaluate(n => ({
    masks: document.querySelectorAll('#svg-mount svg [data-removed-mask]').length,
    edges: document.querySelectorAll('#svg-mount svg [data-removed-edge]').length,
    hidden: document.querySelectorAll('#svg-mount svg [data-removed-src]').length,
    bound: !!document.querySelector(`#svg-mount svg [data-booth="${n}"]`),
    drawn: (function () {
      var el = document.querySelector(`#svg-mount svg [data-booth="${n}"]`);
      return !!el && getComputedStyle(el).display !== 'none';
    })(),
  }), victim);
  check('putting it back binds it to the artwork again', restored.bound);
  check('and the rectangle is drawn once more — hiding it is undone, not permanent',
        restored.drawn && restored.hidden === 0, `${restored.hidden} still hidden`);
  check('and takes the paint away with it', restored.masks === 0 && restored.edges === 0,
        `${restored.masks} masks, ${restored.edges} lines`);

  check('the page raised no errors', errs.length === 0, errs.slice(0, 2).join(' | '));

  await br.close();
  server.close();
  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})();
