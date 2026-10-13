const { getDb } = require('../db');
const config    = require('../config');
const catalogue = require('../data/plan-areas');
const { safeImage } = require('../lib/safe-url');
const { extractStands } = require('../lib/extract-stands');

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
 * WHERE THE AREAS COME FROM. Originally ../data/plan-areas.js, a static list
 * measured off Europe's artwork — which meant every event was served Europe's
 * lounges, sitting at Europe's coordinates, whatever its own plan drew. The
 * extractor already finds each plan's OWN sponsorable areas (the dark fill a
 * plan uses for only a handful of shapes) and they were being discarded, so the
 * import now persists them here, per show, and this model reads them back.
 *
 * The static file is kept as EUROPE'S SEED and nothing more: an event with no
 * stored areas falls back to it, so the event already running is unaffected
 * until its own plan is imported.
 *
 * Either way the editable part — sponsor, logo, corrected label, status — lives
 * on the same row and is keyed by area, so re-importing a plan updates every
 * area's position without touching a single sponsor's logo.
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
 * Is this a real area on THIS show?
 *
 * The shipped catalogue is no longer the only answer — an imported plan brings
 * its own areas — so every edit checks both. Asked of the database rather than
 * a module constant, because an area created by an import a minute ago has to
 * be editable now.
 */
async function isValid(key) {
  const k = String(key || '');
  if (!k) return false;
  if (catalogue.isValid(k)) return true;
  return !!await col().findOne({ showId: config.showId, key: k }, { projection: { _id: 1 } });
}

/** A stable key for an area read off a plan. */
const slug = (v) => String(v == null ? '' : v).toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

// The same shape, within the jitter an export can add. An area is found on the
// plan by its rectangle, so this is also how an area is known across imports.
const sameBox = (g, h) => !!(g && h) && ['x', 'y', 'w', 'h'].every(k => Math.abs((g[k] || 0) - (h[k] || 0)) < 2);

/**
 * Store the sponsorable areas an import read out of this show's plan.
 *
 * Only the geometry and the printed label are written. Everything an admin has
 * put on an area — the sponsor, the logo, the corrected name, the package it is
 * sold under — is on the same row and is deliberately not in the $set, so
 * re-importing a plan moves the areas and keeps the sponsorships.
 *
 * An area the plan still draws in the same place keeps its key — see below.
 *
 * Areas the new plan no longer draws lose their geometry marker rather than
 * their row: a sponsor's logo is not ours to delete because a designer moved a
 * lounge, and a row with no geometry simply stops being listed.
 */
async function replaceFromArtwork(areas, { actor = null } = {}) {
  const list = (Array.isArray(areas) ? areas : []).filter(a => a && a.geometry);
  const showId = config.showId;
  const seen = [];
  let order = 0;

  // An area keeps the key it already has wherever the plan still draws it,
  // because the key is what its sponsor, logo and package hang on. Keying by
  // printed label alone did two things to Europe's re-issued plan: three
  // shapes print NETWORKING LOUNGE and two CONFERENCE, so only the first of
  // each was stored and the rest went unclickable; and every area changed key
  // (networking-lounge-west → networking-lounge), leaving whatever was sold on
  // the old one behind. Matched by position, as the plan binds them.
  const rows = await col().find({ showId }).toArray();
  const byKey = new Map(rows.map(r => [r.key, r]));
  const known = [];
  for (const r of rows) if (r.geometry) known.push({ key: r.key, geometry: r.geometry, row: r });
  // The shipped catalogue is the event's areas until its plan is imported —
  // its keys are the ones an admin's work sits on.
  for (const c of catalogue.AREAS) {
    if (!known.some(k => k.key === c.key)) known.push({ key: c.key, geometry: c.geometry, row: byKey.get(c.key) || null, shipped: c });
  }
  const worked = (r) => !!(r && (r.sponsor || r.logo || r.sponsorKey || r.label || r.status === 'taken'));

  for (const a of list) {
    const printed = (a.exhibitor && a.exhibitor.trim()) || `Area ${a.number}`;
    // Where this shape was already an area: one an admin has worked on first,
    // then a shipped key, then any.
    const here = known.filter(k => !seen.includes(k.key) && sameBox(k.geometry, a.geometry))
      .sort((p, q) => (worked(q.row) - worked(p.row)) || (!!q.shipped - !!p.shipped) ||
                      (!!catalogue.isValid(q.key) - !!catalogue.isValid(p.key)));
    let key = here.length ? here[0].key : null;
    // A shipped key's own name ("Networking Lounge (West)") tells three lounges
    // apart where the plan prints the same words on each.
    const label = key && catalogue.isValid(key) ? catalogue.get(key).label : printed;
    if (!key) {
      key = slug(printed) || `area-${slug(a.number) || order}`;
      if (seen.includes(key) || (byKey.has(key) && known.some(k => k.key === key && !sameBox(k.geometry, a.geometry)))) {
        key = `${key}-${slug(a.number) || order}`;
      }
      if (seen.includes(key)) continue;          // the same shape twice — the first is the area
    }
    seen.push(key);
    await col().updateOne(
      { showId, key },
      { $set: { geometry: a.geometry, artworkLabel: label, fromArtwork: true,
                order: order++, updatedAt: new Date(), updatedBy: actor },
        $setOnInsert: { showId, key } },
      { upsert: true });
  }

  // Rows from a previous import of this plan that the new one does not draw.
  const stale = await col().updateMany(
    { showId, fromArtwork: true, key: { $nin: seen } },
    { $unset: { geometry: '', fromArtwork: '' }, $set: { updatedAt: new Date(), updatedBy: actor } });

  return { ok: true, areas: seen.length, keys: seen, retired: stale.modifiedCount };
}

/**
 * Bring an event's areas into line with the plan it is showing, without an
 * import. Run at boot for every event that has a plan.
 *
 * The areas are a reading of the live drawing, and a reading made by an older
 * version of this file can be wrong in a way nobody will re-import to fix:
 * Europe's lounges were read under keys that dropped two of them, a deploy
 * corrected the reading, and the lounges stayed unclickable because the rows
 * were still the old reading. Compared by shape, as the page binds them. When
 * every shape the plan draws has an area in that place and nothing stale is
 * listed, nothing is written — so a boot costs one extraction per event.
 *
 * A drawing in which no area can be read is not evidence that there are none
 * (the fills may simply be unreadable), so it changes nothing.
 */
async function reconcileWithArtwork(svg, { actor = 'deploy' } = {}) {
  if (!svg) return { ok: false, reason: 'no_artwork' };
  const drawn = extractStands(svg).stands.filter(s => s.sponsored && s.geometry);
  if (!drawn.length) return { ok: true, changed: false, reason: 'no_areas_drawn' };
  const stored = (await col().find({ showId: config.showId }).toArray())
    .filter(r => r.fromArtwork && r.geometry);
  const agree = drawn.length === stored.length &&
                drawn.every(d => stored.some(r => sameBox(r.geometry, d.geometry)));
  if (agree) return { ok: true, changed: false, areas: stored.length };
  const r = await replaceFromArtwork(drawn, { actor });
  return { ...r, changed: true, before: stored.length };
}

/**
 * This show's own areas if its plan has been imported, Europe's seed if not,
 * merged in both cases with whatever the admin has set — the one shape both the
 * public plan and the admin ever see. An area with no row yet simply carries
 * its shipped label and no logo.
 */
async function all() {
  const rows = await col().find({ showId: config.showId }).toArray();
  const by = new Map(rows.map(r => [r.key, r]));
  // An area read from this show's own artwork carries its geometry on the row.
  // Their presence is what says "this event's plan has been imported"; without
  // one, the shipped catalogue stands in.
  const own = rows.filter(r => r.geometry && r.fromArtwork).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const base = own.length ? own.map(r => ({ key: r.key, label: r.artworkLabel || r.key, geometry: r.geometry }))
                          : catalogue.AREAS;
  return base.map(a => {
    const saved = by.get(a.key);
    return {
      key: a.key,
      label: (saved && saved.label) || a.label,
      geometry: (saved && saved.geometry) || a.geometry,
      logo: (saved && saved.logo) || null,
      sponsor: (saved && saved.sponsor) || null,
      // Which sponsorship package sells this area, if an admin has said. The
      // package's own details are joined on by the socket layer rather than
      // here, so this model never has to know about the sponsors model.
      sponsorKey: (saved && saved.sponsorKey) || null,
      // Unset means nobody has taken it yet, which is the useful default for a
      // plan that has just been published.
      status: (saved && saved.status) || 'available',
    };
  });
}

/** Set (or clear) an area's sponsor logo. Inline images only — see above. */
async function setLogo(key, image, { actor = null } = {}) {
  if (!await isValid(key)) return { ok: false, reason: 'unknown_area' };

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
  if (!await isValid(key)) return { ok: false, reason: 'unknown_area' };
  const name = String(label == null ? '' : label).trim().slice(0, 60);

  await col().updateOne(
    { showId: config.showId, key },
    { $set: { label: name || null, updatedAt: new Date(), updatedBy: actor },
      $setOnInsert: { showId: config.showId, key } },
    { upsert: true });
  return { ok: true, key, label: name || (catalogue.get(key) || {}).label || key };
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
  if (!await isValid(key)) return { ok: false, reason: 'unknown_area' };

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

/**
 * Point an area at the sponsorship package that sells it — "the Networking
 * Lounge on the plan is what the Networking Lounge package buys".
 *
 * The link is what stops the two drifting: with it, marking the package sold
 * out can mark the area taken, and the admin can see which opportunity an area
 * belongs to without holding it in their head. An empty value unlinks.
 */
async function setPackage(key, sponsorKey, { actor = null } = {}) {
  if (!await isValid(key)) return { ok: false, reason: 'unknown_area' };
  const value = String(sponsorKey == null ? '' : sponsorKey).trim().slice(0, 60) || null;

  await col().updateOne(
    { showId: config.showId, key },
    { $set: { sponsorKey: value, updatedAt: new Date(), updatedBy: actor },
      $setOnInsert: { showId: config.showId, key } },
    { upsert: true });
  return { ok: true, key, sponsorKey: value };
}

/**
 * Carry a package's sold-out state onto every area it sells.
 *
 * This is the half that makes the link worth having: an admin marks the
 * Networking Lounge package sold out in one place, and the lounges on the plan
 * stop advertising themselves as available.
 *
 * Deliberately one-directional and only onto LINKED areas — an area with no
 * package is managed by hand and must not be moved underneath its admin.
 * Returns how many areas changed.
 */
async function applyPackageSoldOut(sponsorKey, soldOut, { actor = null } = {}) {
  const key = String(sponsorKey || '');
  if (!key) return 0;
  const res = await col().updateMany(
    { showId: config.showId, sponsorKey: key },
    { $set: { status: soldOut ? 'taken' : 'available', updatedAt: new Date(), updatedBy: actor } });
  return res.modifiedCount;
}

module.exports = { col, ensureIndexes, all, isValid, setLogo, setLabel, setSponsor, setPackage,
                   applyPackageSoldOut, replaceFromArtwork, reconcileWithArtwork, STATUSES, MAX_LOGO };
