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
 * The three events this system runs: Europe, North America, Middle East.
 *
 * They are permanent. A floorplan belongs to one edition of an event — when the
 * show is over the plan is cleared and next year's is uploaded to the same
 * event — so the events themselves carry no year, and there is no LEX26 to
 * retire and replace annually.
 *
 * Europe is the event already running, whatever id it was created under. That
 * id is NOT changed here: every booth, lead, tag, hold and setting is filed
 * against it, and renaming it in one place would orphan all of them. Only its
 * slug and display name are set, and nothing is stored against either.
 */
const DEFAULT_EVENTS = [
  { key: 'europe',       slug: 'lex', id: 'LEX', name: 'Lubricant Expo Europe' },
  { key: 'northamerica', slug: 'lna', id: 'LNA', name: 'Lubricant Expo North America' },
  { key: 'middleeast',   slug: 'lme', id: 'LME', name: 'Lubricant Expo Middle East' },
];

async function ensureSeeded() {
  await refresh();

  // Rows with no showId are wreckage from a failed deploy: nothing can be filed
  // against an undefined show, so there is nothing to lose by removing them.
  // Left in place they appear as a duplicate event carrying another event's
  // stand count, which is exactly how this was noticed.
  const junk = await col().find({ $or: [{ showId: { $exists: false } }, { showId: null }, { showId: '' }] }).toArray();
  for (const row of junk) await col().deleteOne({ _id: row._id });
  if (junk.length) await refresh();

  // Europe is the event already running — identified by the id its data is
  // under, not by name.
  const europeId = config.defaultShow;

  for (const ev of DEFAULT_EVENTS) {
    const id = ev.key === 'europe' ? europeId : ev.id;
    const existing = cache.find(c => c.showId === id);

    if (existing) {
      // Only fill in what has never been set. An admin who renamed an event or
      // chose its URL must not have that undone on every boot.
      const $set = {};
      if (!existing.name || existing.name === existing.showId) $set.name = ev.name;
      if (Object.keys($set).length) await col().updateOne({ showId: id }, { $set });
      continue;
    }

    // A slug already taken by another event would collide on the unique index.
    if (cache.some(c => c.slug === ev.slug)) continue;

    await col().insertOne({
      slug: ev.slug, showId: id, name: ev.name, active: true,
      order: DEFAULT_EVENTS.indexOf(ev), createdAt: new Date(),
    });
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
