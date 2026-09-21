/**
 * Importing stands from artwork — and, above all, refusing to.
 *
 * An import rewrites an event's inventory. That is right for standing up a new
 * event and catastrophic on a selling one, so the guard and the show scoping
 * are the parts worth pinning down. Europe has stands sold and on hold; these
 * assert it would be refused.
 *
 * The guard is exercised against REAL documents through a filter-applying
 * stand-in (test/fake-mongo.js), not against a count the test chose in advance.
 * That distinction is the whole reason this file exists in its current form:
 * the defect it now pins down was a filter that no longer matched a booking,
 * and a test that hands countDocuments its answer cannot see that.
 */

const { fakeDb } = require('./fake-mongo');

const dbPath = require.resolve('../server/db');
let db;
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => db } };

const showContext = require('../server/show-context');
const booths = require('../server/models/booths');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

// Status comes from the colour the plan drew each stand in, NOT from whether a
// name is printed on it. Stand 103 is the case that matters: the artwork shows
// it empty while still carrying a stale name.
const STANDS = [
  { number: '101', area: 100, areaSource: 'printed', geometry: { x: 1, y: 1, w: 2, h: 2 },
    exhibitor: 'Acme Oils', status: 'sold' },
  { number: '102', area: 200, areaSource: 'printed', geometry: { x: 3, y: 1, w: 4, h: 2 },
    exhibitor: null, status: 'available' },
  { number: '103', area: 100, areaSource: 'printed', geometry: { x: 8, y: 1, w: 2, h: 2 },
    exhibitor: 'Stale Name Ltd', status: 'available' },
  { number: '104', area: 300, areaSource: 'printed', geometry: { x: 1, y: 5, w: 3, h: 3 },
    exhibitor: 'VIP Lounge', status: 'sold', sponsored: true },
  { number: '105', area: 100, areaSource: 'printed', geometry: { x: 5, y: 5, w: 2, h: 2 },
    exhibitor: 'Reserved Co', status: 'held' },
];

// A stand as a live event holds one: sold to a named exhibitor, with an agreed
// price and a contact.
const soldStand = (n, showId = 'LEX26') => ({
  showId, boothNumber: n, status: 'sold', source: null, updatedBy: 'chris',
  assignment: { company: 'Real Exhibitor Ltd', contactId: 'c1', actualPrice: 12000, notes: '', tags: [], country: null },
});

const standsIn = (showId) => db.store.booths.filter(b => b.showId === showId);

(async () => {
  console.log('\nAn event that has started selling is refused');
  db = fakeDb({ booths: [soldStand('7'), soldStand('8')], holds: [], booths_snapshots: [] });
  const refused = await showContext.runAs('LEX26', () => booths.importFromArtwork(STANDS));
  check('refused outright', refused.ok === false && refused.reason === 'has_bookings', JSON.stringify(refused.reason));
  check('and says how many bookings it was protecting', refused.committed === 2, String(refused.committed));
  check('and nothing was written', !db.calls.some(c => ['deleteMany', 'insertMany', 'bulkWrite'].includes(c[0]) && c[1] === 'booths'));

  console.log('\nA new event imports');
  db = fakeDb({ booths: [], holds: [], booths_snapshots: [] });
  const ok = await showContext.runAs('LNA', () => booths.importFromArtwork(STANDS, { actor: 'chris' }));
  check('the stands are imported', ok.ok === true && ok.imported === 5, JSON.stringify(ok.imported));
  check('the sold count follows the artwork, not the names', ok.sold === 2, `${ok.sold} sold`);
  check('an available stand stays available even with a name printed on it',
        ok.available === 2, `${ok.available} available`);
  check('a stand the plan marks on hold is imported on hold', ok.held === 1);
  check('a sponsorable area is flagged as one', ok.sponsored === 1);

  const inserted = standsIn('LNA');
  check('every stand is filed under the event asked for', inserted.length === 5 &&
        inserted.every(d => d.showId === 'LNA'), inserted.map(d => d.showId).join(','));
  const by = (n) => inserted.find(d => d.boothNumber === n);
  check('the name is carried onto the sold stand', by('101').assignment.company === 'Acme Oils');
  // Believing a printed name over the plan's colours sold nine North American
  // stands the artwork showed as empty or on hold.
  check('a stale name on an empty stand is NOT treated as a booking',
        by('103').assignment.company === null, JSON.stringify(by('103').assignment.company));
  check('the printed area is kept as the stand area', by('102').sqm === 200);
  check('every imported stand is marked as coming from artwork',
        inserted.every(d => d.source === 'artwork-import'));

  console.log('\nEvery write is scoped to one event');
  const unscoped = db.calls.filter(c => ['deleteMany', 'count', 'find', 'updateMany'].includes(c[0]))
                           .filter(c => !c[2] || c[2].showId !== 'LNA');
  check('no query touches another event\'s rows', unscoped.length === 0,
        JSON.stringify(unscoped.map(c => [c[0], c[1], c[2]])));

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nA stand an admin booked is NEVER import output');
  // THE CRITICAL ONE. `source: 'artwork-import'` was stamped on every stand an
  // import created and nothing ever cleared it, while booth:book writes only a
  // status and a company — no contact, no price. So an ordinary booking still
  // matched "put there by an import", countCommitted returned 0, and the next
  // import deleted paying exhibitors while reporting nothing at risk.
  db = fakeDb({ booths: [], holds: [], booths_snapshots: [] });
  await showContext.runAs('LNA', () => booths.importFromArtwork(STANDS, { actor: 'deploy' }));
  check('after an import, nothing counts as committed',
        await showContext.runAs('LNA', () => booths.countCommitted('LNA')) === 0);

  // Exactly what the booth:book handler does, and nothing more.
  const booked = await showContext.runAs('LNA', () => booths.setStatus('102', 'sold',
    { company: 'Paying Customer GmbH', actor: 'chris', expect: ['available', 'held'] }));
  check('the booking lands', booked.changed === true && booked.after.status === 'sold');
  check('and the import\'s mark comes off the stand with it',
        booked.after.source === undefined, JSON.stringify(booked.after.source));
  check('a company name with no price and no contact still counts as committed',
        await showContext.runAs('LNA', () => booths.countCommitted('LNA')) === 1);

  const after = await showContext.runAs('LNA', () => booths.importFromArtwork(STANDS, { actor: 'deploy' }));
  check('so the next import REFUSES', after.ok === false && after.reason === 'has_bookings',
        JSON.stringify(after.reason));
  check('and the booking is still there', standsIn('LNA').find(b => b.boothNumber === '102').assignment.company
        === 'Paying Customer GmbH');

  console.log('\nWork the artwork cannot recreate also refuses it');
  // Tags, a country, a shown number, a sponsor logo, a merge or a split are all
  // invisible to a guard that only counts sold/held/contact/price — so an
  // import on a hand-laid-out event used to throw the whole layout away and
  // report success.
  for (const [what, patch] of [
    ['a shown number',      { displayNumber: '1037' }],
    ['a sponsor logo',      { sponsorLogo: 'data:image/png;base64,AAA' }],
    ['exhibitor tags',      { assignment: { company: null, contactId: null, actualPrice: null, notes: '', tags: ['oils'], country: null } }],
    ['an exhibitor country',{ assignment: { company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: 'DE' } }],
    ['a merge',             { mergeSnapshot: { self: {}, parts: [] } }],
    ['a split',             { splitSnapshot: { self: {}, created: [] } }],
  ]) {
    db = fakeDb({ booths: [{ showId: 'LNA', boothNumber: '101', status: 'available',
                             assignment: { company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null },
                             ...patch }], holds: [], booths_snapshots: [] });
    const r = await showContext.runAs('LNA', () => booths.importFromArtwork(STANDS));
    check(`${what} refuses the import`, r.ok === false && r.reason === 'has_customisations',
          JSON.stringify(r.reason));
  }

  console.log('\nAn upsert keeps what it is not entitled to rewrite');
  db = fakeDb({ booths: [], holds: [], booths_snapshots: [] });
  await showContext.runAs('LNA', () => booths.importFromArtwork(STANDS, { actor: 'import' }));
  await showContext.runAs('LNA', () => booths.setStatus('101', 'sold',
    { company: 'Paying Customer GmbH', actor: 'chris' }));
  const moved = STANDS.map(s => s.number === '101'
    ? { ...s, geometry: { x: 99, y: 99, w: 5, h: 5 }, area: 500, exhibitor: 'Someone Else' } : s);
  const up = await showContext.runAs('LNA', () => booths.importFromArtwork(moved, { actor: 'import', force: true }));
  const kept = standsIn('LNA').find(b => b.boothNumber === '101');
  check('the geometry the plan moved IS rewritten', kept.geometry.x === 99, JSON.stringify(kept.geometry));
  check('and its area and list price with it', kept.sqm === 500);
  check('but the booking is untouched', kept.assignment.company === 'Paying Customer GmbH' && kept.status === 'sold');
  check('and the import says so rather than claiming it replaced everything',
        up.reshaped === 1 && up.mode === 'upsert', JSON.stringify({ reshaped: up.reshaped, mode: up.mode }));

  console.log('\nA merged stand is not reshaped at all');
  db = fakeDb({ booths: [{ showId: 'LNA', boothNumber: '101', status: 'available',
                           geometry: { x: 1, y: 1, w: 9, h: 9 }, sqm: 900,
                           mergeSnapshot: { self: { geometry: { x: 1, y: 1, w: 2, h: 2 }, sqm: 100 }, parts: [] },
                           assignment: { company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null } }],
                holds: [], booths_snapshots: [] });
  await showContext.runAs('LNA', () => booths.importFromArtwork(STANDS, { force: true }));
  const merged = standsIn('LNA').find(b => b.boothNumber === '101');
  check('its footprint is ours now, not the plan\'s rectangle',
        merged.sqm === 900 && merged.geometry.w === 9, JSON.stringify({ sqm: merged.sqm, w: merged.geometry.w }));

  console.log('\nReplacing an existing plan keeps a way back');
  db = fakeDb({ booths: [{ showId: 'LNA', boothNumber: 'old', status: 'available',
                           assignment: { company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null } }],
                holds: [], booths_snapshots: [] });
  const again = await showContext.runAs('LNA', () => booths.importFromArtwork(STANDS, { replace: true }));
  const snapAt = db.calls.findIndex(c => c[1] === 'booths_snapshots' && c[0].startsWith('insert'));
  const delAt = db.calls.findIndex(c => c[0] === 'deleteMany' && c[1] === 'booths');
  check('a snapshot is taken', again.snapshot === true && snapAt > -1);
  check('and taken BEFORE anything is deleted', snapAt > -1 && snapAt < delAt, `snapshot@${snapAt} delete@${delAt}`);
  check('one snapshot document per stand, not one for the whole show',
        db.store.booths_snapshots.filter(s => !s.header).length === 1);
  check('with a header row naming it, so a listing need not read them all',
        db.store.booths_snapshots.some(s => s.header && s.snapshotId));
  check('the old stand is gone — that is what replace means',
        !standsIn('LNA').some(b => b.boothNumber === 'old'));

  console.log('\nNothing to import is not an import');
  check('an empty read writes nothing',
        (await showContext.runAs('LNA', () => booths.importFromArtwork([]))).ok === false);

  console.log('\nA plan whose colours cannot be read is refused, not guessed at');
  // Read only through CSS classes, a plan that colours by attribute yielded a
  // null fill for every stand — and every stand then imported as SOLD, which
  // is a hall nobody can sell.
  db = fakeDb({ booths: [], holds: [], booths_snapshots: [] });
  const blind = await showContext.runAs('LNA', () =>
    booths.importFromArtwork(STANDS.map(s => ({ ...s, fillUnknown: true }))));
  check('refused', blind.ok === false && blind.reason === 'fills_unreadable', JSON.stringify(blind.reason));
  check('and says how much of the plan it could not read', blind.unreadable === 5 && blind.of === 5);

  console.log('\nA stand the plan draws as reserved stays reserved');
  // Without a hold DOCUMENT the expiry sweep finds a held stand nobody is
  // holding and releases it — which is how the four North American stands the
  // plan draws as reserved turned back into empty ones.
  db = fakeDb({ booths: [], holds: [], booths_snapshots: [] });
  await showContext.runAs('LNA', () => booths.importFromArtwork(STANDS));
  const holdDocs = db.store.holds;
  check('a hold document is written for it', holdDocs.length === 1, `${holdDocs.length} written`);
  check('carrying the exhibitor from the plan', holdDocs[0] && holdDocs[0].company === 'Reserved Co');
  check('with no expiry, so the sweep leaves it alone', holdDocs[0] && holdDocs[0].expiresAt === undefined);
  check('and marked as the import\'s, not a person\'s',
        holdDocs[0] && holdDocs[0].source === 'artwork-import' && holdDocs[0].sessionId === null);
  check('and the stand itself records that its hold never expires',
        standsIn('LNA').find(b => b.boothNumber === '105').holdExpiresAt === null);

  console.log('\nStands an import itself created never block the next one');
  // An import stores the stands a plan draws as reserved AS held. Counting
  // those as bookings meant the four held stands an import had just created
  // refused every import after it: an event imported wrong could never be
  // corrected.
  const again2 = await showContext.runAs('LNA', () => booths.importFromArtwork(STANDS));
  check('a re-import is allowed', again2.ok === true, JSON.stringify(again2.reason));
  check('and the guard asks the holds collection who really reserved something',
        db.calls.some(c => c[0] === 'distinct' && c[1] === 'holds'));

  console.log('\nA stand someone actually reserved does block it');
  db = fakeDb({ booths: [{ showId: 'LNA', boothNumber: '101', status: 'held', source: 'artwork-import',
                           updatedBy: 'import',
                           assignment: { company: 'Reserved Co', contactId: null, actualPrice: null, notes: '', tags: [], country: null } }],
                holds: [{ showId: 'LNA', boothNumber: '101', company: 'A Person', createdBy: 'chris' }],
                booths_snapshots: [] });
  const blocked = await showContext.runAs('LNA', () => booths.importFromArtwork(STANDS));
  check('refused on a real hold', blocked.ok === false && blocked.reason === 'has_bookings',
        JSON.stringify(blocked.reason));

  console.log('\nWhat counts as work an import must not destroy');
  const f2 = JSON.stringify(booths.commercialFilter());
  check('a stand on hold that a person made counts', /"status":"held"|\$ne":"available"/.test(f2));
  check('but an import\'s own held stands are excluded alongside its sold ones',
        /"status":\{"\$in":\["sold","held"\]\}/.test(f2), f2.slice(0, 120));
  check('a contact or an agreed price counts',
        /assignment.contactId/.test(f2) && /assignment.actualPrice/.test(f2));
  check('a stand sold only because the artwork named it does NOT count',
        /\$nor/.test(f2) && /artwork-import/.test(f2),
        'so a botched import can still be corrected');
  check('events imported before the marker existed are still recognised',
        /Name read from the supplied floorplan artwork/.test(f2));
  check('and the exclusion also requires an IMPORT to have written it last',
        /"updatedBy"/.test(f2), 'the mark alone was what let a booking be deleted');

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})();
