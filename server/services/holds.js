const { getDb } = require('../db');
const showContext = require('../show-context');
const showsModel = require('../models/shows');
const config    = require('../config');
const booths    = require('../models/booths');
const { track } = require('./tracking');

const col = () => getDb().collection('holds');

/**
 * One live hold per stand.
 *
 * Nothing structural stopped two hold documents existing for the same stand, so
 * a forced hold racing an ordinary one left both, and releasing the stand only
 * cleared what the caller happened to know about. Partial, so it constrains the
 * holds that exist without saying anything about stands that have none.
 *
 * db.js already creates a NON-unique index on the same keys at connect time; if
 * it is still there this call is refused as a conflicting definition, which is
 * reported rather than thrown so it can never take a boot down. Dropping the
 * old one is a migration, not a startup task.
 */
async function ensureIndexes() {
  try {
    return { ok: true, index: await col().createIndex(
      { showId: 1, boothNumber: 1 },
      { unique: true, name: 'hold_one_per_booth' }) };
  } catch (e) {
    return { ok: false, name: 'hold_one_per_booth', error: e.message };
  }
}

/**
 * Place a hold with a real expiry.
 *
 * Two mechanisms work together:
 *   1. A TTL index on expiresAt — Mongo deletes the hold document itself.
 *   2. The reconciliation sweep below — flips the booth back to available.
 *
 * The sweep, rather than a change stream, is deliberate. Change streams require
 * a replica set and drop events while the process is down, which would strand a
 * booth on 'held' permanently. The sweep re-derives truth from the data on every
 * tick, so it self-heals regardless of what was missed.
 */
async function create({ boothNumber, company, contactId = null, sessionId = null,
                        durationMs = config.defaultHoldMs, actor = null }) {
  const booth = await booths.get(boothNumber);
  if (!booth) return { ok: false, reason: 'no_such_booth' };
  if (booth.status !== 'available') return { ok: false, reason: 'not_available' };

  const now       = new Date();
  const expiresAt = new Date(now.getTime() + durationMs);

  // Flip the booth to 'held' ONLY if it is still available — the status read
  // above is a TOCTOU window. Without this precondition a hold landing at the
  // same moment as a booking (booth:book) would unconditionally flip the just-
  // sold stand back to 'held' and overwrite the exhibitor, silently erasing the
  // sale (the same race booth:book itself is already guarded against).
  //
  // The expiry goes on the BOOTH in this same write, not only into the hold
  // document. That is what makes the sweep's release a single conditional
  // write it can lose cleanly — see reconcile().
  const r = await booths.setStatus(boothNumber, 'held',
    { company, actor, expect: ['available'], holdExpiresAt: expiresAt });
  if (!r || !r.changed) return { ok: false, reason: 'not_available' };

  // Only write the hold document once the status flip has actually claimed the
  // stand, so we never leave a hold doc on a stand we didn't hold.
  await col().insertOne({
    showId: config.showId, boothNumber, company, contactId, sessionId,
    createdAt: now, expiresAt, createdBy: actor,
  });
  track({ type: 'hold.create', boothNumber, meta: { company, expiresAt }, sessionId, actor });

  return { ok: true, expiresAt };
}

/** Delete hold documents without touching booth status. */
const drop = (boothNumber) => col().deleteMany({ showId: config.showId, boothNumber });

/**
 * Write a hold document unconditionally — used by the admin force-status path,
 * which may put a stand on hold regardless of its current status. create()
 * refuses unless the stand is available, so relying on it there left the stand
 * 'held' with no hold document, and the expiry sweep reclaimed it within a
 * minute. This always leaves a matching document behind.
 */
async function forceHold(boothNumber, { company = 'Pending', durationMs = config.defaultHoldMs, actor = null } = {}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + durationMs);
  // The booth's own expiry is pushed into the future BEFORE anything else.
  // A sweep already mid-flight has read its candidates and is about to write;
  // its release is conditional on the booth's expiry still being past, so this
  // one write is what makes it miss. The old order — drop, insert, then let the
  // caller set the status — left a gap in which the sweep flipped the stand
  // back to available and abandoned the hold document that had just been
  // written for it.
  await booths.col().updateOne(
    { showId: config.showId, boothNumber },
    { $set: { holdExpiresAt: expiresAt } });
  await drop(boothNumber);
  await col().insertOne({ showId: config.showId, boothNumber, company, contactId: null,
                          sessionId: null, createdAt: now, expiresAt, createdBy: actor });
  track({ type: 'hold.create', boothNumber, meta: { company, expiresAt, forced: true }, actor });
  return { ok: true, expiresAt };
}

async function release(boothNumber, { actor = null } = {}) {
  await drop(boothNumber);
  // Release frees a held OR sold stand back to available (blanking the exhibitor
  // and clearing the deal). The admin action is password-gated in the socket
  // handler, so an accidental click can't silently drop a sale.
  await booths.setStatus(boothNumber, 'available', { company: null, actor, expect: ['held', 'sold'] });
  track({ type: 'hold.release', boothNumber, meta: {}, actor });
}

const active = () => col().find({ showId: config.showId }).sort({ expiresAt: 1 }).toArray();

/**
 * Release any booth whose hold has run out, or that is marked 'held' with no
 * live hold document behind it. Returns the booth numbers that were freed so
 * callers can broadcast.
 *
 * THE RACE THIS IS SHAPED AROUND. The sweep reads, decides, then writes, and an
 * admin can force a hold onto a stand in between. The old release was
 * conditional on nothing more than `status: 'held'` — which a stand someone had
 * just re-held still is — so the sweep flipped a live, forced hold to available
 * and left its brand-new hold document behind with nothing holding it.
 *
 * The fix is to make the condition say what the sweep actually decided: this
 * stand's hold had expired WHEN I LOOKED. The expiry is therefore denormalised
 * onto the booth, and create()/forceHold() write it there atomically with the
 * claim, so a hold placed in the gap moves the booth's expiry into the future
 * and the conditional write simply does not match. Three states, deliberately:
 *
 *   a date  — a countdown hold; expired once it is past
 *   null    — held with no expiry (the plan itself says so); never swept
 *   absent  — a stand held before this field existed, or by a path that did not
 *             set it; decided from the hold documents, as it always was
 *
 * The hold documents are then deleted BY THE _id VALUES READ AT THE TOP, never
 * by a time window: a document written after the read has an id we never saw,
 * so it cannot be caught by the deletion of the ones we did.
 */
async function reconcile() {
  const showId = config.showId;
  const now = new Date();

  const held = await booths.col()
    .find({ showId, status: 'held' })
    .project({ boothNumber: 1, holdExpiresAt: 1 })
    .toArray();
  if (!held.length) return [];

  // expiresAt MUST be projected: liveness is decided from it, and projecting it
  // away left every value undefined — so an expired-but-unreaped hold read as
  // live and the booth stayed held until Mongo's TTL reaper happened to delete
  // the document. _id is what the deletion below is keyed on.
  const docs = await col()
    .find({ showId, boothNumber: { $in: held.map(b => b.boothNumber) } })
    .project({ _id: 1, boothNumber: 1, expiresAt: 1 })
    .toArray();

  // A hold document past its expiry counts as gone even if Mongo's TTL reaper
  // has not removed it yet. Treating it as live would leave the booth held and
  // unsellable for as long as the reaper lagged.
  const liveSet = new Set(docs.filter(h => !h.expiresAt || h.expiresAt > now).map(h => h.boothNumber));
  const idsFor = (n) => docs.filter(h => h.boothNumber === n).map(h => h._id);

  const expired = [];
  for (const b of held) {
    // A hold the plan itself declares, with no expiry: never ours to reclaim.
    if (b.holdExpiresAt === null) continue;

    // The filter is the sweep's own finding, written down. Whichever branch we
    // are in, a hold placed between the read above and the write below has
    // changed the booth out from under it and the update matches nothing.
    const filter = { showId, boothNumber: b.boothNumber, status: 'held' };
    if (b.holdExpiresAt instanceof Date) {
      if (b.holdExpiresAt > now) continue;               // still running
      filter.holdExpiresAt = { $lte: now };
    } else {
      if (liveSet.has(b.boothNumber)) continue;          // a live document holds it
      filter.holdExpiresAt = { $exists: false };
    }

    const res = await booths.col().updateOne(filter, {
      $set: {
        status: 'available',
        'assignment.company': null,
        updatedAt: new Date(),
        updatedBy: 'system:expiry',
      },
      $unset: { holdExpiresAt: '' },
    });
    if (!res.matchedCount) continue;   // re-held or booked under us; leave it alone

    // Only the documents this sweep READ. An admin's create() in the gap
    // inserts a fresh document with an id that was never in this list, so it
    // survives — where the old `expiresAt: {$lte: now}` deletion could still
    // reach a document whose expiry had not yet been set.
    const ids = idsFor(b.boothNumber);
    if (ids.length) await col().deleteMany({ _id: { $in: ids } });
    expired.push(b.boothNumber);
    track({ type: 'hold.expire', boothNumber: b.boothNumber, meta: {}, actor: 'system:expiry' });
    console.log(`⏱  Hold expired — stand ${b.boothNumber} released`);
  }
  return expired;
}

/**
 * Sweep expired holds, for every show this deployment serves.
 *
 * The show has to be named EXPLICITLY here. Everything else in the app learns
 * its show from the request that started it, but this is a timer: it has no
 * request, so it would inherit the default show and reconcile North America's
 * holds against Germany — releasing stands on one event because a hold expired
 * on another, silently, on a live plan. So it loops the shows and enters each
 * one's context in turn.
 *
 * One show's failure must not stop the others, hence the try inside the loop.
 */
function startExpiryLoop(onExpired) {
  const tick = async () => {
    for (const show of showsModel.list()) {
      try {
        const expired = await showContext.runAs(show.showId, () => reconcile());
        // AWAIT the callback: it does refresh()+broadcast, and if that rejected
        // (a DB blip right as a hold expires) an un-awaited call would escape
        // this try/catch as an unhandled rejection and take the process down.
        if (expired.length && onExpired) {
          await showContext.runAs(show.showId, () => onExpired(expired, show.showId));
        }
      } catch (e) {
        console.error(`Hold reconciliation failed for ${show.showId}:`, e.message);
      }
    }
  };

  tick();
  const t = setInterval(tick, 60_000);
  if (t.unref) t.unref();
  return t;
}

module.exports = { create, release, drop, forceHold, active, reconcile, startExpiryLoop, ensureIndexes };
