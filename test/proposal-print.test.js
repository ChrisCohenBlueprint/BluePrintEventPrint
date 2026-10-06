/**
 * The printed proposal: the one document from this system a client keeps.
 *
 * There was no test of this page at all, and "Save as PDF" failed for every
 * proposal on every event: the dashboard opens /sales/<event>/menu/<id>/print,
 * the page took the id from a fixed position in the path, and on that URL the
 * segment it read was the word "menu". Every proposal said "Proposal not found."
 *
 * So this drives the REAL sales routes and the REAL print page in Chrome — only
 * the database and the login are stand-ins — and asserts on what renders:
 *
 *   it opens          — a North America proposal at the URL the dashboard uses,
 *                       and a default-event one at the bare URL, both render;
 *   it goes back      — "Back to dashboard" returns to the proposal's own event;
 *   it prices honestly — an empty price box is "On application", not free; the
 *                       total never counts an unpriced item as nothing, says
 *                       when it leaves one out, is absent when nothing is
 *                       priced, and adds up the figures the lines print.
 */
const path = require('path');
const express = require('express');
const { ObjectId } = require('mongodb');
const { fakeDb } = require('./fake-mongo');
const { launch, listen } = require('./harness');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const ROOT = path.join(__dirname, '..');
const DEFAULT = require('../server/config').defaultShow;   // whatever .env names
const NA = 'LNA';

const LNA_ID = new ObjectId().toHexString();
const LEX_ID = new ObjectId().toHexString();
const POA_ID = new ObjectId().toHexString();

const db = fakeDb({
  shows: [{ slug: DEFAULT.toLowerCase(), showId: DEFAULT, name: 'Europe', active: true, order: 0 },
          { slug: 'lna', showId: NA, name: 'North America', active: true, order: 1 }],
  settings: [{ _id: NA, unit: 'ft', currency: 'USD', ratePerSqm: 60 }],
  users: [{ username: 'rep', role: 'sales', displayName: 'Rita Rep', email: 'rita@example.com' }],
  sponsors: [{ showId: NA, key: 'lounge', name: 'Networking Lounge', tier: 'gold', price: null, active: true },
             { showId: NA, key: 'bags', name: 'Bags', tier: 'silver', price: null, active: true }],
  booths: [{ showId: NA, boothNumber: 'A1', status: 'available', sqm: 100, listPrice: 6000.4,
             geometry: { x: 0, y: 0, w: 10, h: 10 } },
           { showId: DEFAULT, boothNumber: '101', status: 'available', sqm: 9, listPrice: 5400,
             geometry: { x: 0, y: 0, w: 10, h: 10 } }],
  menus: [
    // A priced stand, a package on application and a bespoke line with a price
    // that does not round cleanly — the three things a total can get wrong.
    { _id: LNA_ID, showId: NA, ref: 'LNA-P001', owner: 'rep', title: 'Proposal for Acme',
      clientName: 'Ann', clientCompany: 'Acme Inc', sponsorKeys: ['lounge'], boothNumbers: ['A1'],
      custom: [{ title: 'Extra carpet', detail: '', price: 100.4 }], showPrices: true, showPlan: false,
      createdAt: new Date(), updatedAt: new Date() },
    { _id: LEX_ID, showId: DEFAULT, ref: `${DEFAULT}-P001`, owner: 'rep', title: 'Europe proposal',
      clientName: 'Bo', clientCompany: 'Bo GmbH', sponsorKeys: [], boothNumbers: ['101'], custom: [],
      showPrices: false, showPlan: false, createdAt: new Date(), updatedAt: new Date() },
    // Nothing in it has a price.
    { _id: POA_ID, showId: NA, ref: 'LNA-P002', owner: 'rep', title: 'All on application',
      clientName: 'Cy', clientCompany: 'Cy Ltd', sponsorKeys: ['lounge', 'bags'], boothNumbers: [],
      custom: [{ title: 'Bespoke build', detail: '', price: null }], showPrices: true, showPlan: false,
      createdAt: new Date(), updatedAt: new Date() },
  ],
});

// The models query proposals by `new ObjectId(id)`; the stand-in compares by
// identity, so ids are stored as hex strings and every ObjectId in a filter is
// read as its hex string on the way in. Nothing else about the queries changes.
const plainIds = (v) => {
  if (v instanceof ObjectId) return v.toHexString();
  if (Array.isArray(v)) return v.map(plainIds);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plainIds(x)]));
  }
  return v;
};
const view = {
  collection(name) {
    const c = db.collection(name);
    return { ...c,
      find: (f, ...a) => c.find(plainIds(f), ...a),
      findOne: (f, ...a) => c.findOne(plainIds(f), ...a),
      updateOne: (f, ...a) => c.updateOne(plainIds(f), ...a),
      deleteOne: (f, ...a) => c.deleteOne(plainIds(f), ...a),
      // Fresh proposals get a real ObjectId's hex, so the page can open them.
      insertOne: async (doc) => { const id = new ObjectId().toHexString(); await c.insertOne({ ...doc, _id: id });
                                  return { insertedId: id }; },
      findOneAndUpdate: async (f, u) => {
        await c.updateOne(f, u, { upsert: true });
        return c.findOne(f);
      },
    };
  },
};
const dbPath = require.resolve('../server/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => view } };

// The login is not what is under test: every request is a signed-in rep.
const authPath = require.resolve('../server/auth');
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: {
  ADMIN_ROLES: ['admin', 'owner'],
  salesAuth: (req, _res, next) => { req.account = { user: 'rep', role: 'sales' }; next(); },
} };

const shows = require('../server/models/shows');
const { showMiddleware } = require('../server/show-middleware');
const salesRoutes = require('../server/routes/sales');

const app = express();
app.use(express.json());
app.use(showMiddleware());
app.use(salesRoutes);
app.get('/floorplan.svg', (_q, res) =>
  res.type('image/svg+xml').sendFile(path.join(ROOT, 'public/LEX27_Floorplan_Consolidated.svg')));
app.use(express.static(path.join(ROOT, 'public')));

async function openPrint(br, url) {
  const page = await br.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Either the document appears or the page says why not — never a spinner.
  await page.waitForFunction(() => !document.getElementById('sheet').hidden ||
                                    document.getElementById('load-state').classList.contains('error'),
                             null, { timeout: 15000 }).catch(() => {});
  const r = await page.evaluate(() => {
    const t = (id) => (document.getElementById(id)?.textContent || '').trim();
    const shown = (id) => !document.getElementById(id)?.hidden;
    return {
      rendered: shown('sheet'),
      loadState: t('load-state'),
      ref: t('doc-ref'),
      forWho: t('doc-for'),
      back: document.querySelector('.toolbar a.tb-btn')?.getAttribute('href') || '',
      prices: [...document.querySelectorAll('.p-price, td.col-price')].map(n => n.textContent.trim()),
      totalShown: shown('totals'),
      totalLabel: t('total-label'),
      total: t('total-value'),
    };
  });
  await page.close();
  return { ...r, errors };
}

(async () => {
  await shows.refresh();
  const { server, base } = await listen(app);
  const br = await launch();

  try {
    console.log('\nA North America proposal, at the URL the dashboard opens');
    const na = await openPrint(br, `${base}/sales/lna/menu/${LNA_ID}/print`);
    check('the proposal renders', na.rendered, na.loadState);
    check('it is the right one', na.ref === 'LNA-P001' && /Acme Inc/.test(na.forWho), `${na.ref} / ${na.forWho}`);
    check('not "Proposal not found."', !/not found/i.test(na.loadState), na.loadState);
    check('"Back to dashboard" returns to North America', na.back === '/sales/lna', na.back);
    check('no script errors', na.errors.length === 0, na.errors.join(' | '));

    console.log('\nA default-event proposal, at the bare URL');
    const lex = await openPrint(br, `${base}/sales/menu/${LEX_ID}/print`);
    check('the proposal renders', lex.rendered && lex.ref === `${DEFAULT}-P001`, `${lex.ref} ${lex.loadState}`);
    check('"Back to dashboard" returns to that event',
          lex.back === `/sales/${DEFAULT.toLowerCase()}`, lex.back);

    console.log('\nThe total states what it covers');
    // Lines print in whole dollars: $6,000 for the stand, $100 for the carpet.
    check('the stand and the bespoke line print their rounded prices',
          na.prices.includes('$6,000') && na.prices.includes('$100'), na.prices.join(', '));
    check('the package with no price prints "On application"', na.prices.includes('On application'),
          na.prices.join(', '));
    check('the total is the sum of the printed lines ($6,100, not $6,101)', na.total === '$6,100', na.total);
    check('and says it leaves out the item on application', /excluding 1 item on application/i.test(na.totalLabel),
          na.totalLabel);

    const poa = await openPrint(br, `${base}/sales/lna/menu/${POA_ID}/print`);
    check('an all-on-application proposal renders', poa.rendered, poa.loadState);
    check('and prints no total — not "Total $0"', !poa.totalShown, `${poa.totalLabel} ${poa.total}`);

    console.log('\nAn empty price box is "On application", not free');
    const post = async (custom) => {
      const res = await fetch(`${base}/api/sales/menus`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Show': 'lna' },
        body: JSON.stringify({ title: 'Bespoke', custom, showPrices: true, showPlan: false }),
      });
      return res.json();
    };
    const blank = await post([{ title: 'Null price', price: null }, { title: 'Empty price', price: '' },
                              { title: 'Spaces', price: '  ' }, { title: 'Free', price: 0 },
                              { title: 'Priced', price: '250' }]);
    const by = Object.fromEntries((blank.custom || []).map(c => [c.title, c.price]));
    check('a null price is stored as on application', by['Null price'] === null, String(by['Null price']));
    check('an empty price is stored as on application', by['Empty price'] === null, String(by['Empty price']));
    check('a blank price is stored as on application', by['Spaces'] === null, String(by['Spaces']));
    check('a real zero is still zero', by['Free'] === 0, String(by['Free']));
    check('a typed price is a number', by['Priced'] === 250, String(by['Priced']));

    const printed = await openPrint(br, `${base}/sales/lna/menu/${blank._id}/print`);
    const lines = printed.prices;
    check('the printed document says "On application" for the empty ones',
          lines.filter(p => p === 'On application').length === 3, lines.join(', '));
    check('and does not print them as $0', lines.filter(p => p === '$0').length === 1, lines.join(', '));
  } finally {
    await br.close();
    server.close();
  }

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
