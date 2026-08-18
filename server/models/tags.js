const { getDb } = require('../db');
const config    = require('../config');

/**
 * The tag catalogue — the fixed vocabulary an admin can attach to a booked
 * stand ("Drilling", "Software", "Safety"…), so a visitor clicking a taken
 * stand learns what that exhibitor actually does.
 *
 * Tags are a catalogue rather than free text on the booth for two reasons: the
 * same category then reads identically on every stand (no "Software" vs
 * "software " vs "SW"), and renaming a category updates every stand that
 * carries it without touching a single booth record.
 *
 * A booth stores tag KEYS (`assignment.tags`), never labels. The key is minted
 * from the label at creation and never changes, so a rename is purely cosmetic
 * and can never orphan a stand's tags.
 */
const col = () => getDb().collection('tags');

// Three is the cap the floorplan panel is designed around — enough to describe
// an exhibitor, few enough to stay readable next to the company name.
const MAX_PER_BOOTH = 3;

const ensureIndexes = () =>
  col().createIndex({ showId: 1, key: 1 }, { unique: true, name: 'show_tag_unique' });

const all = () =>
  col().find({ showId: config.showId }).sort({ order: 1, _id: 1 }).toArray();

/** Just what a client needs to render a chip, keyed for lookup by booth tag. */
const catalogue = async () =>
  (await all()).map(t => ({ key: t.key, label: t.label, color: t.color }));

/** The set of keys that currently exist — used to reject a stale tag on a booth. */
const validKeys = async () => new Set((await all()).map(t => t.key));

const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

// A hex colour, normalised to lowercase 6-digit form. Anything else falls back
// to the caller's default rather than being stored verbatim — an unvalidated
// value here would land straight in a style attribute.
function safeColor(v, fallback = '#6366f1') {
  const s = clean(v, 9).toLowerCase();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (!m) return fallback;
  const h = m[1];
  return h.length === 3 ? `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : `#${h}`;
}

/** Mint a stable, URL-safe key from a label, unique within the show. */
async function mintKey(label) {
  const base = clean(label, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'tag';
  const taken = await validKeys();
  if (!taken.has(base)) return base;
  for (let i = 2; i < 500; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return null;
}

async function create({ label, color }) {
  const name = clean(label, 40);
  if (!name) return { ok: false, reason: 'no_label' };
  // Two tags reading the same would make the quick-add list ambiguous.
  const clash = await col().findOne({ showId: config.showId,
                                      label: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });
  if (clash) return { ok: false, reason: 'duplicate' };

  const key = await mintKey(name);
  if (!key) return { ok: false, reason: 'no_key' };

  const last = await col().find({ showId: config.showId }).sort({ order: -1 }).limit(1).toArray();
  const doc = {
    showId: config.showId,
    key, label: name,
    color: safeColor(color),
    order: (last[0]?.order ?? -1) + 1,
    createdAt: new Date(), updatedAt: new Date(),
  };
  await col().insertOne(doc);
  return { ok: true, tag: { key: doc.key, label: doc.label, color: doc.color } };
}

/** Rename / recolour. The key is deliberately immutable — see the file header. */
async function update(key, { label, color }) {
  const existing = await col().findOne({ showId: config.showId, key });
  if (!existing) return { ok: false, reason: 'missing_tag' };

  const $set = { updatedAt: new Date() };
  if (label !== undefined) {
    const name = clean(label, 40);
    if (!name) return { ok: false, reason: 'no_label' };
    const clash = await col().findOne({ showId: config.showId, key: { $ne: key },
                                        label: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });
    if (clash) return { ok: false, reason: 'duplicate' };
    $set.label = name;
  }
  if (color !== undefined) $set.color = safeColor(color, existing.color);

  await col().updateOne({ showId: config.showId, key }, { $set });
  return { ok: true, tag: { key, label: $set.label ?? existing.label, color: $set.color ?? existing.color } };
}

/**
 * Delete a tag from the catalogue. The caller is responsible for pulling the
 * key off every booth that carries it (booths.removeTag) — done in that order,
 * a stand can never be left showing a tag that no longer exists.
 */
async function remove(key) {
  const res = await col().deleteOne({ showId: config.showId, key });
  return res.deletedCount === 1;
}

module.exports = { col, ensureIndexes, all, catalogue, validKeys, create, update, remove, safeColor, MAX_PER_BOOTH };
