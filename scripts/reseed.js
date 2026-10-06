#!/usr/bin/env node
/**
 * Re-seed an event's stands from a fresh extraction (server/data/booth_data.json),
 * carrying everything each stand holds across.
 *
 * A re-extraction renumbers stands, so a plain upsert on boothNumber would
 * leave the old records behind and attach bookings to the wrong stands. This
 * matches old to new by geometry instead: a stand that occupies the same place
 * on the plan is the same stand, whatever number it now has.
 *
 * It used to apply by default — a dry run needed --dry, the opposite of every
 * other script — and only to the default event, with no snapshot and no check
 * on whether the event had sold anything. It deleted the event's stands and
 * rebuilt them carrying six fields: status, company, contact, agreed price,
 * notes and clicks. Tags, country, shown numbers, the sponsored flag and logo,
 * removed flags and every merge and split were lost on the way through. Now:
 *
 *   - it is a dry run until --apply, and --show picks the event;
 *   - every stand that matches is carried WHOLE — every field it has — and
 *     takes only its new number, shape, size and list price from the file;
 *   - it REFUSES what it cannot carry, whatever the flags: a merged or split
 *     stand (its shape is not a rectangle in the file), and any stand holding
 *     a booking or hand-made work that no rectangle in the file matches;
 *   - it refuses an event with committed stands unless --force, like every
 *     script built on lib/run.js;
 *   - the stands it replaces are snapshotted first, and nothing is written if
 *     the snapshot fails. scripts/restore-snapshot.js puts them back.
 *
 *   node scripts/reseed.js                           the mapping, written nowhere
 *   node scripts/reseed.js --show lna                a named event
 *   node scripts/reseed.js --apply --force           apply, on an event that has sold stands
 */
const fs   = require('fs');
const path = require('path');

const { begin, end, close } = require('./lib/run');
const showContext = require('../server/show-context');
const booths = require('../server/models/booths');
const settings = require('../server/models/settings');

const TOL = 3;   // drawing units

const centre = (g) => ({ x: g.x + g.w / 2, y: g.y + g.h / 2 });
const near = (a, b) => Math.abs(a.x - b.x) < TOL && Math.abs(a.y - b.y) < TOL;
const sizeClose = (a, b) => Math.abs(a.w - b.w) < TOL * 4 && Math.abs(a.h - b.h) < TOL * 4;
const numberOf = (f) => String(f.boothId).replace(/^booth-/, '');
const rectOf = (f) => ({ x: f.x, y: f.y, w: f.w, h: f.h });

// A booking, or the record of one.
function hasState(b) {
  const a = b.assignment || {};
  return b.status !== 'available' || !!(a.company || a.contactId || a.actualPrice || a.notes);
}
// Work a person did that the drawing cannot recreate — the same list the
// import guard counts (booths.handworkFilter).
function hasWork(b) {
  const a = b.assignment || {};
  return !!(b.removed === true || b.displayNumber || b.sponsorLogo || b.sponsored === true ||
            b.mergeSnapshot || b.splitSnapshot || b.splitFrom ||
            (Array.isArray(a.tags) && a.tags.length) || a.country);
}
const isComposite = (b) => !!(b.mergeSnapshot || b.splitSnapshot || b.splitFrom);

async function main() {
  const { apply, force, showId, db } = await begin('Re-seed stands from a fresh extraction');

  await showContext.runAs(showId, async () => {
    const col = db.collection('booths');
    const oldBooths = await col.find({ showId }).toArray();
    const fresh = Object.values(JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'server', 'data', 'booth_data.json'), 'utf8')));
    console.log(`  Stored: ${oldBooths.length} stands   Fresh extraction: ${fresh.length} stands`);

    // ── What cannot be carried at all ────────────────────────────────────────
    const composite = oldBooths.filter(isComposite);
    if (composite.length) {
      console.log(`\nREFUSED: ${composite.length} stand(s) were merged or split. Their shapes are not rectangles in`);
      console.log('the file, so they cannot be matched and what they hold cannot be carried. Undo them in the');
      console.log('admin first (Reset on each), or rebuild the plan from an artwork import.');
      for (const b of composite.slice(0, 20)) {
        console.log(`    ${String(b.boothNumber).padEnd(10)} ${String(b.status).padEnd(10)} ${b.assignment?.company || ''}`);
      }
      process.exitCode = 1;
      return;
    }

    // ── Match every stored stand to a fresh one, by position AND size ────────
    // Centre alone is not enough: a resized stand can share a centre with a
    // different new stand. Nearest wins, and each new stand takes at most one
    // old one; the other is left unmatched.
    const byNew = new Map();
    const unmatched = [];
    for (const o of oldBooths) {
      if (!o.geometry) { unmatched.push(o); continue; }
      const oc = centre(o.geometry);
      const best = fresh
        .filter(f => near(centre(rectOf(f)), oc) && sizeClose(o.geometry, f))
        .map(f => ({ f, d: Math.abs(centre(rectOf(f)).x - oc.x) + Math.abs(centre(rectOf(f)).y - oc.y) }))
        .sort((p, q) => p.d - q.d)[0];
      if (!best) { unmatched.push(o); continue; }
      const prev = byNew.get(best.f.boothId);
      if (!prev) { byNew.set(best.f.boothId, { old: o, next: best.f, d: best.d }); continue; }
      const keep = best.d < prev.d ? { old: o, next: best.f, d: best.d } : prev;
      unmatched.push(keep === prev ? o : prev.old);
      byNew.set(best.f.boothId, keep);
    }
    const matches = [...byNew.values()];

    // A stand that holds something and has nowhere to go would lose it.
    const stranded = unmatched.filter(b => hasState(b) || hasWork(b));
    const dropped = unmatched.filter(b => !hasState(b) && !hasWork(b));
    const renumbered = matches.filter(m => m.old.boothNumber !== numberOf(m.next));
    const carrying = matches.filter(m => hasState(m.old) || hasWork(m.old));
    const added = fresh.filter(f => !byNew.has(f.boothId));

    console.log(`  matched by position     : ${matches.length}  (${renumbered.length} renumbered, ${carrying.length} carrying a booking or hand-made work)`);
    console.log(`  new in the file         : ${added.length}  (added as available)`);
    console.log(`  stored, no longer drawn : ${dropped.length}  (nothing on them — removed)`);
    for (const m of carrying) {
      const a = m.old.assignment || {};
      console.log(`    ${String(m.old.boothNumber).padEnd(8)} → ${numberOf(m.next).padEnd(8)} ${String(m.old.status).padEnd(10)} ${a.company || ''}`);
    }

    if (stranded.length) {
      console.log(`\nREFUSED: ${stranded.length} stand(s) hold a booking or hand-made work and match no stand in the file,`);
      console.log('so it would be lost. Move or clear them in the admin first:');
      for (const b of stranded.slice(0, 20)) {
        console.log(`    ${String(b.boothNumber).padEnd(10)} ${String(b.status).padEnd(10)} ${b.assignment?.company || ''}`);
      }
      process.exitCode = 1;
      return;
    }

    // Where every old number goes. A number not in here has gone from the plan,
    // and is dropped rather than kept: after a renumber it could name a
    // different stand that now has it.
    const remap = new Map(matches.map(m => [m.old.boothNumber, numberOf(m.next)]));
    const follow = (list) => list.map(n => remap.get(n)).filter(Boolean);
    const repoint = (h) => remap.has(h.boothNumber) && remap.get(h.boothNumber) !== h.boothNumber;

    const holds = await db.collection('holds').find({ showId }).toArray();
    const leads = await db.collection('inquiries').find({ showId }).toArray();
    const proposals = await db.collection('menus').find({ showId }).toArray();
    const moved = (list) => Array.isArray(list) && list.length &&
                            follow(list).join(',') !== list.join(',');
    console.log(`  holds re-pointed        : ${holds.filter(repoint).length}`);
    console.log(`  leads re-pointed        : ${leads.filter(q => moved(q.boothsOfInterest)).length}`);
    console.log(`  proposals re-pointed    : ${proposals.filter(p => moved(p.boothNumbers)).length}`);

    // On a dry run this is a warning, so the mapping above can be checked
    // before deciding; on --apply it is the refusal.
    const committed = await booths.countCommitted(showId);
    if (committed > 0 && !force) {
      console.log(`\n${apply ? 'REFUSED' : 'NOTE'}: ${committed} stand(s) on this event are sold, held or carry a contact or agreed price.`);
      console.log(`Every one is carried across above — check the list, then ${apply ? 're-run' : 'apply'} with --force to go ahead.`);
      if (apply) { process.exitCode = 1; return; }
    }

    if (!apply) { end(false); return; }

    // ── Snapshot, replace, re-point ──────────────────────────────────────────
    const snap = await booths.snapshot('reseed', oldBooths, { actor: 'reseed', showId });
    if (!snap.ok) {
      console.log(`\nABORTED: the snapshot failed (${snap.error}), so nothing was changed.`);
      process.exitCode = 1;
      return;
    }
    console.log(`\n  snapshot ${snap.snapshotId}  (restore with: node scripts/restore-snapshot.js --id ${snap.snapshotId})`);

    const rate = await settings.rate();
    const now = new Date();
    const fromFile = (f) => ({
      boothNumber: numberOf(f), svgElementId: f.boothId, geometry: rectOf(f),
      sqm: f.sqm, sqmSource: 'estimated', listPrice: Math.round(f.sqm * rate),
    });
    const oldFor = new Map(matches.map(m => [m.next.boothId, m.old]));
    const docs = fresh.map(f => {
      const old = oldFor.get(f.boothId);
      if (old) {
        // The whole stand, every field it has; only what the file is the
        // authority on is replaced.
        const { _id, ...kept } = old;
        return { ...kept, ...fromFile(f), updatedAt: now, updatedBy: 'reseed' };
      }
      return { showId, ...fromFile(f), status: 'available',
               assignment: { company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null },
               clicks: 0, createdAt: now, updatedAt: now, updatedBy: 'reseed' };
    });

    await col.deleteMany({ showId });
    try {
      await col.insertMany(docs);
    } catch (e) {
      console.error(`  insert failed (${e.message}) — putting the previous stands back`);
      await col.deleteMany({ showId });
      if (oldBooths.length) await col.insertMany(oldBooths);
      process.exitCode = 1;
      return;
    }
    console.log(`  ${docs.length} stands written, ${carrying.length} carrying what they held`);

    // A held stand is committed, so it was matched above — every hold has
    // somewhere to go.
    for (const h of holds.filter(repoint)) {
      await db.collection('holds').updateOne({ _id: h._id }, { $set: { boothNumber: remap.get(h.boothNumber) } });
    }
    // Leads and proposals name stands by number too. A number that moved is
    // followed; one whose stand has gone from the plan is dropped.
    for (const q of leads) {
      if (moved(q.boothsOfInterest)) {
        await db.collection('inquiries').updateOne({ _id: q._id }, { $set: { boothsOfInterest: follow(q.boothsOfInterest) } });
      }
    }
    for (const p of proposals) {
      if (moved(p.boothNumbers)) {
        await db.collection('menus').updateOne({ _id: p._id }, { $set: { boothNumbers: follow(p.boothNumbers) } });
      }
    }

    console.log('\n  Activity history is left as it is: it names stands by the numbers they had then.');
    end(true);
  });

  await close();
}

main().catch(e => { console.error('Re-seed failed:', e); process.exit(1); });
