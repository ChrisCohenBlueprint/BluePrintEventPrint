// The REAL page routes and static serving, no database. Tests that the page a
// URL serves actually WORKS — assets, scripts, styles — not just that the URL
// resolves. See the floorplan-browser-test-harness memory.
const ROOT = require('path').join(__dirname, '..');
const path = require('path');
const express = require('express');
const { sendPage } = require('../server/lib/send-page');
const { showMiddleware, showForRequest } = require('../server/show-middleware');

const app = express();
app.use(showMiddleware());
app.get('/floorplan',       (req, res) => sendPage(res, 'floorplan.html', showForRequest(req)));
app.get('/floorplan/:show', (req, res) => sendPage(res, 'floorplan.html', showForRequest(req)));
app.get('/admin',           (req, res) => sendPage(res, 'admin.html', showForRequest(req)));
app.get('/admin/:show',     (req, res) => sendPage(res, 'admin.html', showForRequest(req)));

// The real server attaches socket.io; without a stand-in, admin.js throws on
// its first line and the page's own script never runs — which silently weakens
// every "scripts run" assertion.
app.get('/socket.io/socket.io.js', (_q, res) => {
  res.type('application/javascript').send(`
    window.__handlers = {};
    window.io = function () {
      return { on(ev, fn) { (window.__handlers[ev] = window.__handlers[ev] || []).push(fn); },
               emit() {}, off() {}, get connected() { return true; } };
    };
    window.__fire = (ev, p) => (window.__handlers[ev] || []).forEach(f => f(p));
  `);
});
app.get('/api/me', (_q, res) => res.json({ user: 'tester', role: 'owner' }));
// Any event's artwork, named by ?show= — what lets Settings preview them all.
app.get('/floorplan.svg', (_q, res) =>
  res.type('image/svg+xml').sendFile(path.join(ROOT, 'public/LEX27_Floorplan_Consolidated.svg')));

app.use(express.static(path.join(ROOT, 'public')));
module.exports = { app, start: () => app.listen(3333) };
if (require.main === module) app.listen(3333, () => console.log('page harness on 3333'));
