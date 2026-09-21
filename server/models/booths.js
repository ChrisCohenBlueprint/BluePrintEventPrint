const { getDb } = require('../db');
const config    = require('../config');
const countries = require('../data/countries');
const settings  = require('./settings');
const { safeImage } = require('../lib/safe-url');
const { readRects } = require('../lib/extract-stands');
const floorplans = require('./floorplans');
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
 * numbers — so keeping them costs the broadcast almost nothing.
 */
const all = () => col().find({ showId: config.showId })
  .project({ 'mergeSnapshot.parts': 0 }).toArray();

const get = (boothNumber) => col().findOne({ showId: config.showId, boothNumber });

/**
 * Projection sent to the public floorplan.
 *
 * Status names and exhibitor company names are unchanged from the original —
 * naming who has taken a stand is the point of a published floorplan.
 *
 * What is withheld is the negotiated price and the internal deal notes. The
 * original broadcast the entire booth record to every visitor, so those were
 * public by accident rather than by intent.
 */
function toPublic(b) {
  return {
    boothNumber: b.boothNumber,
    // svgElementId is deliberately not sent. Stands are bound to the artwork by
    // geometry, not by element id, and no client has read this since that
    // changed — it was 273 strings on every broadcast for nobody. It stays on
    // the document, where the import and the migration scripts still write it.
    status:  b.status,
    company: b.assignment?.company || null,
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
    viewers: b.viewers || 0,
    interest: b.clicks || 0,
  };
}

const toAdmin = (b) => b;

/**
 * Set a booth's status.
 *
 * `expect` optionally names the prior statuses this change is allowed from, and
 * is applied as a filter on the write itself — so a booking cannot silently
 * overwrite one another admin made a moment earlier. `changed` reports whether
 * the conditional write actually matched, letting the caller warn on a
 * conflict. With no `expect`, the write is unconditional as before.
 */
async function setStatus(boothNumber, status, { company = null, actor = null, expect = null,
                                                holdExpiresAt = undefined } = {}) {
  const before = await get(boothNumber);
  if (!before) return null;

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
  // Tags describe the exhibitor, so they cannot outlive them: re-booking a stand
  // to a DIFFERENT company drops the previous one's categories rather than
  // letting the new occupant inherit them. Re-stating the same company (a hold
  // converting to a sale, say) keeps them.
  if (status !== 'available' && (before.assignment?.company || null) !== (company || null)) {
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

async function updateDeal(boothNumber, { actualPrice, notes, actor = null }) {
  const before = await get(boothNumber);
  if (!before) return null;

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
  const res = await col().updateOne(
    { showId: config.showId, boothNumber, status: { $in: ['sold', 'held'] } },
    { $set, $unset: { source: '' } }
  );
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
  const rows = await col().find({ showId: config.showId })
    .project({ boothNumber: 1, sqm: 1, mergeSnapshot: 1, splitSnapshot: 1 }).toArray();
  if (!rows.length) return { ok: true, repriced: 0 };
  const now = new Date();
  const at = (sqm) => Math.round((sqm || 0) * r);

  // The composite snapshots hold their own prices — the footprint a merged
  // stand had before it was merged, and the full record of every stand it
  // absorbed. A rate change that did not reach into them meant Reset restored
  // PRE-RATE-CHANGE prices onto live stands, quietly putting the old rate back
  // on the plan months after it was raised.
  const ops = rows.map(b => {
    const $set = { listPrice: at(b.sqm), updatedAt: now, updatedBy: actor };
    if (b.mergeSnapshot) {
      const snap = b.mergeSnapshot;
      $set.mergeSnapshot = {
        ...snap,
        self: { ...snap.self, listPrice: at(snap.self && snap.self.sqm) },
        parts: (snap.parts || []).map(part => ({ ...part, listPrice: at(part.sqm) })),
      };
    }
    if (b.splitSnapshot) {
      const snap = b.splitSnapshot;
      $set.splitSnapshot = { ...snap, self: { ...snap.self, listPrice: at(snap.self && snap.self.sqm) } };
    }
    return { updateOne: { filter: { showId: config.showId, boothNumber: b.boothNumber }, update: { $set } } };
  });

  // One round trip rather than one per stand: this ran ~270 sequential updates
  // on a rate change, which is minutes of an admin watching a spinner.
  const res = await col().bulkWrite(ops, { ordered: false });
  return { ok: true, repriced: res.modifiedCount ?? ops.length };
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
 */
async function setDisplayNumber(boothNumber, value, { actor = null } = {}) {
  const booth = await get(boothNumber);
  if (!booth) return { ok: false, reason: 'missing_booth' };

  const raw = String(value == null ? '' : value).trim().slice(0, 20);

  if (!raw) {                          // clear the override
    await col().updateOne({ showId: config.showId, boothNumber },
      { $unset: CLEAR_DISPLAY, $set: { updatedAt: new Date(), updatedBy: actor } });
    return { ok: true, cleared: true, before: booth, after: await get(boothNumber) };
  }

  if (!/^[A-Za-z0-9 /.\-]{1,20}$/.test(raw)) return { ok: false, reason: 'bad_value' };
  if (raw === boothNumber) {            // "showing its own identity" = no override needed
    await col().updateOne({ showId: config.showId, boothNumber },
      { $unset: CLEAR_DISPLAY, $set: { updatedAt: new Date(), updatedBy: actor } });
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
              updatedAt: new Date(), updatedBy: actor } });
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
  const from = await get(fromNum);
  const to   = await get(toNum);
  if (!from || !to) return { ok: false, reason: 'missing_booth' };
  if (from.status === 'available') return { ok: false, reason: 'nothing_to_move' };  // no booking on the source
  if (to.status !== 'available')   return { ok: false, reason: 'to_not_available' };

  const movedStatus = from.status;   // captured before any write, so it can't alias
  const a = from.assignment || {};
  // Preserve their negotiated rate: €/m² on the old stand × the new size. No
  // negotiated price means they were on list, so leave it on the new list.
  let newActual = null;
  if (a.actualPrice != null && from.sqm > 0) newActual = Math.round((a.actualPrice / from.sqm) * (to.sqm || 0));

  const assignment = { company: a.company || null, contactId: a.contactId || null, actualPrice: newActual,
                       notes: a.notes || '', tags: Array.isArray(a.tags) ? a.tags : [], country: a.country || null };

  // Claim the destination FIRST, only while it is still available — so we can
  // never overwrite a booking that landed on it a moment ago.
  //
  // A HELD booking carries an expiry, and that expiry has to land on the
  // destination in this same write. The socket layer re-points the hold
  // DOCUMENT two steps later; until it does, a destination marked held with no
  // expiry and no document is exactly what the sweep reclaims, so the stand an
  // exhibitor was just moved onto went back on sale within the minute. Carrying
  // it here closes that window on the model side, whatever the caller does
  // afterwards. `source` goes for the reason in setStatus: a person moved this.
  const $claim = { status: movedStatus, assignment, updatedAt: new Date(), updatedBy: actor };
  if (movedStatus === 'held') $claim.holdExpiresAt = from.holdExpiresAt ?? null;
  const claim = await col().updateOne(
    { showId: config.showId, boothNumber: toNum, status: 'available' },
    { $set: $claim, $unset: { source: '' } }
  );
  if (!claim.matchedCount) return { ok: false, reason: 'to_not_available' };

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
    return { ok: false, reason: 'move_conflict' };
  }

  return {
    ok: true, status: movedStatus, company: a.company || null,
    from: fromNum, to: toNum,
    fromSqm: from.sqm, toSqm: to.sqm,
    fromListPrice: from.listPrice, toListPrice: to.listPrice,
    newActualPrice: newActual,
  };
}

async function stats() {
  const [agg] = await col().aggregate([
    { $match: { showId: config.showId } },
    { $group: {
        _id: null,
        totalBooths: { $sum: 1 },
        totalSqm:    { $sum: '$sqm' },
        totalRevenue:{ $sum: '$listPrice' },
        availableBooths: { $sum: { $cond: [{ $eq: ['$status', 'available'] }, 1, 0] } },
        soldBooths:      { $sum: { $cond: [{ $eq: ['$status', 'sold'] },      1, 0] } },
        heldBooths:      { $sum: { $cond: [{ $eq: ['$status', 'held'] },      1, 0] } },
        availSqm: { $sum: { $cond: [{ $eq: ['$status', 'available'] }, '$sqm', 0] } },
        soldSqm:  { $sum: { $cond: [{ $eq: ['$status', 'sold'] },      '$sqm', 0] } },
        heldSqm:  { $sum: { $cond: [{ $eq: ['$status', 'held'] },      '$sqm', 0] } },
        availRev: { $sum: { $cond: [{ $eq: ['$status', 'available'] }, '$listPrice', 0] } },
        earnedRev:{ $sum: { $cond: [{ $eq: ['$status', 'sold'] },      '$listPrice', 0] } },
        heldRev:  { $sum: { $cond: [{ $eq: ['$status', 'held'] },      '$listPrice', 0] } },
    } },
  ]).toArray();

  const base = { totalBooths: 0, availableBooths: 0, soldBooths: 0, heldBooths: 0,
                 totalSqm: 0, availSqm: 0, soldSqm: 0, heldSqm: 0,
                 totalRevenue: 0, earnedRev: 0, availRev: 0, heldRev: 0 };
  const { _id, ...rest } = agg || {};
  return { ...base, ...rest };
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
 * Merge `secondary` into `primary`: the primary absorbs the combined area, list
 * price and footprint, and the secondary is deleted. The geometry becomes the
 * bounding box of the two, so the merged stand still maps onto the plan.
 */
async function consolidate(primaryNum, secondaryNum, { actor = null } = {}) {
  let a = await get(primaryNum);
  let b = await get(secondaryNum);
  if (!a || !b) return { ok: false, reason: 'missing_booth' };
  if (primaryNum === secondaryNum) return { ok: false, reason: 'same_booth' };

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

  // A stand already shaped by a split can't also be merged without first being
  // reset — otherwise it would carry two composite snapshots at once, or leave
  // a dangling split parent/child reference. (Growing an existing merge is fine:
  // the primary may already have a mergeSnapshot; the secondary may not, or it
  // would nest.)
  if (a.splitSnapshot || a.splitFrom || b.splitSnapshot || b.splitFrom || b.mergeSnapshot) {
    return { ok: false, reason: 'reset_first' };
  }

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

  // Snapshot for a later reset: the primary's own footprint before its FIRST
  // merge (captured once), plus the full record of each absorbed stand. Reset
  // uses this to restore everything exactly.
  const mergeSnapshot = a.mergeSnapshot
    || { self: { geometry: a.geometry, sqm: a.sqm, listPrice: a.listPrice }, parts: [] };
  mergeSnapshot.parts = [...mergeSnapshot.parts, b];

  const $set = {
    sqm: (a.sqm || 0) + (b.sqm || 0),
    listPrice: (a.listPrice || 0) + (b.listPrice || 0),
    mergedFrom: [...(a.mergedFrom || []), secondaryNum],
    mergeSnapshot,
    updatedAt: new Date(), updatedBy: actor,
  };
  if (box) $set.geometry = box;   // never $set an undefined geometry

  // The status re-checks above are only a read; between them and the writes
  // another admin could book either stand. Both writes are therefore
  // conditional on the stand still being available, and if the second fails we
  // undo the first — so a booking made mid-merge is never silently destroyed.
  // (No multi-document transaction: it would require a replica set and break
  // local single-node Mongo.)
  //
  // Enlarge the primary FIRST, delete the secondary SECOND. If the process dies
  // between the two writes, the failure mode is an over-count (primary already
  // grown, secondary still present) that `reset` recovers — never a silently
  // lost stand, which the old delete-first order risked.
  const upd = await col().updateOne(
    { showId: config.showId, boothNumber: primaryNum, status: 'available' },
    { $set }
  );
  if (!upd.matchedCount) return { ok: false, reason: 'not_available' };   // primary taken; nothing to undo

  const del = await col().deleteOne({ showId: config.showId, boothNumber: secondaryNum, status: 'available' });
  if (!del.deletedCount) {
    // Secondary was booked/held between the read and now. Roll the primary back
    // to exactly its pre-merge shape so the enlargement doesn't stick. Fields
    // that didn't exist before the merge (first-ever merge) are removed, not set
    // to null, so the record matches its original form.
    const restore = { $set: { sqm: a.sqm, listPrice: a.listPrice, updatedAt: new Date(), updatedBy: actor }, $unset: {} };
    if (a.geometry)      restore.$set.geometry      = a.geometry;      else restore.$unset.geometry = '';
    if (a.mergedFrom)    restore.$set.mergedFrom    = a.mergedFrom;    else restore.$unset.mergedFrom = '';
    if (a.mergeSnapshot) restore.$set.mergeSnapshot = a.mergeSnapshot; else restore.$unset.mergeSnapshot = '';
    if (!Object.keys(restore.$unset).length) delete restore.$unset;
    await col().updateOne({ showId: config.showId, boothNumber: primaryNum }, restore);
    return { ok: false, reason: 'not_available' };
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
  for (const n of nums) { const d = await get(n); if (!d) return { ok: false, reason: 'missing_booth' }; docs.push(d); }
  for (const d of docs) {
    if (d.status !== 'available' || (d.assignment && d.assignment.company)) return { ok: false, reason: 'not_available' };
    if (d.splitSnapshot || d.splitFrom || d.mergeSnapshot) return { ok: false, reason: 'reset_first' };
    if (!d.geometry) return { ok: false, reason: 'no_geometry' };
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
  const totalSqm   = docs.reduce((s, d) => s + (d.sqm || 0), 0);
  const totalPrice = docs.reduce((s, d) => s + (d.listPrice || 0), 0);
  const mergeSnapshot = { self: { geometry: survivor.geometry, sqm: survivor.sqm, listPrice: survivor.listPrice }, parts: others };

  const upd = await col().updateOne(
    { showId: config.showId, boothNumber: survivorNum, status: 'available' },
    { $set: { geometry: box, sqm: totalSqm, listPrice: totalPrice,
              mergedFrom: others.map(o => o.boothNumber), mergeSnapshot, updatedAt: new Date(), updatedBy: actor } }
  );
  if (!upd.matchedCount) return { ok: false, reason: 'not_available' };

  const removed = [];
  for (const o of others) {
    const del = await col().deleteOne({ showId: config.showId, boothNumber: o.boothNumber, status: 'available' });
    if (!del.deletedCount) {
      // One got booked mid-merge: roll the survivor back to its pre-merge shape
      // and re-insert whatever we already removed, so nothing is lost.
      const restore = { $set: { geometry: survivor.geometry, sqm: survivor.sqm, listPrice: survivor.listPrice, updatedAt: new Date() }, $unset: {} };
      if (survivor.mergedFrom)    restore.$set.mergedFrom = survivor.mergedFrom;       else restore.$unset.mergedFrom = '';
      if (survivor.mergeSnapshot) restore.$set.mergeSnapshot = survivor.mergeSnapshot; else restore.$unset.mergeSnapshot = '';
      if (!Object.keys(restore.$unset).length) delete restore.$unset;
      await col().updateOne({ showId: config.showId, boothNumber: survivorNum }, restore);
      for (const dd of removed) await col().insertOne(dd);
      return { ok: false, reason: 'not_available' };
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
  const b = await get(boothNum);
  if (!b) return { ok: false, reason: 'missing_booth' };
  // Splitting is a pre-sale layout operation. On a sold/held stand it would
  // shrink a paid booking to 1/n of its area, so only available stands split.
  // Also lock a stand that carries a company even if its status somehow reads
  // 'available' (a glitched write) — a purchased stand must never be divided.
  if (b.status !== 'available' || (b.assignment && b.assignment.company)) return { ok: false, reason: 'not_available' };
  // A stand already shaped by a merge or an earlier split of its own must be
  // reset first — splitting a merged stand would leave it carrying both a
  // merge and a split snapshot, which reset can only half-undo. (A split CHILD
  // may be split again — reset refuses to unwind a parent whose child is split,
  // so grandchildren can't be orphaned.)
  if (b.mergeSnapshot || b.splitSnapshot) return { ok: false, reason: 'reset_first' };
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

  // Distribute sqm and list price so the parts sum EXACTLY to the original:
  // each cell gets floor(total/n), and the first `remainder` cells get one
  // more. Previously every cell (primary included) took round(total/n), so
  // n×part ≠ whole and the headline stats drifted on every split. An uneven
  // split gives the first cell its chosen share (of the price, pro rata) and
  // the second the remainder, so the pair still sums exactly.
  const share = (total, i) => {
    if (first != null) {
      const a = total === totalSqm ? first : Math.round(total * first / totalSqm);
      return i === 0 ? a : total - a;
    }
    const base = Math.floor(total / n), rem = total - base * n;
    return base + (i < rem ? 1 : 0);
  };

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
  const splitSnapshot = { self: { geometry: b.geometry, sqm: totalSqm, listPrice: totalPrice }, created: nums };

  // Conditional on the stand still being available: if it was booked between
  // the read above and here, matchedCount is 0 and nothing else is touched, so
  // a paid booking can never be shrunk to a fraction of its area.
  const primRes = await col().updateOne(
    { showId: config.showId, boothNumber: boothNum, status: 'available' },
    { $set: { geometry: cellGeom(0), sqm: share(totalSqm, 0), listPrice: share(totalPrice, 0),
              splitSnapshot, updatedAt: new Date(), updatedBy: actor } }
  );
  if (!primRes.matchedCount) return { ok: false, reason: 'not_available' };

  const created = [];
  for (let i = 1; i < n; i++) {
    await col().insertOne({
      showId: config.showId, boothNumber: nums[i - 1],
      svgElementId: null, geometry: cellGeom(i),
      sqm: share(totalSqm, i), sqmSource: 'split', listPrice: share(totalPrice, i), status: 'available',
      assignment: { company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null },
      clicks: 0, splitFrom: boothNum, splitAxis: vertical ? 'vertical' : 'horizontal',
      createdAt: new Date(), updatedAt: new Date(), updatedBy: actor,
    });
    created.push(nums[i - 1]);
  }
  return { ok: true, created, sizes: Array.from({ length: n }, (_, i) => share(totalSqm, i)) };
}

/**
 * Undo whatever composite operation shaped this stand.
 *
 *   - merged stand  → split back into the originals (restore self + re-insert
 *                     every absorbed stand from the snapshot)
 *   - split parent  → delete the created cells and restore the parent footprint
 *   - leftover split cell with no snapshot (legacy) → just remove the stray cell
 *
 * Only touches available stands, so it can never disturb a booking.
 */

/**
 * Custom split: re-carve one available stand (which may be a merged block) into
 * cells with the admin's OWN numbers and sizes. `parts` is [{ number, sqm }].
 * The sizes must add up to the stand's total; the geometry is divided in those
 * proportions along `axis`. Each cell is a split cell (so the plan masks the
 * stale baked figures and draws the given number + size), the survivor keeps the
 * original identity, and any merge is subsumed (reset restores THIS block, not
 * the pre-merge originals — reset before re-carving to get those back).
 */
async function splitCustom(boothNum, { axis = 'vertical', parts = [], actor = null } = {}) {
  const b = await get(boothNum);
  if (!b) return { ok: false, reason: 'missing_booth' };
  if (b.status !== 'available' || (b.assignment && b.assignment.company)) return { ok: false, reason: 'not_available' };
  if (b.splitSnapshot) return { ok: false, reason: 'reset_first' };   // already split; a MERGED block is fine
  const [g] = await footprints([b]);   // carve where it appears on the plan (see footprintOf)
  if (!g) return { ok: false, reason: 'no_geometry' };

  const clean = (parts || []).map(p => ({
    displayNumber: String(p && p.number != null ? p.number : '').trim(),
    sqm: Math.round(Number(p && p.sqm)),
  })).filter(p => p.displayNumber && p.sqm > 0);
  if (clean.length < 2 || clean.length > 8) return { ok: false, reason: 'bad_parts' };

  const totalSqm = b.sqm || 0;
  const sumParts = clean.reduce((s, p) => s + p.sqm, 0);
  if (Math.abs(sumParts - totalSqm) > 1) return { ok: false, reason: 'size_mismatch', total: totalSqm, got: sumParts };
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

  const totalPrice = b.listPrice || 0;
  const priceOf = (sqm) => Math.round(totalPrice * (sqm / (sumParts || 1)));

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
  const splitSnapshot = { custom: true,
                          self: { geometry: b.geometry, sqm: totalSqm, listPrice: totalPrice,   // as written — what a reset puts back
                                  displayNumber: b.displayNumber ?? null, splitAxis: b.splitAxis ?? null },
                          created: nums };
  const p0 = cells[0];
  const primRes = await col().updateOne(
    { showId: config.showId, boothNumber: boothNum, status: 'available' },
    { $set: { geometry: p0.geometry, sqm: p0.sqm, listPrice: priceOf(p0.sqm),
              displayNumber: p0.displayNumber, displayNumberKey: displayKey(p0.displayNumber),
              splitSnapshot,
              splitAxis: vertical ? 'vertical' : 'horizontal', updatedAt: new Date(), updatedBy: actor },
      $unset: { mergeSnapshot: '', mergedFrom: '' } }   // the re-carve subsumes any merge
  );
  if (!primRes.matchedCount) return { ok: false, reason: 'not_available' };

  const created = [];
  for (let i = 1; i < cells.length; i++) {
    const c = cells[i];
    await col().insertOne({
      showId: config.showId, boothNumber: nums[i - 1], svgElementId: null,
      geometry: c.geometry, sqm: c.sqm, sqmSource: 'split', listPrice: priceOf(c.sqm),
      displayNumber: c.displayNumber, displayNumberKey: displayKey(c.displayNumber),
      status: 'available',
      assignment: { company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null },
      clicks: 0, splitFrom: boothNum, splitAxis: vertical ? 'vertical' : 'horizontal',
      createdAt: new Date(), updatedAt: new Date(), updatedBy: actor,
    });
    created.push(nums[i - 1]);
  }
  return { ok: true, created };
}

async function reset(boothNumber) {
  const booth = await get(boothNumber);
  if (!booth) return { ok: false, reason: 'missing_booth' };
  if (booth.status !== 'available') return { ok: false, reason: 'not_available' };

  // Un-merge. Restore the parent FIRST, conditional on it still being available
  // — if it was booked between the read and now, abort without re-inserting the
  // parts, so we never leave a booked merged stand overlapping restored parts.
  if (booth.mergeSnapshot) {
    const snap = booth.mergeSnapshot;
    const upd = await col().updateOne(
      { showId: config.showId, boothNumber, status: 'available' },
      { $set: { geometry: snap.self.geometry, sqm: snap.self.sqm, listPrice: snap.self.listPrice, updatedAt: new Date() },
        $unset: { mergeSnapshot: '', mergedFrom: '' } }
    );
    if (!upd.matchedCount) return { ok: false, reason: 'not_available' };
    const restored = [];
    for (const part of snap.parts || []) {
      if (part && part.boothNumber && !(await get(part.boothNumber))) {
        await col().insertOne(part);            // the stored doc keeps its original geometry/sqm/price
        restored.push(part.boothNumber);
      }
    }
    return { ok: true, type: 'unmerge', restored };
  }

  // Un-split (acting on the parent).
  if (booth.splitSnapshot) {
    const snap = booth.splitSnapshot;
    // Refuse if any child can't be cleanly removed: a booked child would be
    // destroyed and its area would double under the restored parent; a
    // further-split child would orphan its own grandchildren. The admin resets
    // those first.
    for (const num of snap.created || []) {
      const child = await get(num);
      if (!child) continue;
      if (child.status !== 'available') return { ok: false, reason: 'child_booked' };
      if (child.splitSnapshot)          return { ok: false, reason: 'child_split' };
    }
    // Restore the parent first (conditional), then remove the cells — each
    // delete conditional on the cell still being available so a booking landing
    // mid-reset is preserved rather than deleted.
    // Restore the LABEL state too, not just the footprint. splitCustom writes
    // displayNumber + splitAxis onto the parent, so undoing only the geometry
    // left the stand permanently reading the carved-up part's number ("500a")
    // with a stale split axis.
    const $set = { geometry: snap.self.geometry, sqm: snap.self.sqm, listPrice: snap.self.listPrice, updatedAt: new Date() };
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
    if (wasCustom) {
      for (const field of ['displayNumber', 'splitAxis']) {
        const prior = (snap.self || {})[field];
        if (prior == null) $unset[field] = ''; else $set[field] = prior;
      }
      // The comparison key travels with the label it belongs to, or the stand
      // keeps blocking a shown number it no longer shows.
      const priorLabel = (snap.self || {}).displayNumber;
      if (priorLabel == null) $unset.displayNumberKey = '';
      else $set.displayNumberKey = displayKey(priorLabel);
    }

    const upd = await col().updateOne(
      { showId: config.showId, boothNumber, status: 'available' },
      { $set, $unset }
    );
    if (!upd.matchedCount) return { ok: false, reason: 'not_available' };
    const removed = [];
    for (const num of snap.created || []) {
      const res = await col().deleteOne({ showId: config.showId, boothNumber: num, status: 'available' });
      if (res.deletedCount) removed.push(num);
    }
    return { ok: true, type: 'unsplit', removed };
  }

  // Legacy split cell with no snapshot to restore from — remove the stray cell
  // (conditional on availability so it can't delete a booking).
  if (booth.splitFrom) {
    const res = await col().deleteOne({ showId: config.showId, boothNumber, status: 'available' });
    if (!res.deletedCount) return { ok: false, reason: 'not_available' };
    return { ok: true, type: 'remove-cell', removed: [boothNumber] };
  }

  return { ok: false, reason: 'not_composite' };
}

// ─── Provenance ───────────────────────────────────────────────────────────────
const IMPORT_SOURCE = 'artwork-import';
const IMPORT_NOTE = 'Name read from the supplied floorplan artwork.';

/**
 * The actors that are not people: an import, a deploy-time seed, a reset.
 *
 * A stand's `source` says an import PUT its state there; `updatedBy` says who
 * touched it LAST, and the two together are what tell a booking apart from a
 * colour read off a drawing. Checking only `source` was the whole defect: the
 * field is never cleared on its own, so a stand an admin booked kept the mark
 * and the guard counted a paying exhibitor as import output.
 */
const IMPORT_ACTORS = ['import', 'deploy', 'seed', 'reset-blank', 'restore-original', null];

// The source file the blank-plan rebuild reads. It lives in server/data rather
// than public/ because express.static serves everything under public/ — this
// file carries a list price for every stand, and the price is the one thing the
// public plan deliberately withholds.
const BOOTH_DATA = path.join(__dirname, '..', 'data', 'booth_data.json');

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
 * left out and their absence is RECORDED rather than being silently lost.
 */
function withoutLogos(booth) {
  const out = { ...booth };
  if (out.sponsorLogo) { delete out.sponsorLogo; out.sponsorLogoOmitted = true; }
  if (out.mergeSnapshot && Array.isArray(out.mergeSnapshot.parts)) {
    out.mergeSnapshot = { ...out.mergeSnapshot, parts: out.mergeSnapshot.parts.map(withoutLogos) };
  }
  return out;
}

/**
 * Store one stand per document under a fresh snapshot id.
 *
 * Returns ok:false rather than throwing, because every caller has to be able to
 * ABORT on a failed snapshot — proceeding to delete an event's inventory with
 * no way back is the failure this exists to prevent.
 */
async function snapshot(reason, rows, { actor = null, showId = config.showId } = {}) {
  const snapshotId = `${reason}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const at = new Date();
  try {
    if (rows.length) {
      await snapshots().insertMany(rows.map(b => ({
        showId, snapshotId, reason, at, boothNumber: b.boothNumber, booth: withoutLogos(b),
      })), { ordered: false });
    }
    // A header row, so a listing does not have to read every stand back.
    await snapshots().insertOne({ showId, snapshotId, reason, at, header: true,
                                  count: rows.length, takenBy: actor });
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
 * Put a snapshot back.
 *
 * Dry by default and loud about what it would do, because this replaces the
 * event's entire inventory in the other direction. The CURRENT stands are
 * snapshotted first on apply, so an ill-judged restore is itself reversible.
 */
async function restoreSnapshot(snapshotId, { apply = false, actor = null, showId = config.showId } = {}) {
  const rows = await snapshots().find({ showId, snapshotId, header: { $ne: true } }).toArray();
  if (!rows.length) {
    // Told apart deliberately. A snapshot taken of an event that had no stands
    // is a real snapshot of nothing, and restoring it would empty the event —
    // which is a thing someone might mean, but never by accident, and never in
    // the belief that they were recovering something.
    const header = await snapshots().findOne({ showId, snapshotId, header: true });
    return { ok: false, reason: header ? 'empty_snapshot' : 'no_such_snapshot', snapshotId };
  }

  const stored = rows.map(r => r.booth).filter(Boolean);
  const current = await col().find({ showId }).toArray();
  const logos = stored.filter(b => b.sponsorLogoOmitted).map(b => b.boothNumber);
  const plan = { snapshotId, stands: stored.length, replacing: current.length, logosNotRestored: logos };
  if (!apply) return { ok: true, dryRun: true, ...plan };

  const back = await snapshot('pre-restore', current, { actor, showId });
  if (!back.ok) return { ok: false, reason: 'snapshot_failed', detail: back.error };

  await col().deleteMany({ showId });
  // `_id` is dropped: these are new documents in the live collection, and
  // re-using the stored ids would collide with anything not yet deleted.
  await col().insertMany(stored.map(({ _id, sponsorLogoOmitted, ...b }) => ({ ...b, showId })));
  return { ok: true, ...plan, previousSnapshot: back.snapshotId };
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
    $or: [{ source: IMPORT_SOURCE }, { 'assignment.notes': IMPORT_NOTE }],
    // Last written by something that is not a person. setStatus, move and every
    // other human-driven write stamp the admin's name here and clear `source`,
    // so a booking can never satisfy this.
    updatedBy: { $in: IMPORT_ACTORS },
  };
  return {
    $and: [
      { $or: [{ status: { $ne: 'available' } }, { 'assignment.company': { $nin: [null, ''] } }] },
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
  ] };
}

// The same two questions, asked of a document already in hand. They MUST agree
// with the filters above; they are here so the import can decide stand by stand
// what it may overwrite, rather than only all-or-nothing.
const isImportOutput = (b) => {
  const a = b.assignment || {};
  return ['sold', 'held'].includes(b.status) &&
         a.contactId == null && a.actualPrice == null &&
         (b.source === IMPORT_SOURCE || a.notes === IMPORT_NOTE) &&
         IMPORT_ACTORS.includes(b.updatedBy ?? null);
};
const isCommitted = (b) => {
  const a = b.assignment || {};
  const marked = b.status !== 'available' || !!(a.company && String(a.company).trim());
  return marked && !isImportOutput(b);
};
const hasHandwork = (b) => {
  const a = b.assignment || {};
  return !!(b.displayNumber || b.sponsorLogo || b.mergeSnapshot || b.splitSnapshot || b.splitFrom ||
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
 * Stands carrying an exhibitor name are imported as sold under that name.
 * The name then belongs to us: our renderer draws it, the smart search finds
 * it, and sales can change it — none of which is true of a name printed into
 * the artwork.
 */
async function importFromArtwork(stands, { actor = null, force = false, replace = false } = {}) {
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

  const committed = await countCommitted(showId);
  if (committed > 0 && !force) {
    return { ok: false, reason: 'has_bookings', committed, showId };
  }

  const customised = await countHandwork(showId);
  if (customised > 0 && !force) {
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

  const docs = stands.map(s => ({ showId, ...fromArtwork(s), clicks: 0,
                                  createdAt: now, updatedAt: now, updatedBy: actor || 'import' }));

  const result = { ok: true, showId, mode: replace ? 'replace' : 'upsert',
                   imported: docs.length,
                   sold: docs.filter(d => d.status === 'sold').length,
                   available: docs.filter(d => d.status === 'available').length,
                   held: docs.filter(d => d.status === 'held').length,
                   sponsored: docs.filter(d => d.sponsored).length,
                   replaced: existing.length, snapshot: !!snapshotId, snapshotId };

  // ── Replace ─────────────────────────────────────────────────────────────────
  if (replace) {
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
      return { ok: false, reason: 'insert_failed', detail: e.message, restored: existing.length,
               snapshotId, showId };
    }
    await writeImportHolds(db, showId, docs.filter(d => d.status === 'held'), actor, now);
    return result;
  }

  // ── Upsert ──────────────────────────────────────────────────────────────────
  const personHolds = new Set(await db.collection('holds')
    .distinct('boothNumber', { showId, source: { $ne: IMPORT_SOURCE } }));
  const prevByNumber = new Map(existing.map(b => [b.boothNumber, b]));

  const ops = [];
  const created = [], refreshed = [], reshaped = [], untouched = [], released = [];
  for (const doc of docs) {
    const prev = prevByNumber.get(doc.boothNumber);
    const filter = { showId, boothNumber: doc.boothNumber };

    if (!prev) {
      created.push(doc.boothNumber);
      ops.push({ updateOne: { filter, update: { $set: doc }, upsert: true } });
      continue;
    }

    // Its shape is ours now, not the plan's — leave the whole record alone.
    if (isComposite(prev)) { untouched.push(doc.boothNumber); continue; }

    const mayRewrite = !isCommitted(prev) && !hasHandwork(prev) && !personHolds.has(prev.boothNumber);
    const $set = { updatedAt: now, updatedBy: actor || 'import' };
    for (const k of SHAPE) $set[k] = doc[k];

    if (mayRewrite) {
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
      ? { $set, $unset: { holdExpiresAt: '' } } : { $set } } });
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
  const orphaned = existing.filter(b => !incoming.has(b.boothNumber)).map(b => b.boothNumber);

  const heldNow = docs.filter(d => d.status === 'held' &&
    (created.includes(d.boothNumber) || refreshed.includes(d.boothNumber)));
  await writeImportHolds(db, showId, heldNow, actor, now, { onlyOurs: true });

  return { ...result, created: created.length, refreshed: refreshed.length,
           reshaped: reshaped.length, untouched: untouched.length,
           released: released.length, orphaned, preserved: reshaped.concat(untouched) };
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
 * artwork — or say plainly why it cannot be read.
 */
function readBoothData() {
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

  const src = readBoothData();
  if (!src.ok) return { ok: false, reason: src.reason, detail: src.detail };
  const fresh = src.rows;

  const committed = await countCommitted(showId);
  if (committed > 0 && !force) return { ok: false, reason: 'has_bookings', committed, showId };

  const oldBooths = await col().find({ showId }).toArray();

  const TOL = 3;
  const centre    = g => ({ x: g.x + g.w / 2, y: g.y + g.h / 2 });
  const fc        = f => centre({ x: f.x, y: f.y, w: f.w, h: f.h });
  const near      = (a, b) => Math.abs(a.x - b.x) < TOL && Math.abs(a.y - b.y) < TOL;
  const sizeClose = (a, b) => Math.abs(a.w - b.w) < TOL * 4 && Math.abs(a.h - b.h) < TOL * 4;
  const hasState  = b => { const a = b.assignment || {}; return b.status !== 'available' || a.company || a.actualPrice || a.notes || (b.clicks || 0) > 0; };
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
    sqm: f.sqm, sqmSource: 'estimated', listPrice: f.price,
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
      status: m.old.status,
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

  const src = readBoothData();
  if (!src.ok) return { ok: false, reason: src.reason, detail: src.detail };
  const fresh = src.rows;

  const committed = await countCommitted(showId);
  if (committed > 0 && !force) return { ok: false, reason: 'has_bookings', committed, showId };

  const oldBooths = await col().find({ showId }).toArray();
  const heldOrSold = oldBooths.filter(b => b.status !== 'available')
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
    sqm: f.sqm, sqmSource: 'estimated', listPrice: f.price,
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

module.exports = { col, all, get, toPublic, toAdmin, ensureIndexes, setStatus, updateDeal, move,
                   setDisplayNumber, setSponsored, setSponsorLogo, setTags, setCountry, removeTag,
                   recomputeListPrices, incrementClicks, stats, consolidate, consolidateMany,
                   split, splitCustom, reset,
                   repairHalvedStands, restoreOriginalLayout, resetToBlankLayout, importFromArtwork,
                   commercialFilter, handworkFilter, countCommitted, countHandwork,
                   snapshot, listSnapshots, restoreSnapshot,
                   IMPORT_SOURCE, IMPORT_NOTE, IMPORT_ACTORS };
