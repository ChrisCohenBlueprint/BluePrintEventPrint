/**
 * The expiry sweep, and the stand it used to give away.
 *
 * The sweep reads which holds are live, decides which stands to release, and
 * then writes. An admin can force a hold onto a stand in that gap. The release
 * was conditional on nothing more than `status: 'held'` — which a stand someone
 * has just re-held still is — so the sweep flipped a live hold back to
 * available and abandoned the brand-new hold document behind it. Silently, on a
 * selling plan, once a minute.
 *
 * What fixes it is that the booth now carries its own expiry, written
 * atomically with the claim, and the release is conditional on THAT. These
 * drive the real reconcile() against a filter-applying stand-in, so the test
 * fails if the condition ever stops saying what the sweep decided.
 */
const { fakeDb } = require('./fake-mongo');

const dbPath = require.resolve('../server/db');
let db;
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => db } };

const showContext = require('../server/show-context');
const holds = require('../server/services/holds');
const booths = require('../server/models/booths');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const SHOW = 'LEX26';
const past = new Date(Date.now() - 60_000);
const future = new Date(Date.now() + 3_600_000);
const stand = (n, extra = {}) => ({
  showId: SHOW, boothNumber: n, status: 'held',
  assignment: { company: 'Someone', contactId: null, actualPrice: null, notes: '', tags: [], country: null },
  ...extra,
});
const boothNow = (n) => db.store.booths.find(b => b.boothNumber === n);
const run = (fn) => showContext.runAs(SHOW, fn);

(async () => {
  console.log('\nA hold that has run out is released');
  db = fakeDb({
    booths: [stand('101', { holdExpiresAt: past })],
    holds: [{ showId: SHOW, boothNumber: '101', company: 'Someone', expiresAt: past }],
  });
  const freed = await run(() => holds.reconcile());
  check('the stand comes back', freed.join(',') === '101', JSON.stringify(freed));
  check('and is actually available', boothNow('101').status === 'available');
  check('its exhibitor is cleared', boothNow('101').assignment.company === null);
  check('and the stale expiry does not linger on it',
        boothNow('101').holdExpiresAt === undefined);
  check('the hold document goes with it', db.store.holds.length === 0);

  console.log('\nA hold that is still running is left alone');
  db = fakeDb({
    booths: [stand('102', { holdExpiresAt: future })],
    holds: [{ showId: SHOW, boothNumber: '102', company: 'Someone', expiresAt: future }],
  });
  check('nothing is released', (await run(() => holds.reconcile())).length === 0);
  check('and the stand is still held', boothNow('102').status === 'held');

  console.log('\nA hold the PLAN declares has no expiry, and is never swept');
  // An import stores the stands a plan draws as reserved as held, with no
  // countdown: the plan says they are reserved and that stays true until a
  // person says otherwise. Releasing those is what turned North America's four
  // reserved stands back into empty ones.
  db = fakeDb({
    booths: [stand('103', { holdExpiresAt: null })],
    holds: [{ showId: SHOW, boothNumber: '103', company: 'Reserved Co', source: 'artwork-import' }],
  });
  check('it survives the sweep', (await run(() => holds.reconcile())).length === 0);
  check('and stays held', boothNow('103').status === 'held');

  console.log('\nA stand held with no document behind it still self-heals');
  // The sweep re-derives truth from the data on every tick, which is why it is
  // a sweep and not a change stream. A stand left 'held' by a path that never
  // wrote a document must not stay unsellable for ever.
  db = fakeDb({ booths: [stand('104')], holds: [] });
  check('it is reclaimed', (await run(() => holds.reconcile())).join(',') === '104');
  check('and is available again', boothNow('104').status === 'available');

  console.log('\nTHE RACE: an admin forces a hold while the sweep is mid-flight');
  // forceHold stamps the booth's expiry FIRST, precisely so a sweep that has
  // already read its candidates cannot match on the write.
  db = fakeDb({
    booths: [stand('105', { holdExpiresAt: past })],
    holds: [{ showId: SHOW, boothNumber: '105', company: 'Expired Co', expiresAt: past }],
  });
  // Stand in the gap: the sweep has read '105' as expired, and now the admin
  // re-holds it before the release lands.
  await run(() => holds.forceHold('105', { company: 'New Exhibitor', actor: 'chris' }));
  const after = await run(() => holds.reconcile());
  check('the sweep releases nothing', after.length === 0, JSON.stringify(after));
  check('the stand is still held for the new exhibitor', boothNow('105').status === 'held');
  check('its expiry is the new one, in the future',
        boothNow('105').holdExpiresAt > new Date(), String(boothNow('105').holdExpiresAt));
  check('and the new hold document is NOT deleted', db.store.holds.length === 1 &&
        db.store.holds[0].company === 'New Exhibitor',
        JSON.stringify(db.store.holds.map(h => h.company)));

  console.log('\nA booking placed under the sweep is never overwritten');
  db = fakeDb({
    booths: [stand('106', { holdExpiresAt: past })],
    holds: [{ showId: SHOW, boothNumber: '106', company: 'Expired Co', expiresAt: past }],
  });
  await run(() => booths.setStatus('106', 'sold', { company: 'Paid Up Ltd', actor: 'chris', expect: ['available', 'held'] }));
  check('the sweep releases nothing', (await run(() => holds.reconcile())).length === 0);
  check('and the sale stands', boothNow('106').status === 'sold' &&
        boothNow('106').assignment.company === 'Paid Up Ltd');

  console.log('\nPlacing a hold claims the stand and its expiry in one write');
  db = fakeDb({
    booths: [{ showId: SHOW, boothNumber: '107', status: 'available',
               assignment: { company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null } }],
    holds: [],
  });
  const r = await run(() => holds.create({ boothNumber: '107', company: 'Interested Co', actor: 'chris' }));
  check('the hold is placed', r.ok === true, JSON.stringify(r));
  check('the expiry is on the stand, not only in the hold document',
        boothNow('107').holdExpiresAt instanceof Date && boothNow('107').holdExpiresAt > new Date());
  check('so the very next sweep leaves it alone', (await run(() => holds.reconcile())).length === 0);

  console.log('\nOne show\'s sweep never reaches another\'s stands');
  db = fakeDb({
    booths: [stand('108', { holdExpiresAt: past }), { ...stand('108', { holdExpiresAt: past }), showId: 'LNA' }],
    holds: [],
  });
  await run(() => holds.reconcile());
  check('only this event\'s stand is released',
        db.store.booths.filter(b => b.status === 'available').length === 1 &&
        db.store.booths.find(b => b.showId === 'LNA').status === 'held');

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})();
