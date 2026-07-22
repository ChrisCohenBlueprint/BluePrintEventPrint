const { getDb } = require('../db');
const config = require('../config');

const col = () => getDb().collection('sponsors');

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
  const rate = config.ratePerSqm || 600;
  const target = Math.max(1, Number(sqm) || 0) * rate;

  const list = await allActive();
  const scored = list.map(s => {
    // Options without a set price (e.g. price-on-application) get a neutral,
    // mid-pack score rather than being dropped.
    const score = s.price
      ? 1 / (1 + Math.abs(s.price - target) / target)
      : 0.3;
    return { s, score, price: s.price || Infinity };
  });

  // Sold-out options always sink to the bottom: they are there to tempt, not
  // to convert, so they must never outrank something that can still be bought.
  const TIER_ORDER = { platinum: 0, gold: 1, silver: 2 };
  scored.sort((a, b) =>
    (a.s.soldOut === true) - (b.s.soldOut === true) ||
    b.score - a.score ||
    (TIER_ORDER[a.s.tier] ?? 9) - (TIER_ORDER[b.s.tier] ?? 9) ||
    a.price - b.price);

  return scored.map(x => toPublic(x.s));
}

async function setFields(key, fields) {
  const allowed = ['price', 'availability', 'image', 'video', 'active', 'tier', 'soldOut'];
  const $set = { updatedAt: new Date() };
  for (const k of allowed) if (k in fields) $set[k] = fields[k];

  // Sold out and offered are mutually exclusive — marking a package sold out
  // withdraws it from sale in the same click, and clearing the flag puts it
  // back on offer. Doing this here keeps the two in step no matter which
  // client sets the flag.
  if ('soldOut' in fields) {
    $set.soldOut = fields.soldOut === true;
    $set.active  = !$set.soldOut;
  }
  await col().updateOne({ showId: config.showId, key }, { $set });
  return col().findOne({ showId: config.showId, key });
}

module.exports = { col, all, allActive, toPublic, recommend, setFields };
