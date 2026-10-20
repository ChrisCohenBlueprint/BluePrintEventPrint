/**
 * A stand taken off the plan is painted out only where the plan still draws
 * it — and never over a stand that is for sale.
 *
 * Europe, Oct 2026: the re-issued plan stopped drawing 751, 751 was then taken
 * off the plan, and the hall floor painted over its OLD box covered a third of
 * 850 — a live stand — and a strip of aisle. There was nothing under that box
 * to hide: no rectangle, no lettering. And a removed stand's box can overlap a
 * live one in other ways (a block it once shared), so the paint is now cut
 * around every live stand it meets.
 */
const path = require('path');
const fs = require('fs');
const { start, openPage, stand, reporter, wait } = require('./floorplan-stub');

const { check, finish } = reporter();
const V02 = fs.readFileSync(path.join(__dirname, 'fixtures', 'LEX27_Floorplan_v02.svg'), 'utf8');

// Boxes as the v02 drawing writes them (the stored geometry), and 751's as the
// old plan wrote it — the drawing no longer has it.
const G = {
  850:  { x: 737.38, y: 583.79, w: 53.97, h: 80.96 },
  852:  { x: 723.93, y: 556.86, w: 40.39, h: 40.46 },
  753:  { x: 764.42, y: 556.86, w: 40.39, h: 40.46 },
  1150: { x: 360.5,  y: 583.44, w: 81.2,  h: 67.81 },
  751:  { x: 757.67, y: 604.09, w: 53.86, h: 40.46 },
  1051: { x: 401.13, y: 610.82, w: 40.39, h: 40.46 },   // inside 1150's rectangle
  765:  { x: 697.27, y: 328.12, w: 107.72, h: 107.45 }, // rotated on the plan; drawn 697.3,328.1 107.5×107.7
  761:  { x: 764.43, y: 395.38, w: 40.39, h: 40.46 },   // the old plan's stand, flush with 765's right and bottom edges
};
const live = (n) => stand(0, G[n], { boothNumber: String(n) });
const gone = (n) => stand(0, G[n], { boothNumber: String(n), status: 'removed', removed: true });

const measure = (page) => page.evaluate(() => {
  const svg = document.querySelector('#svg-mount svg');
  const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
  const overlap = (a, c) => Math.max(0, Math.min(a.r, c.r) - Math.max(a.l, c.l)) * Math.max(0, Math.min(a.b, c.b) - Math.max(a.t, c.t));
  const masks = [...svg.querySelectorAll('[data-removed-mask]')].map(e => ({ for: e.getAttribute('data-removed-mask'), box: r(e) }));
  const out = { masks: masks.map(m => m.for), hidden: [...svg.querySelectorAll('[data-removed-src]')].map(e => e.getAttribute('data-removed-src')),
                edges: [...svg.querySelectorAll('[data-removed-edge]')].map(e => e.getAttribute('data-removed-edge')) };
  for (const n of ['850', '852', '1150', '765']) {
    const el = svg.querySelector(`[data-booth="${n}"]`);
    if (!el) continue;
    const box = r(el);
    out[n] = { clickable: getComputedStyle(el).pointerEvents !== 'none' && el.classList.contains('booth-interactive'),
               paintedOver: masks.filter(m => overlap(m.box, box) > 2).map(m => m.for) };
  }
  return out;
});

(async () => {
  const srv = await start({ svg: V02 });
  const { page, errors } = await openPage(srv.browser, `${srv.base}/floorplan`, { viewport: { width: 1600, height: 1400 } });
  await wait(1500);

  console.log('\n751, which the drawing no longer has, taken off the plan');
  await page.evaluate(s => window.__fire('state:full', s), [live(850), live(852), live(1150), gone(751)]);
  await wait(800);
  let m = await measure(page);
  check('no floor is painted for it — there is nothing to hide', !m.masks.includes('751'), JSON.stringify(m.masks));
  check('850 is not painted over', m['850'].paintedOver.length === 0, JSON.stringify(m['850'].paintedOver));
  check('and is still for sale on the map', m['850'].clickable);

  console.log('\n753, which the drawing does draw, taken off the plan');
  await page.evaluate(s => window.__fire('state:full', s), [live(850), live(852), live(1150), gone(753)]);
  await wait(800);
  m = await measure(page);
  check('its rectangle is hidden', m.hidden.includes('753'), JSON.stringify(m.hidden));
  check('and the floor painted over its lettering', m.masks.includes('753'), JSON.stringify(m.masks));
  check('without touching 852 beside it or 850 below it', m['852'].paintedOver.length === 0 && m['850'].paintedOver.length === 0,
        JSON.stringify({ 852: m['852'].paintedOver, 850: m['850'].paintedOver }));

  console.log('\nA removed stand whose box lies inside a stand still for sale');
  await page.evaluate(s => window.__fire('state:full', s), [live(850), live(852), live(1150), live(765), gone(1051)]);
  await wait(800);
  m = await measure(page);
  check('1150 is not painted over', m['1150'].paintedOver.length === 0, JSON.stringify(m['1150'].paintedOver));
  check('and stays for sale', m['1150'].clickable);
  check('no floor is painted for it at all — not even a sliver along 1150\'s edge', !m.masks.includes('1051'), JSON.stringify(m.masks));
  check('and no line is redrawn over 1150\'s own', !m.edges.includes('1051'), JSON.stringify(m.edges));

  console.log('\nA removed stand flush with the edges of the stand it lies in');
  await page.evaluate(s => window.__fire('state:full', s), [live(850), live(852), live(1150), live(765), gone(761)]);
  await wait(800);
  m = await measure(page);
  check('765 is not painted over', m['765'].paintedOver.length === 0, JSON.stringify(m['765'].paintedOver));
  check('no floor, no redrawn lines', !m.masks.includes('761') && !m.edges.includes('761'), JSON.stringify({ masks: m.masks, edges: m.edges }));
  check('765 stays for sale', m['765'].clickable);

  check('no page errors', errors.length === 0, errors.join(' | '));
  await srv.close();
  finish();
})().catch(e => { console.error(e); process.exit(1); });
