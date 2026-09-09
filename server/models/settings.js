const { getDb } = require('../db');
const config = require('../config');

// Per-show settings that an admin can change at runtime. Stored in the same
// `settings` document as the floorplan sponsor (keyed by showId), so there is
// one row per show. Values fall back to the config defaults when unset.
const col = () => getDb().collection('settings');

/**
 * The currencies a show can be priced in, and the symbol each prints with.
 *
 * A fixed list rather than a free-text symbol: this string is printed on client
 * proposals and concatenated into money, so it is not somewhere to accept
 * arbitrary input. Always prefixed — "AED 39,950" reads correctly even though
 * the local convention varies.
 */
const CURRENCIES = {
  EUR: '€',
  USD: '$',
  GBP: '£',
  AED: 'AED ',
};

async function get() {
  const doc = await col().findOne({ _id: config.showId });
  // Defaults to EUR, so a show that has never set one behaves exactly as it did
  // before this existed — the Germany plan is untouched by North America
  // needing dollars.
  const currency = doc && CURRENCIES[doc.currency] ? doc.currency : 'EUR';
  return {
    ratePerSqm: doc && typeof doc.ratePerSqm === 'number' ? doc.ratePerSqm : (config.ratePerSqm || 600),
    unit: doc && (doc.unit === 'ft') ? 'ft' : 'm',
    currency,
    currencySymbol: CURRENCIES[currency],
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

/**
 * Currency for this show: which symbol prices print with. A display choice
 * only — switching it does NOT convert any stored number, exactly like the
 * area unit. A 600 rate becomes $600, not the dollar value of €600.
 */
async function setCurrency(value) {
  const code = String(value || '').toUpperCase();
  if (!CURRENCIES[code]) return { ok: false, reason: 'bad_currency' };
  await col().updateOne({ _id: config.showId },
    { $set: { currency: code, updatedAt: new Date() } }, { upsert: true });
  return { ok: true, currency: code, currencySymbol: CURRENCIES[code] };
}

/** Unit of area for this show: 'm' (m²) or 'ft' (ft²). A display label only. */
async function setUnit(value) {
  const unit = value === 'ft' ? 'ft' : 'm';
  await col().updateOne({ _id: config.showId },
    { $set: { unit, updatedAt: new Date() } }, { upsert: true });
  return { ok: true, unit };
}

module.exports = { get, rate, setRate, setUnit, setCurrency, CURRENCIES };
