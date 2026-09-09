const { getDb } = require('../db');
const config = require('../config');

/**
 * The events this deployment serves.
 *
 * These started life as a SHOWS environment variable, which was the wrong
 * place: a list of events is data an organiser maintains, not deployment
 * configuration. Putting it in the database means a new show can be created
 * from the admin instead of from the Render dashboard, and that the person who
 * runs the events can do it.
 *
 * `slug` is the URL segment (/admin/lna); `showId` is the key every other
 * collection is scoped by, and is immutable once created — renaming it would
 * orphan every booth, lead and setting filed under it.
 */
const col = () => getDb().collection('shows');

const ensureIndexes = async () => {
  await col().createIndex({ slug: 1 }, { unique: true, name: 'slug_unique' });
  await col().createIndex({ showId: 1 }, { unique: true, name: 'show_unique' });
};

// Read constantly (every request resolves a show through it) and changed rarely,
// so it is cached in memory and refreshed on write.
let cache = [];

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const ID_RE   = /^[A-Za-z0-9_-]{1,32}$/;

const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

/**
 * The live registry. Falls back to the configured show while the table is empty
 * — on a first boot, and in any test that has no database.
 *
 * The fallback is mapped into the SAME shape as a stored row. It previously
 * spread the config entry, which carries `id` rather than `showId`, so every
 * consumer reading `.showId` got undefined and quietly resolved nothing.
 */
function list() {
  if (cache.length) return cache;
  return config.shows.map(s => ({ slug: s.slug, showId: s.id, name: s.id, active: true }));
}

const bySlug = (slug) => list().find(s => s.slug === String(slug || '').toLowerCase()) || null;
const byId   = (id)   => list().find(s => s.showId === id) || null;

async function refresh() {
  const rows = await col().find({}).sort({ order: 1, _id: 1 }).toArray();
  cache = rows.map(r => ({ slug: r.slug, showId: r.showId, name: r.name || r.showId,
                           active: r.active !== false }));
  return cache;
}

/**
 * Make sure the event this deployment was already running exists as a row.
 *
 * Without this the first boot after the change would find an empty table and
 * fall back to config — which works, but means the show an organiser is looking
 * at is not editable. Seeding it makes the existing event a first-class row
 * like any other.
 */
async function ensureSeeded() {
  await refresh();
  if (cache.length) return cache;

  for (const s of config.shows) {
    await col().updateOne(
      { showId: s.id },
      { $setOnInsert: { slug: s.slug, showId: s.id, name: s.id, active: true, order: 0,
                        createdAt: new Date() } },
      { upsert: true });
  }
  return refresh();
}

async function create({ slug, showId, name }) {
  const s = clean(slug, 24).toLowerCase();
  const id = clean(showId, 32);
  if (!SLUG_RE.test(s)) return { ok: false, reason: 'bad_slug' };
  if (!ID_RE.test(id))  return { ok: false, reason: 'bad_id' };
  if (bySlug(s))        return { ok: false, reason: 'slug_taken' };
  if (byId(id))         return { ok: false, reason: 'id_taken' };

  const last = await col().find({}).sort({ order: -1 }).limit(1).toArray();
  await col().insertOne({
    slug: s, showId: id, name: clean(name, 80) || id, active: true,
    order: ((last[0] && last[0].order) || 0) + 1, createdAt: new Date(),
  });
  await refresh();
  return { ok: true, show: bySlug(s) };
}

/** Rename or retire. `showId` is deliberately not editable — see the header. */
async function update(showId, { name, slug, active }) {
  const existing = byId(showId);
  if (!existing) return { ok: false, reason: 'missing' };

  const $set = { updatedAt: new Date() };
  if (name !== undefined) $set.name = clean(name, 80) || existing.showId;
  if (active !== undefined) $set.active = active !== false;
  if (slug !== undefined) {
    const s = clean(slug, 24).toLowerCase();
    if (!SLUG_RE.test(s)) return { ok: false, reason: 'bad_slug' };
    const clash = bySlug(s);
    if (clash && clash.showId !== showId) return { ok: false, reason: 'slug_taken' };
    $set.slug = s;
  }

  await col().updateOne({ showId }, { $set });
  await refresh();
  return { ok: true, show: byId(showId) };
}

module.exports = { col, ensureIndexes, ensureSeeded, refresh, list, bySlug, byId, create, update };
