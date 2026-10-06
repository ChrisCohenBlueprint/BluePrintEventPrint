/**
 * Every plan an event is given is kept, named, and goes live only when asked.
 *
 * The live slot held one plan and every upload overwrote it: a re-issued
 * drawing went straight onto the public page, before anyone had read what it
 * did to the stands under it, and the plan it replaced was gone. Now an upload
 * is a draft revision (LEX27 → LEX27.1), the public link keeps showing the
 * live one, and making a revision live is a separate, password-gated step that
 * moves the stands onto it in the same breath.
 *
 * What is asserted here:
 *
 *   named          — the edition comes from the file (LEX27_…svg), each
 *                    re-issue adds a point, and another event's file cannot
 *                    rename this one's plans.
 *   draft first    — an upload leaves the live plan, and so the public page,
 *                    untouched.
 *   all or nothing — a revision whose stands cannot be read is not left live:
 *                    the plan before it goes straight back.
 *   one way back   — the history point written when a plan goes live names
 *                    the plan it replaced, so going back restores the drawing
 *                    together with the stands that sat on it.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const { fakeDb } = require('./fake-mongo');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const SHOW = 'LEX';
const PLAN = fs.readFileSync(path.join(__dirname, 'fixtures', 'plan-to-spec.svg'), 'utf8');
// The same drawing, told apart by a comment: what matters here is WHICH plan
// is live, not what is drawn on it.
// Flat fills on the stands, so the reader can tell what is sold (BEC-FP-01).
const issue = (n) => PLAN.replace(/<svg\b/, `<!-- issue ${n} --><svg`)
  .replace(/(<svg[^>]*>)/, '$1<style>.a,.b{fill:#ffffff}</style>');
const isIssue = (svg, n) => String(svg || '').includes(`<!-- issue ${n} -->`);

const stand = (n, extra = {}) => ({
  showId: SHOW, boothNumber: n, status: 'available', sqm: 9, listPrice: 5400,
  geometry: { x: 0, y: 0, w: 1, h: 1 },
  assignment: { company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null },
  ...extra,
});

let db = fakeDb({
  // A plan uploaded before revisions existed, under the office's own name.
  floorplans: [{ showId: SHOW, svg: issue(0), filename: 'LEX27_Floorplan_Consolidated.svg',
                 bytes: 1, version: 'v0', uploadedAt: new Date('2026-09-01'), uploadedBy: 'chris' }],
  booths: [
    stand('101', { status: 'sold', updatedBy: 'chris',
      assignment: { company: 'Real Exhibitor Ltd', contactId: 'c1', actualPrice: 5000, notes: 'signed', tags: [], country: 'DE' } }),
    stand('102'),
  ],
  settings: [{ _id: SHOW, unit: 'm', ratePerSqm: 600 }],
});
const dbPath = require.resolve('../server/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => db } };

// The password gate, stood in for: "pw" is right, anything else is wrong.
const usersPath = require.resolve('../server/models/users');
require.cache[usersPath] = { id: usersPath, filename: usersPath, loaded: true, exports: {
  findByUsername: async () => ({ username: 'chris', passwordHash: 'x' }),
  verifyPassword: async (pw) => pw === 'pw',
  absorbPassword: async () => {},
} };

const showContext = require('../server/show-context');
const floorplans = require('../server/models/floorplans');
const booths = require('../server/models/booths');
const api = require('../server/routes/api');

const run = (fn) => showContext.runAs(SHOW, fn);
const live = () => db.store.floorplans.find(f => f.showId === SHOW);
const rev = (label) => (db.store.floorplan_revisions || []).find(r => r.label === label);
const tick = () => new Promise(r => setTimeout(r, 3));

(async () => {
  console.log('\nNames');
  check('LEX27 from the office\'s file name', floorplans.editionFromFilename('LEX27_Floorplan_Consolidated.svg', 'LEX') === 'LEX27');
  check('with a space or a dash too', floorplans.editionFromFilename('LEX 27 rev B.svg', 'LEX') === 'LEX27' &&
                                      floorplans.editionFromFilename('lex-2027.svg', 'LEX') === 'LEX2027');
  check('but not North America\'s file uploaded to Europe',
        floorplans.editionFromFilename('LNA27_Floorplan_Web-Format_24.svg', 'LEX') === null);
  check('and not a file that names no edition', floorplans.editionFromFilename('floorplan-final.svg', 'LEX') === null);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.admin = { user: 'chris' }; showContext.runAs(SHOW, next); });
  app.use('/api', api);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (p, opts = {}) => {
    const res = await fetch(base + p, opts);
    let body = null; try { body = await res.json(); } catch { /* svg */ }
    return { status: res.status, body };
  };
  const upload = (svg, filename) => call('/floorplan', { method: 'POST', body: svg,
    headers: { 'Content-Type': 'image/svg+xml', 'X-Filename': filename, 'X-Confirm-Password': 'pw' } });
  const publish = (id, q = '', pw = 'pw') => call(`/floorplan/revisions/${id}/publish${q}`,
    { method: 'POST', headers: { 'X-Confirm-Password': pw } });

  try {
    console.log('\nThe plan already live is adopted as the first revision');
    let list = (await call('/floorplan/revisions')).body;
    check('one revision, live, named LEX27', list.length === 1 && list[0].label === 'LEX27' && list[0].status === 'live',
          JSON.stringify(list.map(r => [r.label, r.status])));
    check('the live slot knows which revision it holds', live().revisionId === list[0].revisionId && live().label === 'LEX27');

    console.log('\nAn upload is a draft, and the public plan does not move');
    let up = await upload(issue(1), 'LEX27_Floorplan_Consolidated_rev2.svg');
    check('stored as LEX27.1, a draft', up.status === 200 && up.body.draft && up.body.revision.label === 'LEX27.1' &&
          up.body.revision.status === 'draft', JSON.stringify(up.body && up.body.revision));
    check('the live plan is still the first one', isIssue(live().svg, 0) && live().revisionId === rev('LEX27').revisionId);
    const pub = await run(() => floorplans.get());
    check('so the public page still serves it', isIssue(pub.displaySvg || pub.svg, 0));

    const preview = await call(`/stands/preview?revision=${up.body.revision.revisionId}`);
    check('the draft can be read against the stands before it is live',
          preview.status === 200 && preview.body.ok && preview.body.existing === 2 && !!preview.body.diff,
          JSON.stringify(preview.body && preview.body.diff && preview.body.diff.summary));

    const svgRes = await fetch(`${base}/floorplan/revisions/${up.body.revision.revisionId}/svg`);
    check('and its drawing previewed', svgRes.status === 200 && isIssue(await svgRes.text(), 1));

    console.log('\nA second upload sets the first draft aside, kept');
    await tick();
    up = await upload(issue(2), 'LEX27 updated.svg');
    check('the new one is LEX27.2', up.body.revision.label === 'LEX27.2', up.body.revision.label);
    check('LEX27.1 is discarded but still there', rev('LEX27.1') && rev('LEX27.1').status === 'discarded');
    const draftId = up.body.revision.revisionId;

    console.log('\nMaking it live is all or nothing');
    let r = await publish(draftId, '', 'wrong');
    check('a wrong password changes nothing', r.status === 403 && isIssue(live().svg, 0));
    // The event has a real sale on it, so a plain re-read is refused.
    r = await publish(draftId);
    check('refused when the stands cannot be read in the mode asked for', r.status === 409 && r.body.reason === 'has_bookings',
          `${r.status} ${r.body && r.body.reason}`);
    check('and says the plan was not made live', /LEX27\.2 was not made live/.test(r.body.error), r.body.error);
    check('the previous plan is back in the live slot', isIssue(live().svg, 0) && live().revisionId === rev('LEX27').revisionId);
    check('still live, and the draft still a draft', rev('LEX27').status === 'live' && rev('LEX27.2').status === 'draft',
          `${rev('LEX27').status} / ${rev('LEX27.2').status}`);

    const before = db.store.booths.map(b => b.boothNumber).sort().join(',');
    await tick();
    r = await publish(draftId, '?mode=update');
    check('made live with the update that keeps bookings', r.status === 200 && r.body.ok && r.body.revision.label === 'LEX27.2',
          JSON.stringify(r.body && (r.body.error || r.body.mode)));
    check('the live slot holds it', isIssue(live().svg, 2) && live().label === 'LEX27.2');
    check('the one before is superseded, kept', rev('LEX27').status === 'superseded' && isIssue(rev('LEX27').svg, 0));
    const sold = db.store.booths.find(b => b.boothNumber === '101');
    check('the sale is untouched', sold && sold.status === 'sold' && sold.assignment.company === 'Real Exhibitor Ltd');
    check('the stands now follow the new plan', db.store.booths.map(b => b.boothNumber).sort().join(',') !== before,
          db.store.booths.map(b => b.boothNumber).sort().join(','));
    check('already live cannot be made live again', (await publish(draftId, '?mode=update')).status === 409);

    console.log('\nThe printed names come out of the copy shown, and stay with the revision');
    check('the live display copy has been made', !!live().displaySvg);
    check('and is kept on LEX27.2 itself', rev('LEX27.2').displaySvg === live().displaySvg);

    console.log('\nGoing back puts the drawing back too');
    const h = (await call('/history')).body;
    const point = h.find(p => p.op === 'publish');
    check('making a plan live left a point', !!point, JSON.stringify(h.map(p => p.op)));
    check('naming the plan the stands sat on before', point && point.revisionLabel === 'LEX27', point && point.revisionLabel);

    const dry = await call(`/history/${point.id}/restore`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    check('the dry run says the plan goes back to LEX27', dry.body.artwork && dry.body.artwork.label === 'LEX27',
          JSON.stringify(dry.body.artwork));
    check('without doing it', isIssue(live().svg, 2));

    const wet = await call(`/history/${point.id}/restore`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Confirm-Password': 'pw' }, body: JSON.stringify({ apply: true }) });
    check('applied', wet.status === 200 && wet.body.ok, JSON.stringify(wet.body));
    check('LEX27 is live again', isIssue(live().svg, 0) && rev('LEX27').status === 'live' && rev('LEX27.2').status === 'superseded');
    check('with the stands it had', db.store.booths.map(b => b.boothNumber).sort().join(',') === before,
          db.store.booths.map(b => b.boothNumber).sort().join(','));

    const back = (await call('/history')).body.find(p => p.op === 'restore');
    check('and that is itself a point, on LEX27.2', back && back.revisionLabel === 'LEX27.2', back && back.revisionLabel);

    console.log('\nA draft can be set aside');
    up = await upload(issue(3), 'LEX27.svg');
    check('numbered on from the highest point used', up.body.revision.label === 'LEX27.3', up.body.revision.label);
    r = await call(`/floorplan/revisions/${up.body.revision.revisionId}/discard`, { method: 'POST' });
    check('discarded', r.status === 200 && rev('LEX27.3').status === 'discarded');
    r = await call(`/floorplan/revisions/${rev('LEX27').revisionId}/discard`, { method: 'POST' });
    check('but a plan that has been live cannot be', r.status === 409);
    check('and the live plan never moved', isIssue(live().svg, 0));

    console.log('\nAnother event\'s plans are not this one\'s');
    const other = await showContext.runAs('LNA', () => floorplans.listRevisions());
    check('LNA lists none of them', other.length === 0, other.map(x => x.label).join(','));
  } finally {
    server.close();
  }

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
