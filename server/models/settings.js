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
    // The colours THIS event's spaces are painted in. Null means the app's own
    // palette, which is what Europe has always used.
    palette: cleanPalette(doc && doc.palette),
  };
}

/**
 * The colours a palette can set, and the space each one paints.
 *
 *   available, sold, held — a stand, by status
 *   sponsored             — a sponsorable area (a lounge, a theatre) still open
 *   areaTaken             — a sponsorable area a sponsor has taken
 *
 * `sponsored` keeps its old name because every stored palette already carries
 * it. The two area colours are only ever PAINTED when an admin chose them:
 * a palette read out of the artwork leaves the areas exactly as drawn.
 */
const PALETTE_KEYS = ['available', 'sold', 'held', 'sponsored', 'areaTaken'];
const hex = (v) => (/^#[0-9a-f]{3,8}$/i.test(String(v || '')) ? String(v).toLowerCase() : null);

/** A stored palette as the clients expect it, or null when nothing is set. */
function cleanPalette(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  let any = false;
  for (const k of PALETTE_KEYS) {
    out[k] = hex(raw[k]);
    if (out[k]) any = true;
  }
  if (!any) return null;
  // Who chose these: 'admin' from the colour picker, 'artwork' read off the
  // plan by an import. Older rows predate the field and were all read off the
  // plan, so that is what a missing value means.
  out.source = raw.source === 'admin' ? 'admin' : 'artwork';
  return out;
}

/**
 * Record the colours this event's spaces are painted in.
 *
 * A stand's colour should be the colour the designer chose for it. North
 * America's plan draws sold stands light blue and sponsored areas burgundy;
 * repainting them in Europe's yellow made the plan stop looking like the plan
 * that was approved. So an import reads the colours off the plan and stores
 * them here with `source: 'artwork'`.
 *
 * An admin can also CHOOSE them, at upload or any time after, and a choice
 * outranks a reading: `source: 'admin'` is what setPaletteFromArtwork checks
 * before it writes, so re-reading a plan never undoes a decision someone made.
 * A chosen palette may leave any colour unset, which means the app's own.
 *
 * ON HOLD can be chosen but is never read off a plan: a hold starts and expires
 * in the app, so unless someone decides otherwise it keeps the one orange that
 * means the same thing on every event.
 */
async function setPalette(palette, { source = 'admin' } = {}) {
  const clean = {};
  for (const k of PALETTE_KEYS) clean[k] = hex(palette && palette[k]);
  const any = PALETTE_KEYS.some(k => clean[k]);
  if (source === 'artwork') {
    // A reading with no sold colour is a plan whose colours could not be read;
    // painting the app in that would blank the hall.
    if (!clean.sold) return { ok: false, reason: 'no_sold_colour' };
    clean.held = null;                     // never read off a plan — see above
  } else if (!any) {
    // Nothing chosen at all is "use the app's own colours", not an error.
    await clearPalette();
    return { ok: true, palette: null };
  }
  clean.source = source === 'artwork' ? 'artwork' : 'admin';
  await col().updateOne({ _id: config.showId },
    { $set: { palette: clean, updatedAt: new Date() } }, { upsert: true });
  return { ok: true, palette: cleanPalette(clean) };
}

/**
 * What an import calls: store the colours read off the plan, unless an admin
 * has already chosen this event's colours, in which case their choice stands
 * and the reading is reported back untouched.
 */
async function setPaletteFromArtwork(palette) {
  const current = (await get()).palette;
  if (current && current.source === 'admin') {
    return { ok: true, kept: true, palette: current, fromArtwork: cleanPalette({ ...palette, source: 'artwork' }) };
  }
  const r = await setPalette(palette, { source: 'artwork' });
  return { ...r, kept: false };
}

/** Back to the app's own colours for every space. */
async function clearPalette() {
  await col().updateOne({ _id: config.showId },
    { $unset: { palette: '' }, $set: { updatedAt: new Date() } }, { upsert: true });
  return { ok: true, palette: null };
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

module.exports = { get, rate, setRate, setUnit, setCurrency, setPalette, setPaletteFromArtwork,
                   clearPalette, cleanPalette, PALETTE_KEYS, CURRENCIES };
