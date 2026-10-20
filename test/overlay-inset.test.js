/**
 * A stand lying on another's rectangle leaves the other's outline its weight.
 *
 * An overlay — a hold on part of a stand, a duplicate under another number —
 * is filled opaque by its status. Where its edge lay on the host's edge, that
 * fill covered the inner half of the host's stroke: on Europe's plan 773 lost
 * its right and bottom lines to the released 771 and P014 lying on it, so its
 * left edge (shared with 872 and 870, whose strokes survived) read heavier
 * than its right. Each side of an overlay flush with its host's is now pulled
 * in by half a stroke. Split cells are not: they mask the host and draw their
 * own box.
 */
const path = require('path');
const fs = require('fs');
const { start, openPage, stand, reporter, wait } = require('./floorplan-stub');

const { check, finish } = reporter();
const V02 = fs.readFileSync(path.join(__dirname, 'fixtures', 'LEX27_Floorplan_v02.svg'), 'utf8');

const G = {
  773:  { x: 764.18, y: 211.93, w: 40.39, h: 80.79 },   // drawn where written (rotated 180° about its centre)
  P014: { x: 764.18, y: 211.93, w: 40.39, h: 80.79 },   // the same rectangle under another number
  771:  { x: 764.43, y: 252.29, w: 40.39, h: 40.46 },   // inside 773, flush with its left, right and bottom
  1150: { x: 360.5,  y: 583.44, w: 81.2,  h: 67.81 },
  1051: { x: 401.13, y: 610.82, w: 40.39, h: 40.46 },   // inside 1150, flush with its right and bottom
  900:  { x: 535.29, y: 1688.06, w: 53.86, h: 80.79 },  // a split: the primary cell …
  '900-2': { x: 589.15, y: 1688.06, w: 53.86, h: 80.79 }, // … and its secondary, flush with 900's top, right and bottom
};
const near = (a, b, tol = 0.1) => Math.abs(a - b) < tol;
// The hosts as DRAWN: 773's rectangle is written rotated 180° about its own
// centre, so it lands a hundredth off its written box; 1150 is written plainly.
const H773 = { x: 764.19, y: 211.92, w: 40.39, h: 80.79 };
const H1150 = G[1150];

(async () => {
  const srv = await start({ svg: V02 });
  const { page, errors } = await openPage(srv.browser, `${srv.base}/floorplan`, { viewport: { width: 1600, height: 1400 } });
  await wait(1500);
  await page.evaluate(s => window.__fire('state:full', s), [
    stand(0, G[773], { boothNumber: '773' }), stand(1, G.P014, { boothNumber: 'P014' }), stand(2, G[771], { boothNumber: '771' }),
    stand(3, G[1150], { boothNumber: '1150' }), stand(4, G[1051], { boothNumber: '1051', status: 'held' }),
    stand(5, G[900], { boothNumber: '900' }), stand(6, G['900-2'], { boothNumber: '900-2', splitFrom: '900', splitAxis: 'vertical' }),
  ]);
  await wait(800);

  const r = await page.evaluate(() => {
    const svg = document.querySelector('#svg-mount svg');
    const box = (n) => { const e = svg.querySelector(`[data-booth="${n}"]`); return e && { x: +e.getAttribute('x'), y: +e.getAttribute('y'), w: +e.getAttribute('width'), h: +e.getAttribute('height'), overlay: e.hasAttribute('data-overlay') }; };
    return { stroke: parseFloat(getComputedStyle(svg.querySelector('[data-booth="773"]')).strokeWidth),
             773: box('773'), P014: box('P014'), 771: box('771'), 1051: box('1051'), '900-2': box('900-2') };
  });
  const half = r.stroke / 2;
  console.log(`\nThe plan strokes a stand at ${r.stroke}`);
  check('773 is the plan\'s own rectangle, untouched', !r[773].overlay && near(r[773].x, 764.18) && near(r[773].w, 40.39), JSON.stringify(r[773]));

  console.log('\nP014, the same rectangle as 773');
  check('is pulled in to half a stroke inside 773\'s edges on all four sides',
        r.P014.overlay && near(r.P014.x, H773.x + half) && near(r.P014.y, H773.y + half) && near(r.P014.w, H773.w - 2 * half) && near(r.P014.h, H773.h - 2 * half),
        JSON.stringify(r.P014));

  console.log('\n771, inside 773, overhanging its right edge by a quarter and flush with the left and bottom');
  check('is pulled in to half a stroke inside 773\'s left, right and bottom, and keeps its own top',
        r[771].overlay && near(r[771].x, H773.x + half) && near(r[771].y, 252.29) &&
        near(r[771].x + r[771].w, H773.x + H773.w - half) && near(r[771].y + r[771].h, H773.y + H773.h - half),
        JSON.stringify(r[771]));

  console.log('\n1051 on hold, flush with 1150\'s right and bottom');
  check('is pulled in on those two sides only',
        r[1051].overlay && near(r[1051].x, 401.13) && near(r[1051].y, 610.82) &&
        near(r[1051].x + r[1051].w, H1150.x + H1150.w - half) && near(r[1051].y + r[1051].h, H1150.y + H1150.h - half),
        JSON.stringify(r[1051]));

  console.log('\nA split cell flush with its stand\'s edges');
  check('covers its share exactly — it draws its own box', r['900-2'].overlay && near(r['900-2'].x, 589.15) && near(r['900-2'].w, 53.86) && near(r['900-2'].h, 80.79),
        JSON.stringify(r['900-2']));

  check('no page errors', errors.length === 0, errors.join(' | '));
  await srv.close();
  finish();
})().catch(e => { console.error(e); process.exit(1); });
