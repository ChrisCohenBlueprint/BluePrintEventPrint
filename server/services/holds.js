const { getDb } = require('../db');
const config    = require('../config');
const booths    = require('../models/booths');
const { track } = require('./tracking');

const col = () => getDb().collection('holds');

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

  await col().insertOne({
    showId: config.showId, boothNumber, company, contactId, sessionId,
    createdAt: now, expiresAt, createdBy: actor,
  });

  await booths.setStatus(boothNumber, 'held', { company, actor });
  track({ type: 'hold.create', boothNumber, meta: { company, expiresAt }, sessionId, actor });

  return { ok: true, expiresAt };
}

/** Delete hold documents without touching booth status. */
const drop = (boothNumber) => col().deleteMany({ showId: config.showId, boothNumber });

async function release(boothNumber, { actor = null } = {}) {
  await drop(boothNumber);
  await booths.setStatus(boothNumber, 'available', { company: null, actor });
  track({ type: 'hold.release', boothNumber, meta: {}, actor });
}

const active = () => col().find({ showId: config.showId }).sort({ expiresAt: 1 }).toArray();

/**
 * Release any booth marked 'held' that no longer has a live hold document.
 * Returns the booth numbers that were freed so callers can broadcast.
 */
async function reconcile() {
  const held = await booths.col()
    .find({ showId: config.showId, status: 'held' })
    .project({ boothNumber: 1 })
    .toArray();
  if (!held.length) return [];

  const live = await col()
    .find({ showId: config.showId, boothNumber: { $in: held.map(b => b.boothNumber) } })
    .project({ boothNumber: 1 })
    .toArray();

  // A hold document that is past its expiry counts as gone even if Mongo's TTL
  // reaper has not removed it yet. Treating it as live would leave the booth
  // held and unsellable for as long as the reaper lagged.
  const now = new Date();
  const liveSet = new Set(live.filter(h => !h.expiresAt || h.expiresAt > now).map(h => h.boothNumber));
  const candidates = held.filter(b => !liveSet.has(b.boothNumber)).map(b => b.boothNumber);

  const expired = [];
  for (const boothNumber of candidates) {
    // Conditional write: only release if the booth is STILL held. Between this
    // sweep reading the booth list and writing, an admin may have booked it —
    // an unconditional write would silently erase that sale.
    const res = await booths.col().updateOne(
      { showId: config.showId, boothNumber, status: 'held' },
      { $set: {
          status: 'available',
          'assignment.company': null,
          updatedAt: new Date(),
          updatedBy: 'system:expiry',
      } }
    );
    if (!res.matchedCount) continue;   // status changed under us; leave it alone

    await drop(boothNumber);
    expired.push(boothNumber);
    track({ type: 'hold.expire', boothNumber, meta: {}, actor: 'system:expiry' });
    console.log(`⏱  Hold expired — stand ${boothNumber} released`);
  }
  return expired;
}

function startExpiryLoop(onExpired) {
  const tick = async () => {
    try {
      const expired = await reconcile();
      if (expired.length && onExpired) onExpired(expired);
    } catch (e) {
      console.error('Hold reconciliation failed:', e.message);
    }
  };
  tick();
  const t = setInterval(tick, 60_000);
  if (t.unref) t.unref();
  return t;
}

module.exports = { create, release, drop, active, reconcile, startExpiryLoop };
