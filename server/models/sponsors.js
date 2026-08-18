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

// ─── Shape + validation ───────────────────────────────────────────────────────
// One definition of what a sponsorship option is, used by the single-row editor,
// the create form and the CSV import alike — so a package added from a
// spreadsheet is validated exactly as one typed into the admin.

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

/** Mint a stable, URL-safe key from a name, unique within the show. */
async function mintKey(name, taken = null) {
  const base = str(name, 60).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'package';
  const used = taken || new Set((await all()).map(s => s.key));
  if (!used.has(base)) return base;
  for (let i = 2; i < 500; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
  return null;
}

const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Coerce a loose record (a form body, or a CSV row) into a storable sponsor.
 * Returns { ok, fields } or { ok:false, error } — never a half-valid object.
 *
 * `partial` mode writes only the keys actually supplied, which is what an edit
 * needs; a create fills in the defaults.
 */
function cleanSponsor(raw = {}, { partial = false } = {}) {
  // Read fields through the SAME normalisation the CSV header parser applies —
  // lowercase, no spaces/underscores/hyphens. Without this a camelCase column
  // like `soldOut` arrived as `soldout`, missed the lookup, and silently fell
  // back to its default: a package marked sold out in the spreadsheet imported
  // as still on sale.
  const norm = (k) => String(k).toLowerCase().replace(/[\s_-]+/g, '');
  const input = {};
  for (const [k, v] of Object.entries(raw || {})) input[norm(k)] = v;

  const f = {};
  const has = (k) => input[norm(k)] !== undefined && input[norm(k)] !== null;
  const get = (k) => input[norm(k)];

  if (has('name') || !partial) {
    const name = str(get('name'), 120);
    if (!name) return { ok: false, error: 'Every package needs a name.' };
    f.name = name;
  }
  if (has('tier') || !partial) {
    const t = str(get('tier'), 20).toLowerCase();
    if (t && !TIERS.includes(t)) return { ok: false, error: `Tier must be one of ${TIERS.join(', ')} (got "${t}").` };
    f.tier = t || 'silver';
  }
  if (has('price') || !partial) {
    const raw = str(get('price'), 20).replace(/[£$€,\s]/g, '');   // "€29,950" → 29950
    if (raw === '') f.price = null;                              // price on application
    else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return { ok: false, error: `Price must be a number or blank (got "${get('price')}").` };
      f.price = n;
    }
  }
  if (has('availability') || !partial) f.availability = str(get('availability'), 120);
  if (has('blurb')        || !partial) f.blurb        = str(get('blurb'), 600);
  if (has('perks') || !partial) {
    // A list in one cell. Pipe is the documented separator because a comma would
    // force the author to quote the field; semicolon and newline are accepted
    // because people use them anyway.
    const raw = get('perks');
    f.perks = Array.isArray(raw)
      ? raw.map(x => str(x, 200)).filter(Boolean).slice(0, 30)
      : str(raw, 4000).split(/\s*[|;\n]\s*/).map(x => x.trim()).filter(Boolean).slice(0, 30);
  }
  if (has('image') || !partial) {
    if (str(get('image'), 2_000_000).length > 2_000_000) return { ok: false, error: 'That image is too large to store.' };
    f.image = safeImage(get('image'));
  }
  if (has('video') || !partial) f.video = safeLink(get('video'));

  // Accepts what a spreadsheet produces: TRUE/FALSE, yes/no, 1/0, y/n.
  const bool = (v, dflt) => {
    const t = str(v, 10).toLowerCase();
    if (t === '') return dflt;
    if (['true', 'yes', 'y', '1'].includes(t)) return true;
    if (['false', 'no', 'n', '0'].includes(t)) return false;
    return dflt;
  };
  if (has('active')  || !partial) f.active  = bool(get('active'), true);
  if (has('soldOut') || !partial) f.soldOut = bool(get('soldOut'), false);
  // Same rule the editor enforces: sold out and on offer are mutually exclusive.
  if (f.soldOut === true) f.active = false;

  return { ok: true, fields: f };
}

/** Add a package. The key is minted from the name unless one is supplied. */
async function create(input = {}) {
  const clean = cleanSponsor(input, { partial: false });
  if (!clean.ok) return clean;

  let key = str(input.key, 64).toLowerCase();
  if (key && !KEY_RE.test(key)) return { ok: false, error: `"${key}" is not a valid key — use letters, numbers, . _ or -` };
  if (!key) key = await mintKey(clean.fields.name);
  if (!key) return { ok: false, error: 'Could not generate a key for that name.' };

  if (await col().findOne({ showId: config.showId, key })) {
    return { ok: false, error: `A package with the key "${key}" already exists.` };
  }
  // Names must be unique too. A CSV without a key column matches rows to
  // packages BY NAME, so two packages sharing one would make that lookup
  // ambiguous and send an edit to the wrong package.
  const nameClash = await col().findOne({ showId: config.showId,
    name: { $regex: `^${clean.fields.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });
  if (nameClash) return { ok: false, error: `"${clean.fields.name}" already exists in the catalogue.` };
  const doc = { showId: config.showId, key, ...clean.fields, createdAt: new Date(), updatedAt: new Date() };
  await col().insertOne(doc);
  return { ok: true, sponsor: doc };
}

/**
 * Delete a package from the catalogue.
 *
 * Deliberately does NOT touch the saved proposals or enquiries that reference
 * it: both resolve their keys against this collection at read time and already
 * report an unresolvable one as withdrawn, so a deleted package shows honestly
 * as "no longer available" on a proposal rather than vanishing from a document
 * a client has already been sent.
 */
async function remove(key) {
  const res = await col().deleteOne({ showId: config.showId, key: str(key, 64) });
  return res.deletedCount === 1;
}

/**
 * Bulk create/update from parsed CSV rows, matched on `key` — or, when a row has
 * no key, on an exact (case-insensitive) name match against the existing
 * catalogue, so a spreadsheet edited without the key column updates rather than
 * duplicating.
 *
 * `removeMissing` additionally deletes anything the file does not mention, which
 * makes the spreadsheet the whole truth. It is off unless asked for.
 *
 * `dryRun` reports exactly what would happen and writes nothing — the admin
 * shows that summary for confirmation before anything is committed.
 */
async function importRows(rows, { removeMissing = false, dryRun = false } = {}) {
  const existing = await all();
  const byKey  = new Map(existing.map(s => [s.key, s]));
  const byName = new Map(existing.map(s => [String(s.name || '').trim().toLowerCase(), s]));

  const created = [], updated = [], errors = [];
  const seen = new Set(), seenNames = new Map();
  const mintedSoFar = new Set(existing.map(s => s.key));

  for (const row of rows || []) {
    const line = row.__line;
    const clean = cleanSponsor(row, { partial: false });
    if (!clean.ok) { errors.push({ line, error: clean.error }); continue; }

    let key = str(row.key, 64).toLowerCase();
    if (key && !KEY_RE.test(key)) { errors.push({ line, error: `"${key}" is not a valid key.` }); continue; }
    if (!key) {
      const match = byName.get(clean.fields.name.toLowerCase());
      key = match ? match.key : await mintKey(clean.fields.name, mintedSoFar);
      if (!key) { errors.push({ line, error: 'Could not generate a key.' }); continue; }
    }
    if (seen.has(key)) { errors.push({ line, error: `Duplicate of "${key}" earlier in the file.` }); continue; }

    const isNew = !byKey.has(key);
    // Keep names unique for the same reason create() does — otherwise the next
    // import's name matching becomes ambiguous.
    const lower = clean.fields.name.toLowerCase();
    const nameOwner = byName.get(lower);
    if (isNew && nameOwner && nameOwner.key !== key) {
      errors.push({ line, error: `"${clean.fields.name}" already exists as "${nameOwner.key}" — reuse that key to update it.` });
      continue;
    }
    if (seenNames.has(lower) && seenNames.get(lower) !== key) {
      errors.push({ line, error: `Another row in this file already uses the name "${clean.fields.name}".` });
      continue;
    }
    seen.add(key);
    seenNames.set(lower, key);
    mintedSoFar.add(key);
    byName.set(lower, { key, name: clean.fields.name });
    (isNew ? created : updated).push({ key, name: clean.fields.name });
    if (dryRun) continue;

    if (isNew) {
      await col().insertOne({ showId: config.showId, key, ...clean.fields, createdAt: new Date(), updatedAt: new Date() });
    } else {
      await col().updateOne({ showId: config.showId, key }, { $set: { ...clean.fields, updatedAt: new Date() } });
    }
  }

  const removed = removeMissing
    ? existing.filter(s => !seen.has(s.key)).map(s => ({ key: s.key, name: s.name }))
    : [];
  if (!dryRun && removed.length) {
    await col().deleteMany({ showId: config.showId, key: { $in: removed.map(r => r.key) } });
  }

  return { ok: true, dryRun, created, updated, removed, errors };
}

// ─── CSV shape ────────────────────────────────────────────────────────────────
// The column order the export writes and the import documents. Exporting the
// live catalogue, editing it and re-importing is the intended round trip, so
// these must stay in step.
const CSV_HEADERS = ['key', 'name', 'tier', 'price', 'availability', 'blurb', 'perks', 'image', 'video', 'active', 'soldOut'];

async function toCsvRows() {
  const rows = await all();
  const TIER_RANK = { platinum: 0, gold: 1, silver: 2 };
  rows.sort((a, b) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9) || (b.price || 0) - (a.price || 0));
  return rows.map(s => [
    s.key, s.name, s.tier, s.price ?? '', s.availability ?? '', s.blurb ?? '',
    (s.perks || []).join(' | '), s.image ?? '', s.video ?? '',
    s.active === false ? 'false' : 'true', s.soldOut === true ? 'true' : 'false',
  ]);
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
                   cleanSponsor, create, remove, importRows, toCsvRows, CSV_HEADERS, TIERS,
                   getFloorplanSponsor, setFloorplanSponsor };
