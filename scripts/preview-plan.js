#!/usr/bin/env node
/**
 * A sandbox for reshaping a hall — in the admin console, where the tools are.
 *
 *   npm run preview
 *
 * The real admin page, the real artwork, the real public/admin.js and
 * booth-map.js — AND the real server model. Every action goes through
 * server/models/booths.js exactly as the live socket handlers do; only the
 * database is a stand-in (test/fake-mongo.js, the same one the suite runs
 * against). So what you try is the arithmetic and the interface that ship, not
 * an impression of either. Nothing touches Atlas, nothing needs Docker, nothing
 * survives Ctrl-C: stop it and the hall is as the artwork drew it again.
 *
 * An earlier version of this put its own buttons on the PUBLIC floorplan,
 * because the admin console is behind a login. That tested the model but not
 * the console — and merging, splitting and removing stands are things only the
 * console does, so the half that people actually touch went unexercised. The
 * login is stubbed here instead, and the real console is what opens.
 *
 * The totals strip along the top is the point. A split divides exactly and a
 * merge sums, so the hall's area and list price must read the SAME after any
 * chain of operations as before it. If a number moves, the maths is wrong —
 * visible without reading a line of code.
 *
 * Worth trying, in the Floorplan tab:
 *   1. shift-click two stands side by side → Merge. One block, both sizes.
 *   2. Select it → Split. This used to be refused on a merged block.
 *   3. Reset → the block is back. Reset again → the two originals are. The
 *      button names which of the two steps it is about to undo.
 *   4. Split a stand, then merge one of its cells into the stand next door.
 *   5. Split a stand, select ALL its cells, Merge → it offers to put the stand
 *      back together, and the original number and box come back.
 *   6. Remove a stand from the plan, then Tools → Removed Stands to put it back.
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

// The stand-in database goes in before the model is required — booths.js
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
 * live database and what binds it to its shape — so this plan's rotated rows go
 * through exactly the footprint resolution the real thing does, rather than a
 * tidy invented grid that would hide the interesting cases.
 */
const UNITS_PER_SQM = 180;   // measured off this plan's own printed figures
const RATE = 660;
function seedStands() {
  const svg = fs.readFileSync(SVG, 'utf8');
  // Both of this plan's stand fills — the white ones and the yellow ones.
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
/**
 * The hall survives a restart.
 *
 * It did not, and that cost a real afternoon: a stand was taken off the plan,
 * the sandbox was restarted underneath it, and the stand, the history and the
 * way back all went at once. A workbench whose state evaporates whenever
 * somebody else touches the process is no use for trying something and coming
 * back to it.
 *
 * The whole stand-in database is written beside this script after every change
 * and read back at boot. "Reload the hall" is then the only thing that throws
 * work away, which is the one place it should be.
 *
 * Dates go through JSON as strings, so anything shaped like a timestamp is
 * turned back into a Date on the way in — the model compares them (a merge
 * against a split, newest first) and a string would sort the same but compare
 * as a different type.
 */
const STATE_FILE = path.join(__dirname, '.preview-state.json');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const reviveDates = (v) => {
  if (typeof v === 'string') return ISO.test(v) ? new Date(v) : v;
  if (Array.isArray(v)) return v.map(reviveDates);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = reviveDates(val);
    return out;
  }
  return v;
};

function save() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(db.store)); }
  catch (e) { console.error('Could not save the sandbox hall —', e.message); }
}

function load() {
  try {
    if (!fs.existsSync(STATE_FILE)) return false;
    const store = reviveDates(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
    if (!store || !Array.isArray(store.booths) || !store.booths.length) return false;
    // fakeDb stamps its own _id on insert, so the stored ones are dropped and
    // the collections handed over as they are.
    db = fakeDb({});
    Object.entries(store).forEach(([name, rows]) => {
      db.store[name] = rows;
    });
    return true;
  } catch (e) {
    console.error('Could not read the saved hall, starting fresh —', e.message);
    return false;
  }
}

function reseed() { db = fakeDb({ booths: seedStands() }); save(); }

/**
 * The socket events the console fires, and the model call behind each.
 *
 * Deliberately only the ones that RESHAPE a hall, plus booking, which is what
 * the refusals are about ("the stand must be available"). Everything else the
 * console can emit — tags, sponsors, currency — answers ok and changes nothing,
 * so a stray click cannot make the sandbox look broken.
 */
const EVENTS = {
  'booth:consolidate':      (p) => booths.consolidate(p.primary, p.secondary, { actor: 'preview' }),
  'booth:consolidate-many': (p) => booths.consolidateMany(p.boothNumbers, { actor: 'preview' }),
  'booth:split':            (p) => booths.split(p.boothNumber, { parts: p.parts, axis: p.axis, firstSqm: p.firstSqm, actor: 'preview' }),
  'booth:split-custom':     (p) => booths.splitCustom(p.boothNumber, { axis: p.axis, parts: p.parts, actor: 'preview' }),
  'booth:reset':            (p) => booths.reset(p.boothNumber, { actor: 'preview' }),
  'booth:remove':           (p) => booths.remove(p.boothNumber, { actor: 'preview', reason: p.reason }),
  'booth:restore-stand':    (p) => booths.restoreRemoved(p.boothNumber, { actor: 'preview' }),
  'booth:set-number':       (p) => booths.setDisplayNumber(p.boothNumber, p.displayNumber, { actor: 'preview' }),
  'booth:move':             (p) => booths.move(p.from, p.to, { actor: 'preview' }),
  // A sale is to somebody, here as on the live console: a blank name is
  // refused in the same words rather than booked under a made-up one.
  'booth:book':             async (p) => {
    const name = String(p.company ?? '').trim();
    if (!name) return { ok: false, error: `Give the exhibitor's name to book Stand ${p.boothNumber}.` };
    return { ok: !!await booths.setStatus(p.boothNumber, 'sold', { company: name, actor: 'preview' }) };
  },
  'booth:hold':             async (p) => ({ ok: !!await booths.setStatus(p.boothNumber, 'held', { company: p.company || 'Pending', actor: 'preview' }) }),
  'booth:release':          async (p) => ({ ok: !!await booths.setStatus(p.boothNumber, 'available', { company: null, actor: 'preview' }) }),
};

/** The model's refusals, in the words the admin console uses for them. */
function explain(r) {
  const reason = r && r.reason;
  return {
    not_adjacent: 'the stands are not next to each other',
    not_contiguous: 'the stands must sit next to each other with no gaps',
    not_available: 'every stand must be available — release the booking first',
    reset_first: `${r && r.blockedBy ? `stand ${r.blockedBy} is` : 'one of them is'} a merged block, and a block cannot be absorbed into another — reset it first`,
    need_two: 'select at least two stands',
    too_small: 'the stand is too small to divide that many ways',
    not_composite: 'this stand was not merged or split',
    child_booked: 'one of its cells has been booked — release it first',
    child_split: 'one of its cells was split again — reset that cell first',
    child_merged: `its cell ${r && r.child} has swallowed a neighbour — reset ${r && r.child} first`,
    child_absorbed: `its cell ${r && r.child} was absorbed into stand ${r && r.into} — reset ${r && r.into} first`,
    child_removed: `its cell ${r && r.child} is off the plan — put it back first`,
    already_removed: 'it is already off the plan',
    missing_booth: 'that stand does not exist',
    same_booth: 'that is the same stand twice',
    no_geometry: 'that stand has no shape',
    suffix_exists: 'a cell with that number already exists — reset the stand first',
    size_mismatch: `the sizes must add up to ${r && r.total} — you gave ${r && r.got}`,
    dup_number: 'each part needs a different number',
    bad_parts: 'give 2–8 parts, each with a number and a size',
    uneven_needs_two: 'an uneven split makes exactly two stands',
    bad_ratio: 'each side must keep at least 1 m²',
  }[reason] || reason || 'refused';
}

// ─── The console's socket, answered by the model ──────────────────────────────
const SHIM = `
  window.__h = {};
  window.__rows = [];
  window.__pull = function () {
    return fetch('/preview/state').then(function (r) { return r.json(); }).then(function (s) {
      window.__rows = s.rows;
      window.__totals = s.totals;
      window.__fire('state:full', s.rows);
      window.__fire('stats:updated', s.stats);
      if (window.__renderTotals) window.__renderTotals();
      return s;
    });
  };
  window.__fire = function (e, p) { (window.__h[e] || []).forEach(function (f) { f(p); }); };
  window.io = function () {
    var sock = {
      on: function (e, f) { (window.__h[e] = window.__h[e] || []).push(f); return sock; },
      off: function () { return sock; },
      get connected() { return true; },
      emit: function (event, payload, ack) {
        if (typeof payload === 'function') { ack = payload; payload = {}; }
        fetch('/preview/emit', { method: 'POST', headers: { 'content-type': 'application/json' },
                                 body: JSON.stringify({ event: event, payload: payload || {} }) })
          .then(function (r) { return r.json(); })
          .then(function (res) {
            return window.__pull().then(function () { if (typeof ack === 'function') ack(res); });
          })
          .catch(function (e) { if (typeof ack === 'function') ack({ ok: false, error: String(e) }); });
        return sock;
      },
    };
    // The console waits for these before it will draw anything.
    setTimeout(function () {
      window.__fire('connect');
      window.__fire('session:id', 'preview');
      window.__fire('settings', { ratePerSqm: ${RATE}, unit: 'm', currency: 'EUR', currencySymbol: '\\u20ac', palette: null });
      window.__fire('tags:catalogue', []);
      window.__fire('areas:catalogue', []);
      window.__fire('viewers:count', 0);
      window.__pull();
    }, 0);
    return sock;
  };
`;

const TOTALS = fs.readFileSync(path.join(__dirname, 'lib', 'preview-totals.js'), 'utf8');

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/socket.io/socket.io.js', (_q, res) => res.type('application/javascript').send(SHIM));
  app.get('/preview-boot.js', (_q, res) => res.type('application/javascript').send(TOTALS));
  app.get('/floorplan.svg', (_q, res) => res.type('image/svg+xml').send(fs.readFileSync(SVG, 'utf8')));

  app.get('/preview/state', async (_q, res) => {
    const rows = await run(() => booths.all());
    // The totals, over stands that are still ON the plan. Merging, splitting and
    // re-carving must leave these exactly alone — that is the whole of what
    // "the maths is right" means here.
    // The console's headline figures come from the model's own stats(), not
    // from a tally invented here — so the sandbox shows what the live console
    // would, and a stand taken off the plan leaves them exactly as it does
    // there.
    const stats = await run(() => booths.stats());
    const off = rows.filter(b => b.removed === true).length;
    res.json({
      rows, stats,
      totals: { stands: stats.totalBooths, sqm: stats.totalSqm, price: stats.totalRevenue, off },
    });
  });

  app.post('/preview/emit', async (req, res) => {
    const { event, payload } = req.body || {};
    const fn = EVENTS[event];
    // An event this sandbox does not model is answered ok and does nothing, so
    // a stray click somewhere else in the console cannot look like a failure.
    if (!fn) return res.json({ ok: true, ignored: event });
    try {
      const r = await run(() => fn(payload || {}));
      if (r && r.ok) {
        save();
        return res.json({ ...r, primary: r.primary && r.primary.boothNumber ? r.primary.boothNumber : r.primary });
      }
      res.json({ ok: false, error: `Could not do that — ${explain(r)}.` });
    } catch (e) {
      res.status(500).json({ ok: false, error: String((e && e.message) || e) });
    }
  });

  app.post('/preview/reseed', (_q, res) => { reseed(); res.json({ ok: true }); });

  // ── Everything else the console asks for on the way up ──────────────────────
  // The plan's history, for real — the model's own, so going back here does
  // exactly what going back on the live console does. The password gate the
  // live route puts in front of applying is the one thing skipped: there is no
  // account to check it against, and the whole hall is a throwaway.
  app.get('/api/history', async (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    res.json(await run(() => booths.history({ limit })));
  });
  app.post('/api/history/:id/restore', async (req, res) => {
    const apply = req.body && req.body.apply === true;
    const r = await run(() => booths.restoreSnapshot(String(req.params.id), { apply, actor: 'preview' }));
    // The same answers the live route gives: a point that is gone is a 404, but
    // a point that would move a booking, or a hall that changed while it was
    // being put back, is a 409 the console explains — not "no longer exists".
    if (!r.ok) {
      if (r.reason === 'bookings_in_the_way') {
        const list = (r.conflicts || []).map(c => `stand ${c.displayNumber || c.boothNumber} (${c.status})`).join('; ');
        return res.status(409).json({ reason: r.reason, conflicts: r.conflicts,
          error: `Bookings are kept when the plan goes back, and these are in the way: ${list}. Move or release them first.` });
      }
      if (r.reason === 'changed_meanwhile') {
        return res.status(409).json({ reason: r.reason,
          error: `Stand ${r.boothNumber} changed while the plan was being put back, so nothing was changed. Try again.` });
      }
      return res.status(404).json({ error: 'That point no longer exists.' });
    }
    if (apply) save();
    res.json(r);
  });

  app.get('/api/me', (_q, res) => res.json({ user: 'preview', role: 'owner' }));
  app.get('/api/shows', (_q, res) => res.json([{ id: SHOW, slug: 'lex', name: 'LEX — sandbox', current: true }]));
  app.get('/api/holds', (_q, res) => res.json([]));
  app.get('/api/palette', (_q, res) => res.json({ palette: null }));
  app.get('/api/floorplan', (_q, res) => res.json({ svg: null, version: null, source: 'shipped' }));
  app.get('/api/floorplans', (_q, res) => res.json([]));
  // Anything not named above: an empty list, which every caller in the console
  // copes with. Named ones come first so an object-shaped answer stays an
  // object.
  app.get(/^\/(api|countries|partners|sponsors)/, (_q, res) => res.json([]));
  app.post(/^\/api\//, (_q, res) => res.json({ ok: true }));

  const page = (file, show) => (_q, res) => {
    // Served exactly as the real server serves it; the sandbox's own totals
    // strip is appended afterwards, so nothing shipped is edited to make the
    // demonstration work.
    const send = res.send.bind(res);
    res.send = (body) => send(typeof body === 'string'
      ? body.replace('</body>', '<script src="/preview-boot.js"></script></body>')
      : body);
    require(path.join(ROOT, 'server', 'lib', 'send-page')).sendPage(res, file, show);
  };
  const SHOW_ROW = { slug: 'lex', id: SHOW, name: 'LEX — sandbox' };
  app.get('/', (_q, res) => res.redirect('/admin'));
  app.get('/admin', page('admin.html', SHOW_ROW));
  app.get('/floorplan', page('floorplan.html', SHOW_ROW));   // the same hall as a visitor sees it
  app.use(express.static(path.join(ROOT, 'public')));
  return app;
}

// Pick up where the last run left off; seed from the artwork only if there is
// nothing to pick up.
const resumed = load();
if (!resumed) reseed();
const app = buildApp();
const open = (port, fallback) => {
  const server = app.listen(port);
  server.once('error', (e) => {
    if (e.code !== 'EADDRINUSE' || !fallback) { console.error(e); process.exit(1); }
    console.log(`\n  Port ${port} is already in use — using a free one instead.`);
    open(0, false);
  });
  server.once('listening', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const n = db.store.booths.length;
    const sqm = db.store.booths.reduce((s, b) => s + b.sqm, 0);
    console.log(`\n  Admin console  → ${base}/admin      ← merge, split, reset, remove`);
    console.log(`  Public plan    → ${base}/floorplan  ← the same hall as a visitor sees it`);
    const off = db.store.booths.filter(b => b.removed).length;
    console.log(`\n  ${n} stands, ${sqm.toLocaleString()} m², ` +
                (resumed ? 'carried over from the last run.' : 'read off the real artwork.'));
    if (off) console.log(`  ${off} of them are off the plan — Tools → Plan History, or Removed Stands, puts them back.`);
    console.log('  The real console and the REAL server model; the database is a stand-in.');
    console.log('  No login, and nothing reaches Atlas. The hall now SURVIVES a restart —');
    console.log('  "Reload the hall" is the only thing that throws your work away.');
    console.log('  Leave this running — the links only answer while it is.\n');
  });
};
open(PORT, true);
