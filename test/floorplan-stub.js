/**
 * The public floorplan with nothing behind it: the real page and the real
 * artwork, a stand-in socket the test drives by hand, and the JSON routes the
 * page fetches. Not a suite itself — run-all.js only picks up *.test.js.
 *
 * Every floorplan suite used to carry its own copy of this, and each copy's
 * socket could do one thing: deliver a broadcast. The suites built on this one
 * need the rest of what a socket does to a page — connecting, dropping,
 * coming back, an acknowledgement that never arrives — and need to see what the
 * page sent, so that is all here, once.
 *
 * In the page:
 *   window.__fire(event, payload)  deliver a broadcast
 *   window.__drop() / __rejoin()   lose the connection / get it back
 *   window.__emits                 everything the page emitted: { e, p, connected }
 *   window.__acks[event]           the ack to answer with; 'never' to answer nothing
 *   window.__handshake()           what the auth function would send right now
 *
 * The socket connects on its own a tick after it is created, as the real one
 * does, unless the page is opened with window.__noAutoConnect set.
 */
const express = require('express');
const path = require('path');
const fs   = require('fs');
const { launch, listen } = require('./harness');
const { sendPage } = require('../server/lib/send-page');
const { rects } = require('../scripts/svg-paths');

const PUBLIC = path.join(__dirname, '..', 'public');
const LEX27 = fs.readFileSync(path.join(PUBLIC, 'LEX27_Floorplan_Consolidated.svg'), 'utf8');

const SOCKET_SHIM = `
  window.__h = {}; window.__emits = []; window.__conn = false; window.__acks = {};
  window.io = function (opts) {
    window.__ioOpts = opts;
    var sock = {
      on: function (e, f) { (window.__h[e] = window.__h[e] || []).push(f); return this; },
      emit: function (e, p, cb) {
        window.__emits.push({ e: e, p: p === undefined ? null : JSON.parse(JSON.stringify(p)),
                              connected: window.__conn });
        if (typeof cb === 'function') { var a = window.__acks[e]; if (a !== 'never') cb(a || { ok: true }); }
        return this;
      },
      off: function () { return this; },
      connect: function () { return this; },
      get connected() { return window.__conn; },
    };
    if (!window.__noAutoConnect) setTimeout(function () { window.__rejoin(); }, 0);
    return sock;
  };
  window.__fire = function (e, p) { (window.__h[e] || []).forEach(function (f) { f(p); }); };
  window.__drop = function () { window.__conn = false; window.__fire('disconnect', 'transport close'); };
  window.__rejoin = function () { window.__conn = true; window.__fire('connect'); };
  window.__handshake = function () { var out; window.__ioOpts.auth(function (a) { out = a; }); return out; };
`;

/**
 * Serve the page. `state` is live: change it between steps and the next
 * request sees the change (a re-issued drawing is `state.svg` and
 * `state.version` changed together).
 */
async function start(opts = {}) {
  const state = {
    svg: opts.svg || LEX27,
    version: 'v1',
    svgStatus: 200,
    svgDelay: 0,
    svgRequests: [],
    countries: opts.countries || [],
    recommend: opts.recommend || ((_req, res) => res.json({ sponsors: [] })),
    show: opts.show || { slug: 'lex', id: 'LEX', name: 'LEX' },
  };

  const app = express();
  app.get('/socket.io/socket.io.js', (_q, res) => res.type('application/javascript').send(SOCKET_SHIM));
  // As the real route answers an uploaded plan: the version is the ETag, and a
  // request that already holds it gets a 304 with no body.
  app.get('/floorplan.svg', async (req, res) => {
    if (state.svgDelay) await new Promise(r => setTimeout(r, state.svgDelay));
    const inm = req.get('If-None-Match') || null;
    if (state.svgStatus !== 200) {
      state.svgRequests.push({ inm, status: state.svgStatus });
      return res.status(state.svgStatus).send('unavailable');
    }
    res.type('image/svg+xml');
    res.set('ETag', `"${state.version}"`);
    res.set('Cache-Control', 'no-cache');
    if (inm === `"${state.version}"`) {
      state.svgRequests.push({ inm, status: 304 });
      return res.status(304).end();
    }
    state.svgRequests.push({ inm, status: 200 });
    res.send(state.svg);
  });
  app.get('/countries', (_q, res) => res.json({ countries: state.countries }));
  app.get('/partners',  (_q, res) => res.json([]));
  app.get('/sponsors/recommend', (req, res) => state.recommend(req, res));
  app.get(/^\/sponsors\//, (_q, res) => res.json([]));
  app.get('/floorplan', (_q, res) => sendPage(res, 'floorplan.html', state.show));
  if (opts.routes) opts.routes(app, state);
  app.use(express.static(PUBLIC));

  const { server, base } = await listen(app);
  const browser = await launch();
  return {
    state, base, browser,
    async close() { await browser.close(); server.close(); },
  };
}

/** A page with the error collector every suite wants. */
async function openPage(browser, url, { viewport = { width: 1280, height: 900 }, init, waitUntil = 'networkidle' } = {}) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
  if (init) await page.addInitScript(init);
  await page.goto(url, { waitUntil, timeout: 30000 });
  return { page, errors };
}

/**
 * The same stand rectangles, read from the FILE rather than the page — for a
 * suite that needs real geometry before the page has (or while it cannot get)
 * the artwork.
 */
function fileRects(n = 60) {
  return rects(LEX27).filter(r => r.cls === 'cls-10').slice(0, n)
    .map(({ x, y, w, h }) => ({ x, y, w, h }));
}

/** The first `n` stand rectangles the artwork really draws, as geometry. */
function artworkRects(page, n = 60) {
  return page.evaluate((n) => [...document.querySelectorAll('#svg-mount svg rect.cls-10')]
    .slice(0, n).map(r => ({ x: +r.getAttribute('x'), y: +r.getAttribute('y'),
                             w: +r.getAttribute('width'), h: +r.getAttribute('height') })), n);
}

/** A stand row as the server's toPublic() sends it. */
function stand(i, geometry, extra = {}) {
  return { boothNumber: String(100 + i), status: 'available', company: null, sqm: 9, geometry,
           displayNumber: null, sponsored: false, sponsorLogo: null, tags: [], country: null,
           splitFrom: null, splitAxis: null, merged: false, removed: false, viewers: 0, interest: 0,
           ...extra };
}

/** PASS/FAIL lines and the result line run-all.js reads. */
function reporter() {
  const out = [];
  const check = (n, ok, d = '') => {
    out.push(!!ok);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`);
  };
  const finish = () => {
    const f = out.filter(x => !x).length;
    console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
    process.exit(f ? 1 : 0);
  };
  return { check, finish };
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = { start, openPage, artworkRects, fileRects, stand, reporter, wait, LEX27 };
