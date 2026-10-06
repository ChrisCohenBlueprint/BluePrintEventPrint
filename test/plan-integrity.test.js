/**
 * The plan's revisions stay one consistent story, whoever writes them and in
 * whatever order.
 *
 * What is asserted here:
 *
 *   named        — the edition is read from the file for an event whose id has
 *                  digits in it (LEX26, LNA28) as well as one whose id has
 *                  none, and another event's file still names nothing.
 *   seeded       — a plan written straight into the live slot (the North
 *                  America seed) is a revision like any other: one live
 *                  revision, never two, and the names keep counting.
 *   one at a time — two adoptions, two uploads or two plans made live at the
 *                  same moment cannot make two live revisions or two drafts
 *                  with one name; the database refuses it as well.
 *   all or nothing — a plan made live, or stands re-read, whose last steps
 *                  fail leaves the stands where they were, not on a drawing
 *                  that has been taken back down.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const { fakeDb } = require('./fake-mongo');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

let db = fakeDb({});
const dbPath = require.resolve('../server/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => db } };

const usersPath = require.resolve('../server/models/users');
require.cache[usersPath] = { id: usersPath, filename: usersPath, loaded: true, exports: {
  findByUsername: async () => ({ username: 'chris', passwordHash: 'x' }),
  verifyPassword: async (pw) => pw === 'pw',
  absorbPassword: async () => {},
} };

const showContext = require('../server/show-context');
const floorplans = require('../server/models/floorplans');
const booths = require('../server/models/booths');
const settings = require('../server/models/settings');
const sockets = require('../server/sockets');
const api = require('../server/routes/api');

const PLAN = fs.readFileSync(path.join(__dirname, 'fixtures', 'plan-to-spec.svg'), 'utf8');
const issue = (n) => PLAN.replace(/<svg\b/, `<!-- issue ${n} --><svg`)
  .replace(/(<svg[^>]*>)/, '$1<style>.a,.b{fill:#ffffff}</style>');
const isIssue = (svg, n) => String(svg || '').includes(`<!-- issue ${n} -->`);
// The same drawing with stand 103 reserved: the taken fill, a red stroke. Its
// import writes a hold document, which is what a failed import must not leave.
const held = (n) => PLAN.replace(/<svg\b/, `<!-- issue ${n} --><svg`)
  .replace(/(<svg[^>]*>)/, '$1<style>.a{fill:#fcdf6d;stroke:#000000}.b{fill:#fcdf6d;stroke:#ed1c24}</style>');

const revs = (show) => (db.store.floorplan_revisions || []).filter(r => r.showId === show);
const liveRevs = (show) => revs(show).filter(r => r.status === 'live');
const slot = (show) => (db.store.floorplans || []).find(f => f.showId === show);
const labels = (show) => revs(show).map(r => r.label);
const unique = (xs) => new Set(xs).size === xs.length;

const stand = (show, n, extra = {}) => ({
  showId: show, boothNumber: n, status: 'available', sqm: 9, listPrice: 5400,
  geometry: { x: 0, y: 0, w: 1, h: 1 },
  assignment: { company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null },
  ...extra,
});
const hall = (show) => (db.store.booths || []).filter(b => b.showId === show)
  .map(b => `${b.boothNumber}:${b.status}:${JSON.stringify(b.geometry)}:${(b.assignment || {}).company || ''}`)
  .sort().join('|');

(async () => {
  console.log('\nThe edition is read from the file, for every kind of event id');
  const ed = floorplans.editionFromFilename;
  check('LEX27_… on an event whose id is LEX26', ed('LEX27_Floorplan_Consolidated.svg', 'LEX26') === 'LEX27',
        String(ed('LEX27_Floorplan_Consolidated.svg', 'LEX26')));
  check('LNA28_… on LNA28', ed('LNA28_Floorplan_v01.svg', 'LNA28') === 'LNA28', String(ed('LNA28_Floorplan_v01.svg', 'LNA28')));
  check('LEX 2028 on LEX_2027', ed('LEX 2028 rev B.svg', 'LEX_2027') === 'LEX2028');
  check('still LEX28 on an event whose id is LEX', ed('LEX28.svg', 'LEX') === 'LEX28');
  check('and still nothing from another event\'s file', ed('LNA27_Floorplan.svg', 'LEX26') === null &&
        ed('LEX27_Floorplan.svg', 'LNA28') === null);
  check('nor from a file for a different event that shares the letters', ed('LEX27.svg', 'LEX-ASIA') === null);

  db = fakeDb({ floorplans: [{ showId: 'LEX26', svg: issue(0), filename: 'LEX27_Floorplan_Consolidated.svg', bytes: 1, version: 'v0' }] });
  await showContext.runAs('LEX26', async () => {
    const f = await floorplans.adopt();
    check('a plan already live on LEX26 is adopted as LEX27', f.label === 'LEX27', f.label);
    const d = await floorplans.createDraft(issue(1), { filename: 'LEX27_Floorplan_v02.svg' });
    check('and its re-issue is LEX27.1, not LEX26.1', d.revision.label === 'LEX27.1', d.revision.label);
  });

  console.log('\nA plan written straight to the live slot is a revision like any other');
  db = fakeDb({ floorplans: [{ showId: 'LNA', svg: issue(0), filename: 'LNA27_Floorplan_Web Format_24.svg', bytes: 1, version: 'v0' }] });
  await showContext.runAs('LNA', async () => {
    await floorplans.adopt();
    const saved = await floorplans.save(issue(1), { filename: 'LNA27_Floorplan_Web Format_24.svg', actor: 'deploy' });
    check('saved', saved.ok && isIssue(slot('LNA').svg, 1));
    check('the live slot names the revision it holds', !!slot('LNA').revisionId &&
          slot('LNA').revisionId === (liveRevs('LNA')[0] || {}).revisionId);
    check('exactly one revision is live', liveRevs('LNA').length === 1, revs('LNA').map(r => `${r.label}:${r.status}`).join(' '));
    check('the plan it replaced is superseded, kept', revs('LNA').some(r => r.label === 'LNA27' && r.status === 'superseded'));
    check('and the new one is LNA27.1', slot('LNA').label === 'LNA27.1', slot('LNA').label);
    await floorplans.adopt();
    check('the next adoption makes no second live revision', liveRevs('LNA').length === 1 && revs('LNA').length === 2);
    const back = await floorplans.makeLive(revs('LNA').find(r => r.label === 'LNA27').revisionId);
    check('"Make live again" on the old plan works', back.ok && !back.unchanged && isIssue(slot('LNA').svg, 0));
    check('still one live revision', liveRevs('LNA').length === 1 && liveRevs('LNA')[0].label === 'LNA27');
    check('the save hands back what was live, so a caller can put it back', !!saved.previous && saved.previous.live &&
          isIssue(saved.previous.live.svg, 0));
  });

  // A database the old save() already wrote to: a revision still marked live
  // while the slot names none.
  db = fakeDb({
    floorplans: [{ showId: 'LNA', svg: issue(2), filename: 'LNA27_Floorplan.svg', bytes: 1, version: 'v2' }],
    floorplan_revisions: [
      { showId: 'LNA', revisionId: 'a', seq: 1, edition: 'LNA27', point: 0, label: 'LNA27', status: 'superseded', svg: issue(0) },
      { showId: 'LNA', revisionId: 'b', seq: 2, edition: 'LNA27', point: 2, label: 'LNA27.2', status: 'live', svg: issue(1) },
      { showId: 'LNA', revisionId: 'c', seq: 3, edition: 'LNA27', point: 1, label: 'LNA27.1', status: 'discarded', svg: issue(1) },
    ],
  });
  await showContext.runAs('LNA', async () => {
    const f = await floorplans.adopt();
    check('a revision left marked live by the old seed is superseded on adoption', liveRevs('LNA').length === 1 &&
          liveRevs('LNA')[0].revisionId === f.revisionId, revs('LNA').map(r => `${r.label}:${r.status}`).join(' '));
    check('and the name counts on from the highest point in the edition, not the newest row',
          f.label === 'LNA27.3' && unique(labels('LNA')), labels('LNA').join(','));
  });

  console.log('\nOne at a time');
  db = fakeDb({ floorplans: [{ showId: 'LNA', svg: issue(0), filename: 'LNA27.svg', bytes: 1, version: 'v0' }] });
  await showContext.runAs('LNA', async () => {
    await Promise.all([floorplans.adopt(), floorplans.adopt(), floorplans.listRevisions()]);
    check('three adoptions at once make one revision', revs('LNA').length === 1 && liveRevs('LNA').length === 1,
          revs('LNA').map(r => `${r.label}:${r.status}`).join(' '));

    const [a, b] = await Promise.all([floorplans.createDraft(issue(1), { filename: 'LNA27.svg' }),
                                      floorplans.createDraft(issue(2), { filename: 'LNA27.svg' })]);
    check('two uploads at once get two names', a.revision.label !== b.revision.label && unique(labels('LNA')),
          `${a.revision.label} / ${b.revision.label}`);
    check('and leave one draft', revs('LNA').filter(r => r.status === 'draft').length === 1);

    await Promise.all([floorplans.makeLive(a.revision.revisionId), floorplans.makeLive(b.revision.revisionId)]);
    check('two plans made live at once leave one live revision', liveRevs('LNA').length === 1,
          revs('LNA').map(r => `${r.label}:${r.status}`).join(' '));
    check('and it is the one in the live slot', slot('LNA').revisionId === liveRevs('LNA')[0].revisionId);

    const order = [];
    const slow = (tag) => async () => { order.push(`${tag}+`); await new Promise(r => setTimeout(r, 5)); order.push(`${tag}-`); };
    await Promise.all([floorplans.withPlanLock('LNA', slow('x')), floorplans.withPlanLock('LNA', slow('y')),
                       floorplans.withPlanLock('LEX', slow('other'))]);
    check('the lock runs one event\'s work in turn', order.indexOf('x-') < order.indexOf('y+'), order.join(' '));
    check('and leaves another event free', order.indexOf('other+') < order.indexOf('x-'), order.join(' '));
    const nested = await floorplans.withPlanLock('LNA', () => floorplans.withPlanLock('LNA', async () => 'inner'));
    check('and can be taken again by work already holding it', nested === 'inner');
    let failed = false;
    await floorplans.withPlanLock('LNA', async () => { throw new Error('boom'); }).catch(() => { failed = true; });
    check('a failure inside lets the next one through', failed && await floorplans.withPlanLock('LNA', async () => 'next') === 'next');
  });

  // The database as the backstop: a name used twice, or two live revisions,
  // is refused — and an index that cannot be built (old duplicates) is
  // reported, not thrown, so it cannot stop the site starting.
  const made = [];
  const plain = db.collection;
  db.collection = (name) => {
    const c = plain(name);
    c.createIndex = async (key, opts) => {
      made.push({ name, key, opts });
      if (opts && opts.unique && key.label && process.env.__BREAK_INDEX) throw new Error('E11000 duplicate key');
      return opts && opts.name;
    };
    return c;
  };
  await floorplans.ensureRevisionIndexes();
  const lbl = made.find(m => m.name === 'floorplan_revisions' && m.key.label);
  check('a revision\'s name is unique within its event', lbl && lbl.opts.unique === true && lbl.key.showId === 1);
  const one = made.find(m => m.name === 'floorplan_revisions' && m.opts && m.opts.partialFilterExpression);
  check('and only one revision per event can be live', one && one.opts.unique === true &&
        one.opts.partialFilterExpression.status === 'live');
  process.env.__BREAK_INDEX = '1';
  let threw = false;
  try { await floorplans.ensureRevisionIndexes(); } catch { threw = true; }
  delete process.env.__BREAK_INDEX;
  check('an index the data will not allow is reported, never thrown', !threw);
  db.collection = plain;

  console.log('\nAll or nothing, after the stands have moved');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.admin = { user: 'chris' }; showContext.runAs('LEX', next); });
  app.use('/api', api);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (p, opts = {}) => {
    const res = await fetch(base + p, opts);
    let body = null; try { body = await res.json(); } catch { /* none */ }
    return { status: res.status, body };
  };
  const publish = (id, q = '') => call(`/floorplan/revisions/${id}/publish${q}`,
    { method: 'POST', headers: { 'X-Confirm-Password': 'pw' } });
  const reread = (q = '') => call(`/stands/import${q}`, { method: 'POST', headers: { 'X-Confirm-Password': 'pw' } });

  const realSetUnit = settings.setUnit;
  const realNotify = sockets.notifyStands;
  let notified = 0;
  sockets.notifyStands = async () => { notified++; };
  const failUnit = () => { settings.setUnit = async () => { throw new Error('write refused'); }; };
  const okUnit = () => { settings.setUnit = realSetUnit; };

  const fresh = () => {
    db = fakeDb({
      floorplans: [{ showId: 'LEX', svg: issue(0), filename: 'LEX27.svg', bytes: 1, version: 'v0' }],
      booths: [stand('LEX', '101', { status: 'sold', updatedBy: 'chris',
                 assignment: { company: 'Real Exhibitor Ltd', contactId: 'c1', actualPrice: 5000, notes: '', tags: [], country: 'DE' } }),
               stand('LEX', '102')],
      settings: [{ _id: 'LEX', unit: 'm', ratePerSqm: 600 }],
    });
  };

  try {
    fresh();
    const draft = await showContext.runAs('LEX', () => floorplans.createDraft(held(1), { filename: 'LEX27.svg' }));
    const before = hall('LEX');
    failUnit(); notified = 0;
    let r = await publish(draft.revision.revisionId, '?mode=update');
    okUnit();
    check('a publish whose last steps fail is refused', r.status === 500 && /was not made live/.test(r.body.error),
          `${r.status} ${r.body && r.body.error}`);
    check('the stands are back where they were', hall('LEX') === before, hall('LEX'));
    check('the sale on them untouched', (db.store.booths.find(b => b.boothNumber === '101') || {}).status === 'sold');
    check('the plan before it is live again', isIssue(slot('LEX').svg, 0) &&
          revs('LEX').find(x => x.revisionId === draft.revision.revisionId).status === 'draft');
    check('and open pages were told the stands changed back', notified > 0);
    check('no import hold is left on a stand that is not held',
          (db.store.holds || []).every(h => (db.store.booths.find(b => b.boothNumber === h.boothNumber) || {}).status === 'held'),
          JSON.stringify((db.store.holds || []).map(h => h.boothNumber)));

    r = await publish(draft.revision.revisionId, '?mode=update');
    check('with the step fixed, the same publish goes through', r.status === 200 && isIssue(slot('LEX').svg, 1),
          JSON.stringify(r.body && (r.body.error || r.body.mode)));
    check('and the reserved stand it draws is held, with its hold',
          (db.store.booths.find(b => b.boothNumber === '103') || {}).status === 'held' &&
          (db.store.holds || []).some(h => h.boothNumber === '103'));

    const settled = hall('LEX');
    failUnit(); notified = 0;
    r = await reread('?mode=update');
    okUnit();
    check('re-reading the stands, failing at the end, says so', r.status === 500, `${r.status} ${r.body && r.body.error}`);
    check('and leaves them as they were', hall('LEX') === settled);
    check('with open pages told', notified > 0);

    // A hall with nothing in it before the import has no snapshot to go back
    // to: going back means the stands the import made are taken away again.
    db = fakeDb({ floorplans: [{ showId: 'LEX', svg: issue(0), filename: 'LEX27.svg', bytes: 1, version: 'v0' }],
                  settings: [{ _id: 'LEX', unit: 'm', ratePerSqm: 600 }] });
    failUnit();
    r = await reread();
    okUnit();
    check('an empty hall whose first read fails is left empty', r.status === 500 && hall('LEX') === '', hall('LEX'));

    // And when the stands cannot be put back, the drawing they are now on
    // stays live with them, and the hall before is kept as a point to go back to.
    fresh();
    const d2 = await showContext.runAs('LEX', () => floorplans.createDraft(issue(3), { filename: 'LEX27.svg' }));
    const realRestore = booths.restoreSnapshot;
    booths.restoreSnapshot = async () => ({ ok: false, reason: 'snapshot_failed' });
    failUnit();
    r = await publish(d2.revision.revisionId, '?mode=update');
    okUnit(); booths.restoreSnapshot = realRestore;
    check('stands that cannot be put back keep the plan they are on', r.status === 500 && isIssue(slot('LEX').svg, 3),
          `${r.status} ${r.body && r.body.error}`);
    const points = (db.store.booths_snapshots || []).filter(s => s.header && s.history && s.op === 'publish');
    check('and the hall before it is a point in the history', points.length === 1, String(points.length));

    // An import that fails before it has written anything: nothing to put
    // back, so the plan before goes back and nothing is stranded.
    fresh();
    const d3 = await showContext.runAs('LEX', () => floorplans.createDraft(issue(6), { filename: 'LEX27.svg' }));
    const untouched = hall('LEX');
    const realImport0 = booths.importFromArtwork;
    booths.importFromArtwork = async () => { throw new Error('connection reset'); };
    r = await publish(d3.revision.revisionId, '?mode=update');
    booths.importFromArtwork = realImport0;
    check('an import that fails before writing puts the plan back and changes nothing',
          r.status === 500 && /was not made live/.test(r.body.error) && isIssue(slot('LEX').svg, 0) &&
          hall('LEX') === untouched, `${r.status} ${r.body && r.body.error}`);

    console.log('\nTwo plans made live from the console at the same moment');
    fresh();
    const x = await showContext.runAs('LEX', () => floorplans.createDraft(issue(4), { filename: 'LEX27.svg' }));
    const y = await showContext.runAs('LEX', () => floorplans.createDraft(issue(5), { filename: 'LEX27.svg' }));
    // The first import is slow, as a real one on a full hall is, so the second
    // request arrives while the first is still reading its stands.
    const realImport = booths.importFromArtwork;
    let slowOnce = true;
    booths.importFromArtwork = async (...a) => {
      if (slowOnce) { slowOnce = false; await new Promise(r => setTimeout(r, 40)); }
      return realImport(...a);
    };
    const first = publish(x.revision.revisionId, '?mode=update');
    await new Promise(r => setTimeout(r, 15));
    const [rx, ry] = await Promise.all([first, publish(y.revision.revisionId, '?mode=update')])
      .finally(() => { booths.importFromArtwork = realImport; });
    check('both are answered', rx.status === 200 && ry.status === 200, `${rx.status} ${ry.status}`);
    check('one revision is live, and it is the one in the live slot', liveRevs('LEX').length === 1 &&
          slot('LEX').revisionId === liveRevs('LEX')[0].revisionId,
          revs('LEX').map(v => `${v.label}:${v.status}`).join(' '));
    // In turn: the first finishes — its stands read, its display copy written —
    // before the second goes into the live slot at all.
    const slotWrites = db.calls.filter(c => c[0] === 'updateOne' && c[1] === 'floorplans')
      .map(c => (c[3].$set && c[3].$set.svg ? 'live' : c[3].$set && c[3].$set.displaySvg ? 'display' : 'other'));
    const firstLive = slotWrites.indexOf('live'), secondLive = slotWrites.indexOf('live', firstLive + 1);
    check('each made live in turn, the first finished before the second began',
          secondLive > firstLive && slotWrites.slice(firstLive, secondLive).includes('display'), slotWrites.join(' '));
  } finally {
    settings.setUnit = realSetUnit;
    sockets.notifyStands = realNotify;
    server.close();
  }

  console.log('\nThe North America seed, refused, leaves the plan it found');
  // The script, run for real against stand-ins for the runner (which would
  // connect to a database) and for the seed itself (which restores the plan
  // and is then refused the import, as it is on any event that is selling).
  db = fakeDb({
    shows: [{ slug: 'lex', showId: 'LEX', active: true, order: 0 }, { slug: 'lna', showId: 'LNA', active: true, order: 1 }],
    floorplans: [{ showId: 'LNA', svg: issue(7), filename: 'LNA27_Floorplan.svg', bytes: 1, version: 'v7' }],
  });
  await require('../server/models/shows').refresh();
  const header = [];
  let closed;
  const done = new Promise(r => { closed = r; });
  const stub = (rel, exports) => {
    const p = require.resolve(rel);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  };
  stub('../scripts/lib/run', {
    begin: async (name) => {
      const i = process.argv.indexOf('--show');
      header.push({ name, show: i > -1 ? process.argv[i + 1] : null });
      return { apply: true, force: false, showId: 'LNA' };
    },
    end: () => {},
    close: async () => { closed(); },
  });
  stub('../server/services/seed-artwork', {
    SLUG: 'lna',
    seedNorthAmerica: async () => {
      await showContext.runAs('LNA', () => floorplans.save(issue(8), { filename: 'LNA27_Floorplan_Web Format_24.svg', actor: 'deploy' }));
      return { ok: false, importRefused: 'has_bookings', artworkRestored: true, namesNow: 0, namesShipped: 78,
               planNeedsRestoring: true, sellable: 93, areas: 6, got: {}, want: {}, standsDiffer: true,
               committed: 70, customised: 0, warnings: [] };
    },
  });
  const log = console.log;
  const said = [];
  console.log = (...a) => { said.push(a.join(' ')); };
  try {
    require('../scripts/seed-north-america');
    await done;
  } finally { console.log = log; }
  check('the header names North America, the event it acts on', header[0] && header[0].show === 'lna',
        JSON.stringify(header));
  check('the plan that was live is live again', isIssue(slot('LNA').svg, 7) && liveRevs('LNA').length === 1 &&
        liveRevs('LNA')[0].revisionId === slot('LNA').revisionId,
        revs('LNA').map(v => `${v.label}:${v.status}`).join(' '));
  check('the restored drawing is kept, not live', revs('LNA').some(v => isIssue(v.svg, 8) && v.status === 'superseded'));
  check('and the person running it is told so', said.some(l => /REFUSED/.test(l) && /live again/.test(l)),
        said.filter(l => /REFUSED/.test(l)).join(' '));

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
