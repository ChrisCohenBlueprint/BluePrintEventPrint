/**
 * A booking's life on one stand: held, sold, moved, released, expired.
 *
 * Each of these used to leave something behind it, or say something that was
 * not true:
 *
 *   private until sold — a hold is a provisional deal; its company is never
 *                        published, and the public projection used to send it
 *                        anyway.
 *
 * Driven through the real model, the real hold service and the real socket
 * handlers, against a filter-applying stand-in for the database.
 */
const { fakeDb } = require('./fake-mongo');

const dbPath = require.resolve('../server/db');
let db = fakeDb({});
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => db } };

const showContext = require('../server/show-context');
const booths = require('../server/models/booths');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const SHOW = 'LEX26';
const run = (fn) => showContext.runAs(SHOW, fn);
const now = (n) => db.store.booths.find(b => b.boothNumber === n);
const EMPTY = () => ({ company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null });
const stand = (n, extra = {}) => ({
  showId: SHOW, boothNumber: n, status: 'available', sqm: 9, listPrice: 5400,
  geometry: { x: 0, y: 0, w: 40, h: 40 }, assignment: EMPTY(), ...extra,
});

(async () => {
  console.log('\nA hold is not published; a sale is');
  const held = booths.toPublic(stand('101', { status: 'held',
    assignment: { ...EMPTY(), company: 'Negotiating Ltd', tags: ['oils'], country: 'DE' } }));
  check('a held stand reaches the public plan with no company', held.company === null, JSON.stringify(held.company));
  check('nor its tags or country', held.tags.length === 0 && held.country === null);
  check('but it does say it is held', held.status === 'held');
  const sold = booths.toPublic(stand('102', { status: 'sold',
    assignment: { ...EMPTY(), company: 'Exhibitor GmbH', tags: ['oils'], country: 'DE' } }));
  check('a sold stand names its exhibitor', sold.company === 'Exhibitor GmbH');
  check('with its tags and country', sold.tags.join() === 'oils' && sold.country === 'DE');
  const glitch = booths.toPublic(stand('103', { assignment: { ...EMPTY(), company: 'Left Behind Co' } }));
  check('a name left on an available stand is not published either', glitch.company === null);

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
