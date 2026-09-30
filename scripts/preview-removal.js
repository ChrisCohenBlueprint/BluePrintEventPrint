#!/usr/bin/env node
/**
 * See a stand come off the plan, on this machine, with nothing live involved.
 *
 *   node scripts/preview-removal.js            → a page at http://127.0.0.1:3111
 *   node scripts/preview-removal.js --shots    → writes before/after PNGs instead
 *
 * No database, no Atlas, no admin login — the real floorplan page, the real
 * artwork and the real public/booth-map.js, fed by a socket stand-in that keeps
 * the stands in memory. Clicking "Remove" here runs exactly the code a removal
 * runs on the live site; the only thing missing is the server writing it down.
 *
 * What to look at: pull a stand from the middle of a block and its neighbours
 * keep every wall they shared with it, while the stand's own outline, number
 * and size go. Pull one off the end of a row and only the side it was attached
 * by survives. Pull two that touch and the wall between them goes with them.
 *
 * See the floorplan-browser-test-harness memory for why the stub exists.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 3111);
const SVG = path.join(ROOT, 'public', 'LEX27_Floorplan_Consolidated.svg');

// ─── The socket stand-in ──────────────────────────────────────────────────────
// Holds the stands in memory and answers booth:remove / booth:restore-stand the
// way the server does, so the page's own handlers drive the whole thing.
const SHIM = `
  window.__h = {};
  window.__stands = [];
  window.io = function () {
    return {
      on: function (e, f) { (window.__h[e] = window.__h[e] || []).push(f); return this; },
      emit: function (e, p, cb) {
        if (e === 'booth:remove' || e === 'booth:restore-stand') {
          var s = window.__stands.find(function (x) { return x.boothNumber === p.boothNumber; });
          if (s) {
            var off = e === 'booth:remove';
            s.removed = off || undefined;
            s.status = off ? 'removed' : 'available';
            window.__push();
          }
        }
        if (typeof cb === 'function') cb({ ok: true });
        return this;
      },
      off: function () { return this; },
      get connected() { return true; },
    };
  };
  window.__fire = function (e, p) { (window.__h[e] || []).forEach(function (f) { f(p); }); };
  window.__push = function () {
    window.__fire('state:full', window.__stands.map(function (s) { return JSON.parse(JSON.stringify(s)); }));
    if (window.__renderPanel) window.__renderPanel();
  };
`;

// ─── The control panel ────────────────────────────────────────────────────────
// The public floorplan has no Remove button — that lives in the admin console,
// behind a login this harness deliberately has no way to satisfy. So the same
// two socket calls the admin panel makes are put on screen here instead.
const PANEL = `
(function () {
  function mount() {
    var svg = document.querySelector('#svg-mount svg');
    if (!svg || !window.__stands.length) return setTimeout(mount, 300);

    var box = document.createElement('div');
    box.id = 'removal-preview';
    box.innerHTML =
      '<h4>Stand removal — preview</h4>' +
      '<p>Click a stand on the plan to pick it, or use the list. Nothing here is saved anywhere.</p>' +
      '<div id="rp-pick"></div><div id="rp-list"></div>';
    document.body.appendChild(box);

    var css = document.createElement('style');
    css.textContent =
      '#removal-preview{position:fixed;top:12px;right:12px;width:280px;max-height:88vh;overflow:auto;' +
      'z-index:99999;background:#fff;border:1px solid #d4d4d8;border-radius:10px;padding:14px;' +
      'box-shadow:0 8px 30px rgba(0,0,0,.14);font:13px/1.45 Raleway,system-ui,sans-serif;color:#18181b}' +
      '#removal-preview h4{margin:0 0 6px;font-size:14px}' +
      '#removal-preview p{margin:0 0 10px;color:#71717a;font-size:11.5px}' +
      '#removal-preview button{width:100%;margin:3px 0;padding:7px 9px;border-radius:7px;cursor:pointer;' +
      'border:1px solid #d4d4d8;background:#fafafa;font:inherit;text-align:left}' +
      '#removal-preview button:hover{background:#f4f4f5}' +
      '#removal-preview button.off{background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.3);color:#b91c1c}' +
      '#removal-preview .hd{margin:12px 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;' +
      'letter-spacing:.06em;color:#71717a}';
    document.head.appendChild(css);

    // Picking a stand on the plan itself, ahead of the page's own click handler.
    var picked = null;
    svg.addEventListener('click', function (ev) {
      var el = ev.target.closest('[data-booth]');
      if (!el) return;
      picked = el.getAttribute('data-booth');
      window.__renderPanel();
    }, true);

    window.__renderPanel = function () {
      var gone = window.__stands.filter(function (s) { return s.removed; });
      var pickEl = document.getElementById('rp-pick');
      var s = picked && window.__stands.find(function (x) { return x.boothNumber === picked; });
      pickEl.innerHTML = s && !s.removed
        ? '<div class="hd">Selected</div>'
        : '<div class="hd">Selected</div><p style="margin:0">Click a stand on the plan.</p>';
      if (s && !s.removed) {
        var b = document.createElement('button');
        b.className = 'off';
        b.textContent = 'Remove stand ' + s.boothNumber + ' from the plan';
        b.onclick = function () { window.__socket.emit('booth:remove', { boothNumber: s.boothNumber }); };
        pickEl.appendChild(b);
      }

      var list = document.getElementById('rp-list');
      list.innerHTML = '<div class="hd">Off the plan (' + gone.length + ')</div>';
      if (!gone.length) list.innerHTML += '<p style="margin:0">Nothing removed yet.</p>';
      gone.forEach(function (g) {
        var b = document.createElement('button');
        b.textContent = '↩ Put stand ' + g.boothNumber + ' back';
        b.onclick = function () { window.__socket.emit('booth:restore-stand', { boothNumber: g.boothNumber }); };
        list.appendChild(b);
      });
    };
    window.__renderPanel();
  }
  mount();
})();
`;

/** Stands read straight off the artwork — the rectangles the plan really draws. */
const SEED = `
(function seed() {
  var svg = document.querySelector('#svg-mount svg');
  if (!svg) return setTimeout(seed, 200);
  var g = function (r) { return { x: +r.getAttribute('x'), y: +r.getAttribute('y'),
                                  w: +r.getAttribute('width'), h: +r.getAttribute('height') }; };
  window.__stands = [].slice.call(svg.querySelectorAll('rect.cls-10, rect.cls-7'))
    .map(g).filter(function (b) { return b.w > 0 && b.h > 0; })
    .map(function (b, i) {
      return { boothNumber: String(100 + i), status: 'available', sqm: Math.max(1, Math.round(b.w * b.h / 180)),
               geometry: b, displayNumber: null, sponsored: false, tags: [], company: null };
    });
  window.__socket = window.io();
  window.__push();
})();
`;

function buildApp(inject) {
  const app = express();
  app.get('/socket.io/socket.io.js', (_q, res) => res.type('application/javascript').send(SHIM));
  app.get('/floorplan.svg', (_q, res) => res.type('image/svg+xml').send(fs.readFileSync(SVG, 'utf8')));
  app.get('/countries', (_q, res) => res.json([]));
  app.get('/partners', (_q, res) => res.json([]));
  app.get(/^\/sponsors\//, (_q, res) => res.json([]));
  app.get('/floorplan', (_q, res) => {
    // The page is served exactly as the real server serves it, and the preview's
    // own bootstrap is appended afterwards — nothing shipped is edited to make
    // the demonstration work.
    if (inject) {
      const send = res.send.bind(res);
      res.send = (body) => send(typeof body === 'string'
        ? body.replace('</body>', `<script src="/preview-boot.js"></script></body>`)
        : body);
    }
    require('../server/lib/send-page').sendPage(res, 'floorplan.html', { slug: 'lex', id: 'LEX', name: 'LEX' });
  });
  if (inject) app.get('/preview-boot.js', (_q, res) => res.type('application/javascript').send(inject));
  app.use(express.static(path.join(ROOT, 'public')));
  return app;
}

/** Seed the stands, wait for the plan to bind them, and fit the view. */
async function ready(page) {
  await page.waitForTimeout(1800);
  await page.evaluate(SEED);
  await page.waitForTimeout(1800);
}

async function shots() {
  const { launch } = require('../test/harness');
  const app = buildApp();
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const br = await launch();
  const page = await br.newPage({ viewport: { width: 1500, height: 1000 } });
  await page.goto(`${base}/floorplan`, { waitUntil: 'networkidle', timeout: 30000 });
  await ready(page);

  // A block of stands that genuinely touch, found in the artwork rather than
  // assumed — a shot of an isolated stand would prove nothing about the walls.
  const pick = await page.evaluate(() => {
    const S = window.__stands;
    const touches = (a, b) => {
      const A = a.geometry, B = b.geometry;
      const rows = Math.abs(A.y - B.y) < 2 && Math.abs(A.h - B.h) < 2;
      const cols = Math.abs(A.x - B.x) < 2 && Math.abs(A.w - B.w) < 2;
      return (rows && (Math.abs(A.x + A.w - B.x) < 2 || Math.abs(B.x + B.w - A.x) < 2)) ||
             (cols && (Math.abs(A.y + A.h - B.y) < 2 || Math.abs(B.y + B.h - A.y) < 2));
    };
    let best = null;
    for (const s of S) {
      const near = S.filter(o => o !== s && touches(s, o));
      if (!best || near.length > best.near.length) best = { s, near };
      if (best.near.length >= 2) break;
    }
    const g = best.s.geometry;
    const all = [best.s, ...best.near].map(b => b.geometry);
    const x1 = Math.min(...all.map(b => b.x)), y1 = Math.min(...all.map(b => b.y));
    const x2 = Math.max(...all.map(b => b.x + b.w)), y2 = Math.max(...all.map(b => b.y + b.h));
    return { number: best.s.boothNumber, neighbours: best.near.map(b => b.boothNumber),
             box: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, g };
  });

  // Crop to the block, straight out of the SVG, so both shots frame the same
  // stands at the same size and the only difference is the removal itself.
  const crop = async (file) => {
    const svgText = await page.evaluate((b) => {
      const src = document.querySelector('#svg-mount svg');
      const copy = src.cloneNode(true);
      const pad = Math.max(b.w, b.h) * 0.35;
      copy.setAttribute('viewBox', `${b.x - pad} ${b.y - pad} ${b.w + pad * 2} ${b.h + pad * 2}`);
      copy.setAttribute('width', 900); copy.setAttribute('height', 900 * (b.h + pad * 2) / (b.w + pad * 2));
      copy.removeAttribute('style');
      return new XMLSerializer().serializeToString(copy);
    }, pick.box);
    const shot = await br.newPage({ viewport: { width: 920, height: 700 } });
    await shot.setContent(`<body style="margin:10px;background:#fff">${svgText}</body>`);
    await shot.waitForTimeout(400);
    await shot.screenshot({ path: file });
    await shot.close();
    return file;
  };

  const before = await crop(path.join(ROOT, 'preview-before.png'));
  await page.evaluate(n => window.__socket = window.__socket || window.io(), pick.number);
  await page.evaluate(n => { window.__socket.emit('booth:remove', { boothNumber: n }); }, pick.number);
  await page.waitForTimeout(1500);
  const after = await crop(path.join(ROOT, 'preview-after.png'));

  await br.close();
  server.close();
  console.log(`\nStand ${pick.number}, which touches ${pick.neighbours.join(', ')}`);
  console.log(`  before: ${before}`);
  console.log(`  after:  ${after}`);
  console.log('\nNothing was written to any database.');
}

async function serve() {
  const app = buildApp(SEED + PANEL);
  // If 3111 is taken — the page harness, a dev server, a previous run left
  // behind — say so and move to a free port rather than exiting with a stack
  // trace, which reads as "the preview is broken" when it is nothing of the
  // kind. The whole point of this script is that it just comes up.
  const open = (port, fallback) => {
    const server = app.listen(port);
    server.once('error', (e) => {
      if (e.code !== 'EADDRINUSE' || !fallback) { console.error(e); process.exit(1); }
      console.log(`\n  Port ${port} is already in use — using a free one instead.`);
      open(0, false);
    });
    server.once('listening', () => {
      const url = `http://127.0.0.1:${server.address().port}/floorplan`;
      console.log(`\n  Stand removal preview → ${url}`);
      console.log('  The real page, the real artwork, stands held in memory. No database.');
      console.log('  Click a stand on the plan, then Remove. Ctrl-C to stop.');
      console.log('  Leave this running — the link only answers while it is.\n');
    });
  };
  open(PORT, true);
}

if (process.argv.includes('--shots')) shots().catch(e => { console.error(e); process.exit(1); });
else serve();
