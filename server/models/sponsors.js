const { getDb } = require('../db');
const config = require('../config');
const { safeLink, safeImage } = require('../lib/safe-url');

const col = () => getDb().collection('sponsors');

const TIERS = ['platinum', 'gold', 'silver'];

const all = () => col().find({ showId: config.showId }).toArray();

/**
 * What the public floorplan may show.
 *
 * Three states, not two:
 *   offered   — active, buyable, ranked normally
 *   sold out  — not buyable, but still shown with a "Sold out" badge, because a
 *               gone package advertises next year's better than a gap does
 *   hidden    — active false and not sold out; off the floorplan entirely
 */
const allActive = () => col()
  .find({ showId: config.showId, $or: [{ active: { $ne: false } }, { soldOut: true }] })
  .toArray();

/**
 * Public projection. Price is removed entirely — the buyer never receives it,
 * because sales walk them through cost during follow-up. Tier stays, since it
 * drives the card colour and conveys weight without a number.
 */
function toPublic(s) {
  return {
    key: s.key,
    name: s.name,
    tier: s.tier,
    availability: s.availability,
    blurb: s.blurb,
    perks: s.perks || [],
    soldOut: s.soldOut === true,
    image: s.image || '',
    video: s.video || '',
  };
}

/**
 * Rank the catalogue for a booth of a given size.
 *
 * A company's sponsorship budget tends to scale with what it spends on floor
 * space, so the target sponsor spend is taken as the booth's own list price
 * (size × rate). Each option is scored by how close its price sits to that
 * target — the nearest options surface first, which naturally sorts a 9 m²
 * buyer toward the entry tier and a 50 m² buyer toward the headline packages,
 * without ever showing a number.
 *
 * Ranking uses price server-side; the returned objects carry no price.
 */
async function recommend(sqm) {
  const rate = await require('./settings').rate();   // live €/unit rate, admin-editable
  const target = Math.max(1, Number(sqm) || 0) * rate;

  const list = await allActive();
  const scored = list.map(s => {
    // Only a genuinely UNSET price is price-on-application (neutral score). A
    // legitimate £0 (complimentary) package is scored on its real distance to
    // target rather than being treated as unpriced and sunk.
    const priced = s.price != null;
    const score = priced ? 1 / (1 + Math.abs(s.price - target) / target) : 0.3;
    // Number.MAX_VALUE rather than Infinity: two unpriced options then tie at 0
    // in the price tie-break below instead of producing Infinity - Infinity = NaN,
    // which makes the comparator inconsistent and the resulting order arbitrary.
    return { s, score, price: priced ? s.price : Number.MAX_VALUE };
  });

  // Sold-out options always sink to the bottom: they are there to tempt, not
  // to convert, so they must never outrank something that can still be bought.
  const TIER_ORDER = { platinum: 0, gold: 1, silver: 2 };
  scored.sort((a, b) =>
    (a.s.soldOut === true) - (b.s.soldOut === true) ||
    b.score - a.score ||
    (TIER_ORDER[a.s.tier] ?? 9) - (TIER_ORDER[b.s.tier] ?? 9) ||
    a.price - b.price ||
    String(a.s.name || '').localeCompare(String(b.s.name || '')));

  return scored.map(x => toPublic(x.s));
}

async function setFields(key, fields) {
  const $set = { updatedAt: new Date() };

  // Each field is validated rather than copied verbatim: price is already
  // coerced by the route, but tier/availability/image/video reach the public
  // card, so they are constrained here too — a bad tier can't break the sort,
  // and image/video get the same URL sanitising as partner logos (no
  // javascript:, no data:text/html, no protocol-relative off-site links).
  if ('price'   in fields) $set.price = fields.price;                       // route already validated
  if ('active'  in fields) $set.active = fields.active === true;
  if ('tier'    in fields) $set.tier = TIERS.includes(String(fields.tier).toLowerCase())
                                       ? String(fields.tier).toLowerCase() : 'silver';
  if ('availability' in fields) $set.availability = String(fields.availability ?? '').slice(0, 120);
  if ('image'   in fields) $set.image = safeImage(fields.image);
  if ('video'   in fields) $set.video = safeLink(fields.video);

  // Sold out and offered are mutually exclusive, and now kept in step in BOTH
  // directions: marking a package sold out withdraws it from sale, and putting
  // it back on offer (active:true) clears the sold-out flag. Otherwise a
  // sold-out package flipped active still showed its "Sold out" badge.
  if ('soldOut' in fields) {
    $set.soldOut = fields.soldOut === true;
    $set.active  = !$set.soldOut;
  } else if ('active' in fields) {
    // Any explicit change to `active` — offering it (true) OR hiding it
    // (false) — clears sold-out. Without this, un-ticking Offered on a sold-out
    // sponsor left soldOut:true, and allActive()'s `soldOut:true` clause kept it
    // on the public floorplan: it could not be hidden.
    $set.soldOut = false;
  }
  await col().updateOne({ showId: config.showId, key }, { $set });
  return col().findOne({ showId: config.showId, key });
}

// ─── Floorplan (title) sponsor ────────────────────────────────────────────────
// A single show-level sponsor: a name and a brand colour. Booths flagged as
// `sponsored` are filled with this colour on the plan, and the legend shows a
// matching "Sponsored" swatch. Stored once per show in a settings document.
const settings = () => getDb().collection('settings');

// Accept only a #RGB / #RRGGBB hex colour — this value flows into an inline
// `fill` / CSS background on the client, so anything else must be rejected to
// avoid style injection.
const HEX = /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/;
function cleanColor(c) {
  const s = String(c == null ? '' : c).trim();
  return HEX.test(s) ? s : '';
}

async function getFloorplanSponsor() {
  const doc = await settings().findOne({ _id: config.showId });
  const fp = (doc && doc.floorplanSponsor) || {};
  return { name: fp.name || '', color: fp.color || '' };
}

async function setFloorplanSponsor({ name, color } = {}) {
  const value = { name: String(name == null ? '' : name).trim().slice(0, 80), color: cleanColor(color) };
  await settings().updateOne({ _id: config.showId },
    { $set: { floorplanSponsor: value, updatedAt: new Date() } }, { upsert: true });
  return value;
}

module.exports = { col, all, allActive, toPublic, recommend, setFields,
                   getFloorplanSponsor, setFloorplanSponsor };
