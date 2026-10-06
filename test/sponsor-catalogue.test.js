/**
 * The sponsorship catalogue's CSV round trip, and what a package change does
 * to the plan.
 *
 * The intended workflow is export → edit in a spreadsheet → import. Each of
 * these broke it, and each was found by running it:
 *
 *   a partial file    — `Name,Price` with one row turned a platinum package
 *                       silver, blanked its blurb, perks and logo, and put a
 *                       sold-out package back on sale. The dry run said only
 *                       "Update 1".
 *   a formula guard   — the export prefixes ' to a cell starting = + - @ so a
 *                       spreadsheet reads it as text; the import kept it, so
 *                       "+1 Networking Add-on" came back "'+1 …" and a keyless
 *                       re-import added a duplicate package.
 *   an inline logo    — the export wrote every data URI into the file, so one
 *                       uploaded logo pushed it past the import's own size
 *                       limit (and past Excel's 32,767-character cell).
 *
 * The real /api routes and models run against the stand-in database.
 */
const express = require('express');
const { fakeDb } = require('./fake-mongo');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const SHOW = require('../server/config').defaultShow;
const LOGO = 'data:image/png;base64,' + 'A'.repeat(1_500_000);

const db = fakeDb({
  shows: [{ slug: SHOW.toLowerCase(), showId: SHOW, name: 'Europe', active: true, order: 0 }],
  sponsors: [
    { showId: SHOW, key: 'conference', name: 'Conference Sponsorship', tier: 'platinum', price: 45000,
      availability: 'Exclusive', blurb: 'Own the conference stages.', perks: ['20 VIP passes', 'Welcome address'],
      image: LOGO, video: '', active: false, soldOut: true },
    { showId: SHOW, key: 'addon', name: '+1 Networking Add-on', tier: 'silver', price: 1000,
      availability: '', blurb: '', perks: [], image: 'https://cdn.example.com/addon.png', video: '',
      active: true, soldOut: false },
    { showId: SHOW, key: 'networking-lounge', name: 'Networking Lounge', tier: 'platinum', price: 34950,
      availability: '2 Available', blurb: 'A branded lounge.', perks: [], image: '', video: '',
      active: true, soldOut: false },
    { showId: SHOW, key: 'bags', name: 'Bags', tier: 'silver', price: 12950, availability: 'Exclusive',
      blurb: '', perks: [], image: '', video: '', active: true, soldOut: false },
  ],
  // Two lounges on the plan, both sold by the Networking Lounge package, and
  // one area sold by Bags.
  // Read off this show's own artwork, so they are the areas the plan is sent.
  planAreas: [
    { showId: SHOW, key: 'lounge-a', sponsorKey: 'networking-lounge', status: 'available' },
    { showId: SHOW, key: 'lounge-b', sponsorKey: 'networking-lounge', status: 'available' },
    { showId: SHOW, key: 'bag-desk', sponsorKey: 'bags', status: 'available' },
  ].map((a, i) => ({ ...a, fromArtwork: true, order: i, artworkLabel: a.key,
                     geometry: { x: i * 20, y: 0, w: 10, h: 10 } })),
});
const dbPath = require.resolve('../server/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => db } };

const showContext = require('../server/show-context');
const shows = require('../server/models/shows');
const planAreas = require('../server/models/plan-areas');
const sockets = require('../server/sockets');
const api = require('../server/routes/api');
const csv = require('../server/lib/csv');

// Every refresh of the areas catalogue the plan is sent, and what it held.
const notified = [];
const realNotify = sockets.notifyAreas;
sockets.notifyAreas = async () => { const cat = await realNotify(); notified.push(cat); return cat; };

const app = express();
app.use(express.json({ limit: '3mb' }));
app.use((req, _res, next) => { req.admin = { user: 'chris', role: 'owner' }; showContext.runAs(SHOW, next); });
app.use('/api', api);

const pkg = (key) => db.store.sponsors.find(s => s.key === key && s.showId === SHOW);
const area = (key) => db.store.planAreas.find(a => a.key === key);

(async () => {
  await shows.refresh();
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' },
                                           body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json, text };
  };
  const importCsv = (text, opts = {}) => call('POST', '/sponsors/import', { csv: text, ...opts });

  try {
    console.log('\nA file with only some columns changes only those columns');
    const partial = 'Name,Price\r\nConference Sponsorship,"42.500"\r\n';
    const dry = await importCsv(partial, { dryRun: true });
    const u = (dry.body.updated || [])[0] || {};
    check('the dry run finds the package by name', dry.status === 200 && u.key === 'conference', dry.text.slice(0, 200));
    check('and lists what the update changes — the price, and nothing else',
          Array.isArray(u.changes) && u.changes.length === 1 && u.changes[0].field === 'price' &&
          u.changes[0].from === 45000 && u.changes[0].to === 42500, JSON.stringify(u.changes));
    check('in words an admin can read', /price/i.test(u.detail || '') && /42[,.]?500/.test(u.detail || ''), u.detail);
    check('the dry run wrote nothing', pkg('conference').price === 45000);

    const applied = await importCsv(partial);
    const c = pkg('conference');
    check('the import applies', applied.status === 200 && applied.body.updated.length === 1, applied.text.slice(0, 200));
    check('the price changed', c.price === 42500, String(c.price));
    check('the tier is still platinum', c.tier === 'platinum', c.tier);
    check('the availability, blurb and perks are untouched',
          c.availability === 'Exclusive' && c.blurb === 'Own the conference stages.' && c.perks.length === 2);
    check('the logo is untouched', c.image === LOGO, `${String(c.image).length} chars`);
    check('and it is still sold out, not back on sale', c.soldOut === true && c.active === false,
          `soldOut ${c.soldOut}, active ${c.active}`);

    const again = await importCsv(partial, { dryRun: true });
    check('importing the same file again changes nothing, and says so',
          again.body.updated.length === 0 && (again.body.unchanged || []).length === 1,
          JSON.stringify({ updated: again.body.updated, unchanged: again.body.unchanged }));

    console.log('\nThe exported file comes back as it went out');
    const exp = await call('GET', '/sponsors/export.csv');
    check('the export is well under the import limit with a logo stored inline',
          exp.status === 200 && exp.text.length < 20_000, `${exp.text.length} chars`);
    check('and carries no data URI', !/data:image/i.test(exp.text));
    const rows = csv.parseCsvObjects(exp.text).rows;
    const conf = rows.find(r => r.key === 'conference');
    check('the stored logo is marked as kept, not written out', conf && /uploaded image/i.test(conf.image), conf && conf.image);
    const addon = rows.find(r => r.key === 'addon');
    check('a name starting "+" comes back without the spreadsheet guard',
          addon && addon.name === '+1 Networking Add-on', addon && addon.name);
    check('the guard is still on the exported cell', /'\+1 Networking Add-on/.test(exp.text));

    const round = await importCsv(exp.text, { dryRun: true });
    check('re-importing the export unchanged changes nothing',
          round.status === 200 && round.body.created.length === 0 && round.body.updated.length === 0 &&
          round.body.errors.length === 0, JSON.stringify({ c: round.body.created, u: round.body.updated, e: round.body.errors }));

    // Without the key column a row is matched by name — so a name that came
    // back "'+1 …" matched nothing and became a second package.
    const keyless = exp.text.split('\r\n').map(line => line.replace(/^[^,]*,/, '')).join('\r\n');
    const k = await importCsv(keyless);
    check('a keyless re-import adds no duplicate package',
          k.status === 200 && k.body.created.length === 0 && db.store.sponsors.filter(s => s.showId === SHOW).length === 4,
          JSON.stringify(k.body.created));
    check('and the logo survived the round trip', pkg('conference').image === LOGO);
    check('and so did the linked image URL', pkg('addon').image === 'https://cdn.example.com/addon.png', pkg('addon').image);

    const blankImage = await importCsv('key,name,image\r\nconference,Conference Sponsorship,\r\n');
    check('an empty image cell leaves the stored logo alone', blankImage.status === 200 && pkg('conference').image === LOGO);
    const urlImage = await importCsv('key,name,image\r\nbags,Bags,https://cdn.example.com/bags.png\r\n');
    check('a new image URL in the file is still applied',
          urlImage.status === 200 && pkg('bags').image === 'https://cdn.example.com/bags.png', pkg('bags').image);
    const badImage = await importCsv('key,name,image\r\nbags,Bags,javascript:alert(1)\r\n');
    check('an image the app cannot use is refused for that row, not stored as blank',
          badImage.body.errors.length === 1 && pkg('bags').image === 'https://cdn.example.com/bags.png',
          JSON.stringify(badImage.body.errors));

    console.log('\nThe guard is only stripped where the export put it');
    const parsed = csv.parseCsvObjects("name,blurb\r\n'=SUM(A1),It's fine\r\n''=quoted,'plain\r\n").rows;
    check("a guarded formula comes back as typed", parsed[0].name === '=SUM(A1)', parsed[0].name);
    check('an apostrophe that guards nothing is kept', parsed[0].blurb === "It's fine" && parsed[1].blurb === "'plain",
          `${parsed[0].blurb} / ${parsed[1].blurb}`);
    check("a name that really starts with ' survives the round trip",
          csv.parseCsvObjects(csv.toCsv(['name'], [["'=quoted"]])).rows[0].name === "'=quoted");

  } finally {
    server.close();
  }

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
