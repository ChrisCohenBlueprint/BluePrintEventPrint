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
 * The three events this system runs, created on boot if they are not there.
 *
 * The organiser runs Lubricant Expo in Europe, North America and the Middle
 * East. Those are facts about the business, not something to be assembled by
 * hand in an admin screen before anything works — so they are seeded, and the
 * three appear without anyone creating them.
 *
 * The existing event keeps its show id. Every booth, lead, tag and setting is
 * filed under it, so changing it would orphan the lot; only its slug and
 * display name are set, and neither has anything stored against it. The two new
 * events take ids matching the existing one's year, so the set reads
 * consistently.
 */
const DEFAULT_EVENTS = [
  { slugs: ['lex'], suffix: 'LEX', name: 'Lubricant Expo Europe' },
  { slugs: ['lna'], suffix: 'LNA', name: 'Lubricant Expo North America' },
  { slugs: ['lme'], suffix: 'LME', name: 'Lubricant Expo Middle East' },
];

async function ensureSeeded() {
  await refresh();

  // The year the running event uses — "LEX26" gives "26", so the new events
  // become LNA26 and LME26 rather than a year picked out of the air.
  const existing = String(config.defaultShow || '');
  const year = (existing.match(/(\d{2,4})\s*$/) || [])[1] || '';

  for (const ev of DEFAULT_EVENTS) {
    const id = ev.suffix === existing.replace(/\d+$/, '') ? existing : `${ev.suffix}${year}`;
    const slug = ev.slugs[0];

    // Never touch an event that already exists beyond giving it a readable
    // name: it may have a slug someone chose, and it certainly has data.
    const already = cache.find(c => c.showId === id);
    if (already) {
      if (!already.name || already.name === already.showId) {
        await col().updateOne({ showId: id }, { $set: { name: ev.name } });
      }
      continue;
    }
    // A slug already used by another event would collide on the unique index.
    if (cache.some(c => c.slug === slug)) continue;

    await col().updateOne(
      { showId: id },
      { $setOnInsert: { slug, showId: id, name: ev.name, active: true,
                        order: DEFAULT_EVENTS.indexOf(ev), createdAt: new Date() } },
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
