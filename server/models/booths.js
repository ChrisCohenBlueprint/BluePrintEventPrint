const { getDb } = require('../db');
const config    = require('../config');
const countries = require('../data/countries');
const settings  = require('./settings');
const { safeImage } = require('../lib/safe-url');
const { readRects, extractStands, paletteOf } = require('../lib/extract-stands');
const floorplans = require('./floorplans');
const planAreas = require('./plan-areas');
const crypto    = require('crypto');
const fs        = require('fs');
const path      = require('path');

const col = () => getDb().collection('booths');

/**
 * Every stand on this show.
 *
 * `mergeSnapshot.parts` is projected away. It holds a FULL copy of every stand
 * the merge absorbed — sponsor logo data URIs and all — and this query is what
 * warms the in-memory cache every broadcast is built from, so a hall with a
 * handful of merges pushed those copies to every connected browser on every
 * single edit. reset() reads the stand itself rather than the cache, so nothing
 * needs the parts here.
 *
 * What is NOT projected away, and must not be: the admin projection is the
 * identity, so whatever survives this query is what the admin console sees. It
 * decides whether to offer Reset from the presence of `mergeSnapshot` or
 * `splitSnapshot`, and maps a child cell's reset back to its parent through
 * `splitSnapshot.created`. Dropping the snapshots wholesale took those buttons
 * off the page while leaving every test green, because no test opens that menu.
 * Both remaining objects are small — a geometry, an area, a price, a list of
 * numbers — so keeping them costs the broadcast almost nothing. The one part
 * of a merge record that is not small is the earlier merge a block split and
 * merged again carries underneath (`self.under`, see nextMergeSnapshot), which
 * holds parts of its own, so it goes the same way.
 */
const all = () => col().find({ showId: config.showId })
  .project({ 'mergeSnapshot.parts': 0, 'mergeSnapshot.self.under': 0 }).toArray();

const get = (boothNumber) => col().findOne({ showId: config.showId, boothNumber });

/**
 * A copy of a stored stand that later writes cannot reach.
 *
 * The rows a driver hands back are not guaranteed to be detached from what a
 * write is about to change — the test stand-in hands back the stored objects
 * themselves — and a rollback that "restores" the object the write already
 * changed restores nothing. structuredClone would do, except that it turns an
 * ObjectId into a plain object; ids and other BSON values are carried by
 * reference instead, since nothing ever writes to one.
 */
function detach(v) {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Date) return new Date(v.getTime());
  if (v._bsontype) return v;
  if (Array.isArray(v)) return v.map(detach);
  const out = {};
  for (const k of Object.keys(v)) out[k] = detach(v[k]);
  return out;
}

/**
 * Projection sent to the public floorplan.
 *
 * Status names are unchanged from the original, and so is the name of the
 * exhibitor on a SOLD stand — naming who has taken a stand is the point of a
 * published floorplan.
 *
 * What is withheld is the negotiated price, the internal deal notes, and every
 * name on a stand that is only on hold. The original broadcast the entire
 * booth record to every visitor, so those were public by accident rather than
 * by intent.
 */
function toPublic(b) {
  return {
    boothNumber: b.boothNumber,
    // svgElementId is deliberately not sent. Stands are bound to the artwork by
    // geometry, not by element id, and no client has read this since that
    // changed — it was 273 strings on every broadcast for nobody. It stays on
    // the document, where the import and the migration scripts still write it.
    status:  b.status,
    // Only on a SOLD stand. A hold is a provisional deal, and the public page
    // already promised never to name one (see the directory in floorplan.js) —
    // but the name was sent regardless, so anyone reading the socket traffic
    // could see who was negotiating for which stand. The tags and the country
    // below were already gated this way; the company is the one that mattered.
    company: b.status === 'sold' ? (b.assignment?.company || null) : null,
    sqm:     b.sqm,
    geometry: b.geometry,
    displayNumber: b.displayNumber || null,   // admin-set label shown in place of boothNumber (identity is unchanged)
    sponsored: b.sponsored === true,          // filled with the floorplan sponsor's brand colour on the plan
    // The sponsor's logo, drawn inside the stand. Only sent for a stand that is
    // actually flagged as sponsored, so clearing the flag takes the logo off
    // the public plan immediately without having to also clear the image.
    sponsorLogo: b.sponsored === true ? (b.sponsorLogo || null) : null,
    // Tag keys the visitor's floorplan resolves against the tag catalogue.
    // Only on a SOLD stand: a hold is a provisional deal, and naming what a
    // not-yet-committed exhibitor does would publish it early.
    tags: b.status === 'sold' && Array.isArray(b.assignment?.tags) ? b.assignment.tags : [],
    // The exhibitor's country (ISO alpha-2), withheld on a hold for the same
    // reason as the tags. The client resolves it to a name and flag.
    country: b.status === 'sold' ? (b.assignment?.country || null) : null,
    splitFrom: b.splitFrom || null,   // lets the client draw + number split cells
    splitAxis: b.splitAxis || null,   // 'vertical' | 'horizontal' — which edge is the divider
    merged: Array.isArray(b.mergedFrom) && b.mergedFrom.length > 0,   // a block the plan draws as several stands
    // Taken off the plan. It is still sent — with its geometry — because the
    // page has to know where the hole is in order to draw hall floor there
    // instead of the stand the artwork still contains. Nothing else about it
    // travels: it is not for sale, not clickable and not in any count.
    removed: b.removed === true,
    viewers: b.viewers || 0,
    interest: b.clicks || 0,
  };
}

const toAdmin = (b) => b;

/**
 * The name a hold carries when nobody gave one. It is a placeholder, not an
 * exhibitor: a hold taken as "Pending" and then booked under a real name is the
 * same deal acquiring its name, not the stand changing hands.
 */
const PLACEHOLDER_NAMES = ['pending'];
const nameKey = (v) => String(v == null ? '' : v).trim().toLowerCase();
const isRealName = (v) => !!nameKey(v) && !PLACEHOLDER_NAMES.includes(nameKey(v));

/**
 * Set a booth's status.
 *
 * `expect` optionally names the prior statuses this change is allowed from, and
 * is applied as a filter on the write itself — so a booking cannot silently
 * overwrite one another admin made a moment earlier. `changed` reports whether
 * the conditional write actually matched, letting the caller warn on a
 * conflict. With no `expect`, the write is unconditional as before.
 *
 * A SALE needs a name. `error: 'no_company'` (with `changed: false`) is the
 * refusal: the console used to book an empty prompt as "Admin", and a stand
 * sold to nobody is a booking nobody can invoice. A hold may stay nameless.
 */
async function setStatus(boothNumber, status, { company = null, actor = null, expect = null,
                                                holdExpiresAt = undefined } = {}) {
  // Stored trimmed: "Acme " and "Acme" are one exhibitor, and a name of only
  // spaces is no name.
  if (typeof company === 'string') company = company.trim() || null;
  const before = await get(boothNumber);
  // A stand that has been taken off the plan cannot be booked, held or
  // released. It reads as missing, which is what every caller already handles.
  if (!before || before.removed === true) return null;
  if (status === 'sold' && !company) return { before, after: before, changed: false, error: 'no_company' };

  const filter = { showId: config.showId, boothNumber };
  if (Array.isArray(expect) && expect.length) filter.status = { $in: expect };

  const $set = {
    status,
    'assignment.company': company,
    updatedAt: new Date(),
    updatedBy: actor,
  };
  // Provenance belongs to the BOOKING, not to the stand. `source` records that
  // a stand's state was put there by an import, and the import guard uses it to
  // decide what may be destroyed — so the moment a person changes that state,
  // it stops being the import's and the mark has to go. It never did: an admin
  // booking a stand with only a company name (which is exactly what booth:book
  // does) left `source` in place, the guard counted the booking as import
  // output, countCommitted returned 0, and the next import deleted paying
  // exhibitors.
  const $unset = { source: '' };
  // The import's own note is provenance too, and re-booking to a different
  // company leaves it describing someone else's name.
  if ((before.assignment?.company || null) !== (company || null) &&
      before.assignment?.notes === IMPORT_NOTE) {
    $set['assignment.notes'] = '';
  }
  // The hold expiry is denormalised onto the stand so the sweep can release it
  // in ONE conditional write (see services/holds.js). It only means anything
  // while the stand is held; left behind on a sold or available stand it is a
  // stale date the next hold would be judged against.
  if (status === 'held') {
    if (holdExpiresAt !== undefined) $set.holdExpiresAt = holdExpiresAt;
  } else {
    $unset.holdExpiresAt = '';
  }
  // The whole deal describes the exhibitor it was agreed with, so none of it
  // can outlive them: re-booking a stand to a DIFFERENT company drops the
  // previous one's price, notes, contact, categories and country rather than
  // letting the new occupant inherit them. Only the tags and country used to
  // go, so Acme's €9,000 and Acme's notes turned up on Beta's booking the
  // moment Beta took the stand Acme had been holding. Re-stating the same
  // company (a hold converting to a sale, say) keeps all of it, and so does a
  // placeholder hold acquiring its real name — that is the same deal.
  const prior = before.assignment?.company || null;
  if (status !== 'available' && isRealName(prior) && nameKey(prior) !== nameKey(company)) {
    $set['assignment.actualPrice'] = null;
    $set['assignment.notes'] = '';
    $set['assignment.contactId'] = null;
    $set['assignment.tags'] = [];
    $set['assignment.country'] = null;
  }

  // Freeing a stand clears its whole deal, so releasing a sale can't leave a
  // stale price/notes/contact lingering on the now-available stand.
  if (status === 'available') {
    $set['assignment.actualPrice'] = null;
    $set['assignment.notes'] = '';
    $set['assignment.contactId'] = null;
    $set['assignment.tags'] = [];
    $set['assignment.country'] = null;
  }
  const res = await col().updateOne(filter, { $set, $unset });
  return { before, after: await get(boothNumber), changed: res.matchedCount === 1 };
}

/**
 * Write the price and notes of the deal on a booked stand.
 *
 * A field left OUT is left alone; `actualPrice: null` clears the price. That
 * distinction is what lets a console send only what the admin actually edited.
 *
 * `expectCompany` is the exhibitor the editor was looking at when it opened.
 * Given, the write refuses (`error: 'changed_hands'`) unless the stand is still
 * theirs — and the write itself is conditional on it — so a price typed for
 * Acme cannot land on the booking Beta made while the panel sat open.
 */
async function updateDeal(boothNumber, { actualPrice, notes, actor = null, expectCompany = undefined }) {
  const before = await get(boothNumber);
  if (!before) return null;
  const holder = before.assignment?.company || null;
  if (expectCompany !== undefined && nameKey(expectCompany) !== nameKey(holder)) {
    return { before, after: before, changed: false, error: 'changed_hands' };
  }

  const $set = { updatedAt: new Date(), updatedBy: actor };
  if (actualPrice !== undefined) {
    if (actualPrice === null || actualPrice === '') {
      $set['assignment.actualPrice'] = null;
    } else {
      // A non-numeric/negative price used to be stored verbatim (NaN, a string,
      // a negative), corrupting the deal record.
      const n = Number(actualPrice);
      if (!Number.isFinite(n) || n < 0) return { before, after: before, changed: false, error: 'bad_price' };
      $set['assignment.actualPrice'] = n;
    }
  }
  if (notes !== undefined) $set['assignment.notes'] = String(notes).slice(0, 2000);

  // A deal only exists on a sold or held stand. Guarding the write means an edit
  // racing a release/expiry can't paint a price and notes onto a stand that just
  // went available (where they'd linger until the next booking overwrote them),
  // and `changed` lets the caller report the conflict. ('sold' — the booked
  // status — was previously the never-matching 'booked', which silently blocked
  // price/notes edits on sold stands.)
  // Same reason as setStatus: agreeing a price or writing a note is a person
  // doing something to this booking, so the import's mark on it comes off and
  // the guard can no longer mistake it for artwork output.
  const filter = { showId: config.showId, boothNumber, status: { $in: ['sold', 'held'] } };
  if (expectCompany !== undefined) filter['assignment.company'] = holder;
  const res = await col().updateOne(filter, { $set, $unset: { source: '' } });
  if (!res.matchedCount && expectCompany !== undefined) {
    // Lost to a change of hands between the read and the write, rather than
    // to the stand going available: say which, so the console can tell the
    // admin to reopen the stand instead of to book it.
    const now = await get(boothNumber);
    if (now && ['sold', 'held'].includes(now.status) && nameKey(now.assignment?.company) !== nameKey(holder)) {
      return { before, after: now, changed: false, error: 'changed_hands' };
    }
  }
  return { before, after: await get(boothNumber), changed: res.matchedCount === 1 };
}

/**
 * Set the tags carried by a booked stand.
 *
 * Tags describe the EXHIBITOR, so they only exist where there is one: setting
 * them is guarded on the stand still being sold or held, exactly like the deal
 * price and notes. `changed: false` means the stand went available underneath
 * the edit and the tags were not written — the caller reports the conflict
 * rather than painting categories onto a now-empty stand.
 *
 * `valid` is the current tag catalogue's key set. Anything outside it is
 * rejected rather than stored, so a stand can never end up displaying a tag
 * that was deleted while the panel was open.
 */
async function setTags(boothNumber, keys, { valid = null, max = 3, actor = null } = {}) {
  const before = await get(boothNumber);
  if (!before) return { ok: false, reason: 'missing_booth' };

  const list = [...new Set(
    (Array.isArray(keys) ? keys : []).map(k => String(k == null ? '' : k).trim()).filter(Boolean)
  )];
  if (list.length > max) return { ok: false, reason: 'too_many', max };
  if (valid) {
    const unknown = list.filter(k => !valid.has(k));
    if (unknown.length) return { ok: false, reason: 'unknown_tag', unknown };
  }

  const res = await col().updateOne(
    { showId: config.showId, boothNumber, status: { $in: ['sold', 'held'] } },
    { $set: { 'assignment.tags': list, updatedAt: new Date(), updatedBy: actor },
      $unset: { source: '' } }          // a person categorised this exhibitor — see setStatus
  );
  return { ok: true, changed: res.matchedCount === 1, tags: list, before, after: await get(boothNumber) };
}

/**
 * Set the country of the exhibitor on a booked stand.
 *
 * Guarded on the stand still being sold or held, exactly like setTags — the
 * country describes an exhibitor, so it must never be painted onto a stand that
 * went available underneath the edit (`changed: false` reports that race).
 *
 * `code` is normalised against the built-in list rather than trusted: an
 * unknown value is rejected outright, so a booth can never store a country the
 * floorplan cannot resolve to a name. Empty clears it.
 */
async function setCountry(boothNumber, code, { actor = null } = {}) {
  const before = await get(boothNumber);
  if (!before) return { ok: false, reason: 'missing_booth' };

  const raw = String(code == null ? '' : code).trim();
  const value = raw ? countries.normalise(raw) : null;
  if (raw && !value) return { ok: false, reason: 'unknown_country' };

  const res = await col().updateOne(
    { showId: config.showId, boothNumber, status: { $in: ['sold', 'held'] } },
    { $set: { 'assignment.country': value, updatedAt: new Date(), updatedBy: actor },
      $unset: { source: '' } }          // a person set this exhibitor's country — see setStatus
  );
  return { ok: true, changed: res.matchedCount === 1, country: value,
           name: value ? countries.nameOf(value) : null, before, after: await get(boothNumber) };
}

/**
 * Strip one tag key off every stand that carries it — the cleanup half of
 * deleting a tag from the catalogue. Returns how many stands were touched.
 */
async function removeTag(key) {
  const res = await col().updateMany(
    { showId: config.showId, 'assignment.tags': key },
    { $pull: { 'assignment.tags': key }, $set: { updatedAt: new Date() } }
  );
  return res.modifiedCount;
}

async function incrementClicks(boothNumber) {
  await col().updateOne({ showId: config.showId, boothNumber }, { $inc: { clicks: 1 } });
}

/**
 * Reprice every stand's LIST price off a new €/unit rate: listPrice = sqm × rate.
 * Negotiated deal prices (assignment.actualPrice) are deliberately left alone —
 * changing the rate must never silently rewrite an agreed price. Returns how
 * many stands were repriced.
 */
async function recomputeListPrices(rate, { actor = null } = {}) {
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) return { ok: false, reason: 'bad_rate' };
  const read = (filter = {}) => col().find({ showId: config.showId, ...filter })
    .project({ boothNumber: 1, sqm: 1, listPrice: 1, mergeSnapshot: 1, splitSnapshot: 1, shapeRev: 1 }).toArray();
  let pending = await read();
  if (!pending.length) return { ok: true, repriced: 0 };
  const total = pending.length;
  const at = (sqm) => Math.round((sqm || 0) * r);

  // The composite snapshots hold their own prices — the footprint a merged
  // stand had before it was merged, and the full record of every stand it
  // absorbed. A rate change that did not reach into them meant Reset restored
  // PRE-RATE-CHANGE prices onto live stands, quietly putting the old rate back
  // on the plan months after it was raised. A merge laid over a split carries
  // the earlier merge underneath (see nextMergeSnapshot), which is repriced the
  // same way.
  const repriceMerge = (snap) => {
    const self = { ...snap.self, listPrice: at(snap.self && snap.self.sqm) };
    if (self.under && self.under.mergeSnapshot) {
      self.under = { ...self.under, mergeSnapshot: repriceMerge(self.under.mergeSnapshot) };
    }
    return { ...snap, self, parts: (snap.parts || []).map(part => ({ ...part, listPrice: at(part.sqm) })) };
  };
  const repriced = (b) => b.listPrice === at(b.sqm) &&
    (!b.mergeSnapshot || JSON.stringify(repriceMerge(b.mergeSnapshot)) === JSON.stringify(b.mergeSnapshot)) &&
    (!b.splitSnapshot || (b.splitSnapshot.self && b.splitSnapshot.self.listPrice === at(b.splitSnapshot.self.sqm)));

  // Every write is conditional on the revision it was computed from (see
  // revFilter). The snapshots are rewritten whole, so one computed from a read
  // taken before a merge used to write that merge's record back to what it was
  // before the merge, and the stand it absorbed vanished from it. A stand
  // reshaped in the gap simply misses, and is read again and repriced from
  // what it is now. A merge that read the old price before this write misses
  // in its turn, because this write moves the revision on.
  for (let pass = 0; pass < 5 && pending.length; pass++) {
    const now = new Date();
    const ops = pending.map(b => {
      const $set = { listPrice: at(b.sqm), updatedAt: now, updatedBy: actor };
      if (b.mergeSnapshot) $set.mergeSnapshot = repriceMerge(b.mergeSnapshot);
      if (b.splitSnapshot) {
        const snap = b.splitSnapshot;
        $set.splitSnapshot = { ...snap, self: { ...snap.self, listPrice: at(snap.self && snap.self.sqm) } };
      }
      return { updateOne: { filter: { showId: config.showId, boothNumber: b.boothNumber, ...revFilter(b) },
                            update: { $set, $inc: BUMP } } };
    });
    // One round trip rather than one per stand: this ran ~270 sequential
    // updates on a rate change, which is minutes of an admin watching a spinner.
    await col().bulkWrite(ops, { ordered: false });
    pending = (await read({ boothNumber: { $in: pending.map(b => b.boothNumber) } })).filter(b => !repriced(b));
  }
  if (pending.length) {
    console.error(`Rate change: ${pending.length} stand(s) kept changing under the repricing —`,
                  pending.map(b => b.boothNumber).join(', '));
  }
  return { ok: true, repriced: total - pending.length };
}

// Flag (or unflag) a stand as the floorplan sponsor's — it then renders in the
// sponsor's brand colour. Identity/status/booking are untouched; this is a
// presentation flag only.
async function setSponsored(boothNumber, on, { actor = null } = {}) {
  const res = await col().updateOne(
    { showId: config.showId, boothNumber },
    { $set: { sponsored: on === true, updatedAt: new Date(), updatedBy: actor } });
  return { ok: res.matchedCount === 1, sponsored: on === true };
}

// The largest inline logo we will store. Matches the partner-logo cap: a data
// URI beyond this used to be truncated into a corrupt image, so it is rejected
// outright and the admin is told, rather than saved broken.
const MAX_LOGO = 2_000_000;

/**
 * Set (or clear) the sponsor logo drawn inside a stand.
 *
 * Guarded on the stand being flagged `sponsored` — a logo is the sponsor's, so
 * it cannot be attached to a stand that has no sponsor. `changed: false` means
 * the flag was taken off underneath the edit, which the caller reports rather
 * than storing an image nothing will ever draw.
 *
 * Only an inline `data:image/…` URI is accepted — deliberately narrower than
 * the safeImage used for partner logos, which also allows an http(s) URL. Two
 * reasons, both about where this ends up. It is drawn into the plan's SVG, and
 * the "Download Floorplan" PNG rasterises that SVG through an <img>: an
 * external reference is not fetched in that context, so a hosted logo would
 * simply be missing from every download, and could taint the canvas outright.
 * It also means the public plan never fetches from a third-party host.
 * An empty value clears it.
 */
async function setSponsorLogo(boothNumber, image, { actor = null } = {}) {
  const before = await get(boothNumber);
  if (!before) return { ok: false, reason: 'missing_booth' };

  const raw = typeof image === 'string' ? image.trim() : '';
  if (raw.length > MAX_LOGO) return { ok: false, reason: 'too_large' };
  // safeImage first (it rejects data:text/html and friends), then narrow to the
  // inline forms for the reasons in the header.
  const safe = raw ? safeImage(raw) : '';
  const value = /^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(safe) ? safe : '';
  if (raw && !value) return { ok: false, reason: 'bad_image' };

  const res = await col().updateOne(
    { showId: config.showId, boothNumber, sponsored: true },
    { $set: { sponsorLogo: value || null, updatedAt: new Date(), updatedBy: actor } }
  );
  return { ok: true, changed: res.matchedCount === 1, logo: value || null,
           before, after: await get(boothNumber) };
}

const escapeRe = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The comparison form of a shown number: one casing, so "A12" and "a12" cannot
 * both exist. Stored alongside the label (which keeps the admin's own casing)
 * and indexed, so uniqueness is enforced by the DATABASE rather than by a
 * check-then-write that two admins can both pass at once.
 */
const displayKey = (v) => String(v == null ? '' : v).trim().toLowerCase();

// Clearing the label clears its key with it, or the stand would go on blocking
// a number it no longer shows.
const CLEAR_DISPLAY = { displayNumber: '', displayNumberKey: '' };

/**
 * Indexes this model needs beyond the ones db.js creates at connect time.
 *
 * Partial, because only a minority of stands carry a shown number and a plain
 * unique index would collide every stand that has none against every other.
 * Safe to call repeatedly. It can legitimately fail on data that already holds
 * duplicates — that is the point — so it reports rather than throwing into
 * boot.
 */
async function ensureIndexes() {
  const out = [];
  const make = async (spec, options) => {
    try { out.push({ ok: true, index: await col().createIndex(spec, options) }); }
    catch (e) { out.push({ ok: false, name: options.name, error: e.message }); }
  };
  await make({ showId: 1, displayNumberKey: 1 },
             { unique: true, name: 'show_shown_number_unique',
               partialFilterExpression: { displayNumberKey: { $type: 'string' } } });
  // The snapshots behind restore-snapshot.js: found by id, and expired by TTL so
  // a recovery collection cannot grow without bound.
  const snaps = getDb().collection('booths_snapshots');
  try { await snaps.createIndex({ showId: 1, snapshotId: 1 }, { name: 'show_snapshot' }); }
  catch (e) { out.push({ ok: false, name: 'show_snapshot', error: e.message }); }
  try {
    await snaps.createIndex({ at: 1 },
      { expireAfterSeconds: SNAPSHOT_TTL_DAYS * 86400, name: 'snapshot_ttl' });
  } catch (e) { out.push({ ok: false, name: 'snapshot_ttl', error: e.message }); }
  return out;
}

/**
 * Set (or clear) the human-facing "shown number" for a stand.
 *
 * This is a DISPLAY LABEL only. `boothNumber` stays the immutable identity that
 * holds, enquiries, activity history and split/merge records all reference — so
 * this never cascades and is fully reversible. Its purpose is to let an admin
 * make the app show the printed artwork number (e.g. "1037") on a stand whose
 * internal key is a positional index (e.g. "198").
 *
 * An empty value clears the override. The label must be unique across the show —
 * it can't collide with another stand's shown number OR with any stand's real
 * identity, or two stands would read as the same number.
 *
 * The label is part of what a merge stores of a stand it absorbs, so changing
 * it moves the stand's shape revision on (see revFilter): a merge that read the
 * stand before the change misses, rather than storing the old label for a
 * reset to bring back.
 */
async function setDisplayNumber(boothNumber, value, { actor = null } = {}) {
  const booth = await get(boothNumber);
  if (!booth) return { ok: false, reason: 'missing_booth' };

  const raw = String(value == null ? '' : value).trim().slice(0, 20);

  if (!raw) {                          // clear the override
    await col().updateOne({ showId: config.showId, boothNumber },
      { $unset: CLEAR_DISPLAY, $set: { updatedAt: new Date(), updatedBy: actor }, $inc: BUMP });
    return { ok: true, cleared: true, before: booth, after: await get(boothNumber) };
  }

  if (!/^[A-Za-z0-9 /.\-]{1,20}$/.test(raw)) return { ok: false, reason: 'bad_value' };
  if (raw === boothNumber) {            // "showing its own identity" = no override needed
    await col().updateOne({ showId: config.showId, boothNumber },
      { $unset: CLEAR_DISPLAY, $set: { updatedAt: new Date(), updatedBy: actor }, $inc: BUMP });
    return { ok: true, cleared: true, before: booth, after: await get(boothNumber) };
  }

  // Reject a label that another stand already shows, or that is any stand's real
  // identity — otherwise two stands would present the same number.
  //
  // Compared WITHOUT case, because two stands reading "A12" and "a12" are two
  // stands presenting the same number to anyone looking at the plan. This check
  // was case-sensitive while splitCustom's own de-duplication was not, so the
  // two disagreed about what a duplicate is.
  const clash = await col().findOne({
    showId: config.showId,
    boothNumber: { $ne: boothNumber },
    $or: [{ displayNumberKey: displayKey(raw) },
          { boothNumber: { $regex: `^${escapeRe(raw)}$`, $options: 'i' } }],
  });
  if (clash) return { ok: false, reason: 'duplicate', clashWith: clash.boothNumber };

  await col().updateOne({ showId: config.showId, boothNumber },
    { $set: { displayNumber: raw, displayNumberKey: displayKey(raw),
              updatedAt: new Date(), updatedBy: actor }, $inc: BUMP });
  return { ok: true, value: raw, before: booth, after: await get(boothNumber) };
}

/**
 * Move a booking from one stand to another — an exhibitor upgrading or
 * downgrading their space. The company (and any notes) move to the destination;
 * the source is freed. Because size and list price belong to the STAND, the
 * exhibitor's size and cost update to the new space automatically. A negotiated
 * per-m² rate is preserved and re-applied to the new size; if they were on the
 * list price, they stay on the (new) list price.
 *
 * Writes are conditional and destination-first, so a booking is never lost or
 * double-created if another admin acts on either stand at the same time.
 */
async function move(fromNum, toNum, { actor = null } = {}) {
  if (fromNum === toNum) return { ok: false, reason: 'same_booth' };
  const from = detach(await get(fromNum));
  const to   = detach(await get(toNum));
  if (!from || !to) return { ok: false, reason: 'missing_booth' };
  // Only a sale or a hold is a booking to move. Anything else used to count —
  // a stand taken off the plan included, whose 'removed' status landed on the
  // destination without the flag that goes with it, while the source came
  // back 'available' still flagged as removed.
  if (from.removed === true || !['sold', 'held'].includes(from.status)) return { ok: false, reason: 'nothing_to_move' };
  if (to.removed === true || to.status !== 'available') return { ok: false, reason: 'to_not_available' };

  const movedStatus = from.status;   // captured before any write, so it can't alias
  const a = from.assignment || {};
  // Preserve their negotiated rate: €/m² on the old stand × the new size. No
  // negotiated price means they were on list, so leave it on the new list.
  let newActual = null;
  if (a.actualPrice != null && from.sqm > 0) newActual = Math.round((a.actualPrice / from.sqm) * (to.sqm || 0));

  const assignment = { company: a.company || null, contactId: a.contactId || null, actualPrice: newActual,
                       notes: a.notes || '', tags: Array.isArray(a.tags) ? a.tags : [], country: a.country || null };

  // A HELD booking is a countdown, and the countdown moves with it unchanged.
  // Its hold DOCUMENT is the record of that hold — who placed it, for which
  // contact and session, until when — and it is re-pointed rather than
  // replaced. The socket layer used to drop it and write a fresh 24-hour one,
  // so a 7-day hold with a day left became 24 hours, an expired hold not yet
  // swept was revived, a hold with no expiry at all became 24 hours, and the
  // contact and session were lost.
  const holdsCol = getDb().collection('holds');
  const holdDocs = movedStatus === 'held'
    ? await holdsCol.find({ showId: config.showId, boothNumber: fromNum }).toArray() : [];
  const holdDoc = holdDocs[0] || null;
  // The expiry the stand carries, or failing that its document's: a date, null
  // (never expires) — or, for a hold that has neither, nothing, so the
  // destination is judged by its document exactly as the source was.
  const carriedExpiry = from.holdExpiresAt !== undefined ? from.holdExpiresAt
    : (holdDoc ? (holdDoc.expiresAt ?? null) : undefined);

  // Claim the destination FIRST, only while it is still available — so we can
  // never overwrite a booking that landed on it a moment ago.
  //
  // The expiry has to land on the destination in this same write: a stand
  // marked held with no expiry and no document is exactly what the sweep
  // reclaims, so until the document follows, the expiry is what keeps the
  // stand an exhibitor was just moved onto from going back on sale.
  // `source` goes for the reason in setStatus: a person moved this.
  const $claim = { status: movedStatus, assignment, updatedAt: new Date(), updatedBy: actor };
  if (movedStatus === 'held' && carriedExpiry !== undefined) $claim.holdExpiresAt = carriedExpiry;
  const claim = await col().updateOne(
    { showId: config.showId, boothNumber: toNum, status: 'available', removed: { $ne: true } },
    { $set: $claim, $unset: { source: '' } }
  );
  if (!claim.matchedCount) return { ok: false, reason: 'to_not_available' };

  // The hold document follows the booking before the source is freed, so a
  // stop between the two leaves one hold on two held stands — visible, and
  // put right by a release — rather than a document stranded on a stand that
  // is for sale, where the next hold on it fails on one-hold-per-stand.
  if (holdDoc) {
    await holdsCol.deleteMany({ showId: config.showId, boothNumber: toNum });   // a leftover on the free destination
    await holdsCol.updateOne({ _id: holdDoc._id },
      { $set: { boothNumber: toNum, movedFrom: fromNum, movedAt: new Date(), movedBy: actor } });
    // A stand only ever holds one; any duplicate an older version left goes.
    if (holdDocs.length > 1) await holdsCol.deleteMany({ showId: config.showId, boothNumber: fromNum });
  }

  // Free the source, only if it still holds the booking we just moved.
  const freed = await col().updateOne(
    { showId: config.showId, boothNumber: fromNum, status: movedStatus },
    { $set: { status: 'available', assignment: { company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null }, updatedAt: new Date(), updatedBy: actor },
      $unset: { source: '', holdExpiresAt: '' } }
  );
  if (!freed.matchedCount) {
    // The source changed under us between read and free (another admin released
    // it, or converted a hold to a booking) — the precondition no longer holds.
    // Roll the destination claim back to available so we never leave the same
    // company occupying both stands, and report the conflict. The rollback is
    // itself conditional on our own write still standing, so it can't clobber a
    // booking a third admin may have just placed on the destination.
    await col().updateOne(
      { showId: config.showId, boothNumber: toNum, status: movedStatus, 'assignment.company': assignment.company },
      { $set: { status: 'available', assignment: { company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null }, updatedAt: new Date(), updatedBy: actor },
        $unset: { holdExpiresAt: '' } }
    );
    if (holdDoc) {
      await holdsCol.updateOne({ _id: holdDoc._id },
        { $set: { boothNumber: fromNum }, $unset: { movedFrom: '', movedAt: '', movedBy: '' } });
    }
    return { ok: false, reason: 'move_conflict' };
  }

  return {
    ok: true, status: movedStatus, company: a.company || null,
    from: fromNum, to: toNum,
    fromSqm: from.sqm, toSqm: to.sqm,
    fromListPrice: from.listPrice, toListPrice: to.listPrice,
    newActualPrice: newActual,
    holdExpiresAt: movedStatus === 'held' ? (carriedExpiry ?? null) : undefined,
  };
}

async function stats() {
  const [agg] = await col().aggregate([
    // A stand taken off the plan is not floor space the show has to sell, so it
    // leaves every total — the count, the square metres and the revenue alike.
    { $match: { showId: config.showId, removed: { $ne: true } } },
    { $group: {
        _id: null,
        totalBooths: { $sum: 1 },
        totalSqm:    { $sum: '$sqm' },
        availableBooths: { $sum: { $cond: [{ $eq: ['$status', 'available'] }, 1, 0] } },
        soldBooths:      { $sum: { $cond: [{ $eq: ['$status', 'sold'] },      1, 0] } },
        heldBooths:      { $sum: { $cond: [{ $eq: ['$status', 'held'] },      1, 0] } },
        availSqm: { $sum: { $cond: [{ $eq: ['$status', 'available'] }, '$sqm', 0] } },
        soldSqm:  { $sum: { $cond: [{ $eq: ['$status', 'sold'] },      '$sqm', 0] } },
        heldSqm:  { $sum: { $cond: [{ $eq: ['$status', 'held'] },      '$sqm', 0] } },
        availRev: { $sum: { $cond: [{ $eq: ['$status', 'available'] }, '$listPrice', 0] } },
    } },
  ]).toArray();

  // The revenue on a BOOKED stand is the price agreed for it where one was
  // agreed, and its list price only where none was. "Revenue Earned" summed
  // list prices whatever the deal said, so a stand sold at a discount, or at a
  // premium, was counted at a price nobody is paying. Summed here rather than
  // in the pipeline above: a negotiated price that is missing and one that is
  // null have to read the same, which the aggregation's own comparison does
  // not do.
  const booked = await col().find({ showId: config.showId, removed: { $ne: true }, status: { $in: ['sold', 'held'] } })
    .project({ status: 1, listPrice: 1, assignment: 1 }).toArray();
  const agreed = (b) => (b.assignment && b.assignment.actualPrice != null ? Number(b.assignment.actualPrice) || 0 : (b.listPrice || 0));
  const earnedRev = booked.filter(b => b.status === 'sold').reduce((sum, b) => sum + agreed(b), 0);
  const heldRev = booked.filter(b => b.status === 'held').reduce((sum, b) => sum + agreed(b), 0);

  const base = { totalBooths: 0, availableBooths: 0, soldBooths: 0, heldBooths: 0,
                 totalSqm: 0, availSqm: 0, soldSqm: 0, heldSqm: 0,
                 totalRevenue: 0, earnedRev: 0, availRev: 0, heldRev: 0 };
  const { _id, ...rest } = agg || {};
  const out = { ...base, ...rest, earnedRev, heldRev };
  // The floor's value is what its three parts add up to — agreed for what is
  // booked, list for what is still for sale — so the breakdown's rows and its
  // total row agree.
  out.totalRevenue = out.availRev + earnedRev + heldRev;
  return out;
}

/**
 * Where a stand actually sits on the plan.
 *
 * A stand's stored geometry is its artwork rectangle's x/y/width/height AS
 * WRITTEN, because that is what the page reads when it binds a stand to its
 * shape. Illustrator writes a rotated stand as a rectangle plus a
 * `translate(…) rotate(90)` transform, so for those the written box is not
 * where the shape appears: it is the shape turned on its side about another
 * origin. Europe's plan has whole rows of them — 649, 750, 651 and 653 among
 * them. Every merge and split used to reason about the written boxes, so two
 * stands drawn flush side by side (651 and 653) were refused as "not next to
 * each other with no gaps", and a split of such a stand carved a rectangle
 * that was not where the stand is.
 *
 * The footprint comes from the artwork itself: the current plan's rectangles
 * are read with their rotation resolved, and the stand's written box is
 * matched to one of them. A geometry that matches no rectangle — a merged
 * block, a split cell — was produced by this code in footprint space already
 * and is used as it is. Snapshots keep the written box, so a reset puts back
 * exactly what the artwork binds to.
 */
let artworkRectCache = { key: null, rects: [] };
async function artworkRects() {
  const stored = await floorplans.get();
  let key, read;
  if (stored && stored.svg) {
    key = `${config.showId}:${stored.version || stored.svg.length}`;
    read = () => stored.svg;
  } else {
    const file = path.join(__dirname, '..', '..', 'public', String(config.floorplanSvg).replace(/^\//, ''));
    key = `${config.showId}:shipped:${file}`;
    read = () => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; } };
  }
  if (artworkRectCache.key !== key) {
    const svg = read();
    artworkRectCache = { key, rects: svg ? readRects(svg) : [] };
  }
  return artworkRectCache.rects;
}

function footprintOf(geometry, rects) {
  if (!geometry) return geometry;
  const near = (a, b) => Math.abs(a - b) < 0.05;
  const hit = rects.find(r => near(r.raw.x, geometry.x) && near(r.raw.y, geometry.y) &&
                              near(r.raw.w, geometry.w) && near(r.raw.h, geometry.h));
  return hit ? { x: hit.x, y: hit.y, w: hit.w, h: hit.h } : geometry;
}

async function footprints(docs) {
  const rects = await artworkRects();
  return docs.map(d => footprintOf(d && d.geometry, rects));
}

/**
 * Do two stand rectangles share an edge (touch), within a small tolerance?
 *
 * Merge only makes sense for stands that are actually next to each other. If it
 * is allowed between distant stands, the merged geometry — the bounding box of
 * the two — spans the whole gap between them, producing one giant rectangle
 * that overlaps every unrelated stand in between. Do it a few times and the
 * booth grows across the hall (the "booth got bigger and bigger" bug).
 */
function adjacent(g1, g2, tol = 3) {
  const a2x = g1.x + g1.w, a2y = g1.y + g1.h;
  const b2x = g2.x + g2.w, b2y = g2.y + g2.h;
  const xOverlap = Math.min(a2x, b2x) - Math.max(g1.x, g2.x);
  const yOverlap = Math.min(a2y, b2y) - Math.max(g1.y, g2.y);
  // "Aligned" in an axis = the two cover (nearly) the same span there, i.e. they
  // share that whole edge — columns line up for a vertical stack, rows for a
  // side-by-side. Measured against the SMALLER extent so equal-size stands match.
  const xAligned = xOverlap >= Math.min(g1.w, g2.w) - tol;
  const yAligned = yOverlap >= Math.min(g1.h, g2.h) - tol;
  // Aligned in BOTH axes = one footprint sits on/inside the other (a nested stand
  // or an exact duplicate) — corruption, never a merge.
  if (xAligned && yAligned) return false;
  // A vertical stack (columns aligned, offset top-to-bottom) or a side-by-side
  // (rows aligned, offset left-to-right).
  if (!xAligned && !yAligned) return false;
  // How far apart they are along the OFFSET axis. Negative is the small overlap
  // some plans store between stacked stands (e.g. LEX27's ~54-stride, 80-tall
  // boxes), which the old touch-only rule wrongly refused, blocking every
  // vertical merge. POSITIVE is a real gap, and it has to be bounded here in
  // DRAWING UNITS: contiguousMerge's 15% area allowance scales with the stands,
  // so on an 80-unit-tall pair it tolerated a ~12-unit gap — wide enough to
  // swallow an aisle and merge across it.
  const gap = xAligned
    ? Math.max(g1.y, g2.y) - Math.min(a2y, b2y)
    : Math.max(g1.x, g2.x) - Math.min(a2x, b2x);
  return gap <= tol;
}

/**
 * Would merging these two produce a CONTIGUOUS rectangle? Two same-height (or
 * same-width) edge-adjacent stands tile their bounding box exactly; an L-shape
 * (different heights) leaves an empty corner that would overlap whatever sits
 * there. Require the box area to be within a whisker of the summed areas.
 */
function contiguousMerge(g1, g2) {
  const box = { w: Math.max(g1.x + g1.w, g2.x + g2.w) - Math.min(g1.x, g2.x),
                h: Math.max(g1.y + g1.h, g2.y + g2.h) - Math.min(g1.y, g2.y) };
  return box.w * box.h <= (g1.w * g1.h + g2.w * g2.h) * 1.15;
}

/**
 * When a shaping happened — the ordering a chain of them depends on.
 *
 * A stand may be merged and then split, or split and then merged, and it then
 * carries both snapshots. Only the LATER one can be undone: putting back a
 * footprint from under a shaping that came after it restores a stand on top of
 * cells that still exist, and doubles the area of the hall. Every snapshot
 * written from now on is stamped; rows written before this carry no stamp and
 * only ever hold one snapshot, so nothing is ever compared against nothing.
 */
const stampOf = (snap) => (snap ? (snap.at ? new Date(snap.at).getTime() : 0) : -1);
/** Is the split the most recent thing done to this stand? */
const splitIsLatest = (b) => !!(b && b.splitSnapshot) && stampOf(b.splitSnapshot) >= stampOf(b.mergeSnapshot);
/**
 * The stamp for a new shaping of this stand: now, and in any case later than
 * every shaping it already carries. Two inside one millisecond — a script, a
 * merge selection that undoes a split, a test — used to tie, and a tie reads
 * as the split being the later, whichever actually came last.
 */
const stampAfter = (b) => new Date(Math.max(Date.now(),
  stampOf(b && b.splitSnapshot) + 1, stampOf(b && b.mergeSnapshot) + 1));

/**
 * Which version of its shape a stand is at.
 *
 * Every reshaping reads a stand, decides, and then writes, and two admins can
 * do that to the same stand at once. The writes used to be conditional only on
 * the stand still being available — which both admins' stands still were. Merge
 * A+B and A+C at the same moment and the second write replaced the first one's
 * merge record: C was deleted and in no record at all, 18 m² of a 27 m² block,
 * and no Reset could bring it back. Two splits at once half-split the hall, and
 * a rate change wrote back a merge record read from before the merge.
 *
 * So every write that changes a stand's shape or its shaping records bumps
 * `shapeRev`, and every one is conditional on the revision it was computed
 * from. The write that loses the race matches nothing, and the operation undoes
 * whatever it had already done. A stand never reshaped has no revision; null in
 * a filter matches a missing field as well as a stored null.
 */
const revFilter = (b) => ({ shapeRev: (b && b.shapeRev != null) ? b.shapeRev : null });
const BUMP = { shapeRev: 1 };
/** The revision a stand is at once OUR write to it has landed. */
const ourRev = (b) => ((b && b.shapeRev) || 0) + 1;

/** Why a conditional write on this stand matched nothing: gone, booked, or reshaped under us. */
async function whyMissed(boothNumber) {
  const b = await get(boothNumber);
  if (!b || b.removed === true) return 'missing_booth';
  if (b.status !== 'available' || (b.assignment && b.assignment.company)) return 'not_available';
  return 'changed';
}

/**
 * Put fields of a stand back to what they were before a write of ours, when a
 * later step of the same operation failed.
 *
 * `prior` must be a detached copy (see detach): the failed-merge rollback used
 * to "restore" the very snapshot object the merge had already extended, which
 * restored the extension. Conditional on our write still being the last one,
 * so it can never undo somebody else's change; a field the stand did not have
 * before is removed rather than set to null.
 */
async function putBack(boothNumber, prior, fields, actor) {
  const $set = { updatedAt: new Date(), updatedBy: actor }, $unset = {};
  for (const k of fields) { if (prior[k] === undefined) $unset[k] = ''; else $set[k] = prior[k]; }
  const update = { $set, $inc: BUMP };
  if (Object.keys($unset).length) update.$unset = $unset;
  return col().updateOne({ showId: config.showId, boothNumber, shapeRev: ourRev(prior) }, update);
}

// Areas are stored to the hundredth (a printed 12.5 m² stays 12.5); a sum is
// rounded back to that so a merge cannot add floating-point dust.
const area2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const decimalsOf = (n) => { const s = String(n); const i = s.indexOf('.'); return i < 0 || /e/i.test(s) ? 0 : s.length - i - 1; };

/**
 * Divide `total` in proportion to `weights` so the parts add back to the total
 * EXACTLY, at the precision the total is stored to (whole numbers for a price,
 * hundredths at most for an area).
 *
 * Largest remainder: each part gets its share rounded down to that precision,
 * and what is left goes one unit at a time to the parts the rounding cut most —
 * the earliest first on a tie, so an equal split of 9 is 5 + 4. The old rule
 * floored to WHOLE numbers and handed the remainder to the first cells, which
 * is right for whole m² and wrong for anything else: 12.5 m² in two came out
 * 7 + 6 = 13, and 12.3 in three came out 13. A custom split rounded each part's
 * price on its own, so €1,001 in thirds came to €1,002.
 */
function apportion(total, weights) {
  const t = Number(total) || 0;
  const scale = 10 ** Math.min(2, decimalsOf(t));
  const units = Math.round(t * scale);
  const sumW = weights.reduce((s, w) => s + (Number(w) || 0), 0) || 1;
  const raw = weights.map(w => units * (Number(w) || 0) / sumW);
  const out = raw.map(r => Math.floor(r + 1e-9));
  let left = units - out.reduce((s, v) => s + v, 0);
  const order = raw.map((r, i) => [r - out[i], i]).sort((p, q) => (q[0] - p[0]) || (p[1] - q[1]));
  for (let k = 0; left > 0 && order.length; k = (k + 1) % order.length, left--) out[order[k][1]]++;
  return out.map(u => u / scale);
}

/**
 * What a merge keeps of a stand it absorbs: the whole record as it was, so a
 * reset can put it back exactly — less its database id, which a re-inserted
 * stand does not need and which does not survive being copied.
 */
const partOf = (d) => { const { _id, ...rest } = detach(d); return rest; };

/**
 * The merge record a block carries once it has absorbed `others`.
 *
 * Growing a block whose merge is the latest thing done to it EXTENDS that
 * record: `self` stays the footprint before the FIRST merge, so one reset
 * still walks all the way back to the stands it started as.
 *
 * But a block that has been split since its merge is not the hall that record
 * describes any more — the split carved part of the merged footprint into
 * cells that are still on the plan. Extending the old record re-stamped it as
 * the newest shaping, and the next Reset put the pre-merge stands back over
 * the live cells: merge A+X, split A, merge A+B, reset A, and X came back on
 * top of A-2 — 36 m² in a 27 m² hall, with no way to take it out again. So a
 * merge laid over a split starts a record of its own, whose `self` is the
 * stand as it stands now, carrying the earlier merge underneath it to be put
 * back when this one is undone.
 */
function nextMergeSnapshot(survivor, others, at) {
  const parts = others.map(partOf);
  const prev = survivor.mergeSnapshot;
  if (prev && !splitIsLatest(survivor)) {
    return { ...detach(prev), parts: [...(prev.parts || []).map(detach), ...parts], at };
  }
  const self = { geometry: detach(survivor.geometry), sqm: survivor.sqm, listPrice: survivor.listPrice };
  if (prev) self.under = { mergeSnapshot: detach(prev), mergedFrom: [...(survivor.mergedFrom || [])] };
  return { self, parts, at };
}

/**
 * Putting a split back together, cell for cell, IS undoing the split.
 *
 * Merging them as if they were ordinary neighbours would work arithmetically —
 * the cells sum back to the whole, because a split divides exactly — but it
 * would leave the stand wearing the first cell's label ("500a") across the
 * whole of the original, bound to a footprint the artwork does not draw, and
 * with the split's own snapshot still hanging off it. Undoing the split gives
 * back the stand that was there: its number, its written box, its size.
 *
 * Only when the SELECTION IS EXACTLY the split — every cell, nothing else — and
 * only when the split is the last thing that happened to the parent. A merge
 * laid on top of it has to come off first.
 *
 * @returns the parent stand, or null when this selection is not that.
 */
function wholeSplitOf(docs, nums) {
  return docs.find(d => splitIsLatest(d)
    && Array.isArray(d.splitSnapshot.created)
    && d.splitSnapshot.created.length + 1 === nums.length
    && nums.includes(d.boothNumber)
    && d.splitSnapshot.created.every(c => nums.includes(c))) || null;
}

/**
 * Merge `secondary` into `primary`: the primary absorbs the combined area, list
 * price and footprint, and the secondary is deleted. The geometry becomes the
 * bounding box of the two, so the merged stand still maps onto the plan.
 */
async function consolidate(primaryNum, secondaryNum, { actor = null } = {}) {
  // Detached: these are what a failed merge is rolled back to.
  let a = detach(await get(primaryNum));
  let b = detach(await get(secondaryNum));
  if (!a || !b) return { ok: false, reason: 'missing_booth' };
  if (primaryNum === secondaryNum) return { ok: false, reason: 'same_booth' };

  // A two-cell split being put back together is that split being undone.
  const whole2 = wholeSplitOf([a, b], [primaryNum, secondaryNum]);
  if (whole2) {
    const r = await reset(whole2.boothNumber, { actor });
    return r.ok ? { ok: true, primary: await get(whole2.boothNumber), unsplit: true } : r;
  }

  // Where the two stands actually are on the plan (see footprintOf).
  let [fa, fb] = await footprints([a, b]);

  // Always keep the TOP-LEFT stand as the survivor (its number stays) — the
  // natural "keep the top / first" expectation — regardless of which stand was
  // picked as Primary. Compare top edge first, then left edge.
  if (fa && fb && (((fb.y - fa.y) || (fb.x - fa.x)) < 0)) {
    [primaryNum, secondaryNum] = [secondaryNum, primaryNum];
    [a, b] = [b, a];
    [fa, fb] = [fb, fa];
  }

  // Only merge available stands. Consolidating a sold or held stand would delete
  // its booking along with the record and orphan any hold document — refuse it.
  // The company checks lock a purchased stand even if its status glitched to
  // 'available', so a paid booking can never be absorbed and lost.
  if (a.status !== 'available' || b.status !== 'available' ||
      (a.assignment && a.assignment.company) || (b.assignment && b.assignment.company)) {
    return { ok: false, reason: 'not_available' };
  }

  // A stand shaped by a split may now be merged — merging two cells back
  // together, or a cell into the stand next door, is a thing people do. What it
  // cannot do is NEST: the secondary is about to be deleted, and a merge of its
  // own would go with it, so a secondary that is itself a merged block has to
  // be reset first. (Growing an existing merge is fine — that is the primary.)
  //
  // Carrying a merge AND a split at once is now legitimate, and `reset` undoes
  // whichever came last; see the `at` stamps below.
  if (b.mergeSnapshot) return { ok: false, reason: 'reset_first' };

  // The two stands must actually touch AND tile a contiguous rectangle —
  // otherwise the merged bounding box swallows everything between/around them.
  if (fa && fb && (!adjacent(fa, fb) || !contiguousMerge(fa, fb))) {
    return { ok: false, reason: 'not_adjacent' };
  }

  // The merged block is stored where it appears: the page draws it as its own
  // shape at exactly this box, so it has to be the footprint, not the written
  // one.
  const g1 = fa, g2 = fb;
  const box = (g1 && g2) ? {
    x: Math.min(g1.x, g2.x), y: Math.min(g1.y, g2.y),
    w: Math.max(g1.x + g1.w, g2.x + g2.w) - Math.min(g1.x, g2.x),
    h: Math.max(g1.y + g1.h, g2.y + g2.h) - Math.min(g1.y, g2.y),
  } : (g1 || g2 || null);

  // Snapshot for a later reset — see nextMergeSnapshot for what it holds and
  // why a merge over a split starts a record of its own. Stamped with when it
  // happened: a stand may carry a merge and a split at once, and reset has to
  // undo the LATER one.
  const at = stampAfter(a);
  const mergeSnapshot = nextMergeSnapshot(a, [b], at);

  const $set = {
    sqm: area2((a.sqm || 0) + (b.sqm || 0)),
    listPrice: (a.listPrice || 0) + (b.listPrice || 0),
    mergedFrom: [...(a.mergedFrom || []), secondaryNum],
    mergeSnapshot,
    updatedAt: at, updatedBy: actor,
  };
  if (box) $set.geometry = box;   // never $set an undefined geometry

  // The status re-checks above are only a read; between them and the writes
  // another admin could book either stand, or reshape it. Both writes are
  // therefore conditional on the stand still being available AND still at the
  // revision read (see revFilter), and if the second fails we undo the first —
  // so a booking made mid-merge is never silently destroyed, and a merge into
  // the same block at the same moment cannot overwrite this one's record.
  // (No multi-document transaction: it would require a replica set and break
  // local single-node Mongo.)
  //
  // Enlarge the primary FIRST, delete the secondary SECOND. If the process dies
  // between the two writes, the failure mode is an over-count (primary already
  // grown, secondary still present) that `reset` recovers — never a silently
  // lost stand, which the old delete-first order risked.
  const upd = await col().updateOne(
    { showId: config.showId, boothNumber: primaryNum, status: 'available', ...revFilter(a) },
    { $set, $inc: BUMP }
  );
  if (!upd.matchedCount) return { ok: false, reason: await whyMissed(primaryNum) };   // nothing to undo

  const del = await col().deleteOne({ showId: config.showId, boothNumber: secondaryNum, status: 'available',
                                      'assignment.company': { $in: [null, ''] }, ...revFilter(b) });
  if (!del.deletedCount) {
    // Secondary was booked or reshaped between the read and now. Roll the
    // primary back to exactly its pre-merge shape so the enlargement doesn't
    // stick.
    await putBack(primaryNum, a, ['geometry', 'sqm', 'listPrice', 'mergedFrom', 'mergeSnapshot'], actor);
    return { ok: false, reason: await whyMissed(secondaryNum) };
  }
  return { ok: true, primary: await get(primaryNum) };
}

/**
 * Consolidate a whole selection of adjacent stands into one, in a single step.
 * (A 2×2 block can't be merged pair-by-pair — the L-shaped middle step fails the
 * contiguity test — so this validates and merges the whole set at once.) The
 * survivor is the top-left stand; the rest are absorbed. Refuses unless the parts
 * tile a rectangle (no scattered/gappy selection) and all are free.
 */
async function consolidateMany(boothNumbers, { actor = null } = {}) {
  const nums = [...new Set(boothNumbers || [])];
  if (nums.length < 2) return { ok: false, reason: 'need_two' };
  const docs = [];
  for (const n of nums) {
    // Detached: these are what a failed merge is rolled back to and re-inserted from.
    const d = detach(await get(n));
    if (!d) return { ok: false, reason: 'missing_booth' };
    docs.push(d);
  }
  for (const d of docs) {
    if (d.status !== 'available' || (d.assignment && d.assignment.company)) return { ok: false, reason: 'not_available' };
    // Split cells and split parents may be merged (see consolidate). Whether a
    // stand that is ALREADY a block may join depends on which end of the merge
    // it lands on, which is not known until the survivor is picked below.
    if (!d.geometry) return { ok: false, reason: 'no_geometry' };
  }
  // The whole of one split, selected: undo it rather than re-merge it.
  const whole = wholeSplitOf(docs, nums);
  if (whole) {
    const cells = [...whole.splitSnapshot.created];
    const r = await reset(whole.boothNumber, { actor });
    return r.ok ? { ok: true, primary: await get(whole.boothNumber), absorbed: cells, unsplit: true } : r;
  }

  const geoms = await footprints(docs);   // where they are on the plan, not as written
  const box = { x: Math.min(...geoms.map(g => g.x)), y: Math.min(...geoms.map(g => g.y)) };
  box.w = Math.max(...geoms.map(g => g.x + g.w)) - box.x;
  box.h = Math.max(...geoms.map(g => g.y + g.h)) - box.y;
  // Two checks together. (1) Connectivity: a pair is an edge if the two share
  // an aligned edge. BFS from node 0 — every stand must be reachable, so a
  // selection split by an aisle (two separate blocks, whose within-block
  // overlaps can mask the aisle in the overall area test) is refused. (2) The
  // parts must fill the bounding box, so an L-shape / gap inside the box is
  // refused.
  //
  // An edge is adjacency ALONE. It used to also demand that the pair would
  // merge on its own (a compact box for just the two), which no pair in a
  // T-shaped tiling can satisfy: two stands side by side over one wide stand
  // beneath them — 651 and 653 over 649 — tile a perfect rectangle, yet each
  // top stand with the wide one below makes an L, so the selection was refused
  // as "not next to each other". Check (2) already rejects any selection that
  // leaves a gap or corner, and it judges the whole.
  const edge = (i, j) => adjacent(geoms[i], geoms[j]);
  const seen = new Set([0]), queue = [0];
  while (queue.length) {
    const i = queue.pop();
    for (let j = 0; j < geoms.length; j++) if (!seen.has(j) && edge(i, j)) { seen.add(j); queue.push(j); }
  }
  if (seen.size !== geoms.length) return { ok: false, reason: 'not_contiguous' };
  const sumArea = geoms.reduce((s, g) => s + g.w * g.h, 0);
  if (box.w * box.h > sumArea * 1.15) return { ok: false, reason: 'not_contiguous' };

  let si = 0;
  docs.forEach((d, i) => { if (((geoms[i].y - geoms[si].y) || (geoms[i].x - geoms[si].x)) < 0) si = i; });
  const survivorNum = nums[si], survivor = docs[si];
  const others = docs.filter((_, i) => i !== si);

  // A block may GROW — the survivor carrying a merge of its own is fine, and
  // its parts are simply added to. What it may not do is swallow another block:
  // the absorbed stand's record is deleted, and the merge inside it, holding
  // the only copies of the stands IT absorbed, would go with it.
  for (const o of others) if (o.mergeSnapshot) return { ok: false, reason: 'reset_first', blockedBy: o.boothNumber };

  const totalSqm   = area2(docs.reduce((s, d) => s + (d.sqm || 0), 0));
  const totalPrice = docs.reduce((s, d) => s + (d.listPrice || 0), 0);
  // See nextMergeSnapshot: a growing block extends its record, a block split
  // since its merge starts a new one over the old.
  const at = stampAfter(survivor);
  const mergeSnapshot = nextMergeSnapshot(survivor, others, at);

  // Conditional on the revision read, as in consolidate: two merges into the
  // same block at once must not leave one of them in no record at all.
  const upd = await col().updateOne(
    { showId: config.showId, boothNumber: survivorNum, status: 'available', ...revFilter(survivor) },
    { $set: { geometry: box, sqm: totalSqm, listPrice: totalPrice,
              mergedFrom: [...(survivor.mergedFrom || []), ...others.map(o => o.boothNumber)],
              mergeSnapshot, updatedAt: at, updatedBy: actor },
      $inc: BUMP }
  );
  if (!upd.matchedCount) return { ok: false, reason: await whyMissed(survivorNum) };

  const removed = [];
  for (const o of others) {
    const del = await col().deleteOne({ showId: config.showId, boothNumber: o.boothNumber, status: 'available',
                                        'assignment.company': { $in: [null, ''] }, ...revFilter(o) });
    if (!del.deletedCount) {
      // One got booked or reshaped mid-merge: roll the survivor back to its
      // pre-merge shape and re-insert whatever we already removed, so nothing
      // is lost.
      await putBack(survivorNum, survivor, ['geometry', 'sqm', 'listPrice', 'mergedFrom', 'mergeSnapshot'], actor);
      for (const dd of removed) await col().insertOne(dd);
      return { ok: false, reason: await whyMissed(o.boothNumber) };
    }
    removed.push(o);
  }
  return { ok: true, primary: await get(survivorNum), absorbed: others.map(o => o.boothNumber) };
}

/**
 * Split one stand into `parts` equal columns (or rows). The original keeps the
 * first cell and its commercial state; the rest become new available stands
 * numbered `<n>-2`, `<n>-3`, … The area and list price divide evenly.
 */
async function split(boothNum, { parts = 2, axis = 'vertical', firstSqm = null, actor = null } = {}) {
  const b = detach(await get(boothNum));
  if (!b) return { ok: false, reason: 'missing_booth' };
  // Splitting is a pre-sale layout operation. On a sold/held stand it would
  // shrink a paid booking to 1/n of its area, so only available stands split.
  // Also lock a stand that carries a company even if its status somehow reads
  // 'available' (a glitched write) — a purchased stand must never be divided.
  if (b.status !== 'available' || (b.assignment && b.assignment.company)) return { ok: false, reason: 'not_available' };
  // A merged block may be divided — the merge and the split are both kept, and
  // `reset` undoes them one at a time, newest first. What still has to be reset
  // first is a stand ALREADY split: re-carving one is splitCustom's job, and
  // two split snapshots on one stand would lose the first set of cells. (A
  // split CHILD may be split again — reset refuses to unwind a parent whose
  // child is split, so grandchildren can't be orphaned.)
  if (b.splitSnapshot) return { ok: false, reason: 'reset_first' };
  const n = Math.max(2, Math.min(6, parts | 0));
  // Carve the stand where it appears on the plan (see footprintOf): the cells
  // are drawn by the page at exactly the boxes stored here.
  const [g] = await footprints([b]);
  if (!g) return { ok: false, reason: 'no_geometry' };
  // Below this every cell would round to <1 m², so refuse rather than emit
  // zero-size stands or inflate the total with a Math.max(1,…) floor.
  if ((b.sqm || 0) < n) return { ok: false, reason: 'too_small' };

  const vertical = axis === 'vertical';   // side by side
  const cellW = vertical ? g.w / n : g.w;
  const cellH = vertical ? g.h : g.h / n;
  const totalSqm = b.sqm || 0, totalPrice = b.listPrice || 0;

  // An UNEVEN two-way split: `firstSqm` is how much the original keeps, the
  // new cell takes the rest — what the admin's draggable divider sends. Whole
  // m² only, and neither side may be emptied. Three or more parts stay equal:
  // one divider makes exactly two cells.
  let first = null;
  if (firstSqm != null) {
    if (n !== 2) return { ok: false, reason: 'uneven_needs_two' };
    first = Math.round(Number(firstSqm));
    if (!Number.isFinite(first) || first < 1 || first > totalSqm - 1) return { ok: false, reason: 'bad_ratio' };
  }

  // Sizes and list prices that sum EXACTLY to the original, at the precision
  // each is stored to (see apportion). An uneven split gives the first cell
  // its chosen share (of the price, pro rata) and the second the remainder.
  const weights = first != null ? [first, totalSqm - first] : Array.from({ length: n }, () => 1);
  const sizes  = first != null ? [first, area2(totalSqm - first)] : apportion(totalSqm, weights);
  const prices = apportion(totalPrice, weights);

  // The footprint divides in the same proportion as the area, so the divider
  // sits on the plan exactly where the admin dragged it.
  const cellGeom = (i) => {
    if (first != null) {
      const len = vertical ? g.w : g.h;
      const a = len * (first / totalSqm);
      return vertical ? { x: g.x + (i ? a : 0), y: g.y, w: i ? len - a : a, h: g.h }
                      : { x: g.x, y: g.y + (i ? a : 0), w: g.w, h: i ? len - a : a };
    }
    return {
      x: vertical ? g.x + i * cellW : g.x,
      y: vertical ? g.y : g.y + i * cellH,
      w: cellW, h: cellH,
    };
  };

  // Check every new suffix for a collision BEFORE mutating anything. The old
  // order mutated the primary and inserted some cells first, so a collision on
  // a later cell left the stand corrupted and half-split.
  const nums = [];
  for (let i = 1; i < n; i++) {
    const num = `${boothNum}-${i + 1}`;
    if (await get(num)) return { ok: false, reason: 'suffix_exists' };
    nums.push(num);
  }

  // Snapshot for a later reset: the primary's footprint before the split and
  // the numbers of the cells it created, so Reset can delete the cells and
  // restore the parent exactly.
  // The snapshot keeps the box AS WRITTEN (b.geometry, not the footprint): it
  // is what a reset puts back, and what binds the stand to its artwork shape.
  const splitSnapshot = { self: { geometry: b.geometry, sqm: totalSqm, listPrice: totalPrice },
                          created: nums, at: stampAfter(b) };   // see consolidate: reset undoes the later shaping first

  // Conditional on the stand still being available and at the revision read:
  // if it was booked between the read above and here, matchedCount is 0 and
  // nothing else is touched, so a paid booking can never be shrunk to a
  // fraction of its area — and a second split of the same stand at the same
  // moment loses here, cleanly, instead of half-splitting the hall.
  const primRes = await col().updateOne(
    { showId: config.showId, boothNumber: boothNum, status: 'available', ...revFilter(b) },
    { $set: { geometry: cellGeom(0), sqm: sizes[0], listPrice: prices[0],
              splitSnapshot, updatedAt: new Date(), updatedBy: actor },
      $inc: BUMP }
  );
  if (!primRes.matchedCount) return { ok: false, reason: await whyMissed(boothNum) };

  const created = [];
  try {
    for (let i = 1; i < n; i++) {
      await col().insertOne({
        showId: config.showId, boothNumber: nums[i - 1],
        svgElementId: null, geometry: cellGeom(i),
        sqm: sizes[i], sqmSource: 'split', listPrice: prices[i], status: 'available',
        assignment: { company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null },
        clicks: 0, splitFrom: boothNum, splitAxis: vertical ? 'vertical' : 'horizontal',
        createdAt: new Date(), updatedAt: new Date(), updatedBy: actor,
      });
      created.push(nums[i - 1]);
    }
  } catch (e) {
    // A cell's number taken in the gap since the check above — the unique
    // index refuses the second. Undo the half of the split that landed.
    for (const num of created) await col().deleteOne({ showId: config.showId, boothNumber: num, status: 'available' });
    await putBack(boothNum, b, ['geometry', 'sqm', 'listPrice', 'splitSnapshot'], actor);
    return { ok: false, reason: 'suffix_exists' };
  }
  return { ok: true, created, sizes };
}

/**
 * Custom split: re-carve one available stand (which may be a merged block) into
 * cells with the admin's OWN numbers and sizes. `parts` is [{ number, sqm }].
 * The sizes must add up to the stand's total — exactly, to the hundredth it is
 * stored to; the geometry is divided in those proportions along `axis`. Each
 * cell is a split cell (so the plan masks the stale baked figures and draws the
 * given number + size), and the survivor keeps the original identity.
 *
 * A merged block keeps its merge. It used to be thrown away here — the block was
 * re-carved and the records of every stand it had absorbed went with it, so the
 * originals could never come back. Now both shapings are kept and `reset` undoes
 * them one at a time, newest first: once to put the block back, again to split
 * it into the stands it was made from.
 */
async function splitCustom(boothNum, { axis = 'vertical', parts = [], actor = null } = {}) {
  const b = detach(await get(boothNum));
  if (!b) return { ok: false, reason: 'missing_booth' };
  if (b.status !== 'available' || (b.assignment && b.assignment.company)) return { ok: false, reason: 'not_available' };
  if (b.splitSnapshot) return { ok: false, reason: 'reset_first' };   // already split; a MERGED block is fine
  const [g] = await footprints([b]);   // carve where it appears on the plan (see footprintOf)
  if (!g) return { ok: false, reason: 'no_geometry' };

  const clean = (parts || []).map(p => ({
    displayNumber: String(p && p.number != null ? p.number : '').trim(),
    sqm: area2(p && p.sqm),
  })).filter(p => p.displayNumber && p.sqm > 0);
  if (clean.length < 2 || clean.length > 8) return { ok: false, reason: 'bad_parts' };

  // The sizes have to add up to the stand, not to within a square metre of
  // it: a tolerance of one let 15 + 16 re-carve a 30 m² stand into 31.
  const totalSqm = b.sqm || 0;
  const sumParts = area2(clean.reduce((s, p) => s + p.sqm, 0));
  if (Math.abs(sumParts - totalSqm) >= 0.005) return { ok: false, reason: 'size_mismatch', total: totalSqm, got: sumParts };
  if (new Set(clean.map(p => p.displayNumber.toLowerCase())).size !== clean.length) return { ok: false, reason: 'dup_number' };

  // The same show-wide uniqueness rule setDisplayNumber enforces: a part may not
  // take a number that another stand already IS, or already shows. Without this
  // a custom split could mint a second "Stand 700" that the Shown Number tool
  // would have refused outright. The stand being carved up is excluded — it is
  // about to be replaced by these very parts — as are the suffixed keys the
  // split is about to create.
  const willCreate = new Set([boothNum, ...clean.map((_, i) => i === 0 ? boothNum : `${boothNum}-${i + 1}`)]);
  for (const p of clean) {
    if (!/^[A-Za-z0-9 /.\-]{1,20}$/.test(p.displayNumber)) return { ok: false, reason: 'bad_value', number: p.displayNumber };
    const clash = await col().findOne({
      showId: config.showId,
      boothNumber: { $nin: [...willCreate] },
      // Case-insensitive, exactly as setDisplayNumber compares — the two used
      // to disagree about what counts as a duplicate.
      $or: [{ displayNumberKey: displayKey(p.displayNumber) },
            { boothNumber: { $regex: `^${escapeRe(p.displayNumber)}$`, $options: 'i' } }],
    });
    if (clash) return { ok: false, reason: 'duplicate', number: p.displayNumber, clashWith: clash.boothNumber };
  }

  // Geometry divides proportionally to the sizes along the axis; the last cell
  // takes the remainder so the cells tile the block exactly.
  const vertical = axis === 'vertical';
  const totalLen = vertical ? g.w : g.h;
  const cells = [];
  let offset = 0;
  clean.forEach((p, i) => {
    const len = (i === clean.length - 1) ? (totalLen - offset) : totalLen * (p.sqm / sumParts);
    cells.push({ ...p, geometry: vertical ? { x: g.x + offset, y: g.y, w: len, h: g.h }
                                          : { x: g.x, y: g.y + offset, w: g.w, h: len } });
    offset += len;
  });

  // The list price shares out in the same proportions and adds back to the
  // whole (see apportion); each part rounded on its own did not.
  const prices = apportion(b.listPrice || 0, clean.map(p => p.sqm));

  const nums = [];
  for (let i = 1; i < cells.length; i++) {
    const num = `${boothNum}-${i + 1}`;
    if (await get(num)) return { ok: false, reason: 'suffix_exists' };
    nums.push(num);
  }

  // `custom` marks a snapshot whose parent had its LABEL rewritten as well as its
  // footprint — this is the only split that overwrites the parent's
  // displayNumber and splitAxis, so it is the only one whose reset must put them
  // back. The prior values are recorded for exactly that.
  const splitSnapshot = { custom: true, at: stampAfter(b),   // see consolidate: reset undoes the later shaping first
                          self: { geometry: b.geometry, sqm: totalSqm, listPrice: b.listPrice || 0,   // as written — what a reset puts back
                                  displayNumber: b.displayNumber ?? null, splitAxis: b.splitAxis ?? null },
                          created: nums };
  const p0 = cells[0];
  // The parent's label changes BEFORE any cell is inserted, so a cell may take
  // the number the parent showed until now without the unique index on shown
  // numbers ever seeing two stands hold it.
  const primRes = await col().updateOne(
    { showId: config.showId, boothNumber: boothNum, status: 'available', ...revFilter(b) },
    { $set: { geometry: p0.geometry, sqm: p0.sqm, listPrice: prices[0],
              displayNumber: p0.displayNumber, displayNumberKey: displayKey(p0.displayNumber),
              splitSnapshot,
              splitAxis: vertical ? 'vertical' : 'horizontal', updatedAt: new Date(), updatedBy: actor },
      $inc: BUMP }
  );
  if (!primRes.matchedCount) return { ok: false, reason: await whyMissed(boothNum) };

  const created = [];
  try {
    for (let i = 1; i < cells.length; i++) {
      const c = cells[i];
      await col().insertOne({
        showId: config.showId, boothNumber: nums[i - 1], svgElementId: null,
        geometry: c.geometry, sqm: c.sqm, sqmSource: 'split', listPrice: prices[i],
        displayNumber: c.displayNumber, displayNumberKey: displayKey(c.displayNumber),
        status: 'available',
        assignment: { company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null },
        clicks: 0, splitFrom: boothNum, splitAxis: vertical ? 'vertical' : 'horizontal',
        createdAt: new Date(), updatedAt: new Date(), updatedBy: actor,
      });
      created.push(nums[i - 1]);
    }
  } catch (e) {
    // A cell's number or shown number taken in the gap since the checks above.
    // Cells out first, so the parent's own label can go back without meeting
    // a copy of itself.
    for (const num of created) await col().deleteOne({ showId: config.showId, boothNumber: num, status: 'available' });
    await putBack(boothNum, b, ['geometry', 'sqm', 'listPrice', 'displayNumber', 'displayNumberKey',
                                'splitSnapshot', 'splitAxis'], actor);
    const failed = cells[created.length + 1] || {};
    return /shown_number/.test(String(e && e.message))
      ? { ok: false, reason: 'duplicate', number: failed.displayNumber || null, clashWith: null }
      : { ok: false, reason: 'suffix_exists' };
  }
  return { ok: true, created };
}

/**
 * Would putting these boxes on the plan stand them on a stand already there?
 *
 * The last line of defence for the one thing every merge, split and reset has
 * to keep true: the hall's floor is counted once. A merge record written by
 * the old code could describe the hall from before a split, and undoing it
 * re-inserted a stand on top of a cell that was still on the plan — the hall
 * grew by a stand and nothing could take it back out. Records written now
 * cannot do that, but ones already stored can, so the reset checks before it
 * writes anything.
 *
 * Judged on footprints (see footprintOf). Plans store small overlaps between
 * neighbouring stands, so only a box covering more than half of another counts.
 */
async function floorTaken(exceptNum, boxes) {
  const rects = await artworkRects();
  const others = (await col().find({ showId: config.showId, removed: { $ne: true } }).toArray())
    .filter(d => d.boothNumber !== exceptNum && d.geometry);
  for (const { boothNumber, geometry } of boxes) {
    const a = footprintOf(geometry, rects);
    if (!a) continue;
    for (const o of others) {
      const b = footprintOf(o.geometry, rects);
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 0 && oy > 0 && ox * oy > 0.5 * Math.min(a.w * a.h, b.w * b.h)) {
        return { part: boothNumber, with: o.boothNumber };
      }
    }
  }
  return null;
}

/**
 * Undo whatever composite operation shaped this stand.
 *
 *   - merged stand  → split back into the originals (restore self + re-insert
 *                     every absorbed stand from the snapshot)
 *   - split parent  → delete the created cells and restore the parent footprint
 *   - split cell    → undo the split it belongs to; only a true leftover — a
 *                     cell its parent no longer records, sitting on floor the
 *                     parent already covers — is removed
 *
 * Only touches available stands, so it can never disturb a booking; and it
 * checks before writing that nothing it puts back lands on floor another
 * stand already holds, so it can never make floor either.
 */
async function reset(boothNumber, { actor = null } = {}) {
  const booth = detach(await get(boothNumber));
  if (!booth) return { ok: false, reason: 'missing_booth' };
  if (booth.status !== 'available') return { ok: false, reason: 'not_available' };

  // A stand may carry BOTH a merge and a split — merged and then divided, or
  // divided and then merged with what is next to it. Only one step is undone
  // per reset, and it has to be the LATER one: undoing a merge under a split
  // would restore the pre-merge stands on top of cells that still exist, and
  // undoing a split under a merge would restore a footprint that the merge has
  // since grown past. Reset again to unwind the step before it.
  if (booth.mergeSnapshot && !splitIsLatest(booth)) return unmerge(booth, actor);
  if (booth.splitSnapshot) return unsplit(booth, actor);
  if (booth.splitFrom) return resetCell(booth, actor);
  return { ok: false, reason: 'not_composite' };
}

/**
 * Un-merge. Restore the block FIRST, conditional on it still being available
 * and unchanged — if it was booked or reshaped between the read and now, abort
 * without re-inserting the parts, so we never leave a booked merged stand
 * overlapping restored parts.
 */
async function unmerge(booth, actor) {
  const { boothNumber } = booth;
  const snap = booth.mergeSnapshot;
  const parts = (snap.parts || []).filter(p => p && p.boothNumber);

  // Every stand the block absorbed comes back under its own number, so each
  // number has to be free. It used to be skipped silently when it was not —
  // and the floor that stand stood on went with it.
  for (const part of parts) {
    if (await get(part.boothNumber)) return { ok: false, reason: 'part_exists', part: part.boothNumber };
  }
  const blocked = await floorTaken(boothNumber, parts.map(p => ({ boothNumber: p.boothNumber, geometry: p.geometry })));
  if (blocked) return { ok: false, reason: 'overlap', part: blocked.part, with: blocked.with };

  // A merge laid over a split carries the merge before it underneath (see
  // nextMergeSnapshot); undoing this one puts that one back.
  const under = snap.self && snap.self.under;
  const $set = { geometry: snap.self.geometry, sqm: snap.self.sqm, listPrice: snap.self.listPrice,
                 updatedAt: new Date(), updatedBy: actor };
  const update = { $set, $inc: BUMP };
  if (under) { $set.mergeSnapshot = under.mergeSnapshot; $set.mergedFrom = under.mergedFrom || []; }
  else update.$unset = { mergeSnapshot: '', mergedFrom: '' };

  const upd = await col().updateOne(
    { showId: config.showId, boothNumber, status: 'available', ...revFilter(booth) }, update);
  if (!upd.matchedCount) return { ok: false, reason: await whyMissed(boothNumber) };

  const restored = [];
  try {
    for (const part of parts) {
      // The stored record keeps its original geometry/sqm/price. Its old id and
      // any marker a recovery copy left on it do not come back.
      const { _id, sponsorLogoOmitted, ...doc } = part;
      await col().insertOne({ ...doc, shapeRev: (doc.shapeRev || 0) + 1 });
      restored.push(part.boothNumber);
    }
  } catch (e) {
    // A number claimed in the gap since the check above. Put the block back
    // as it was rather than leave half of it restored.
    for (const n of restored) await col().deleteOne({ showId: config.showId, boothNumber: n, status: 'available' });
    await putBack(boothNumber, booth, ['geometry', 'sqm', 'listPrice', 'mergeSnapshot', 'mergedFrom'], actor);
    return { ok: false, reason: 'part_exists' };
  }
  return { ok: true, type: 'unmerge', restored };
}

/** Un-split, acting on the parent. */
async function unsplit(booth, actor) {
  const { boothNumber } = booth;
  const snap = booth.splitSnapshot;
  // Refuse if any child can't be cleanly removed: a booked child would be
  // destroyed and its area would double under the restored parent; a
  // further-split child would orphan its own grandchildren. The admin resets
  // those first.
  const cells = [];
  for (const num of snap.created || []) {
    const child = detach(await get(num));
    if (!child) {
      // Gone — but gone WHERE? A cell absorbed by a merge still occupies its
      // floor space, inside whatever swallowed it. Restoring the parent over
      // the top would draw the original stand across a block that is still
      // being sold, and double-count the area. Undo that merge first.
      const into = await col().findOne({ showId: config.showId, mergedFrom: num });
      if (into) return { ok: false, reason: 'child_absorbed', child: num, into: into.boothNumber };
      continue;
    }
    if (child.removed === true)       return { ok: false, reason: 'child_removed', child: num };
    if (child.status !== 'available') return { ok: false, reason: 'child_booked' };
    if (child.splitSnapshot)          return { ok: false, reason: 'child_split' };
    // A cell that has since SWALLOWED something is not this split's cell any
    // more — it is a block, and the stands inside it live only in its
    // snapshot. Deleting it to restore the parent would destroy them and take
    // their floor space out of the hall with them. Undo that merge first.
    if (child.mergeSnapshot)          return { ok: false, reason: 'child_merged', child: num };
    cells.push(child);
  }
  // Restore the parent first (conditional), then remove the cells — each
  // delete conditional on the cell still being available and unchanged, and
  // any one failing puts everything back, so a booking landing mid-reset is
  // preserved and the parent never ends up restored over a cell still there.
  // Restore the LABEL state too, not just the footprint. splitCustom writes
  // displayNumber + splitAxis onto the parent, so undoing only the geometry
  // left the stand permanently reading the carved-up part's number ("500a")
  // with a stale split axis.
  const $set = { geometry: snap.self.geometry, sqm: snap.self.sqm, listPrice: snap.self.listPrice,
                 updatedAt: new Date(), updatedBy: actor };
  const $unset = { splitSnapshot: '' };
  // Only a CUSTOM split rewrote the parent's label, so only its reset restores
  // one. An equal split leaves displayNumber/splitAxis untouched — clearing
  // them here would wipe a Shown Number the admin set after splitting, which
  // has nothing to do with the split being undone.
  //
  // `snap.custom` is absent on snapshots written before it was recorded; those
  // are identified by the marker splitCustom leaves behind, since it is the
  // only operation that puts splitAxis on a PARENT (an equal split sets it on
  // the child cells alone).
  const wasCustom = snap.custom === true || (snap.custom === undefined && !!booth.splitAxis);
  let label = null;
  if (wasCustom) {
    for (const field of ['displayNumber', 'splitAxis']) {
      const prior = (snap.self || {})[field];
      if (prior == null) $unset[field] = ''; else $set[field] = prior;
    }
    // The comparison key travels with the label it belongs to, or the stand
    // keeps blocking a shown number it no longer shows. It is written LAST,
    // once the cells are gone: a cell may have taken the very number the
    // parent showed before the split, and on the real database the unique
    // index on shown numbers refused the parent's key while that cell still
    // held it — so the reset of such a split could never succeed.
    $unset.displayNumberKey = '';
    label = (snap.self || {}).displayNumber ?? null;
  }

  const upd = await col().updateOne(
    { showId: config.showId, boothNumber, status: 'available', ...revFilter(booth) },
    { $set, $unset, $inc: BUMP }
  );
  if (!upd.matchedCount) return { ok: false, reason: await whyMissed(boothNumber) };

  const removed = [], gone = [];
  for (const c of cells) {
    const res = await col().deleteOne({ showId: config.showId, boothNumber: c.boothNumber,
                                        status: 'available', ...revFilter(c) });
    if (!res.deletedCount) {
      // Cells back first, then the parent's own label and footprint.
      for (const g of gone) await col().insertOne(g);
      await putBack(boothNumber, booth, ['geometry', 'sqm', 'listPrice', 'splitSnapshot',
                                         'displayNumber', 'displayNumberKey', 'splitAxis'], actor);
      const why = await whyMissed(c.boothNumber);
      return { ok: false, reason: why === 'not_available' ? 'child_booked' : 'changed', child: c.boothNumber };
    }
    gone.push(c);
    removed.push(c.boothNumber);
  }
  if (label != null) {
    try {
      await col().updateOne({ showId: config.showId, boothNumber },
        { $set: { displayNumberKey: displayKey(label) } });
    } catch (e) {
      // Only the uniqueness guard on the label is missing; the stand is whole.
      console.error(`Reset ${boothNumber}: shown number "${label}" not re-reserved —`, e.message);
    }
  }
  return { ok: true, type: 'unsplit', removed };
}

/**
 * Reset asked of a split CELL.
 *
 * Every cell used to be treated as a leftover from before splits kept a record
 * of their cells, and deleted — so resetting "500-2" of a live split threw away
 * half of stand 500, the hall lost its floor, and the log said "removed
 * leftover cell". A cell its parent still lists is half of that split, and
 * resetting it is resetting the split. Only a cell the parent no longer lists
 * AND whose floor the parent already covers is a true leftover, counted twice;
 * anything else is real floor and is left alone.
 */
async function resetCell(cell, actor) {
  const parentNum = cell.splitFrom;
  const parent = detach(await get(parentNum));
  const listed = !!(parent && parent.splitSnapshot &&
                    (parent.splitSnapshot.created || []).includes(cell.boothNumber));
  if (listed) {
    // The split is undone only when it is the latest thing done to the parent;
    // a merge laid over it comes off first, and that is a reset of the parent
    // the admin should ask for by name.
    if (!splitIsLatest(parent)) return { ok: false, reason: 'cell_of', parent: parentNum };
    return { ...(await reset(parentNum, { actor })), parent: parentNum };
  }

  if (parent && parent.removed !== true && parent.geometry && cell.geometry) {
    const [pf, cf] = await footprints([parent, cell]);
    const ox = Math.min(pf.x + pf.w, cf.x + cf.w) - Math.max(pf.x, cf.x);
    const oy = Math.min(pf.y + pf.h, cf.y + cf.h) - Math.max(pf.y, cf.y);
    if (ox > 0 && oy > 0 && ox * oy > 0.5 * cf.w * cf.h) {
      // Conditional on availability and the revision read, so it can't delete
      // a booking or a cell that has since become something else.
      const res = await col().deleteOne({ showId: config.showId, boothNumber: cell.boothNumber,
                                          status: 'available', ...revFilter(cell) });
      if (!res.deletedCount) return { ok: false, reason: await whyMissed(cell.boothNumber) };
      return { ok: true, type: 'remove-cell', removed: [cell.boothNumber] };
    }
  }
  return { ok: false, reason: 'orphan_cell', parent: parentNum };
}

/**
 * Take a stand off the plan.
 *
 * A plan arrives with rectangles the show does not sell: a stand the organiser
 * pulled, a block the designer drew that turned out to be a fire lane, two
 * stands where the hall has one. Until now the only way to be rid of one was to
 * merge it into a neighbour, which is a lie about the neighbour's size, or to
 * re-import the artwork, which throws away everything anyone has done.
 *
 * The stand is kept, not destroyed. Its number stays reserved (nothing else can
 * claim it), its geometry stays (the plan needs to know WHERE the hole is in
 * order to draw the floor there), and restoreRemoved puts it back exactly as it
 * was. Everything that counts stands — the totals, the bookings table, the
 * dropdowns, an import's handwork guard — reads `removed` and passes it by.
 *
 * Refused for anything that is not a plain available stand:
 *   • sold or held, or carrying a company — that is a booking, and deleting a
 *     stand is not how a booking is cancelled.
 *   • merged or split — its shape is half of a pair of records. Removing a
 *     split cell would leave the parent's reset with a cell it cannot delete
 *     and a restored parent overlapping it. Reset it first, then remove the
 *     whole stand.
 */
async function remove(boothNumber, { actor = null, reason = '' } = {}) {
  const booth = await get(boothNumber);
  if (!booth) return { ok: false, reason: 'missing_booth' };
  if (booth.removed === true) return { ok: false, reason: 'already_removed' };
  if (booth.status !== 'available' || (booth.assignment && booth.assignment.company)) {
    return { ok: false, reason: 'not_available' };
  }
  if (booth.mergeSnapshot || booth.splitSnapshot || booth.splitFrom) {
    return { ok: false, reason: 'reset_first' };
  }

  // Conditional on it still being available, so a booking that lands between
  // the read and this write survives rather than being quietly deleted.
  const upd = await col().updateOne(
    { showId: config.showId, boothNumber, status: 'available', removed: { $ne: true } },
    { $set: { status: 'removed', removed: true, removedAt: new Date(),
              removedBy: actor, removedReason: String(reason || '').slice(0, 200),
              updatedAt: new Date(), updatedBy: actor },
      // A removed stand is nobody's: an import must not read it as its own
      // output and quietly resurrect it on the next upload.
      $unset: { source: '' } }
  );
  if (!upd.matchedCount) return { ok: false, reason: 'not_available' };
  return { ok: true, boothNumber, sqm: booth.sqm || 0, listPrice: booth.listPrice || 0 };
}

/**
 * Put a removed stand back on the plan, exactly as it was.
 *
 * Nothing was thrown away, so this is only the flags coming off. The stand
 * returns available — a stand cannot be removed while it carries a booking, so
 * there is never a booking to return it to.
 */
async function restoreRemoved(boothNumber, { actor = null } = {}) {
  const booth = await get(boothNumber);
  if (!booth) return { ok: false, reason: 'missing_booth' };
  if (booth.removed !== true) return { ok: false, reason: 'not_removed' };

  const upd = await col().updateOne(
    { showId: config.showId, boothNumber, removed: true },
    { $set: { status: 'available', updatedAt: new Date(), updatedBy: actor },
      $unset: { removed: '', removedAt: '', removedBy: '', removedReason: '' } }
  );
  if (!upd.matchedCount) return { ok: false, reason: 'not_removed' };
  return { ok: true, boothNumber };
}

/** Every stand currently off the plan, newest first — what Tools offers to put back. */
const removedStands = () => col()
  .find({ showId: config.showId, removed: true })
  .project({ boothNumber: 1, displayNumber: 1, sqm: 1, geometry: 1, removedAt: 1, removedBy: 1, removedReason: 1 })
  .toArray();

// ─── Provenance ───────────────────────────────────────────────────────────────
const IMPORT_SOURCE = 'artwork-import';
const IMPORT_NOTE = 'Name read from the supplied floorplan artwork.';

/**
 * The actors that are not people: an import, a deploy-time seed, a reset.
 *
 * A stand's `source` says an import PUT its booking state there, and every
 * write a person makes to that state — a booking, a hold, a release, a price,
 * a tag, a country, a move — takes the mark off. (It was once never cleared at
 * all, so a stand an admin booked kept the mark and the guard counted a paying
 * exhibitor as import output; that is what the clearing fixed.) So the mark
 * alone now says who wrote the booking last.
 *
 * `updatedBy` is PROVENANCE, not just an audit name: an import writes one of
 * these actors there for the state it writes, and records the person who ran
 * it in `importedBy`. It used to stamp the admin's own name, so after the first
 * "Make live" from the console every stand the plan drew as sold read as a
 * person's booking — every later import was refused, and ?mode=update could
 * not correct a misread status. It matters for stands imported before the
 * mark existed, which are known only by the import's note and need an import
 * to have written them last.
 */
const IMPORT_ACTORS = ['import', 'deploy', 'seed', 'reset-blank', 'restore-original', null];
/** What an import writes in `updatedBy`: its own name if it has one of these, 'import' if run by a person. */
const importActorOf = (actor) => (actor && IMPORT_ACTORS.includes(actor) ? actor : 'import');

// The source file the blank-plan rebuild reads. It lives in server/data rather
// than public/ because express.static serves everything under public/ — this
// file carries a list price for every stand, and the price is the one thing the
// public plan deliberately withholds.
const BOOTH_DATA = path.join(__dirname, '..', 'data', 'booth_data.json');
// Whose plan that file is: EUROPE's — its 262 stands read off LEX27 — and
// Europe is the event the deployment was built around, filed under the default
// show id (see shows.ensureSeeded). It is nobody else's: rebuilt from it, North
// America became a copy of Europe's hall.
const boothDataShow = () => config.defaultShow;

// ─── Snapshots ────────────────────────────────────────────────────────────────
/**
 * The recovery path, made real.
 *
 * Every destructive path here claims a snapshot as the way back, and until now
 * that claim was false in three separate ways: the whole show went into ONE
 * document (a hall of 260 stands carrying 2 MB sponsor logos comfortably
 * exceeds Mongo's 16 MB limit, and the insert then throws), the collection had
 * no index and no expiry, and — the part that mattered — nothing in the
 * codebase ever read one back. A snapshot nobody can restore is not a backup,
 * it is a comment.
 *
 * So: one document per stand, tagged with a snapshot id, found by index, aged
 * out by TTL, and restored by scripts/restore-snapshot.js.
 */
const SNAPSHOT_TTL_DAYS = Number(process.env.SNAPSHOT_TTL_DAYS || 180);
const snapshots = () => getDb().collection('booths_snapshots');

/**
 * A sponsor logo is an inline data URI of up to 2 MB, and there can be one per
 * stand. They are what took the old single-document snapshot past the limit.
 * They are also the one thing here that is trivially re-uploadable, so they are
 * left out and their absence is RECORDED rather than being silently lost —
 * including on the stands a merged block carries inside its record, and inside
 * the earlier merge a block split and merged again carries underneath.
 */
function withoutLogos(booth) {
  const out = { ...booth };
  if (out.sponsorLogo) { delete out.sponsorLogo; out.sponsorLogoOmitted = true; }
  const snap = out.mergeSnapshot;
  if (snap && typeof snap === 'object') {
    const self = snap.self && snap.self.under && snap.self.under.mergeSnapshot
      ? { ...snap.self, under: { ...snap.self.under, mergeSnapshot: withoutLogos({ mergeSnapshot: snap.self.under.mergeSnapshot }).mergeSnapshot } }
      : snap.self;
    out.mergeSnapshot = { ...snap, self, parts: Array.isArray(snap.parts) ? snap.parts.map(withoutLogos) : snap.parts };
  }
  return out;
}

/**
 * Store one stand per document under a fresh snapshot id.
 *
 * Returns ok:false rather than throwing, because every caller has to be able to
 * ABORT on a failed snapshot — proceeding to delete an event's inventory with
 * no way back is the failure this exists to prevent.
 *
 * The id carries a random tail as well as the time. It was the time alone, to
 * the millisecond, so two points written inside one — two admins' changes, a
 * script — shared an id, and restoring one put back the stands of both.
 */
async function snapshot(reason, rows, { actor = null, showId = config.showId, revisionId: knownRevision } = {}) {
  const snapshotId = `${reason}-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const at = new Date();
  try {
    if (rows.length) {
      await snapshots().insertMany(rows.map(b => ({
        showId, snapshotId, reason, at, boothNumber: b.boothNumber, booth: withoutLogos(b),
      })), { ordered: false });
    }
    // Which drawing these stands were positioned against. Stands and artwork
    // go back together, or a restored hall sits on shapes that are not there.
    // Named by the caller when the live plan has already moved on by the time
    // the point is written — making a plan live is the case.
    let revisionId = knownRevision === undefined ? null : knownRevision;
    if (knownRevision === undefined) try { revisionId = await floorplans.liveRevisionId(showId); }
    catch (e) { console.error(`Snapshot "${reason}": live revision not recorded —`, e.message); }
    // A header row, so a listing does not have to read every stand back.
    await snapshots().insertOne({ showId, snapshotId, reason, at, header: true,
                                  count: rows.length, takenBy: actor, revisionId });
    return { ok: true, snapshotId, count: rows.length };
  } catch (e) {
    console.error(`Snapshot "${reason}" failed —`, e.message);
    return { ok: false, error: e.message };
  }
}

/** The snapshots available to restore from, newest first. */
async function listSnapshots({ showId = config.showId, limit = 25 } = {}) {
  return snapshots().find({ showId, header: true }).sort({ at: -1 }).limit(limit).toArray();
}

/**
 * What a point in the plan's history puts back: a stand's SHAPE — where it is,
 * how big, what it is merged from or split into, the number it shows, whether
 * it is on the plan at all. Everything else a stand carries is its booking —
 * status, exhibitor, price, notes, contact, tags, country, hold expiry, sponsor
 * flag and logo, who wrote it, its clicks — and that stays exactly as it is now.
 */
const SHAPE_FIELDS = ['svgElementId', 'geometry', 'sqm', 'sqmSource', 'listPrice',
  'displayNumber', 'displayNumberKey', 'mergedFrom', 'mergeSnapshot', 'splitSnapshot', 'splitFrom', 'splitAxis',
  'removed', 'removedAt', 'removedBy', 'removedReason'];
const NOT_BOOKING = new Set([...SHAPE_FIELDS, '_id', 'showId', 'boothNumber', 'shapeRev', 'sponsorLogoOmitted']);
const shapeOf = (b) => Object.fromEntries(SHAPE_FIELDS.filter(k => b[k] !== undefined).map(k => [k, b[k]]));
const bookingOf = (b) => Object.fromEntries(Object.keys(b).filter(k => !NOT_BOOKING.has(k)).map(k => [k, b[k]]));
/** Booked, for the purpose of what a restore may not move: sold, held, or carrying an exhibitor. */
const isBooked = (b) => b.removed !== true &&
  (['sold', 'held'].includes(b.status) || !!(b.assignment && String(b.assignment.company || '').trim()));
const sameFootprint = (a, b) => {
  const near = (x, y) => Math.abs((x || 0) - (y || 0)) < 0.05;
  const g = a.geometry, h = b.geometry;
  const box = (!g && !h) || (!!g && !!h && near(g.x, h.x) && near(g.y, h.y) && near(g.w, h.w) && near(g.h, h.h));
  return box && Math.abs((a.sqm || 0) - (b.sqm || 0)) < 0.005;
};

/** Every stand record a hall holds: the stands on it, and those inside its merged blocks' records. */
function recordsOf(docs) {
  const out = new Map();
  const walk = (snap) => {
    if (!snap || typeof snap !== 'object') return;
    for (const p of snap.parts || []) {
      if (p && p.boothNumber && !out.has(p.boothNumber)) { out.set(p.boothNumber, p); walk(p.mergeSnapshot); }
    }
    if (snap.self && snap.self.under) walk(snap.self.under.mergeSnapshot);
  };
  for (const d of docs) out.set(d.boothNumber, d);
  for (const d of docs) walk(d.mergeSnapshot);
  return out;
}

/**
 * The drawing's own settings, read back off a restored revision: its lounges
 * and theatres, the unit it prints, the colours it is drawn in.
 *
 * Making a plan live re-reads all three from the new drawing. Going back to a
 * point from before it switched the drawing back and left them as the newer
 * plan had them — lounges drawn where the old plan has a row of stands. The
 * colours go through setPaletteFromArtwork, which leaves a palette an admin
 * chose alone, exactly as the publish did.
 */
async function restoreDrawingSettings(svg, { actor = null } = {}) {
  const out = { areas: null, unit: null, paletteKept: null };
  let read;
  try { read = extractStands(svg); }
  catch (e) { console.error('Restore: the drawing could not be read back —', e.message); return out; }
  try {
    const ar = await planAreas.replaceFromArtwork(read.stands.filter(s => s.sponsored), { actor });
    out.areas = ar && ar.areas;
  } catch (e) { console.error('Restore: plan areas not put back —', e.message); }
  try {
    if (read.unit) out.unit = (await settings.setUnit(read.unit === 'sqft' ? 'ft' : 'm')).unit;
  } catch (e) { console.error('Restore: unit not put back —', e.message); }
  try {
    if (read.fills && read.fills.length) {
      const pr = await settings.setPaletteFromArtwork(paletteOf(read.fills));
      out.paletteKept = !!(pr && pr.kept);
    }
  } catch (e) { console.error('Restore: palette not put back —', e.message); }
  return out;
}

/**
 * Put a point back — the SHAPE of the hall, and never its bookings.
 *
 * It used to delete the event's stands and insert the stored ones, status and
 * exhibitor included, so every sale, hold and deal made since the point was
 * quietly reverted to how it stood then. The holds collection was not touched,
 * so a stand held since came back available with its hold document still
 * there (the next hold on it then failed on the one-hold-per-stand index); a
 * stand held at the point came back with an expiry long past. And the history
 * says, in as many words, that it is about the shape of the plan.
 *
 * Now each stand on the plan both then and now keeps its booking and has its
 * shape put back; a stand only the point has comes back available; a stand
 * only the hall has now goes. A stand that is booked NOW and would go, be
 * taken off the plan, or change size or footprint makes the whole restore
 * refuse (`bookings_in_the_way`), naming each — the admin moves or releases
 * those first. The dry run reports the same, so the console can say so before
 * asking for a password.
 *
 * Written stand by stand rather than by emptying the event, each write
 * conditional on the stand still being what was read, and the whole of it is
 * undone if any write misses — so a booking that lands mid-restore is never
 * overwritten. The CURRENT stands are snapshotted first, so an ill-judged
 * restore is itself reversible.
 */
async function restorePoint(snapshotId, { apply = false, actor = null, showId = config.showId } = {}) {
  const rows = await snapshots().find({ showId, snapshotId, header: { $ne: true } }).toArray();
  if (!rows.length) {
    // Told apart deliberately. A snapshot taken of an event that had no stands
    // is a real snapshot of nothing, and restoring it would empty the event —
    // which is a thing someone might mean, but never by accident, and never in
    // the belief that they were recovering something.
    const header = await snapshots().findOne({ showId, snapshotId, header: true });
    return { ok: false, reason: header ? 'empty_snapshot' : 'no_such_snapshot', snapshotId };
  }

  const stored = rows.map(r => r.booth).filter(Boolean).map(detach);
  const current = detach(await col().find({ showId }).toArray());
  const then = new Map(stored.map(b => [b.boothNumber, b]));
  const nowBy = new Map(current.map(b => [b.boothNumber, b]));
  const records = recordsOf(current);   // what each number is now, wherever it lives
  const logos = new Set();

  // The booking a stand carries into the restored hall: its own, now — or,
  // for a stand that is now inside a merged block, what the block recorded of
  // it. A number the hall no longer holds anywhere comes back with no booking.
  const bookingFor = (n, fallback) => {
    const rec = records.get(n);
    if (rec) return bookingOf(rec);
    return { status: 'available', sponsored: fallback.sponsored === true,
             assignment: { company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null } };
  };
  // A stored stand, made whole for the hall it is going back into: its shape
  // from the point, its booking from now, its logo from now where there is one.
  const rebuild = (p) => {
    const shape = shapeOf(p);
    const booking = bookingFor(p.boothNumber, p);
    const doc = { ...booking, ...shape, showId, boothNumber: p.boothNumber };
    if (doc.removed === true) doc.status = 'removed';
    else if (!['sold', 'held'].includes(doc.status)) doc.status = 'available';
    if (doc.status !== 'held') delete doc.holdExpiresAt;
    // A logo is the booking's, so a stand the hall still holds keeps its own.
    // Only one coming back from nowhere — a point stores no logos — is short.
    if (p.sponsorLogoOmitted && !records.has(p.boothNumber)) logos.add(p.boothNumber);
    if (doc.mergeSnapshot) doc.mergeSnapshot = rebuildMerge(doc.mergeSnapshot);
    return doc;
  };
  const rebuildMerge = (snap) => {
    const self = snap.self && snap.self.under && snap.self.under.mergeSnapshot
      ? { ...snap.self, under: { ...snap.self.under, mergeSnapshot: rebuildMerge(snap.self.under.mergeSnapshot) } }
      : snap.self;
    // A recovery copy's id is not a real one, and does not survive copying.
    return { ...snap, self, parts: (snap.parts || []).map(part => { const { _id, ...d } = rebuild(part); return d; }) };
  };

  const conflicts = [], updates = [], inserts = [], deletes = [];
  const said = (b, why) => conflicts.push({ boothNumber: b.boothNumber, displayNumber: b.displayNumber || null,
                                            status: b.status, company: (b.assignment && b.assignment.company) || null, why });
  for (const b of current) {
    const p = then.get(b.boothNumber);
    if (!p) { if (isBooked(b)) said(b, 'gone'); deletes.push(b); continue; }
    if (isBooked(b)) {
      if (p.removed === true) said(b, 'removed');
      else if (!sameFootprint(b, p)) said(b, 'resized');
    }
  }
  for (const p of stored) {
    const b = nowBy.get(p.boothNumber);
    if (!b) { inserts.push(rebuild(p)); continue; }
    // Its shape from the point, its booking left alone. Only what differs is
    // written; the list price follows the shape only where the size changes,
    // so a stand whose size is the same keeps the price today's rate gives it.
    const target = rebuild(p);
    if (Math.abs((b.sqm || 0) - (p.sqm || 0)) < 0.005) {
      if (b.listPrice === undefined) delete target.listPrice; else target.listPrice = b.listPrice;
    }
    const $set = {}, $unset = {};
    for (const k of SHAPE_FIELDS) {
      if (target[k] === undefined) { if (b[k] !== undefined) $unset[k] = ''; }
      else if (JSON.stringify(target[k]) !== JSON.stringify(b[k])) $set[k] = target[k];
    }
    // Coming off the plan or going back on it is the one change to a status
    // that is the shape's: only ever an available stand, never a booking.
    if (target.status === 'removed' && b.status !== 'removed') $set.status = 'removed';
    if (b.status === 'removed' && target.removed !== true) $set.status = 'available';
    if (!Object.keys($set).length && !Object.keys($unset).length) continue;
    updates.push({ b, $set, $unset, moves: !sameFootprint(b, p) || 'status' in $set });
  }

  // The drawing those stands were placed on, when it is not the one live now.
  // Points written before revisions existed carry none, and leave the artwork.
  const header = await snapshots().findOne({ showId, snapshotId, header: true });
  const liveRev = await floorplans.liveRevisionId(showId);
  const wantRev = header && header.revisionId;
  const rev = wantRev && wantRev !== liveRev ? await floorplans.getRevision(wantRev, { showId }) : null;
  const artwork = rev ? { revisionId: rev.revisionId, label: rev.label } : null;
  const plan = {
    snapshotId, stands: stored.length, replacing: current.length,
    // Bookings ride through untouched; these are the ones that do.
    bookingsKept: current.filter(isBooked).length,
    conflicts,
    changes: { reshaped: updates.map(u => u.b.boothNumber), added: inserts.map(d => d.boothNumber),
               dropped: deletes.map(d => d.boothNumber) },
    logosNotRestored: [...logos], artwork,
  };
  if (!apply) return { ok: true, dryRun: true, ...plan };
  if (conflicts.length) return { ok: false, reason: 'bookings_in_the_way', ...plan };

  const back = await snapshot('pre-restore', current, { actor, showId });
  if (!back.ok) return { ok: false, reason: 'snapshot_failed', detail: back.error };

  // ── The writes, each conditional on the stand being as it was read ─────────
  // Shown numbers are held unique by the database, and a restore can swap two
  // of them; so every label that changes is cleared first, numbers that go are
  // deleted, then the shapes and labels are written, then the stands that come
  // back are inserted. Anything that misses undoes all of it, in reverse.
  const done = { cleared: [], deleted: [], inserted: [] };
  const revOf = (b) => ({ showId, boothNumber: b.boothNumber, ...revFilter(b) });
  const now = new Date();
  let missed = null;
  try {
    for (const u of updates) {
      if (!('displayNumberKey' in u.$set) && !('displayNumberKey' in u.$unset)) continue;
      const r = await col().updateOne(revOf(u.b), { $unset: { displayNumberKey: '' }, $inc: BUMP });
      if (!r.matchedCount) { missed = u.b.boothNumber; break; }
      u.b = { ...u.b, shapeRev: ourRev(u.b) };
      done.cleared.push(u);
    }
    for (const b of missed ? [] : deletes) {
      const r = await col().deleteOne({ ...revOf(b), status: b.status, 'assignment.company': { $in: [null, ''] } });
      if (!r.deletedCount) { missed = b.boothNumber; break; }
      done.deleted.push(b);
    }
    for (const u of missed ? [] : updates) {
      // A stand whose footprint or place on the plan changes must still be
      // unbooked; one whose only change is a label or a record need not be.
      const filter = revOf(u.b);
      if (u.moves) Object.assign(filter, { status: u.b.status, 'assignment.company': { $in: [null, ''] } });
      const update = { $set: { ...u.$set, updatedAt: now }, $inc: BUMP };
      if (Object.keys(u.$unset).length) update.$unset = u.$unset;
      const r = await col().updateOne(filter, update);
      if (!r.matchedCount) { missed = u.b.boothNumber; break; }
      u.b = { ...u.b, shapeRev: ourRev(u.b) };
      u.written = true;
    }
    for (const d of missed ? [] : inserts) {
      await col().insertOne({ ...d, shapeRev: ((records.get(d.boothNumber) || d).shapeRev || 0) + 1, updatedAt: now });
      done.inserted.push(d);
    }
  } catch (e) {
    missed = missed || `(${e.message})`;
  }

  if (missed) {
    // Back out, newest first: the stands that came back go, the shapes are put
    // back with no shown numbers, the stands that went return, and only then do
    // the shown numbers go back on — the same order, for the same index.
    // Each put back only where our own write is still the last one, and only
    // the fields we wrote — a stand whose only change was a label may have
    // been booked since, and that booking stays.
    const touched = updates.filter(u => u.written || done.cleared.includes(u));
    for (const d of done.inserted) await col().deleteOne({ showId, boothNumber: d.boothNumber, status: d.status });
    for (const u of touched) {
      const orig = nowBy.get(u.b.boothNumber);
      const $set = {}, $unset = { displayNumberKey: '' };
      if (u.written) {
        for (const k of [...Object.keys(u.$set), ...Object.keys(u.$unset)]) {
          if (k === 'displayNumberKey') continue;
          if (orig[k] === undefined) $unset[k] = ''; else $set[k] = orig[k];
        }
      }
      const update = { $unset, $inc: BUMP };
      if (Object.keys($set).length) update.$set = $set;
      const r = await col().updateOne({ showId, boothNumber: orig.boothNumber, ...revFilter(u.b) }, update);
      if (r.matchedCount) u.b = { ...u.b, shapeRev: ourRev(u.b) };
    }
    for (const b of done.deleted) await col().insertOne(b);
    for (const u of touched) {
      const orig = nowBy.get(u.b.boothNumber);
      if (orig.displayNumberKey === undefined) continue;
      try { await col().updateOne({ showId, boothNumber: orig.boothNumber, ...revFilter(u.b) },
                                  { $set: { displayNumberKey: orig.displayNumberKey } }); }
      catch (e) { console.error(`Restore rollback: shown number of ${orig.boothNumber} not re-reserved —`, e.message); }
    }
    // The point stored a moment ago describes a change that did not happen.
    await snapshots().deleteMany({ showId, snapshotId: back.snapshotId });
    return { ok: false, reason: 'changed_meanwhile', boothNumber: missed, ...plan };
  }

  // Going back is a change like any other, so it takes its place in the
  // history. Without this the hall as it stood before a restore was stored
  // faithfully and shown nowhere — so the one change that replaces the entire
  // plan was the single one that could not be walked back out of from the
  // console, which is exactly backwards.
  await snapshots().updateOne(
    { showId, snapshotId: back.snapshotId, header: true },
    { $set: { history: true, op: 'restore', label: 'Plan put back to an earlier point',
              detail: snapshotId, boothNumbers: [] } }
  );

  if (artwork) {
    const made = await floorplans.makeLive(artwork.revisionId, { actor, showId });
    if (!made.ok) plan.artwork = null;
    else {
      plan.artworkVersion = made.version;
      plan.drawing = await restoreDrawingSettings(rev.svg, { actor });
    }
  }
  return { ok: true, ...plan, previousSnapshot: back.snapshotId };
}


/**
 * restorePoint, holding the plan lock while it writes.
 *
 * Applying a point writes stand after stand and may switch the drawing; a
 * publish or a stand import doing the same at that moment would interleave
 * with it, each reading the hall the other is halfway through rewriting. Both
 * of those hold the event's plan lock for their whole sequence, so applying a
 * point holds it too. A dry run writes nothing and does not wait. (The lock
 * lives with the drawings in floorplans.js; on a build without it, the restore
 * runs as it always did.)
 */
async function restoreSnapshot(snapshotId, opts = {}) {
  const { apply = false, showId = config.showId } = opts;
  if (apply && typeof floorplans.withPlanLock === 'function') {
    return floorplans.withPlanLock(showId, () => restorePoint(snapshotId, opts));
  }
  return restorePoint(snapshotId, opts);
}

// ─── The plan's history ───────────────────────────────────────────────────────
/**
 * Every change to the shape of a hall, as a point you can go back to.
 *
 * A per-action undo is not a mechanism, it is a courtesy. The removal toast
 * carried an Undo for ten seconds, and the first person to delete a stand found
 * it an hour later and had nothing: the stand was recoverable, but only by
 * someone who knew that Tools held a list of removed stands, and that is not a
 * way back, it is a thing you have to have been told.
 *
 * So each change records the WHOLE hall as it was immediately before it, under
 * an id of its own, and any of those points can be put back — repeatedly, in
 * any order, however long afterwards. Undoing the last change and winding the
 * plan back to where it stood on Tuesday are then the same operation, and
 * nothing depends on a countdown or on remembering where a tool lives.
 *
 * It is the snapshot machinery that already existed, now written on ordinary
 * changes rather than only on the three bulk operations that could destroy an
 * event. A hall of 262 stands is 93 KB, so the two hundred points kept here are
 * about 18 MB — the cost of never having to say "that cannot be undone".
 *
 * What is NOT recorded: bookings. A sale, a hold and a release have their own
 * undo, which restores the booking without touching the rest of the hall, and
 * they happen hundreds of times where a merge happens once. The history is
 * about the SHAPE of the plan — and going back to a point puts back only the
 * shape, leaving every booking as it is (see restoreSnapshot).
 */
const HISTORY_KEEP = Number(process.env.HISTORY_KEEP || 200);

/** Each tracked operation, and how to describe it to the person reading. */
const HISTORY_LABELS = {
  consolidate:     'Stands merged',
  consolidateMany: 'Stands merged',
  split:           'Stand split',
  splitCustom:     'Stand re-carved',
  reset:           'Merge or split undone',
  remove:          'Stand taken off the plan',
  restoreRemoved:  'Stand put back on the plan',
  move:            'Booking moved',
  setDisplayNumber: 'Stand renumbered',
  publish:         'New plan made live',
};

/**
 * Keep only the newest points, so a collection that is written on every change
 * cannot grow without bound. The TTL index covers age; this covers volume.
 */
async function pruneHistory(showId = config.showId) {
  const headers = await snapshots()
    .find({ showId, header: true, history: true }).sort({ at: -1 }).toArray();
  const stale = headers.slice(HISTORY_KEEP);
  for (const h of stale) {
    await snapshots().deleteMany({ showId, snapshotId: h.snapshotId });
  }
  return stale.length;
}

/**
 * Store the hall exactly as these rows have it, as a point to come back to.
 *
 * Called with the rows read BEFORE the change, and only once the change has
 * actually happened — a refused operation has nothing to undo, and a point for
 * it would be a step backwards that moves nothing.
 */
async function writeHistoryPoint(op, rows, { actor = null, detail = '', boothNumbers = [], revisionId } = {}) {
  const snap = await snapshot(op, rows, { actor, revisionId });
  if (!snap.ok) return snap;
  await snapshots().updateOne(
    { showId: config.showId, snapshotId: snap.snapshotId, header: true },
    { $set: { history: true, op, label: HISTORY_LABELS[op] || op, detail, boothNumbers } }
  );
  await pruneHistory();
  return snap;
}

/** The points this event can be put back to, newest first. */
async function history({ showId = config.showId, limit = 50 } = {}) {
  const rows = await snapshots()
    .find({ showId, header: true, history: true }).sort({ at: -1 }).limit(limit).toArray();
  // Each point names the drawing it sat on, so the list can say when going
  // back also changes the plan people see.
  const labels = new Map();
  for (const id of new Set(rows.map(r => r.revisionId).filter(Boolean))) {
    const rev = await floorplans.getRevision(id, { showId });
    if (rev) labels.set(id, rev.label);
  }
  return rows.map(r => ({
    id: r.snapshotId, at: r.at, op: r.op,
    label: r.label || r.op, detail: r.detail || '',
    boothNumbers: r.boothNumbers || [], actor: r.takenBy || null, stands: r.count || 0,
    revisionId: r.revisionId || null, revisionLabel: labels.get(r.revisionId) || null,
  }));
}

/**
 * Wrap a reshaping operation so it leaves a point behind it.
 *
 * The hall is read before the call and written only if the call reports
 * success, so the stored point is the hall as it stood the instant before the
 * change — which is exactly what going back to it has to restore.
 *
 * Only the EXPORTED functions are wrapped. consolidateMany undoes a split by
 * calling reset() directly, and that inner call must not leave a point of its
 * own: the one operation the admin performed is one step back, not two.
 */
function tracked(op, fn) {
  return async function (...args) {
    // A COPY, taken before the call. The rows a driver hands back are not
    // guaranteed to be detached from what the change is about to write — and
    // when they are not, the "before" picture quietly becomes the "after" one,
    // so the point recorded restores the very change it was meant to undo.
    // detach keeps the Dates as Dates, which JSON would not, and the ids as
    // ids, which structuredClone would not.
    const before = detach(await col().find({ showId: config.showId }).toArray());
    const r = await fn(...args);
    if (r && r.ok !== false) {
      // The actor travels in the options object every one of these takes last.
      const opts = args.find(a => a && typeof a === 'object' && !Array.isArray(a) && 'actor' in a) || {};
      const nums = args.filter(a => typeof a === 'string');
      try {
        await writeHistoryPoint(op, before, {
          actor: opts.actor || null,
          boothNumbers: Array.isArray(args[0]) ? args[0] : nums,
          detail: Array.isArray(args[0]) ? args[0].join(', ') : nums.join(' → '),
        });
      } catch (e) {
        // A failed history write must never fail the change itself: the hall is
        // already reshaped, and throwing here would report an error for work
        // that was done. It is logged and the operation stands.
        console.error(`History point for "${op}" failed —`, e.message);
      }
    }
    return r;
  };
}

// ─── What an import must not destroy ──────────────────────────────────────────
/**
 * Stands where real commercial work has happened.
 *
 * The distinction that matters is NOT "is this stand sold". A stand marked
 * sold purely because the artwork printed a name on it represents no booking,
 * no contact and no money; refusing to re-import over those would mean a
 * botched import could never be corrected — which is precisely the state a
 * first import can leave an event in.
 *
 * So a stand counts as committed when someone has done something to it that an
 * import cannot recreate: it is on hold, it has a contact or an agreed price,
 * or it is not available for a reason other than a previous import of this
 * kind. "A previous import of this kind" now means BOTH that it carries the
 * import's mark AND that an import was the last thing to write it. Matching on
 * the mark alone was the critical defect: nothing ever cleared `source`, so an
 * admin booking a stand with a company name and no price — which is exactly
 * what booth:book does — stayed classified as import output for ever, and a
 * re-import deleted paying exhibitors while reporting zero bookings at risk.
 */
function commercialFilter() {
  const fromImport = {
    status: { $in: ['sold', 'held'] },
    'assignment.contactId': null,
    'assignment.actualPrice': null,
    $or: [
      // The import's mark: every write a person makes to the booking clears it
      // (see IMPORT_ACTORS), so a booking can never carry it.
      { source: IMPORT_SOURCE },
      // A stand imported before the mark existed carries only the import's
      // note, which a person converting a hold to a sale for the same company
      // keeps — so for these, an import also has to have written it last.
      { 'assignment.notes': IMPORT_NOTE, updatedBy: { $in: IMPORT_ACTORS } },
    ],
  };
  return {
    $and: [
      // A stand taken off the plan is not a booking: remove() refuses anything
      // booked, and its 'removed' status used to read as "not available" here,
      // so one pulled stand refused every import and blank reset as
      // "has bookings".
      { removed: { $ne: true } },
      { $or: [{ status: { $nin: ['available', 'removed'] } }, { 'assignment.company': { $nin: [null, ''] } }] },
      { $nor: [fromImport] },
    ],
  };
}

/**
 * Stands carrying work the ARTWORK cannot recreate, whether or not anyone has
 * paid for them.
 *
 * A booking is not the only thing an import destroys. Tags, the exhibitor's
 * country, an admin's shown number, a sponsor's logo, a sponsored flag and
 * every merge and split are all invisible to the guard that only counted
 * sold/held/contact/price — so an import on an event that had been laid out by
 * hand silently threw the whole layout away and reported success.
 */
function handworkFilter() {
  return { $or: [
    { displayNumber: { $nin: [null, ''] } },
    { sponsorLogo: { $nin: [null, ''] } },
    { mergeSnapshot: { $exists: true } },
    { splitSnapshot: { $exists: true } },
    { splitFrom: { $nin: [null, ''] } },
    { 'assignment.tags.0': { $exists: true } },
    { 'assignment.country': { $nin: [null, ''] } },
    // The import sets `sponsored` itself, so only a flag that is NOT this
    // import's own is someone's work — otherwise every re-import would refuse
    // on the areas the previous one created.
    { $and: [{ sponsored: true }, { source: { $ne: IMPORT_SOURCE } }] },
    // A stand somebody took off the plan. An import re-reads the artwork, which
    // still draws that rectangle, so without this every upload put the pulled
    // stand back and the person who removed it had to remove it again.
    { removed: true },
  ] };
}

// The same two questions, asked of a document already in hand. They MUST agree
// with the filters above; they are here so the import can decide stand by stand
// what it may overwrite, rather than only all-or-nothing.
const isImportOutput = (b) => {
  const a = b.assignment || {};
  return ['sold', 'held'].includes(b.status) &&
         a.contactId == null && a.actualPrice == null &&
         (b.source === IMPORT_SOURCE ||
          (a.notes === IMPORT_NOTE && IMPORT_ACTORS.includes(b.updatedBy ?? null)));
};
const isCommitted = (b) => {
  if (b.removed === true) return false;
  const a = b.assignment || {};
  const marked = !['available', 'removed'].includes(b.status) || !!(a.company && String(a.company).trim());
  return marked && !isImportOutput(b);
};
const hasHandwork = (b) => {
  const a = b.assignment || {};
  return !!(b.removed === true || b.displayNumber || b.sponsorLogo || b.mergeSnapshot || b.splitSnapshot || b.splitFrom ||
            (Array.isArray(a.tags) && a.tags.length) || a.country ||
            (b.sponsored === true && b.source !== IMPORT_SOURCE));
};
// A stand whose shape was made by merging or splitting is not the artwork's
// rectangle any more. Writing the artwork's geometry back onto it would leave a
// merged block the size of one of its parts, overlapping the others.
const isComposite = (b) => !!(b.mergeSnapshot || b.splitSnapshot || b.splitFrom);

/**
 * How many stands on this show carry work an import cannot recreate.
 *
 * A stand a person actually put on hold has a row in `holds`, with a company
 * and an expiry; one an import wrote does not. That row is the difference
 * between a reservation someone made and a colour read off a drawing, so it is
 * checked directly rather than inferred from the stand alone.
 */
async function countCommitted(showId = config.showId) {
  const byRecord = await col().countDocuments({ showId, ...commercialFilter() });

  // Any stand someone actually reserved, whatever else is true of it. Holds an
  // import wrote are excluded: counting those would mean an import's own held
  // stands refused the next import, which is the loop this guard already had
  // to be dug out of once.
  const held = await getDb().collection('holds')
    .distinct('boothNumber', { showId, source: { $ne: IMPORT_SOURCE } });
  const heldByHand = held.length
    ? await col().countDocuments({ showId, boothNumber: { $in: held } })
    : 0;

  // They can overlap; the larger is the honest floor and is only used to
  // decide whether to refuse.
  return Math.max(byRecord, heldByHand);
}

/** How many stands carry hand-made work — see handworkFilter. */
const countHandwork = (showId = config.showId) =>
  col().countDocuments({ showId, ...handworkFilter() });

/**
 * Read this show's stands out of its artwork and make them its inventory.
 *
 * Everything here is scoped to `config.showId`, which is a getter reading the
 * per-request show context — so an import can only ever touch the event it was
 * asked for. That is not a convention to be careful about; it is enforced by
 * the filter on every query below.
 *
 * TWO MODES, and the difference is the whole point.
 *
 *   upsert (default) — each stand is matched on its number. Geometry, area and
 *     list price are re-read from the plan; everything else the stand carries
 *     is left exactly as it is. A stand that still holds nothing but a previous
 *     import's output also has its status and exhibitor re-read, so a botched
 *     import is still correctable. A merged or split stand is not touched at
 *     all: its shape is no longer the artwork's rectangle.
 *
 *   replace — the old behaviour: the inventory is thrown away and rebuilt.
 *     Kept, because a plan that has genuinely been redrawn needs it, but it is
 *     now something a caller has to ASK for rather than what "import" means.
 *
 * REFUSES on a show with commercial state, or with work the artwork cannot
 * recreate. Europe has stands sold and on hold, so this guard is what makes the
 * feature safe to expose in the admin at all. `force` exists for a deliberate
 * re-import of a plan that has not sold anything yet; it does not bypass the
 * snapshot.
 *
 *   keep — the RE-ISSUED PLAN case: the hall has been extended or redrawn
 *     after selling started, and the new drawing has to land without moving a
 *     single booking. Always an upsert. A stand that is sold, held by a person
 *     or carrying hand-work keeps everything but its shape, size and list
 *     price, which are re-read from the plan; a stand the plan no longer draws
 *     is removed only if nothing but a previous import ever touched it, and is
 *     otherwise left in place and REPORTED by number, status and company so
 *     the person who uploaded the plan can see what the drawing dropped. It
 *     does not bypass the unreadable-fills refusal: a plan whose colours cannot
 *     be read is no safer for being a re-issue.
 *
 * Stands carrying an exhibitor name are imported as sold under that name.
 * The name then belongs to us: our renderer draws it, the smart search finds
 * it, and sales can change it — none of which is true of a name printed into
 * the artwork.
 */
async function importFromArtwork(stands, { actor = null, force = false, replace = false, keep = false } = {}) {
  if (!Array.isArray(stands) || !stands.length) return { ok: false, reason: 'no_stands' };

  const db = getDb();
  const showId = config.showId;

  // A plan whose fills could not be read tells us nothing about what is sold.
  // The reader defaults an unreadable fill to available; if MOST of the plan is
  // unreadable that default is not a reading, it is a guess at the scale of the
  // whole hall, so the import refuses instead of making it.
  const unreadable = stands.filter(s => s.fillUnknown).length;
  if (unreadable * 2 > stands.length && !force) {
    return { ok: false, reason: 'fills_unreadable', unreadable, of: stands.length, showId };
  }

  // A re-issued plan is only ever merged over the inventory, never swapped
  // for it: "keep" and "replace" together would mean keep nothing.
  if (keep) replace = false;

  const committed = await countCommitted(showId);
  if (committed > 0 && !force && !keep) {
    return { ok: false, reason: 'has_bookings', committed, showId };
  }

  const customised = await countHandwork(showId);
  if (customised > 0 && !force && !keep) {
    return { ok: false, reason: 'has_customisations', customised, showId };
  }

  const existing = await col().find({ showId }).toArray();
  let snapshotId = null;
  if (existing.length) {
    // The recovery path. Taken before anything is changed, never conditionally,
    // and a failure to take it ABORTS — proceeding without one is how a reset
    // came to have no way back at all.
    const snap = await snapshot(replace ? 'import-replace' : 'import-from-artwork', existing, { actor, showId });
    if (!snap.ok) return { ok: false, reason: 'snapshot_failed', detail: snap.error, showId };
    snapshotId = snap.snapshotId;
  }

  const perUnit = await settings.rate();
  const now = new Date();

  // What the artwork says a stand is, with nothing of ours in it.
  const fromArtwork = (s) => {
    // Status comes from the colour the plan drew the stand in, not from
    // whether a name happens to be printed on it. North America's plan draws
    // 70 stands in the sold colour and prints 79 names; believing the names
    // sold nine stands that the artwork plainly showed as empty or on hold.
    const status = s.status || 'available';
    const named = !!(s.exhibitor && s.exhibitor.trim());
    return {
      boothNumber: String(s.number),
      svgElementId: `booth-${s.number}`,
      geometry: s.geometry,
      // `sqm` holds the area in whatever unit the show is set to; the unit is
      // a display label held on the show, exactly as it already works.
      sqm: s.area || 0,
      sqmSource: s.areaSource === 'printed' ? 'printed' : 'estimated',
      listPrice: s.area ? Math.round(s.area * perUnit) : null,
      status,
      source: IMPORT_SOURCE,
      // An import's hold has no expiry: the plan says the stand is reserved and
      // that stays true until a person says otherwise. Null — rather than the
      // field being absent — is what tells the expiry sweep to leave it alone
      // for good, instead of falling back to hunting for a hold document.
      ...(status === 'held' ? { holdExpiresAt: null } : {}),
      // A sponsorable area — a lounge or a conference track — drawn in a
      // colour the plan uses for only a handful of shapes.
      sponsored: s.sponsored === true,
      assignment: {
        // A name is only carried onto a stand the plan shows as taken. A name
        // printed on an available stand is stale artwork, not a booking.
        company: status !== 'available' && named ? s.exhibitor.trim() : null,
        contactId: null, actualPrice: null,
        notes: status !== 'available' && named ? IMPORT_NOTE : '',
        tags: [], country: null,
      },
    };
  };

  // The geometry half — the only thing an upsert rewrites on a stand somebody
  // has done something to.
  const SHAPE = ['svgElementId', 'geometry', 'sqm', 'sqmSource', 'listPrice'];

  // Provenance, kept apart from the person: the booking state an import writes
  // is stamped as the import's (see IMPORT_ACTORS), and whoever ran it is
  // recorded alongside rather than in its place.
  const importActor = importActorOf(actor);
  const docs = stands.map(s => ({ showId, ...fromArtwork(s), clicks: 0,
                                  createdAt: now, updatedAt: now, updatedBy: importActor,
                                  importedBy: actor || importActor }));
  const prevByNumber = new Map(existing.map(b => [b.boothNumber, b]));

  // A plan with no readable areas — a re-issue whose printed figures failed to
  // calibrate — gives every stand an area of nothing. That is the reader not
  // knowing, not the stand having shrunk, so a size and price already known
  // are kept rather than overwritten with 0 m² and no price — on every stand,
  // the sold ones included.
  for (const d of docs) {
    const prev = prevByNumber.get(d.boothNumber);
    if (!(d.sqm > 0) && prev && prev.sqm > 0) {
      d.sqm = prev.sqm;
      d.sqmSource = prev.sqmSource;
      d.listPrice = prev.listPrice ?? null;
    }
  }

  const result = { ok: true, showId, mode: replace ? 'replace' : (keep ? 'update' : 'upsert'),
                   imported: docs.length,
                   sold: docs.filter(d => d.status === 'sold').length,
                   available: docs.filter(d => d.status === 'available').length,
                   held: docs.filter(d => d.status === 'held').length,
                   sponsored: docs.filter(d => d.sponsored).length,
                   replaced: existing.length, snapshot: !!snapshotId, snapshotId };

  // ── Replace ─────────────────────────────────────────────────────────────────
  if (replace) {
    // The holds go with the stands, so they come back with them too: a failed
    // insert used to restore the stands and leave every hold deleted, and the
    // sweep then released each restored held stand within the minute.
    const priorHolds = await db.collection('holds').find({ showId }).toArray();
    await col().deleteMany({ showId });
    await db.collection('holds').deleteMany({ showId });
    try {
      await col().insertMany(docs);
    } catch (e) {
      // Delete-then-insert cannot be reordered: the unique index on
      // (showId, boothNumber) refuses a second generation alongside the first,
      // and a multi-document transaction needs a replica set the local database
      // has not got. So the recovery is explicit — put back exactly what was
      // there rather than leaving the show with zero stands, which is what a
      // failed insert used to do.
      console.error('Import: insert failed, restoring the previous stands —', e.message);
      await col().deleteMany({ showId });
      if (existing.length) await col().insertMany(existing);
      await db.collection('holds').deleteMany({ showId });
      if (priorHolds.length) await db.collection('holds').insertMany(priorHolds);
      return { ok: false, reason: 'insert_failed', detail: e.message, restored: existing.length,
               holdsRestored: priorHolds.length, snapshotId, showId };
    }
    await writeImportHolds(db, showId, docs.filter(d => d.status === 'held'), actor, now);
    return result;
  }

  // ── Upsert ──────────────────────────────────────────────────────────────────
  const personHolds = new Set(await db.collection('holds')
    .distinct('boothNumber', { showId, source: { $ne: IMPORT_SOURCE } }));
  // Numbers that live inside a merged block. The plan the block was merged
  // from may still draw them — a designer's file that predates the merge, or
  // one that never had it — and creating them again put a stand back on top of
  // the block: merge 102+103, make live a plan still drawing 103, and 103 came
  // back available on 102's floor. They are skipped and named instead.
  const absorbedInto = new Map();
  for (const b of existing) {
    for (const n of (Array.isArray(b.mergedFrom) ? b.mergedFrom : [])) absorbedInto.set(String(n), b.boothNumber);
  }

  const ops = [];
  const created = [], refreshed = [], reshaped = [], untouched = [], released = [], absorbed = [];
  for (const doc of docs) {
    const prev = prevByNumber.get(doc.boothNumber);
    const filter = { showId, boothNumber: doc.boothNumber };

    if (!prev) {
      if (absorbedInto.has(doc.boothNumber)) {
        absorbed.push({ boothNumber: doc.boothNumber, into: absorbedInto.get(doc.boothNumber) });
        continue;
      }
      created.push(doc.boothNumber);
      ops.push({ updateOne: { filter, update: { $set: doc }, upsert: true } });
      continue;
    }

    // Its shape is ours now, not the plan's — leave the whole record alone.
    if (isComposite(prev)) { untouched.push(doc.boothNumber); continue; }

    // Conditional on the stand's shape revision as read (see revFilter): a
    // stand merged or split while the import ran is composite now, and the
    // plan's rectangle must not be written over the block.
    Object.assign(filter, revFilter(prev));
    const mayRewrite = !isCommitted(prev) && !hasHandwork(prev) && !personHolds.has(prev.boothNumber);
    // Only the shape is the import's to rewrite on a stand somebody has worked
    // on, so only the shape is stamped: `updatedBy` is the provenance of the
    // BOOKING (see IMPORT_ACTORS), and re-stamping a person's booking with
    // 'deploy' while re-reading its outline turned it into import output that
    // the next import set available.
    const $set = { updatedAt: now, shapeReadBy: actor || importActor };
    for (const k of SHAPE) $set[k] = doc[k];

    if (mayRewrite) {
      $set.updatedBy = importActor;
      $set.importedBy = actor || importActor;
      $set.status = doc.status;
      $set.source = doc.source;
      $set.sponsored = doc.sponsored;
      $set.assignment = { ...(prev.assignment || {}), ...doc.assignment };
      // An import's hold has no expiry — the plan says the stand is reserved
      // and that stays true until a person says otherwise. Null (rather than
      // absent) is what tells the expiry sweep to leave it alone for good.
      if (doc.status === 'held') $set.holdExpiresAt = null;
      // A stand the plan no longer draws as reserved has to lose the hold the
      // last import gave it, document and all. Left behind, it shows in the
      // admin's hold list as a reservation on a stand that is plainly for sale.
      else if (prev.status === 'held') released.push(doc.boothNumber);
      refreshed.push(doc.boothNumber);
    } else {
      reshaped.push(doc.boothNumber);
    }
    ops.push({ updateOne: { filter, update: released.includes(doc.boothNumber)
      ? { $set, $unset: { holdExpiresAt: '' }, $inc: BUMP } : { $set, $inc: BUMP } } });
  }

  if (ops.length) await col().bulkWrite(ops, { ordered: false });
  if (released.length) {
    await db.collection('holds').deleteMany(
      { showId, boothNumber: { $in: released }, source: IMPORT_SOURCE });
  }

  // Stands the plan no longer draws. Left in place and REPORTED rather than
  // removed: an upsert that quietly deleted them would be the destructive
  // behaviour this mode exists to avoid.
  const incoming = new Set(docs.map(d => d.boothNumber));
  const orphans = existing.filter(b => !incoming.has(b.boothNumber));
  const orphaned = orphans.map(b => b.boothNumber);

  // A re-issued plan is the one case where a stand that has vanished from the
  // drawing is removed — and only a stand that has nothing on it but what a
  // previous import wrote. An empty stand the new hall does not draw is not
  // inventory; left behind it would be counted as available and be unclickable
  // on the plan, which is exactly the phantom-stand fault the artwork spec
  // exists to prevent. Anything a person touched — a sale, a hold, a merge, a
  // logo — stays, and is named in the result so the person uploading can see
  // what the drawing dropped.
  const removed = [];
  const kept = [];
  if (keep) {
    for (const b of orphans) {
      const ours = b.source === IMPORT_SOURCE && !isCommitted(b) && !hasHandwork(b) &&
                   !isComposite(b) && !personHolds.has(b.boothNumber);
      if (ours) removed.push(b.boothNumber);
      else kept.push({ boothNumber: b.boothNumber, status: b.status,
                       company: (b.assignment && b.assignment.company) || null });
    }
    if (removed.length) {
      await col().deleteMany({ showId, boothNumber: { $in: removed } });
      await db.collection('holds').deleteMany({ showId, boothNumber: { $in: removed }, source: IMPORT_SOURCE });
    }
  }

  const heldNow = docs.filter(d => d.status === 'held' &&
    (created.includes(d.boothNumber) || refreshed.includes(d.boothNumber)));
  await writeImportHolds(db, showId, heldNow, actor, now, { onlyOurs: true });

  return { ...result, created: created.length, refreshed: refreshed.length,
           reshaped: reshaped.length, untouched: untouched.length,
           released: released.length, orphaned, preserved: reshaped.concat(untouched),
           createdNumbers: created, reshapedNumbers: reshaped, untouchedNumbers: untouched,
           // { boothNumber, into }: drawn by the plan, but inside merged block `into`.
           absorbed, removed, kept };
}

/**
 * A stand marked held needs a hold DOCUMENT as well as the status, or the
 * expiry sweep — which re-derives truth from the hold documents — finds a
 * held stand nobody is holding and releases it. That is what turned the four
 * stands North America's plan draws as reserved back into empty ones.
 *
 * No expiresAt: the sweep treats a hold without one as live, which is right.
 * The plan says these are reserved, and that stays true until a person says
 * otherwise — unlike a hold someone takes on the website, which is a
 * countdown. `source` marks them so they are not later mistaken for
 * reservations a person made.
 */
async function writeImportHolds(db, showId, heldDocs, actor, now, { onlyOurs = false } = {}) {
  if (!heldDocs.length) return 0;
  const nums = heldDocs.map(d => d.boothNumber);
  // Only ever clears the import's OWN holds: a reservation a person made on one
  // of these stands is theirs, and the upsert path has already refused to
  // rewrite that stand's status anyway.
  const scope = { showId, boothNumber: { $in: nums } };
  if (onlyOurs) scope.source = IMPORT_SOURCE;
  await db.collection('holds').deleteMany(scope);
  await db.collection('holds').insertMany(heldDocs.map(d => ({
    showId, boothNumber: d.boothNumber, company: d.assignment.company,
    contactId: null, sessionId: null, createdAt: now,
    createdBy: actor || 'import', source: IMPORT_SOURCE,
  })));
  return nums.length;
}

// ─── Deliberate, destructive operations ───────────────────────────────────────
// Each of the three below used to run as a SIDE EFFECT OF BOOTING, guarded only
// by a flag in `meta`. That is the wrong shape for an operation that rewrites
// an event's inventory: nobody chose to run it, nobody saw what it was about to
// do, and a flag written on a half-finished run silently disabled the repair for
// good. They are now plain functions that DEFAULT TO A DRY RUN, and the only
// things that call them are the scripts in scripts/, which print the database,
// the event and every change before writing anything.

/**
 * Repair for the two stands the "booth got bigger and bigger" bug left at half
 * size (128, 198).
 *
 * DEAD as it stands, and it says so rather than pretending: the coordinates it
 * matches (x:2086) belong to the LEX26 drawing space, and the current plan is
 * LEX27 — 262 stands numbered by their printed number, none further right than
 * x:1654, with no stand 128 or 198 at all. Nothing can match, yet it wrote its
 * completion flag on every boot regardless, which is what made it look done.
 * Kept because the dry run is the cheapest possible proof of that, and because
 * the same repair on a restored LEX26 database would still be correct.
 *
 * It only acts on a stand that STILL matches the exact corrupted footprint,
 * isn't part of a live split/merge, and has no sibling `-2` cell — a size-only
 * heuristic would otherwise clobber a LEGITIMATE later split (an admin
 * splitting 128 into two 67×67 cells matches the half-size test exactly).
 */
async function repairHalvedStands({ apply = false, actor = 'repair:halved-stands' } = {}) {
  const FIXES = [
    { boothNumber: '128', from: { x: 2086, y: 834,  w: 67, h: 67  }, to: { x: 2086, y: 834,  w: 67,  h: 134 }, sqm: 32 },
    { boothNumber: '198', from: { x: 1650, y: 1379, w: 67, h: 101 }, to: { x: 1650, y: 1379, w: 134, h: 101 }, sqm: 48 },
  ];
  const near = (g, t) => g && ['x', 'y', 'w', 'h'].every(k => Math.abs(g[k] - t[k]) < 3);

  const planned = [], skipped = [];
  for (const f of FIXES) {
    const b = await get(f.boothNumber);
    if (!b)                             { skipped.push({ boothNumber: f.boothNumber, why: 'no such stand on this event' }); continue; }
    if (!near(b.geometry, f.from))      { skipped.push({ boothNumber: f.boothNumber, why: `drawn ${Math.round(b.geometry?.w)}×${Math.round(b.geometry?.h)}, not the corrupted half` }); continue; }
    if (b.splitSnapshot || b.mergeSnapshot || b.splitFrom) { skipped.push({ boothNumber: f.boothNumber, why: 'part of a live split or merge' }); continue; }
    if (await get(`${f.boothNumber}-2`)) { skipped.push({ boothNumber: f.boothNumber, why: 'a real split sibling exists' }); continue; }
    const rate = (b.sqm && b.listPrice) ? b.listPrice / b.sqm : (config.ratePerSqm || 600);
    planned.push({ boothNumber: f.boothNumber, from: b.geometry, to: f.to,
                   fromSqm: b.sqm, sqm: f.sqm, listPrice: Math.round(f.sqm * rate), status: b.status });
  }

  if (apply) {
    for (const p of planned) {
      await col().updateOne(
        { showId: config.showId, boothNumber: p.boothNumber },
        { $set: { geometry: p.to, sqm: p.sqm, listPrice: p.listPrice,
                  updatedAt: new Date(), updatedBy: actor } });
    }
  }
  return { ok: true, dryRun: !apply, planned, skipped, applied: apply ? planned.length : 0 };
}

/**
 * Read the blank-plan source — the stand rectangles extracted from the original
 * artwork — or say plainly why it cannot be read: including that it is not this
 * event's plan at all. `scripts/reset-blank-layout.js --show lna --apply`, as
 * its own usage text suggested, would have rebuilt North America from Europe's
 * stands at Europe's prices.
 */
function readBoothData(showId = config.showId) {
  if (showId !== boothDataShow()) return { ok: false, reason: 'wrong_event', showId, belongsTo: boothDataShow() };
  try {
    const raw = JSON.parse(fs.readFileSync(BOOTH_DATA, 'utf8'));
    const rows = Object.values(raw);
    return rows.length ? { ok: true, rows } : { ok: false, reason: 'empty-source' };
  } catch (e) {
    return { ok: false, reason: 'no-source', detail: e.message };
  }
}

/**
 * Rebuild the plan from the original SVG extraction, removing every split cell
 * and merge so the layout matches the artwork again.
 *
 * Existing bookings are carried onto the matching original stand by position
 * (the same geometry match reseed.js uses), and the admin-set shown-number and
 * sponsor flags ride along too. A booking that sat on a split cell with no
 * original equivalent is dropped (its shape no longer exists) — that's the
 * intended trade-off of collapsing the plan back to the original, and the dry
 * run names every one of them before it happens.
 */
async function restoreOriginalLayout({ apply = false, force = false, actor = 'restore-original' } = {}) {
  const db = getDb();
  const showId = config.showId;

  const src = readBoothData(showId);
  if (!src.ok) return { ok: false, reason: src.reason, detail: src.detail, showId, belongsTo: src.belongsTo };
  const fresh = src.rows;
  // Priced at this event's own rate. The file's prices are Europe's at the rate
  // it had when the file was made, and the rate has been changed since.
  const perUnit = await settings.rate();

  const committed = await countCommitted(showId);
  if (committed > 0 && !force) return { ok: false, reason: 'has_bookings', committed, showId };

  const oldBooths = await col().find({ showId }).toArray();

  const TOL = 3;
  const centre    = g => ({ x: g.x + g.w / 2, y: g.y + g.h / 2 });
  const fc        = f => centre({ x: f.x, y: f.y, w: f.w, h: f.h });
  const near      = (a, b) => Math.abs(a.x - b.x) < TOL && Math.abs(a.y - b.y) < TOL;
  const sizeClose = (a, b) => Math.abs(a.w - b.w) < TOL * 4 && Math.abs(a.h - b.h) < TOL * 4;
  // A booking, not a removal: a stand taken off the plan has status 'removed',
  // which is no booking to carry (see commercialFilter).
  const hasState  = b => { const a = b.assignment || {}; return ['sold', 'held'].includes(b.status) || a.company || a.actualPrice || a.notes || (b.clicks || 0) > 0; };
  // Carry a stand's data forward if it holds a booking OR an admin override.
  const hasCarry  = b => hasState(b) || b.displayNumber || b.sponsored;

  // Match each carried old stand to the nearest same-size original stand.
  const matches = [];
  for (const o of oldBooths.filter(hasCarry)) {
    if (!o.geometry) continue;
    const oc = centre(o.geometry);
    const cands = fresh
      .filter(f => near(fc(f), oc) && sizeClose(o.geometry, { w: f.w, h: f.h }))
      .map(f => ({ f, d: Math.abs(fc(f).x - oc.x) + Math.abs(fc(f).y - oc.y) }))
      .sort((p, q) => p.d - q.d);
    if (cands.length) matches.push({ old: o, next: cands[0].f, d: cands[0].d });
  }
  // One original stand can only receive one old booking — keep the nearest.
  const byNew = new Map();
  for (const m of matches) {
    const prev = byNew.get(m.next.boothId);
    if (!prev || m.d < prev.d) byNew.set(m.next.boothId, m);
  }
  const finalMatches = [...byNew.values()];
  const toNum = f => String(f.boothId).replace(/^booth-/, '');
  const remap = new Map(finalMatches.map(m => [m.old.boothNumber, toNum(m.next)]));

  // Named, not counted. A booking about to be dropped because its shape no
  // longer exists is the one thing a person has to see before saying yes.
  const carried = new Set(finalMatches.map(m => m.old.boothNumber));
  const losing = oldBooths.filter(b => hasCarry(b) && !carried.has(b.boothNumber))
    .map(b => ({ boothNumber: b.boothNumber, status: b.status, company: b.assignment?.company || null }));

  const plan = { showId, stands: fresh.length, replacing: oldBooths.length,
                 carrying: finalMatches.length, dropping: losing, committed };
  if (!apply) return { ok: true, dryRun: true, ...plan };

  const snap = await snapshot('restore-original-layout', oldBooths, { actor, showId });
  if (!snap.ok) return { ok: false, reason: 'snapshot_failed', detail: snap.error };

  const now = new Date();
  const docs = fresh.map(f => ({
    showId,
    boothNumber: toNum(f),
    svgElementId: f.boothId,
    geometry: { x: f.x, y: f.y, w: f.w, h: f.h },
    sqm: f.sqm, sqmSource: 'estimated', listPrice: Math.round((f.sqm || 0) * perUnit),
    status: f.status,
    assignment: { company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null },
    clicks: 0, createdAt: now, updatedAt: now, updatedBy: actor,
  }));

  await col().deleteMany({ showId });
  try {
    await col().insertMany(docs);
  } catch (e) {
    console.error('restoreOriginalLayout: insert failed, putting the previous stands back —', e.message);
    await col().deleteMany({ showId });
    if (oldBooths.length) await col().insertMany(oldBooths);
    return { ok: false, reason: 'insert_failed', detail: e.message, snapshotId: snap.snapshotId };
  }
  const freshNums = new Set(docs.map(d => d.boothNumber));

  // Carry bookings + admin overrides onto their matched stands.
  for (const m of finalMatches) {
    const a = m.old.assignment || {};
    const $set = {
      // A removed stand carried for its shown number or sponsor flag comes back
      // available, never with a 'removed' status and no flag to match it.
      status: m.old.removed === true ? 'available' : m.old.status,
      'assignment.company': a.company ?? null,
      'assignment.contactId': a.contactId ?? null,
      'assignment.actualPrice': a.actualPrice ?? null,
      'assignment.notes': a.notes ?? '',
      'assignment.tags': Array.isArray(a.tags) ? a.tags : [],
      'assignment.country': a.country ?? null,
      clicks: m.old.clicks || 0,
      updatedAt: now, updatedBy: `${actor}:carried`,
    };
    if (m.old.displayNumber) {
      $set.displayNumber = m.old.displayNumber;
      $set.displayNumberKey = displayKey(m.old.displayNumber);
    }
    if (m.old.sponsored)   $set.sponsored = true;
    if (m.old.sponsorLogo) $set.sponsorLogo = m.old.sponsorLogo;
    if (m.old.holdExpiresAt !== undefined) $set.holdExpiresAt = m.old.holdExpiresAt;
    await col().updateOne({ showId, boothNumber: toNum(m.next) }, { $set });
  }

  // Re-point holds: move a matched booking's hold, drop one whose stand is gone.
  const holds = await db.collection('holds').find({ showId }).toArray();
  for (const h of holds) {
    const to = remap.get(h.boothNumber);
    if (to && to !== h.boothNumber) await db.collection('holds').updateOne({ _id: h._id }, { $set: { boothNumber: to } });
    else if (!to && !freshNums.has(h.boothNumber)) await db.collection('holds').deleteOne({ _id: h._id });
  }

  // Re-point lead stand references through the same map; drop refs now gone.
  const inqs = await db.collection('inquiries').find({ showId }).toArray();
  for (const q of inqs) {
    if (!Array.isArray(q.boothsOfInterest) || !q.boothsOfInterest.length) continue;
    const mapped = q.boothsOfInterest.map(n => remap.get(n) || n).filter(n => freshNums.has(n));
    if (mapped.join(',') !== q.boothsOfInterest.join(','))
      await db.collection('inquiries').updateOne({ _id: q._id }, { $set: { boothsOfInterest: mapped } });
  }

  return { ok: true, ...plan, inserted: docs.length, carried: finalMatches.length,
           snapshotId: snap.snapshotId };
}

/**
 * Reset to a completely blank original plan. Rebuilds the stands from the SVG
 * extraction with EVERY stand available — all bookings, holds, sponsor flags
 * and shown-number overrides cleared, nothing carried. The original 'sold'
 * flags baked into the extraction are forced available too, so the result is a
 * clean, fully sell-able plan.
 *
 * Leads and enquiries are deliberately left untouched — they are sales records,
 * not plan state.
 *
 * A failed snapshot ABORTS. It used to be caught and logged, and the reset then
 * destroyed the event's inventory with no way back at all — which is the exact
 * situation the snapshot exists for.
 */
async function resetToBlankLayout({ apply = false, force = false, actor = 'reset-blank' } = {}) {
  const db = getDb();
  const showId = config.showId;

  const src = readBoothData(showId);
  if (!src.ok) return { ok: false, reason: src.reason, detail: src.detail, showId, belongsTo: src.belongsTo };
  const fresh = src.rows;
  // Priced at this event's own rate. The file's prices are Europe's at the rate
  // it had when the file was made, and the rate has been changed since.
  const perUnit = await settings.rate();

  const committed = await countCommitted(showId);
  if (committed > 0 && !force) return { ok: false, reason: 'has_bookings', committed, showId };

  const oldBooths = await col().find({ showId }).toArray();
  // Bookings only: a stand taken off the plan is not one (see commercialFilter).
  const heldOrSold = oldBooths.filter(b => ['sold', 'held'].includes(b.status) && b.removed !== true)
    .map(b => ({ boothNumber: b.boothNumber, status: b.status, company: b.assignment?.company || null }));
  const holds = await db.collection('holds').countDocuments({ showId });

  const plan = { showId, stands: fresh.length, replacing: oldBooths.length,
                 clearing: heldOrSold, holdsCleared: holds, committed,
                 customised: await countHandwork(showId) };
  if (!apply) return { ok: true, dryRun: true, ...plan };

  const snap = await snapshot('reset-blank-layout', oldBooths, { actor, showId });
  if (!snap.ok) return { ok: false, reason: 'snapshot_failed', detail: snap.error };

  const now = new Date();
  const docs = fresh.map(f => ({
    showId,
    boothNumber: String(f.boothId).replace(/^booth-/, ''),
    svgElementId: f.boothId,
    geometry: { x: f.x, y: f.y, w: f.w, h: f.h },
    sqm: f.sqm, sqmSource: 'estimated', listPrice: Math.round((f.sqm || 0) * perUnit),
    status: 'available',                 // FORCE available — blank, sell-able plan
    assignment: { company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null },
    clicks: 0, createdAt: now, updatedAt: now, updatedBy: actor,
  }));

  await col().deleteMany({ showId });
  try {
    await col().insertMany(docs);
  } catch (e) {
    console.error('resetToBlankLayout: insert failed, putting the previous stands back —', e.message);
    await col().deleteMany({ showId });
    if (oldBooths.length) await col().insertMany(oldBooths);
    return { ok: false, reason: 'insert_failed', detail: e.message, snapshotId: snap.snapshotId };
  }
  await db.collection('holds').deleteMany({ showId });

  return { ok: true, ...plan, inserted: docs.length, snapshotId: snap.snapshotId };
}

/**
 * The operations that reshape a hall, each leaving a point to come back to.
 *
 * Wrapped HERE and nowhere else: the module's own calls go to the bare
 * functions above, so an operation built out of others — consolidateMany
 * undoing a split through reset — is one step back for the admin, not two.
 */
module.exports = { col, all, get, toPublic, toAdmin, ensureIndexes, setStatus, updateDeal,
                   move: tracked('move', move),
                   setDisplayNumber: tracked('setDisplayNumber', setDisplayNumber),
                   setSponsored, setSponsorLogo, setTags, setCountry, removeTag,
                   recomputeListPrices, incrementClicks, stats,
                   consolidate: tracked('consolidate', consolidate),
                   consolidateMany: tracked('consolidateMany', consolidateMany),
                   split: tracked('split', split),
                   splitCustom: tracked('splitCustom', splitCustom),
                   reset: tracked('reset', reset),
                   remove: tracked('remove', remove),
                   restoreRemoved: tracked('restoreRemoved', restoreRemoved),
                   removedStands, history, pruneHistory, writeHistoryPoint,
                   repairHalvedStands, restoreOriginalLayout, resetToBlankLayout, importFromArtwork,
                   commercialFilter, handworkFilter, countCommitted, countHandwork,
                   snapshot, listSnapshots, restoreSnapshot,
                   IMPORT_SOURCE, IMPORT_NOTE, IMPORT_ACTORS };
