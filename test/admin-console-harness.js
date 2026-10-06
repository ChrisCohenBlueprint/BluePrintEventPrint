/**
 * The real admin console, in a real browser, against a stand-in socket.
 *
 * The stand-in matters more than it looks. Production ACKNOWLEDGES an action
 * first and sends the state that reflects it about 80 ms later, because
 * broadcastState is debounced. Every console bug of the form "the panel read
 * the stand in the ack handler and believed it" is invisible to a shim that
 * sends the state before the ack — which is what the preview sandbox does, and
 * why it never showed a stand panel saying "Available" over a stand that had
 * just been sold. So this one answers in production's order: ack now, state
 * later.
 *
 * Behind the socket is a deliberately small model of the server — enough to
 * book, hold, release and save a deal the way the handlers do, and nothing a
 * suite does not need. A suite replaces any handler with its own
 * (`window.__server[event] = …`), plays a colleague by editing
 * `window.__state` and calling `window.__broadcast()`, and reads what the
 * console sent from `window.__emits`.
 *
 * Every page route, script and stylesheet is the shipped one: the console is
 * served through sendPage exactly as the server serves it.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const { listen, launch } = require('./harness');
const { readRects } = require('../server/lib/extract-stands');
const { sendPage } = require('../server/lib/send-page');

const ROOT = path.join(__dirname, '..');
const SVG = path.join(ROOT, 'public', 'LEX27_Floorplan_Consolidated.svg');

/** Stands built from rectangles the shipped artwork really draws, so they bind. */
function seedStands(count = 40) {
  const svg = fs.readFileSync(SVG, 'utf8');
  return readRects(svg)
    .filter(r => (r.cls === 'cls-10' || r.cls === 'cls-7') && r.w > 0 && r.h > 0)
    .slice(0, count)
    .map((r, i) => {
      const sqm = Math.max(1, Math.round(r.w * r.h / 180));
      return {
        showId: 'LEX', boothNumber: String(100 + i), status: 'available',
        sqm, listPrice: sqm * 660, displayNumber: null, sponsored: false,
        geometry: { x: r.raw.x, y: r.raw.y, w: r.raw.w, h: r.raw.h },
        assignment: { company: null, actualPrice: null, notes: '', tags: [], country: null },
        clicks: 0,
      };
    });
}

/** Give a seeded stand a booking, as the server would hold it. */
function book(stand, { status = 'sold', company, actualPrice = null, notes = '' }) {
  stand.status = status;
  stand.assignment = { ...stand.assignment, company, actualPrice, notes };
  return stand;
}

const shim = (seed) => `
(function () {
  var H = {};
  window.__h = H;
  window.__emits = [];
  window.__state = ${JSON.stringify(seed).replace(/</g, '\\u003c')};
  window.__fire = function (e, p) { (H[e] || []).slice().forEach(function (f) { f(p); }); };
  var clone = function (x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); };
  window.__clone = clone;
  // broadcastState's debounce: one state, ~80 ms after the last change.
  var timer = null;
  window.__broadcast = function () {
    clearTimeout(timer);
    timer = setTimeout(function () { timer = null; window.__fire('state:full', clone(window.__state)); }, 80);
  };
  window.__stand = function (n) {
    return window.__state.find(function (b) { return b.boothNumber === n; }) || null;
  };
  var refuse = function (error) { return { ok: false, error: error }; };
  var EMPTY = function () { return { company: null, actualPrice: null, notes: '', tags: [], country: null }; };
  // A handler returning this sends no acknowledgement at all.
  window.__NO_ACK = { noAck: true };

  // Only what a suite needs, and each on the server's own terms.
  window.__server = {
    'booth:book': function (p) {
      var b = window.__stand(p.boothNumber);
      if (!b) return refuse('Stand ' + p.boothNumber + ' not found.');
      if (b.status !== 'available' && b.status !== 'held') return refuse('Stand ' + p.boothNumber + ' is already taken — reload to see the latest.');
      if (!p.company) return refuse('A sale needs the exhibitor\\'s name.');
      b.status = 'sold'; b.assignment.company = p.company;
      window.__broadcast(); return { ok: true };
    },
    'booth:hold': function (p) {
      var b = window.__stand(p.boothNumber);
      if (!b || b.status !== 'available') return refuse('Stand ' + p.boothNumber + ' could not be held — it is not available.');
      b.status = 'held'; b.assignment.company = p.company || 'Pending';
      window.__broadcast(); return { ok: true };
    },
    'booth:release': function (p) {
      var b = window.__stand(p.boothNumber);
      if (!b || b.status === 'available') return refuse('Nothing to release.');
      b.status = 'available'; b.assignment = EMPTY();
      window.__broadcast(); return { ok: true };
    },
    // The agreed contract: an omitted field is left alone, and a stand that
    // has changed hands since the form was filled is refused.
    'booth:update-deal': function (p) {
      var b = window.__stand(p.boothNumber);
      if (!b) return refuse('Stand ' + p.boothNumber + ' not found.');
      if (b.status !== 'sold' && b.status !== 'held') return refuse('Stand ' + p.boothNumber + ' must be sold or on hold to hold a price or notes.');
      if ('expectCompany' in p && p.expectCompany !== b.assignment.company) {
        return refuse('This stand has changed hands since you opened it — reopen it before saving.');
      }
      if ('actualPrice' in p) b.assignment.actualPrice = p.actualPrice === null ? null : Number(p.actualPrice);
      if ('notes' in p) b.assignment.notes = String(p.notes);
      window.__broadcast(); return { ok: true };
    },
  };

  window.io = function () {
    var sock = {
      on: function (e, f) { (H[e] = H[e] || []).push(f); return sock; },
      off: function () { return sock; },
      get connected() { return true; },
      emit: function (event, payload, ack) {
        if (typeof payload === 'function') { ack = payload; payload = undefined; }
        // Through JSON, as the wire does: an undefined field is not sent at all.
        var sent = clone(payload === undefined ? {} : payload);
        window.__emits.push({ event: event, payload: sent });
        var fn = window.__server[event];
        var res = fn ? fn(clone(sent)) : { ok: true };
        if (res === window.__NO_ACK) return sock;
        Promise.resolve(res).then(function (r) { if (typeof ack === 'function') ack(r); });
        return sock;
      },
    };
    setTimeout(function () {
      window.__fire('connect');
      window.__fire('session:id', 'test');
      window.__fire('settings', { ratePerSqm: 660, unit: 'm', currency: 'EUR', currencySymbol: '\\u20ac', palette: null });
      window.__fire('tags:catalogue', window.__tags || []);
      window.__fire('areas:catalogue', []);
      window.__fire('state:full', clone(window.__state));
      window.__fire('ready');
    }, 0);
    return sock;
  };
})();
`;

/**
 * Start the console. `routes(app)` registers a suite's own answers before the
 * defaults, so anything it names wins.
 */
async function startConsole({ stands = seedStands(), routes = null,
                              show = { slug: 'lex', id: 'LEX', name: 'Lubricant Expo Europe' } } = {}) {
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  if (routes) routes(app);
  app.get('/socket.io/socket.io.js', (_q, res) => res.type('application/javascript').send(shim(stands)));
  app.get('/floorplan.svg', (_q, res) => res.type('image/svg+xml').send(fs.readFileSync(SVG, 'utf8')));
  app.get('/api/me', (_q, res) => res.json({ user: 'tester', role: 'owner' }));
  app.get('/api/shows', (_q, res) => res.json([{ slug: show.slug, showId: show.id, name: show.name, active: true }]));
  app.get('/api/sales-team', (_q, res) => res.json({ team: [], manager: null }));
  // Anything not named: an empty list, which every caller in the console copes with.
  app.get(/^\/(api|countries|partners|sponsors)/, (_q, res) => res.json([]));
  app.post(/^\/api\//, (_q, res) => res.json({ ok: true }));
  app.get('/admin', (_q, res) => sendPage(res, 'admin.html', show));
  app.get('/admin/:slug', (_q, res) => sendPage(res, 'admin.html', show));
  app.use(express.static(path.join(ROOT, 'public')));
  return listen(app);
}

/** Open the console with the Floorplan tab showing and every stand bound. */
async function openFloorplan(page, base) {
  await page.goto(`${base}/admin`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.click('[data-section="floorplan"]');
  await page.waitForFunction(() => document.querySelectorAll('#admin-svg-mount svg [data-booth]').length > 10,
                             null, { timeout: 15000 });
  await page.waitForTimeout(300);
}

/** Settle: long enough for an ack, the debounced state, and a repaint. */
const settle = (page, ms = 350) => page.waitForTimeout(ms);

/** The text of the console's toast(s) on screen right now. */
const toasts = (page) => page.evaluate(() =>
  [...document.querySelectorAll('[id^="admin-toast"]')]
    .filter(n => n.classList.contains('show'))
    .map(n => n.textContent).join(' | '));

/** The events the console has sent, optionally only one kind. */
const emits = (page, event) => page.evaluate((ev) =>
  window.__emits.filter(e => !ev || e.event === ev), event);

/** What the stand panel shows right now. */
const panelState = (page) => page.evaluate(() => ({
  open: !document.getElementById('admin-booth-action').classList.contains('hidden'),
  id: document.getElementById('aba-id').textContent,
  status: document.getElementById('aba-status').textContent,
  company: document.getElementById('aba-company').textContent,
  sqm: document.getElementById('aba-sqm').textContent,
  price: document.getElementById('aba-actual-price').value,
  notes: document.getElementById('aba-notes').value,
  selected: typeof selectedAdminId === 'undefined' ? null : selectedAdminId,
}));

/** Click a stand on the plan the way a person does: pointer down, pointer up. */
const clickStand = (page, n) => page.evaluate((num) => {
  const el = document.querySelector(`#admin-svg-mount svg [data-booth="${num}"]`);
  if (!el) throw new Error(`stand ${num} is not on the plan`);
  const r = el.getBoundingClientRect();
  const at = { clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, bubbles: true, pointerId: 1 };
  el.dispatchEvent(new PointerEvent('pointerdown', at));
  el.dispatchEvent(new PointerEvent('pointerup', at));
}, n);

/**
 * A colleague's change: the server's state moves, and its broadcast follows.
 * `src` runs in the page with `state` (every stand) and `stand(n)` in scope.
 */
const colleague = (page, src) => page.evaluate((code) => {
  // eslint-disable-next-line no-new-func
  new Function('state', 'stand', code)(window.__state, window.__stand);
  window.__broadcast();
}, src);

/** The console's own dialog, if one is open: its title, fields, error and buttons. */
const dialogState = (page) => page.evaluate(() => {
  const d = document.querySelector('dialog.bp-dialog[open]');
  if (!d) return null;
  return {
    title: d.querySelector('.bp-dialog-title')?.textContent || '',
    text: d.textContent,
    fields: [...d.querySelectorAll('input')].map(i => ({ name: i.name, value: i.value, type: i.type })),
    error: d.querySelector('.bp-dialog-error')?.textContent || '',
    buttons: [...d.querySelectorAll('button')].map(b => b.textContent),
  };
});
/** Press a button in the open dialog, by its words. */
const press = (page, label) => page.evaluate((l) => {
  const b = [...document.querySelectorAll('dialog.bp-dialog[open] button')].find(x => x.textContent === l);
  if (!b) throw new Error(`no "${l}" button in the dialog`);
  b.click();
}, label);
/** The dialog's confirming button — whatever it is called — pressed. */
const confirmIt = async (page) => press(page, (await dialogState(page)).buttons.find(b => b !== 'Cancel'));
/** Type into one of the open dialog's fields, by name. */
const fillField = (page, name, value) => page.fill(`dialog.bp-dialog[open] input[name="${name}"]`, value);

function checker() {
  const out = [];
  const check = (n, ok, d = '') => { out.push(!!ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
  const finish = () => {
    const f = out.filter(x => !x).length;
    console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
    return f ? 1 : 0;
  };
  return { check, finish };
}

module.exports = { startConsole, seedStands, book, openFloorplan, settle, toasts, emits, checker, launch,
                   panelState, clickStand, colleague, dialogState, press, confirmIt, fillField };
