const { getDb } = require('../db');
const config    = require('../config');
const catalogue = require('../data/plan-areas');
const { safeImage } = require('../lib/safe-url');

/**
 * What an admin has done to the plan's named areas — who sponsors each one,
 * whether it is still available, their logo, and a corrected label if the
 * shipped one was wrong.
 *
 * These areas are not stands and never become stands: they carry no price, no
 * m², and no booking. They are sponsorable inventory in their own right — the
 * lounges and theatres a sponsor buys — so an area tracks a sponsor and an
 * availability the same way a stand tracks a company and a status.
 *
 * The areas themselves live in ../data/plan-areas.js because their geometry
 * comes from the artwork and is not the admin's to change. This collection
 * holds only the editable part, keyed by area, so re-exporting the plan updates
 * every area's position without touching a single sponsor's logo.
 */
const col = () => getDb().collection('planAreas');

const ensureIndexes = () =>
  col().createIndex({ showId: 1, key: 1 }, { unique: true, name: 'show_area_unique' });

// Matches the booth sponsor-logo cap — see booths.setSponsorLogo for why the
// stored value is an inline image and never a hosted URL.
const MAX_LOGO = 2_000_000;
const inlineImage = (v) => /^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(v) ? v : '';

// An area is either still for sale or it isn't. Deliberately not the booths'
// three-state available/held/sold: an area is not held while a hold expires,
// and borrowing that vocabulary would invite the two to be treated as one.
const STATUSES = ['available', 'taken'];

/**
 * The shipped areas merged with whatever the admin has set — the one shape both
 * the public plan and the admin ever see. An area with no row yet simply
 * carries its shipped label and no logo.
 */
async function all() {
  const rows = await col().find({ showId: config.showId }).toArray();
  const by = new Map(rows.map(r => [r.key, r]));
  return catalogue.AREAS.map(a => {
    const saved = by.get(a.key);
    return {
      key: a.key,
      label: (saved && saved.label) || a.label,
      geometry: a.geometry,
      logo: (saved && saved.logo) || null,
      sponsor: (saved && saved.sponsor) || null,
      // Unset means nobody has taken it yet, which is the useful default for a
      // plan that has just been published.
      status: (saved && saved.status) || 'available',
    };
  });
}

/** Set (or clear) an area's sponsor logo. Inline images only — see above. */
async function setLogo(key, image, { actor = null } = {}) {
  if (!catalogue.isValid(key)) return { ok: false, reason: 'unknown_area' };

  const raw = typeof image === 'string' ? image.trim() : '';
  if (raw.length > MAX_LOGO) return { ok: false, reason: 'too_large' };
  const value = raw ? inlineImage(safeImage(raw)) : '';
  if (raw && !value) return { ok: false, reason: 'bad_image' };

  await col().updateOne(
    { showId: config.showId, key },
    { $set: { logo: value || null, updatedAt: new Date(), updatedBy: actor },
      $setOnInsert: { showId: config.showId, key } },
    { upsert: true });
  return { ok: true, key, logo: value || null };
}

/**
 * Correct an area's name. The shipped labels were matched by position because
 * the artwork's own text is vector outlines, so getting one wrong is expected;
 * an empty value restores the shipped name rather than blanking it.
 */
async function setLabel(key, label, { actor = null } = {}) {
  if (!catalogue.isValid(key)) return { ok: false, reason: 'unknown_area' };
  const name = String(label == null ? '' : label).trim().slice(0, 60);

  await col().updateOne(
    { showId: config.showId, key },
    { $set: { label: name || null, updatedAt: new Date(), updatedBy: actor },
      $setOnInsert: { showId: config.showId, key } },
    { upsert: true });
  return { ok: true, key, label: name || catalogue.get(key).label };
}

/**
 * Record who has taken an area, and whether it is still going.
 *
 * The two move together on purpose: naming a sponsor without marking the area
 * taken would leave it advertised as available under that sponsor's own logo,
 * which is the one state that must never reach the public plan. Clearing the
 * sponsor frees the area for the same reason.
 */
async function setSponsor(key, { sponsor, status } = {}, { actor = null } = {}) {
  if (!catalogue.isValid(key)) return { ok: false, reason: 'unknown_area' };

  const $set = { updatedAt: new Date(), updatedBy: actor };

  if (sponsor !== undefined) {
    const name = String(sponsor == null ? '' : sponsor).trim().slice(0, 80);
    $set.sponsor = name || null;
    // Naming a sponsor takes the area; removing the name gives it back. An
    // explicit status in the same call still wins — see below.
    $set.status = name ? 'taken' : 'available';
  }

  if (status !== undefined) {
    const st = String(status || '').toLowerCase();
    if (!STATUSES.includes(st)) return { ok: false, reason: 'bad_status' };
    $set.status = st;
  }

  await col().updateOne(
    { showId: config.showId, key },
    { $set, $setOnInsert: { showId: config.showId, key } },
    { upsert: true });

  const row = await col().findOne({ showId: config.showId, key });
  return { ok: true, key, sponsor: row?.sponsor || null, status: row?.status || 'available' };
}

module.exports = { col, ensureIndexes, all, setLogo, setLabel, setSponsor, STATUSES, MAX_LOGO };
