const { getDb } = require('../db');
const config = require('../config');

// Per-show settings that an admin can change at runtime. Stored in the same
// `settings` document as the floorplan sponsor (keyed by showId), so there is
// one row per show. Values fall back to the config defaults when unset.
const col = () => getDb().collection('settings');

async function get() {
  const doc = await col().findOne({ _id: config.showId });
  return {
    ratePerSqm: doc && typeof doc.ratePerSqm === 'number' ? doc.ratePerSqm : (config.ratePerSqm || 600),
    unit: doc && (doc.unit === 'ft') ? 'ft' : 'm',
  };
}

/** The live €/unit rate — used wherever a list price is derived. */
async function rate() {
  return (await get()).ratePerSqm;
}

/**
 * Set the €/unit rate. Positive finite number only. Returns the stored value;
 * recomputing existing list prices is the caller's job (booths.recomputeListPrices).
 */
async function setRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return { ok: false, reason: 'bad_rate' };
  const rounded = Math.round(n);
  await col().updateOne({ _id: config.showId },
    { $set: { ratePerSqm: rounded, updatedAt: new Date() } }, { upsert: true });
  return { ok: true, ratePerSqm: rounded };
}

/** Unit of area for this show: 'm' (m²) or 'ft' (ft²). A display label only. */
async function setUnit(value) {
  const unit = value === 'ft' ? 'ft' : 'm';
  await col().updateOne({ _id: config.showId },
    { $set: { unit, updatedAt: new Date() } }, { upsert: true });
  return { ok: true, unit };
}

module.exports = { get, rate, setRate, setUnit };
