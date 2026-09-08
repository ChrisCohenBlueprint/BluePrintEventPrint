const { getDb } = require('../db');
const config    = require('../config');
const catalogue = require('../data/plan-areas');
const { safeImage } = require('../lib/safe-url');

/**
 * What an admin has done to the plan's named areas — currently a sponsor logo
 * and, if the shipped name was wrong, a corrected label.
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

module.exports = { col, ensureIndexes, all, setLogo, setLabel, MAX_LOGO };
