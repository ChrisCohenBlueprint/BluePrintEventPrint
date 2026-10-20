/**
 * A stand drawn as an overlay sits ABOVE the shape it sits in.
 *
 * A stand with no rectangle of its own on the plan — a split cell, a hold on
 * part of a bigger stand — is a transparent overlay inserted just after its
 * host shape, so its colour paints over the host. The host was the first
 * shape in document order containing the stand's centre, and on Europe's
 * re-issued plan that is the hall's background: the overlay went in beneath
 * every stand drawn later. 1051, held inside 1150, was painted orange and then
 * covered by 1150's white, leaving only its hold's name showing.
 */
const path = require('path');
const fs = require('fs');
const { start, openPage, stand, reporter, wait } = require('./floorplan-stub');

const { check, finish } = reporter();
const V02 = fs.readFileSync(path.join(__dirname, 'fixtures', 'LEX27_Floorplan_v02.svg'), 'utf8');

const G1150 = { x: 360.5, y: 583.44, w: 81.2, h: 67.81 };     // as the plan writes it
const G1051 = { x: 401.13, y: 610.82, w: 40.39, h: 40.46 };   // the old plan's stand, inside 1150

(async () => {
  const srv = await start({ svg: V02 });
  const { page, errors } = await openPage(srv.browser, `${srv.base}/floorplan`, { viewport: { width: 1600, height: 1400 } });
  await wait(1500);
  await page.evaluate(s => window.__fire('state:full', s), [
    stand(0, G1150, { boothNumber: '1150', sqm: 30 }),
    stand(1, G1051, { boothNumber: '1051', status: 'held', sqm: 9 }),
  ]);
  await wait(800);

  const r = await page.evaluate(() => {
    const svg = document.querySelector('#svg-mount svg');
    const host = svg.querySelector('[data-booth="1150"]'), held = svg.querySelector('[data-booth="1051"]');
    const b = held.getBoundingClientRect();
    const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    const all = [...svg.querySelectorAll('*')];
    return {
      hostIsArtwork: host.tagName === 'rect' && host.classList.contains('cls-4'),
      heldFill: getComputedStyle(held).fill,
      heldAfterHost: all.indexOf(held) > all.indexOf(host),
      atCentre: top && top.getAttribute('data-booth'),
      previous: held.previousElementSibling && held.previousElementSibling.getAttribute('data-booth'),
    };
  });
  console.log('\n1051 on hold, inside 1150');
  check('1150 is the plan\'s own rectangle', r.hostIsArtwork);
  check('1051 is painted in the hold colour', /249, 115, 22/.test(r.heldFill), r.heldFill);
  check('and sits in the document after 1150, not after the hall', r.heldAfterHost && r.previous === '1150', `previous sibling: ${r.previous}`);
  check('so it is what you see, and click, at its centre', r.atCentre === '1051', String(r.atCentre));
  check('no page errors', errors.length === 0, errors.join(' | '));

  await srv.close();
  finish();
})().catch(e => { console.error(e); process.exit(1); });
