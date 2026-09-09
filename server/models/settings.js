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
    // The colours THIS event's artwork is drawn in. Null means the app's own
    // palette, which is what Europe has always used.
    palette: doc && doc.palette && doc.palette.sold ? doc.palette : null,
  };
}

/**
 * Record the colours this event's plan is drawn in.
 *
 * A stand's colour should be the colour the designer chose for it. North
 * America's plan draws sold stands light blue and sponsored areas burgundy;
 * repainting them in Europe's yellow made the plan stop looking like the plan
 * that was approved. Held stays the app's orange on every event, because a
 * held stand is a state the app owns, not something the artwork drew.
 */
async function setPalette(palette) {
  const hex = (v) => (/^#[0-9a-f]{3,8}$/i.test(String(v || '')) ? String(v).toLowerCase() : null);
  const clean = {
    available: hex(palette && palette.available),
    sold: hex(palette && palette.sold),
    sponsored: hex(palette && palette.sponsored),
  };
  if (!clean.sold) return { ok: false, reason: 'no_sold_colour' };
  await col().updateOne({ _id: config.showId },
    { $set: { palette: clean, updatedAt: new Date() } }, { upsert: true });
  return { ok: true, palette: clean };
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

module.exports = { get, rate, setRate, setUnit, setCurrency, setPalette, CURRENCIES };
