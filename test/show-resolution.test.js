/**
 * A request acts on the event it names — and only that event.
 *
 * Settings lists every event, retired ones included, with all their controls:
 * colours, the plan, the stand schedule. Each sends `X-Show: <slug>`. The
 * middleware treated a retired slug as unknown, and an unknown header ran as
 * the DEFAULT event, so choosing colours for last year's show repainted this
 * year's and removing last year's plan removed this year's — while the card
 * went on showing last year's, because the artwork route did not share the
 * mistake. An admin tab left open on an event that was then retired did the
 * same on every call, and on reconnect its socket joined the default event's
 * rooms: a console labelled with one event booking another's stands.
 *
 * What is asserted, against the real middleware and the real shows model:
 *
 *   named        — a retired slug runs as that event, for colours and for the
 *                  plan; the default is untouched.
 *   gone         — a slug naming no event is refused on /api with the 409 the
 *                  console reloads on, and nothing is written anywhere.
 *   public       — a visitor's request with a stale slug still falls back, and
 *                  a retired event's own page is still off the air.
 *   sockets      — an admin socket joins the event it names, retired or not,
 *                  and is told a vanished one is gone; a visitor's falls back.
 */
process.env.SHOW_ID = 'LEX';

const express = require('express');
const { fakeDb } = require('./fake-mongo');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const PALETTE = { available: '#fffcf8', sold: '#689abb', source: 'artwork' };
const db = fakeDb({
  shows: [{ slug: 'lex', showId: 'LEX', name: 'Lubricant Expo Europe', active: true, order: 0 },
          { slug: 'lna', showId: 'LNA', name: 'Lubricant Expo North America', active: true, order: 1 },
          // Last year's event: finished, taken off the air, its data kept.
          { slug: 'lex25', showId: 'LEX25', name: 'Lubricant Expo Europe 2025', active: false, order: 2 }],
  settings: [{ _id: 'LEX', palette: { ...PALETTE } }, { _id: 'LEX25', palette: { ...PALETTE } }],
  floorplans: [{ showId: 'LEX', svg: '<svg><!-- europe --></svg>', filename: 'LEX27.svg', bytes: 1, version: 'a' },
               { showId: 'LEX25', svg: '<svg><!-- last year --></svg>', filename: 'LEX25.svg', bytes: 1, version: 'b' }],
});
const dbPath = require.resolve('../server/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => db } };

// The password gate, stood in for: "pw" is right.
const usersPath = require.resolve('../server/models/users');
require.cache[usersPath] = { id: usersPath, filename: usersPath, loaded: true, exports: {
  findByUsername: async () => ({ username: 'chris', passwordHash: 'x' }),
  verifyPassword: async (pw) => pw === 'pw',
  absorbPassword: async () => {},
} };

const config = require('../server/config');
const shows = require('../server/models/shows');
const { showMiddleware, showForSocket, GONE } = require('../server/show-middleware');
const api = require('../server/routes/api');

const settingsOf = (id) => db.store.settings.find(s => s._id === id) || {};
const planOf = (id) => db.store.floorplans.find(f => f.showId === id);

(async () => {
  await shows.refresh();

  const app = express();
  app.use(express.json());
  app.use(showMiddleware());
  // A public read: which event did the request end up in?
  app.get('/which', (_req, res) => res.json({ showId: config.showId }));
  app.get('/floorplan/:show', (_req, res) => res.send('page'));
  app.use((req, _res, next) => { req.admin = { user: 'chris', role: 'owner' }; next(); });
  app.use('/api', api);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, { show, method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(base + p, { method,
      headers: { ...(show ? { 'X-Show': show } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: json };
  };

  try {
    console.log('\nA retired event, named, is the event acted on');
    let r = await call('/api/palette', { show: 'lex25', method: 'PUT', body: { palette: { sold: '#123456' } } });
    check('the colours are saved', r.status === 200 && r.body.ok, JSON.stringify(r.body));
    check('on the retired event', settingsOf('LEX25').palette && settingsOf('LEX25').palette.sold === '#123456',
          JSON.stringify(settingsOf('LEX25').palette));
    check('and the default event keeps its own', settingsOf('LEX').palette.sold === '#689abb',
          JSON.stringify(settingsOf('LEX').palette));

    r = await call('/api/floorplan', { show: 'lex25', method: 'DELETE', headers: { 'X-Confirm-Password': 'pw' } });
    check('removing its plan removes ITS plan', r.status === 200 && !planOf('LEX25'), JSON.stringify(r.body));
    check('and not the default event\'s', !!planOf('LEX') && /europe/.test(planOf('LEX').svg));

    console.log('\nA slug that names nothing is refused on /api');
    const before = JSON.stringify(db.store.settings);
    r = await call('/api/palette', { show: 'lex24', method: 'PUT', body: { palette: { sold: '#abcdef' } } });
    check('409, with the message the console reloads on', r.status === 409 && r.body && r.body.error === GONE,
          `${r.status} ${JSON.stringify(r.body)}`);
    check('which is the agreed wording', GONE === 'This event is no longer at that address. Reload the page.');
    check('and nothing was written to any event', JSON.stringify(db.store.settings) === before);
    r = await call('/api/floorplan', { show: 'lex24', method: 'DELETE', headers: { 'X-Confirm-Password': 'pw' } });
    check('the plan is not removed either', r.status === 409 && !!planOf('LEX'));

    console.log('\nWhat a visitor sees is unchanged');
    r = await call('/which', { show: 'lex24' });
    check('a public read with a stale slug falls back to the default', r.status === 200 && r.body.showId === 'LEX',
          JSON.stringify(r.body));
    r = await call('/which', { show: 'lna' });
    check('and one with a live slug is that event', r.body.showId === 'LNA');
    r = await call('/floorplan/lex25');
    check('a retired event\'s own page is still off the air', r.status === 404);
    r = await call('/floorplan/lna');
    check('while a live one is served', r.status === 200);

    console.log('\nSockets');
    check('an admin socket joins a retired event it names', showForSocket('lex25', { admin: true }).showId === 'LEX25');
    check('an admin socket on a vanished slug is told it is gone',
          showForSocket('lex24', { admin: true }).gone === true && !showForSocket('lex24', { admin: true }).showId);
    check('an admin socket naming no event at all is the default',
          showForSocket('', { admin: true }).showId === 'LEX');
    check('a visitor\'s socket on a vanished slug falls back',
          showForSocket('lex24').showId === 'LEX' && !showForSocket('lex24').gone);
    check('as does one on a retired event, which is off the air', showForSocket('lex25').showId === 'LEX');
    check('and a live slug is that event, for both', showForSocket('lna').showId === 'LNA' &&
          showForSocket('lna', { admin: true }).showId === 'LNA');

    const src = require('fs').readFileSync(require.resolve('../server/sockets'), 'utf8');
    check('the socket layer resolves through the same rules, and lets a gone admin go',
          /showForSocket\(slug, \{ admin: !!isAdmin \}\)/.test(src) && /emit\('show:gone'\)/.test(src) &&
          /socket\.disconnect\(true\)/.test(src));
  } finally {
    server.close();
  }

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
