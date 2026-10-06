/**
 * A new event can start from one already running.
 *
 * A new year of an event (LEX28 after LEX27), or the same show in a new place,
 * sells the way the last one did. Starting it empty meant re-entering the rate,
 * the currency, the colours, every business activity and every sponsorship
 * package by hand — which is how an event ends up quoting in the wrong money.
 *
 * What is asserted here:
 *
 *   configuration moves — rate, currency, units, colours, activities, packages.
 *   trading does not    — no stands, bookings, leads, plan, or floorplan
 *                         sponsor; last year's sold-out badges are cleared.
 *   nothing half-made   — an event to start from that does not exist refuses
 *                         the whole request, before anything is created.
 *   the owner decides   — and anyone else is told what was refused, not that
 *                         they cannot "manage team members".
 */
const express = require('express');
const { fakeDb } = require('./fake-mongo');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const FROM = 'LEX';
const db = fakeDb({
  shows: [{ slug: 'lex', showId: FROM, name: 'Lubricant Expo Europe', active: true, order: 0 }],
  settings: [{ _id: FROM, ratePerSqm: 640, unit: 'm', currency: 'EUR',
               palette: { available: '#fffcf8', sold: '#689abb', source: 'admin' },
               floorplanSponsor: { name: 'Last Year Oil Co', color: '#7c1315' } }],
  tags: [{ showId: FROM, key: 'base-oils', label: 'Base Oils', color: '#6366f1', order: 0 },
         { showId: FROM, key: 'additives', label: 'Additives', color: '#10b981', order: 1 }],
  sponsors: [{ showId: FROM, key: 'lanyards', name: 'Lanyards', tier: 'gold', price: 8000, soldOut: true, active: true },
             { showId: FROM, key: 'wifi', name: 'Wi-Fi', tier: 'silver', price: 5000, soldOut: false, active: true }],
  booths: [{ showId: FROM, boothNumber: '101', status: 'sold', assignment: { company: 'Real Exhibitor Ltd' } }],
  inquiries: [{ showId: FROM, company: 'A Lead Ltd' }],
  floorplans: [{ showId: FROM, svg: '<svg/>', filename: 'LEX27.svg', revisionId: 'r1', label: 'LEX27' }],
});
const dbPath = require.resolve('../server/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => db } };

const showContext = require('../server/show-context');
const shows = require('../server/models/shows');
const api = require('../server/routes/api');

let role = 'owner';
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.admin = { user: 'chris', role }; showContext.runAs(FROM, next); });
app.use('/api', api);

const rowsFor = (name, id) => (db.store[name] || []).filter(r => (r.showId ?? r._id) === id);

(async () => {
  await shows.refresh();
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const post = async (body) => {
    const res = await fetch(`${base}/shows`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                               body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  try {
    console.log('\nStarting LEX28 from LEX');
    const r = await post({ name: 'Lubricant Expo Europe 2028', showId: 'LEX28', slug: 'lex28', copyFrom: FROM });
    check('created', r.status === 201 && r.body.showId === 'LEX28' && r.body.slug === 'lex28', JSON.stringify(r.body));
    check('and listed as an event straight away', !!shows.bySlug('lex28'));
    check('saying where it was started from', r.body.copiedFrom === FROM);

    const st = db.store.settings.find(s => s._id === 'LEX28');
    check('the rate, units and currency come with it', st && st.ratePerSqm === 640 && st.unit === 'm' && st.currency === 'EUR',
          JSON.stringify(st));
    check('and the colours chosen for it', st && st.palette && st.palette.sold === '#689abb');
    check('but not last year\'s floorplan sponsor', st && !st.floorplanSponsor);

    const tags = rowsFor('tags', 'LEX28');
    check('every business activity, under the same keys', tags.length === 2 &&
          tags.map(t => t.key).sort().join(',') === 'additives,base-oils', tags.map(t => t.key).join(','));
    const pk = rowsFor('sponsors', 'LEX28');
    check('every sponsorship package', pk.length === 2 && pk.some(p => p.key === 'lanyards' && p.price === 8000));
    check('none of them sold out — that was last year', pk.every(p => p.soldOut === false));
    check('the originals untouched', rowsFor('sponsors', FROM).find(p => p.key === 'lanyards').soldOut === true &&
          rowsFor('tags', FROM).length === 2);

    check('no stands', rowsFor('booths', 'LEX28').length === 0);
    check('no leads', rowsFor('inquiries', 'LEX28').length === 0);
    check('no plan — its colours would sell last year\'s stands again', rowsFor('floorplans', 'LEX28').length === 0);

    console.log('\nA blank event is still a blank event');
    const b = await post({ name: 'Lubricant Expo Asia', showId: 'LAS', slug: 'las' });
    check('created with nothing copied', b.status === 201 && b.body.copied === null &&
          !db.store.settings.find(s => s._id === 'LAS') && rowsFor('tags', 'LAS').length === 0);

    console.log('\nNothing half-made');
    const bad = await post({ name: 'Ghost', showId: 'GHOST', slug: 'ghost', copyFrom: 'NOPE' });
    check('an event to start from that does not exist is refused', bad.status === 400 && /start from/.test(bad.body.error),
          bad.body.error);
    check('and no event was created', !shows.byId('GHOST'));
    const dup = await post({ name: 'Again', showId: 'LEX29', slug: 'lex28', copyFrom: FROM });
    check('a URL name already in use is refused', dup.status === 400 && /URL name is already used/.test(dup.body.error));
    check('and nothing was copied for it', rowsFor('tags', 'LEX29').length === 0);

    console.log('\nThe owner decides');
    role = 'admin';
    const no = await post({ name: 'Not Mine', showId: 'NM', slug: 'nm' });
    check('anyone else is refused', no.status === 403 && !shows.byId('NM'));
    check('and told what was refused', /Only the owner account can add or change events/.test(no.body.error), no.body.error);
  } finally {
    server.close();
  }

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
