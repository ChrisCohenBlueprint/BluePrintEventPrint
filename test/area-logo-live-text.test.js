/**
 * A sponsor's logo on a plan whose lettering is live text.
 *
 * Europe's first plan had its names converted to outlines, so the code that
 * finds an area's printed name — to shrink it and lift it clear of the logo —
 * measured paths and polygons and nothing else. The re-issued plan prints
 * "NETWORKING LOUNGE" as <text>. The name was not found, so the logo was sized
 * to the whole box and the name was left full size across it (Shell on 1120,
 * 13 Oct 2026). And live text is placed by a transform of its own, which the
 * shrink used to write over.
 */
const path = require('path');
const fs = require('fs');
const { start, openPage, reporter, wait } = require('./floorplan-stub');

const { check, finish } = reporter();

const V02 = fs.readFileSync(path.join(__dirname, 'fixtures', 'LEX27_Floorplan_v02.svg'), 'utf8');
const LOGO = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><rect width="60" height="40" fill="#e11d48"/></svg>');
// The West lounge, as the plan draws it and as plan-areas stores it.
const WEST = { x: 400.73, y: 1243.58, w: 107.72, h: 94.25 };
const EAST = { x: 1356.72, y: 1243.58, w: 121.18, h: 107.72 };
const area = (key, g, logo) => ({ key, label: key, status: logo ? 'taken' : 'available',
                                  sponsor: logo ? 'Shell' : null, logo: logo || null, geometry: g });

// The lounge's lettering and its box, in screen pixels, so the comparison is
// of what is drawn rather than of attributes.
const measure = (page, g) => page.evaluate((g) => {
  const svg = document.querySelector('#svg-mount svg');
  const inside = (r, h) => r.left >= h.left - 1 && r.top >= h.top - 1 && r.right <= h.right + 1 && r.bottom <= h.bottom + 1;
  const host = [...svg.querySelectorAll('rect')].find(r => Math.abs(+r.getAttribute('x') - g.x) < 1 && Math.abs(+r.getAttribute('y') - g.y) < 1);
  const hb = host.getBoundingClientRect();
  const name = [...svg.querySelectorAll('text')].find(t => /NETWORKING\s*LOUNGE/.test(t.textContent.replace(/\s+/g, ' ')) &&
                                                          inside(t.getBoundingClientRect(), hb));
  const nb = name.getBoundingClientRect();
  const img = svg.querySelector('image[id="area-logo-' + host.getAttribute('data-area') + '"]');
  const ib = img ? img.getBoundingClientRect() : null;
  const box = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height });
  return { host: box(hb), name: box(nb), logo: ib ? box(ib) : null,
           scaled: name.hasAttribute('data-label-scaled'), transform: name.getAttribute('transform'),
           nameInside: inside(nb, hb), logoInside: ib ? inside(ib, hb) : null, clickable: host.getAttribute('data-area') };
}, g);

(async () => {
  const srv = await start({ svg: V02 });
  const { page, errors } = await openPage(srv.browser, `${srv.base}/floorplan`, { viewport: { width: 1600, height: 1400 } });
  await wait(1500);
  await page.evaluate(() => window.__fire('state:full', []));
  await wait(500);

  console.log('\nBefore any sponsor: the lettering as the plan placed it');
  const plain = await measure(page, WEST);
  const plainEast = await measure(page, EAST);
  check('the name is live text placed by its own translate', /^translate\(/.test(plain.transform || ''), plain.transform);
  check('and sits inside the lounge', plain.nameInside);

  console.log('\nShell takes the West lounge');
  await page.evaluate(a => window.__fire('areas:catalogue', a), [area('networking-lounge-west', WEST, LOGO), area('networking-lounge-east', EAST, null)]);
  await wait(1200);
  const west = await measure(page, WEST);
  check('the lounge is clickable', west.clickable === 'networking-lounge-west', String(west.clickable));
  check('the logo is drawn', !!west.logo);
  check('the printed name is shrunk to make room', west.scaled && west.name.h < plain.name.h * 0.75,
        `${west.name.h.toFixed(1)}px tall, was ${plain.name.h.toFixed(1)}px`);
  check('and keeps its own placement underneath', (west.transform || '').endsWith(plain.transform), west.transform);
  check('so it is still inside the lounge', west.nameInside, JSON.stringify({ name: west.name, host: west.host }));
  check('lifted towards the top', west.name.top < plain.name.top, `${west.name.top.toFixed(1)} was ${plain.name.top.toFixed(1)}`);
  check('the logo sits below the name, not under it', west.logo && west.logo.top >= west.name.bottom - 1 && west.logoInside,
        JSON.stringify({ logo: west.logo, name: west.name }));

  const east = await measure(page, EAST);
  check('the East lounge, with no sponsor, is left as drawn',
        !east.scaled && east.transform === plainEast.transform && Math.abs(east.name.h - plainEast.name.h) < 0.5 && !east.logo,
        JSON.stringify({ transform: east.transform, h: east.name.h, was: plainEast.name.h }));

  console.log('\nShell leaves');
  await page.evaluate(a => window.__fire('areas:catalogue', a), [area('networking-lounge-west', WEST, null), area('networking-lounge-east', EAST, null)]);
  await wait(1000);
  const gone = await measure(page, WEST);
  check('the name is exactly as the plan placed it', !gone.scaled && gone.transform === plain.transform, gone.transform);
  check('at its full size', Math.abs(gone.name.h - plain.name.h) < 0.5, `${gone.name.h.toFixed(1)}px vs ${plain.name.h.toFixed(1)}px`);
  check('and the logo is gone', !gone.logo);

  check('no page errors', errors.length === 0, errors.join(' | '));
  await srv.close();
  finish();
})().catch(e => { console.error(e); process.exit(1); });
