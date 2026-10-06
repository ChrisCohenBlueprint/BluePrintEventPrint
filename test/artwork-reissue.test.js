/**
 * A re-issued drawing reaches every open plan, and nothing of the old one
 * survives it.
 *
 * Three ways the old drawing outlived its replacement:
 *
 *   1. floorplan:changed is a broadcast — sent once, to whoever is connected
 *      at that moment, and not replayed. A visitor whose socket was down when
 *      the new drawing went up reconnected, received state:full with the NEW
 *      geometry, and the page bound it to the OLD drawing it still had: a
 *      stand that moved became a transparent overlay floating over wherever
 *      the old artwork happened to be, until a reload. Every reconnect now
 *      asks the server whether the drawing has changed — a conditional
 *      request, so when it has not the answer is a 304 with no body.
 *
 *   2. BoothMap caches what it measures in the artwork — where an area's
 *      printed name is, every glyph's box, how a stand's number is lettered —
 *      for the life of the page. A new drawing is a new document, and those
 *      caches went on describing the old one: an area's printed name was
 *      "found" as elements of the detached old document, so the shrink that
 *      makes room for a sponsor's logo was applied to nodes nobody could see
 *      and the logo was drawn over the full-size name; and a split cell's
 *      number was sized from the old drawing's lettering.
 *
 *   3. When a re-tag turned a rectangle back into plain artwork (its stand
 *      merged away or split), clear() took off its stand number and status
 *      classes but left it focusable, announced as a button with the old
 *      stand's name, still faded or ringed by the search and still painted in
 *      the sponsor's colour.
 */
const { start, openPage, artworkRects, stand, reporter, wait, LEX27 } = require('./floorplan-stub');

const { check, finish } = reporter();

// The drawing as re-issued: the first stand has moved, and the file carries a
// mark that only it has.
const V2 = LEX27
  .replace('<rect class="cls-10" x="171.83" y="1391.69"', '<rect class="cls-10" x="1171.83" y="1391.69"')
  .replace('</svg>', '<rect id="reissue-mark" x="0" y="0" width="1" height="1" fill="none"/></svg>');

const BLANK = `<!doctype html><title>booth-map</title>
  <script src="/booth-map.js"></script>
  <svg id="a" viewBox="0 0 200 100" width="400" height="200">
    <rect class="cls-10" x="0" y="0" width="100" height="60" fill="#fff" stroke="#000"/>
    <text x="5" y="15" font-size="10">12</text>
  </svg>
  <svg id="b" viewBox="0 0 200 100" width="400" height="200">
    <rect class="cls-10" x="0" y="0" width="100" height="60" fill="#fff" stroke="#000"/>
    <text x="5" y="25" font-size="20">12</text>
  </svg>`;

const LOGO = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#e11d48"/></svg>');

(async () => {
  const srv = await start({ routes: (app) => app.get('/blank', (_q, res) => res.type('html').send(BLANK)) });
  const { page, errors } = await openPage(srv.browser, `${srv.base}/floorplan`);
  await wait(1200);

  const rects = await artworkRects(page, 40);
  const stands = rects.map((g, i) => stand(i, g));
  const areas = await page.evaluate((logo) => [...document.querySelectorAll('#svg-mount svg rect.cls-6, #svg-mount svg rect.cls-8')]
    .map((r, i) => ({ key: 'area' + i, label: 'Area ' + i, status: 'taken', sponsor: 'Someone', logo,
      geometry: { x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') } })), LOGO);
  await page.evaluate(s => window.__fire('state:full', s), stands);
  await wait(800);
  await page.evaluate(a => window.__fire('areas:catalogue', a), areas);
  await wait(800);

  const scaledNames = () => page.evaluate(() => {
    const all = [...document.querySelectorAll('#svg-mount svg [data-label-scaled]')];
    return all.length;
  });

  console.log('\nA sponsored area on the drawing as first loaded');
  const before = await scaledNames();
  check('its printed name is shrunk to make room for the logo', before > 0, `${before} glyphs scaled`);

  console.log('\nThe drawing is re-issued while the visitor is connected');
  srv.state.version = 'v1b';                        // same artwork, new version
  await page.evaluate(() => window.__fire('floorplan:changed', { version: 'v1b' }));
  await wait(2500);
  const after = await scaledNames();
  check('the new drawing\'s printed names are shrunk too — not the old document\'s', after === before,
        `${after} glyphs scaled in the new drawing, ${before} before`);
  const logos = await page.evaluate(() => document.querySelectorAll('#svg-mount svg image[id^="area-logo-"]').length);
  check('and the logos are drawn on it', logos > 0, `${logos} logos`);

  console.log('\nThe drawing is re-issued while the visitor is offline');
  const marked = () => page.evaluate(() => !!document.querySelector('#svg-mount svg #reissue-mark'));
  await page.evaluate(() => window.__drop());
  srv.state.svg = V2;
  srv.state.version = 'v2';
  const moved = { ...rects[0], x: 1171.83 };
  const restate = [stand(0, moved), ...stands.slice(1)];
  await page.evaluate(s => window.__fire('state:full', s), restate);  // as the server sends on reconnect
  srv.state.svgRequests.length = 0;
  await page.evaluate(() => window.__rejoin());
  await wait(2500);
  check('reconnecting fetches the new drawing', await marked());
  check('asking with the version it had', srv.state.svgRequests[0] && srv.state.svgRequests[0].inm === '"v1b"',
        JSON.stringify(srv.state.svgRequests));
  const bound = await page.evaluate(() => {
    const el = document.querySelector('#svg-mount svg [data-booth="100"]');
    return el && { overlay: el.hasAttribute('data-overlay'), x: el.getAttribute('x') };
  });
  check('and the stand that moved is bound to where it is now drawn',
        bound && !bound.overlay && bound.x === '1171.83', JSON.stringify(bound));

  console.log('\nReconnecting when nothing has changed');
  await page.evaluate(() => { document.querySelector('#svg-mount svg').__sameNode = true; });
  srv.state.svgRequests.length = 0;
  await page.evaluate(() => { window.__drop(); window.__rejoin(); });
  await wait(1200);
  check('costs one conditional request, answered 304', srv.state.svgRequests.length === 1
        && srv.state.svgRequests[0].status === 304 && srv.state.svgRequests[0].inm === '"v2"',
        JSON.stringify(srv.state.svgRequests));
  check('and the plan on screen is left alone', await page.evaluate(() =>
    !!document.querySelector('#svg-mount svg').__sameNode));

  console.log('\nA rectangle that stops being a stand');
  await page.evaluate(() => window.__fire('floorplan-sponsor', { color: '#0e7490', name: 'Title Sponsor' }));
  const sponsoredRows = restate.map(s => s.boothNumber === '101' ? { ...s, sponsored: true } : s);
  await page.evaluate(s => window.__fire('state:full', s), sponsoredRows);
  await page.fill('#fps-input', '102');                  // lights 102, fades the rest
  await wait(400);
  const g = rects[1];
  const rectFor = () => page.evaluate((g) => {
    const el = [...document.querySelectorAll('#svg-mount svg rect')].find(r =>
      r.getAttribute('x') === String(g.x) && r.getAttribute('y') === String(g.y));
    return el && { booth: el.getAttribute('data-booth'), tabindex: el.getAttribute('tabindex'), role: el.getAttribute('role'),
                   label: el.getAttribute('aria-label'), cls: el.getAttribute('class'),
                   fill: el.style.getPropertyValue('fill') };
  }, g);
  const was = await rectFor();
  check('while it is stand 101 it is a sponsored, faded, focusable button',
        was && was.booth === '101' && was.role === 'button' && was.tabindex === '0'
        && /booth-sponsored/.test(was.cls) && /booth-dim/.test(was.cls) && !!was.fill, JSON.stringify(was));
  // 101 merged away: it is no longer in the broadcast, which re-tags the map.
  await page.evaluate(s => window.__fire('state:full', s), sponsoredRows.filter(s => s.boothNumber !== '101'));
  await wait(600);
  const now = await rectFor();
  check('afterwards it is not a stand', now && !now.booth, JSON.stringify(now));
  check('not focusable, and not announced as one', now && now.tabindex === null && now.role === null && now.label === null,
        JSON.stringify(now));
  check('not faded, lit or sponsored', now && !/booth-(dim|match|sponsored)/.test(now.cls || ''), now && now.cls);
  check('and not painted in the sponsor\'s colour', now && !now.fill, now && now.fill);
  check('the floorplan raised no errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  console.log('\nSplit-cell lettering, measured per drawing');
  const blank = await openPage(srv.browser, `${srv.base}/blank`);
  const sizes = await blank.page.evaluate(() => {
    const cells = [
      { boothNumber: '12', splitAxis: 'vertical', geometry: { x: 0, y: 0, w: 50, h: 60 } },
      { boothNumber: '12b', splitFrom: '12', splitAxis: 'vertical', geometry: { x: 50, y: 0, w: 50, h: 60 } },
    ];
    const font = (id) => {
      const svg = document.getElementById(id);
      BoothMap.attach(svg, cells, {});
      return parseFloat(svg.querySelector('[data-split-label="12"]').getAttribute('font-size'));
    };
    return { a: font('a'), b: font('b') };
  });
  check('a cell is lettered to match ITS drawing\'s numbers, not the last one measured',
        sizes.a > 0 && sizes.b > sizes.a * 1.6, `${sizes.a}px on a drawing lettered at 10, ${sizes.b}px on one lettered at 20`);
  check('that page raised no errors', blank.errors.length === 0, blank.errors.slice(0, 2).join(' | '));

  await srv.close();
  finish();
})().catch((e) => { console.error(e); process.exit(1); });
