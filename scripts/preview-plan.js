#!/usr/bin/env node
/**
 * A sandbox for reshaping a hall: merge, split, re-carve, remove, reset.
 *
 *   npm run preview
 *
 * The real floorplan page, the real artwork, the real public/booth-map.js —
 * AND the real server model. Every button here calls server/models/booths.js
 * exactly as the live socket handlers do; only the database is a stand-in
 * (test/fake-mongo.js, the same one the suite runs against). So what you try is
 * the arithmetic that ships, not an impression of it. Nothing touches Atlas,
 * nothing needs Docker, nothing is written anywhere that outlives the process:
 * stop it and the hall is as the artwork drew it again.
 *
 * The totals bar is the point. A split divides exactly and a merge sums, so the
 * hall's area and list price must read the SAME after any chain of operations
 * as before it. If a number ever moves, the maths is wrong — and that is
 * visible here without reading a line of code.
 *
 * Worth trying, in this order:
 *   1. shift-click two stands side by side → Merge. One block, both sizes.
 *   2. Split it in two. This used to be refused outright.
 *   3. Reset → the block is back. Reset again → the two original stands are.
 *   4. Split a stand, then merge one of its cells into the stand next door.
 *   5. Split a stand, select ALL its cells, Merge → the split is undone and the
 *      stand returns at its own number, not a block wearing a cell's label.
 *
 * See the floorplan-browser-test-harness memory for why the stub exists.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 3111);
const SVG = path.join(ROOT, 'public', 'LEX27_Floorplan_Consolidated.svg');
const SHOW = 'LEX';

// The stand-in database, in place before the model is required — booths.js
// resolves server/db at load time.
const { fakeDb } = require(path.join(ROOT, 'test', 'fake-mongo'));
const dbPath = require.resolve(path.join(ROOT, 'server', 'db'));
let db = fakeDb({ booths: [] });
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => db } };

const showContext = require(path.join(ROOT, 'server', 'show-context'));
const booths = require(path.join(ROOT, 'server', 'models', 'booths'));
const { readRects } = require(path.join(ROOT, 'server', 'lib', 'extract-stands'));

const run = (fn) => showContext.runAs(SHOW, fn);

/**
 * Stands built from the rectangles the artwork really draws.
 *
 * Geometry is the box AS WRITTEN (`raw`), which is what a stand carries in the
 * live database and what binds it to its shape — so the rotated rows of this
 * plan go through exactly the footprint resolution the real thing does.
 */
const UNITS_PER_SQM = 180;   // measured off this plan's own printed figures
const RATE = 660;
function seedStands() {
  const svg = fs.readFileSync(SVG, 'utf8');
  // Both of this plan's stand fills: the white ones and the yellow ones. Seeding
  // only the white left the yellow row looking like stands that do not answer,
  // which is a distraction in a workbench.
  const rects = readRects(svg).filter(r => (r.cls === 'cls-10' || r.cls === 'cls-7') && r.w > 0 && r.h > 0);
  return rects.map((r, i) => {
    const sqm = Math.max(1, Math.round(r.w * r.h / UNITS_PER_SQM));
    return {
      showId: SHOW, boothNumber: String(100 + i), status: 'available',
      sqm, sqmSource: 'derived', listPrice: sqm * RATE,
      geometry: { x: r.raw.x, y: r.raw.y, w: r.raw.w, h: r.raw.h },
      assignment: { company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null },
      clicks: 0, createdAt: new Date(), updatedAt: new Date(),
    };
  });
}
function reseed() { db = fakeDb({ booths: seedStands() }); }

/** Every operation the panel offers, and the model call behind it. */
const OPS = {
  'merge':   ({ boothNumbers }) => booths.consolidateMany(boothNumbers, { actor: 'preview' }),
  'split':   ({ boothNumber, parts, axis }) => booths.split(boothNumber, { parts, axis, actor: 'preview' }),
  'carve':   ({ boothNumber, axis, parts }) => booths.splitCustom(boothNumber, { axis, parts, actor: 'preview' }),
  'reset':   ({ boothNumber }) => booths.reset(boothNumber),
  'remove':  ({ boothNumber }) => booths.remove(boothNumber, { actor: 'preview' }),
  'restore': ({ boothNumber }) => booths.restoreRemoved(boothNumber, { actor: 'preview' }),
};

// ─── The page's socket, answered by the model ─────────────────────────────────
const SHIM = `
  window.__h = {};
  window.__rows = [];
  window.io = function () {
    return {
      on: function (e, f) { (window.__h[e] = window.__h[e] || []).push(f); return this; },
      emit: function () { return this; },
      off: function () { return this; },
      get connected() { return true; },
    };
  };
  window.__fire = function (e, p) { (window.__h[e] || []).forEach(function (f) { f(p); }); };
  window.__op = function (op, args) {
    return fetch('/preview/op', { method: 'POST', headers: { 'content-type': 'application/json' },
                                  body: JSON.stringify(Object.assign({ op: op }, args)) })
      .then(function (r) { return r.json(); })
      .then(function (res) { return window.__pull().then(function () { return res; }); });
  };
  window.__pull = function () {
    return fetch('/preview/state').then(function (r) { return r.json(); }).then(function (s) {
      window.__rows = s.rows;
      window.__totals = s.totals;
      window.__fire('state:full', s.rows);
      if (window.__renderPanel) window.__renderPanel();
      return s;
    });
  };
`;

const PANEL = fs.existsSync(path.join(__dirname, 'lib', 'preview-panel.js'))
  ? fs.readFileSync(path.join(__dirname, 'lib', 'preview-panel.js'), 'utf8')
  : '';

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/socket.io/socket.io.js', (_q, res) => res.type('application/javascript').send(SHIM));
  app.get('/preview-boot.js', (_q, res) => res.type('application/javascript').send(PANEL));
  app.get('/floorplan.svg', (_q, res) => res.type('image/svg+xml').send(fs.readFileSync(SVG, 'utf8')));
  app.get('/countries', (_q, res) => res.json([]));
  app.get('/partners', (_q, res) => res.json([]));
  app.get(/^\/sponsors\//, (_q, res) => res.json([]));

  app.get('/preview/state', async (_q, res) => {
    const rows = await run(() => booths.all());
    // The live totals, over stands that are still ON the plan. These must not
    // move when stands are merged, split or re-carved — that is the whole of
    // what "the maths is right" means here.
    const on = rows.filter(b => b.removed !== true);
    res.json({
      rows,
      totals: { stands: on.length,
                sqm: on.reduce((s, b) => s + (b.sqm || 0), 0),
                price: on.reduce((s, b) => s + (b.listPrice || 0), 0),
                off: rows.length - on.length },
    });
  });

  app.post('/preview/op', async (req, res) => {
    const { op, ...args } = req.body || {};
    if (!OPS[op]) return res.status(400).json({ ok: false, error: `No such operation: ${op}` });
    try {
      const r = await run(() => OPS[op](args));
      if (r && r.ok) return res.json(r);
      // The model's reasons, in the words the admin console uses.
      const why = {
        not_contiguous: 'those stands must sit next to each other with no gaps',
        not_available: 'every stand must be available',
        reset_first: 'a merged block cannot be absorbed into another — reset it first',
        need_two: 'select at least two stands',
        too_small: 'that stand is too small to divide that many ways',
        not_composite: 'that stand was not merged or split',
        child_merged: `its cell ${r && r.child} has swallowed a neighbour — reset ${r && r.child} first`,
        child_absorbed: `its cell ${r && r.child} was absorbed into ${r && r.into} — reset ${r && r.into} first`,
        child_removed: `its cell ${r && r.child} is off the plan — put it back first`,
        already_removed: 'that stand is already off the plan',
        missing_booth: 'no such stand',
        size_mismatch: `the sizes must add up to ${r && r.total} — you gave ${r && r.got}`,
      }[r && r.reason] || (r && r.reason) || 'refused';
      res.json({ ok: false, error: why });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e && e.message || e) });
    }
  });

  app.post('/preview/reseed', (_q, res) => { reseed(); res.json({ ok: true }); });

  app.get('/floorplan', (_q, res) => {
    // Served exactly as the real server serves it; the sandbox's own bootstrap
    // is appended afterwards, so nothing shipped is edited to make this work.
    const send = res.send.bind(res);
    res.send = (body) => send(typeof body === 'string'
      ? body.replace('</body>', '<script src="/preview-boot.js"></script></body>')
      : body);
    require(path.join(ROOT, 'server', 'lib', 'send-page'))
      .sendPage(res, 'floorplan.html', { slug: 'lex', id: 'LEX', name: 'LEX' });
  });
  app.use(express.static(path.join(ROOT, 'public')));
  return app;
}

reseed();
const app = buildApp();
const open = (port, fallback) => {
  const server = app.listen(port);
  server.once('error', (e) => {
    if (e.code !== 'EADDRINUSE' || !fallback) { console.error(e); process.exit(1); }
    console.log(`\n  Port ${port} is already in use — using a free one instead.`);
    open(0, false);
  });
  server.once('listening', () => {
    const n = db.store.booths.length;
    const sqm = db.store.booths.reduce((s, b) => s + b.sqm, 0);
    console.log(`\n  Floorplan sandbox → http://127.0.0.1:${server.address().port}/floorplan`);
    console.log(`  ${n} stands, ${sqm.toLocaleString()} m², read off the real artwork.`);
    console.log('  The real page and the REAL server model; the database is a stand-in.');
    console.log('  Nothing reaches Atlas, and nothing survives Ctrl-C.');
    console.log('  Leave this running — the link only answers while it is.\n');
  });
};
open(PORT, true);
