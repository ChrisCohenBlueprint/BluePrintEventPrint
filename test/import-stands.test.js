/**
 * Importing stands from artwork — and, above all, refusing to.
 *
 * An import DELETES every stand on an event and re-inserts. That is right for
 * standing up a new event and catastrophic on a selling one, so the guard and
 * the show scoping are the parts worth pinning down. Europe has stands sold
 * and on hold; these assert it would be refused.
 */
const path = require('path');

// Stand in for Mongo. Records what was asked of it so the test can assert on
// the filters, which is where show scoping either holds or does not.
const calls = [];
function fakeDb(state) {
  const docs = { booths: state.booths || [], booths_snapshots: [], holds: [] };
  const col = (name) => ({
    distinct: async (field, f) => {
      calls.push(['distinct', name, f]);
      // The guard asks only for holds a PERSON made; an import's own are
      // excluded by the filter, so honour that here rather than returning all.
      if (f && f.source && f.source.$ne) return state.personHolds || [];
      return state.holds || [];
    },
    countDocuments: async (f) => {
      calls.push(['count', name, f]);
      // The guard asks two different questions of the same collection: how many
      // stands carry real commercial state, and how many are named by a row in
      // `holds`. Answering both with one number hid a bug, so tell them apart.
      if (f && f.boothNumber && Array.isArray(f.boothNumber.$in)) return f.boothNumber.$in.length;
      return state.committed ?? 0;
    },
    find: (f) => { calls.push(['find', name, f]); return { toArray: async () => docs.booths.filter(b => b.showId === f.showId) }; },
    findOne: async () => null,
    insertOne: async (d) => { calls.push(['insertOne', name, d]); docs[name].push(d); },
    insertMany: async (d) => { calls.push(['insertMany', name, d]); docs[name] = d; },
    deleteMany: async (f) => { calls.push(['deleteMany', name, f]); },
    updateOne: async () => {},
  });
  return { collection: col, __docs: docs };
}

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

(async () => {
  console.log('\nAn event that has started selling is refused');
  calls.length = 0;
  db = fakeDb({ committed: 19, booths: [{ showId: 'LEX26' }] });
  const refused = await showContext.runAs('LEX26', () => booths.importFromArtwork(STANDS));
  check('refused outright', refused.ok === false && refused.reason === 'has_bookings', JSON.stringify(refused.reason));
  check('and nothing was deleted', !calls.some(c => c[0] === 'deleteMany'));
  check('and nothing was inserted', !calls.some(c => c[0] === 'insertMany'));

  console.log('\nA new event imports');
  calls.length = 0;
  db = fakeDb({ committed: 0, booths: [] });
  const ok = await showContext.runAs('LNA', () => booths.importFromArtwork(STANDS, { actor: 'chris' }));
  check('the stands are imported', ok.ok === true && ok.imported === 5, JSON.stringify(ok.imported));
  check('the sold count follows the artwork, not the names',
        ok.sold === 2, `${ok.sold} sold`);
  check('an available stand stays available even with a name printed on it',
        ok.available === 2, `${ok.available} available`);
  check('a stand the plan marks on hold is imported on hold', ok.held === 1);
  check('a sponsorable area is flagged as one', ok.sponsored === 1);

  const inserted = calls.find(c => c[0] === 'insertMany' && c[1] === 'booths')[2];
  check('every stand is filed under the event asked for',
        inserted.every(d => d.showId === 'LNA'), inserted.map(d => d.showId).join(','));
  check('the name is carried onto the sold stand',
        inserted.find(d => d.boothNumber === '101').assignment.company === 'Acme Oils');
  // Believing a printed name over the plan's colours sold nine North American
  // stands the artwork showed as empty or on hold.
  check('a stale name on an empty stand is NOT treated as a booking',
        inserted.find(d => d.boothNumber === '103').assignment.company === null,
        JSON.stringify(inserted.find(d => d.boothNumber === '103').assignment.company));
  check('the printed area is kept as the stand area',
        inserted.find(d => d.boothNumber === '102').sqm === 200);
  check('every imported stand is marked as coming from artwork',
        inserted.every(d => d.source === 'artwork-import'));

  console.log('\nEvery write is scoped to one event');
  const unscoped = calls.filter(c => ['deleteMany', 'count', 'find'].includes(c[0]))
                        .filter(c => !c[2] || c[2].showId !== 'LNA');
  check('no query touches another event\'s rows', unscoped.length === 0,
        JSON.stringify(unscoped.map(c => [c[0], c[1], c[2]])));

  console.log('\nReplacing an existing plan keeps a way back');
  calls.length = 0;
  db = fakeDb({ committed: 0, booths: [{ showId: 'LNA', boothNumber: 'old' }] });
  const again = await showContext.runAs('LNA', () => booths.importFromArtwork(STANDS));
  const snapAt = calls.findIndex(c => c[1] === 'booths_snapshots');
  const delAt = calls.findIndex(c => c[0] === 'deleteMany' && c[1] === 'booths');
  check('a snapshot is taken', again.snapshot === true && snapAt > -1);
  check('and taken BEFORE anything is deleted', snapAt > -1 && snapAt < delAt, `snapshot@${snapAt} delete@${delAt}`);

  console.log('\nNothing to import is not an import');
  check('an empty read writes nothing',
        (await showContext.runAs('LNA', () => booths.importFromArtwork([]))).ok === false);

  console.log('\nA stand the plan draws as reserved stays reserved');
  // Without a hold DOCUMENT the expiry sweep finds a held stand nobody is
  // holding and releases it — which is how the four North American stands the
  // plan draws as reserved turned back into empty ones.
  const holdDocs = calls.filter(c => c[0] === 'insertMany' && c[1] === 'holds').map(c => c[2])[0] || [];
  check('a hold document is written for it', holdDocs.length === 1, `${holdDocs.length} written`);
  check('carrying the exhibitor from the plan',
        holdDocs[0] && holdDocs[0].company === 'Reserved Co');
  check('with no expiry, so the sweep leaves it alone',
        holdDocs[0] && holdDocs[0].expiresAt === undefined);
  check('and marked as the import\'s, not a person\'s',
        holdDocs[0] && holdDocs[0].source === 'artwork-import' && holdDocs[0].sessionId === null);

  console.log('\nStands an import itself created never block the next one');
  // An import stores the stands a plan draws as reserved AS held. Counting
  // those as bookings meant the four held stands an import had just created
  // refused every import after it: an event imported wrong could never be
  // corrected.
  calls.length = 0;
  db = fakeDb({ committed: 0, holds: [], booths: [{ showId: 'LNA' }] });
  const again2 = await showContext.runAs('LNA', () => booths.importFromArtwork(STANDS));
  check('a re-import is allowed', again2.ok === true, JSON.stringify(again2.reason));
  check('and the guard asks the holds collection who really reserved something',
        calls.some(c => c[0] === 'distinct' && c[1] === 'holds'));

  console.log('\nA stand someone actually reserved does block it');
  db = fakeDb({ committed: 0, personHolds: ['101'], booths: [{ showId: 'LNA' }] });
  const blocked = await showContext.runAs('LNA', () => booths.importFromArtwork(STANDS));
  check('refused on a real hold', blocked.ok === false && blocked.reason === 'has_bookings',
        JSON.stringify(blocked.reason));

  console.log('\nWhat counts as work an import must not destroy');
  const { commercialFilter } = booths;
  // Matching is asserted against the shape of the filter rather than a live
  // Mongo, so read it as: which of these documents would be counted.
  const f2 = JSON.stringify(commercialFilter());
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

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})();
