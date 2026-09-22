/**
 * The stand schedule a designer is sent before they redraw a plan.
 *
 * A re-issued drawing is made from the designer's own last file, and that file
 * cannot know what has happened to the layout since: stands consolidated into
 * one block, a stand split into cells, a number relabelled. Redrawn from it,
 * every one of those comes back through the re-issue diff as a sold stand that
 * has moved, resized or vanished — and the person loading the plan has to
 * reconcile by hand what nobody needed to lose in the first place.
 *
 * So the schedule has to say what the CURRENT stands are, in the columns
 * specification BEC-FP-01 R15 asks for, and it must not carry anything
 * commercial: it goes outside the company.
 */
const express = require('express');
const { fakeDb } = require('./fake-mongo');
const { parseCsv } = require('../server/lib/csv');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const SHOW = 'LEX27';
const booths = [
  { showId: SHOW, boothNumber: '101', sqm: 30, status: 'sold',
    assignment: { company: 'Acme Oils', actualPrice: 18000, contactEmail: 'buyer@acme.test', notes: 'discount agreed' } },
  { showId: SHOW, boothNumber: '102', sqm: 30, status: 'available', assignment: null },
  { showId: SHOW, boothNumber: '103', sqm: 24, status: 'held', assignment: { company: 'Northern Oils BV' } },
  { showId: SHOW, boothNumber: '104', sqm: 60, status: 'sold', mergedFrom: ['104', '106'],
    assignment: { company: 'Barentz' } },
  { showId: SHOW, boothNumber: '105a', sqm: 15, status: 'available', splitFrom: '105' },
  { showId: SHOW, boothNumber: '20', sqm: 12, status: 'available', displayNumber: 'P20' },
  // Another event entirely: it must never appear in this one's schedule.
  { showId: 'LNA27', boothNumber: '901', sqm: 99, status: 'sold', assignment: { company: 'Elsewhere Inc' } },
];

const db = fakeDb({ booths, settings: [{ _id: SHOW, unit: 'm', ratePerSqm: 600 }] });
const dbPath = require.resolve('../server/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => db } };

const showContext = require('../server/show-context');
const api = require('../server/routes/api');

const app = express();
app.use((req, _res, next) => showContext.runAs(SHOW, next));
app.use('/api', api);

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${base}/api/stands/schedule.csv`);
  const text = await res.text();
  check('the schedule is served', res.status === 200, String(res.status));
  check('as a CSV file, named for the event and the day',
        /text\/csv/.test(res.headers.get('content-type') || '') &&
        /attachment; filename="LEX27-stand-schedule-\d{4}-\d{2}-\d{2}\.csv"/.test(res.headers.get('content-disposition') || ''),
        res.headers.get('content-disposition'));

  const rows = parseCsv(text).filter(r => r.length > 1);
  const head = rows[0];
  const byNumber = Object.fromEntries(rows.slice(1).map(r => [r[0], Object.fromEntries(head.map((h, i) => [h, r[i]]))]));

  console.log('\nThe columns R15 asks for');
  check('stand_number, area, unit, status, exhibitor, note',
        head.join(',') === 'stand_number,area,unit,status,exhibitor,note', head.join(','));

  console.log('\nOne row per stand on THIS event');
  check('six stands, and not the other event\'s', rows.length - 1 === 6 && !byNumber['901'],
        Object.keys(byNumber).join(','));
  check('sorted the way a person reads stand numbers',
        rows.slice(1).map(r => r[0]).join(',') === '20,101,102,103,104,105a',
        rows.slice(1).map(r => r[0]).join(','));

  console.log('\nStatus in the words the specification uses');
  check('a sold stand is "taken"', byNumber['101'].status === 'taken', byNumber['101'].status);
  check('an available stand is "available"', byNumber['102'].status === 'available');
  check('a held stand is "reserved" — it must keep its number too',
        byNumber['103'].status === 'reserved', byNumber['103'].status);
  check('the area and unit are carried', byNumber['101'].area === '30' && byNumber['101'].unit === 'sqm',
        `${byNumber['101'].area} ${byNumber['101'].unit}`);

  console.log('\nWhat the designer\'s own last file cannot know');
  check('a merged block says it is now ONE stand',
        /merged from 104 \+ 106/.test(byNumber['104'].note), byNumber['104'].note);
  check('a split cell says it was not on the previous drawing',
        /split from 105/.test(byNumber['105a'].note), byNumber['105a'].note);
  check('a relabelled stand gives the number printed on the plan',
        /shown on the plan as P20/.test(byNumber['20'].note), byNumber['20'].note);

  console.log('\nNothing commercial leaves the company');
  check('the exhibitor name is given — it is printed on the plan anyway',
        byNumber['101'].exhibitor === 'Acme Oils', byNumber['101'].exhibitor);
  check('the agreed price is not', !/18000/.test(text));
  check('nor the contact, nor the deal notes', !/acme\.test/.test(text) && !/discount agreed/.test(text));

  server.close();
  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})();
