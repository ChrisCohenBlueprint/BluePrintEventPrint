const { getDb } = require('../db');
const config    = require('../config');
const fs        = require('fs');
const path      = require('path');

const col = () => getDb().collection('booths');

const all = () => col().find({ showId: config.showId }).toArray();

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
    svgElementId: b.svgElementId,
    status:  b.status,
    company: b.assignment?.company || null,
    sqm:     b.sqm,
    geometry: b.geometry,
    displayNumber: b.displayNumber || null,   // admin-set label shown in place of boothNumber (identity is unchanged)
    sponsored: b.sponsored === true,          // filled with the floorplan sponsor's brand colour on the plan
    splitFrom: b.splitFrom || null,   // lets the client draw + number split cells
    splitAxis: b.splitAxis || null,   // 'vertical' | 'horizontal' — which edge is the divider
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
async function setStatus(boothNumber, status, { company = null, actor = null, expect = null } = {}) {
  const before = await get(boothNumber);
  if (!before) return null;

  const filter = { showId: config.showId, boothNumber };
  if (Array.isArray(expect) && expect.length) filter.status = { $in: expect };

  const res = await col().updateOne(filter, { $set: {
    status,
    'assignment.company': company,
    updatedAt: new Date(),
    updatedBy: actor,
  } });
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

  // A deal only exists on a stand that is booked or held. Guarding the write
  // means an edit racing a release/expiry can't paint a price and notes onto a
  // stand that just went available (where they'd linger until the next booking
  // overwrote them), and `changed` lets the caller report the conflict.
  const res = await col().updateOne(
    { showId: config.showId, boothNumber, status: { $in: ['booked', 'held'] } },
    { $set }
  );
  return { before, after: await get(boothNumber), changed: res.matchedCount === 1 };
}

async function incrementClicks(boothNumber) {
  await col().updateOne({ showId: config.showId, boothNumber }, { $inc: { clicks: 1 } });
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
      { $unset: { displayNumber: '' }, $set: { updatedAt: new Date(), updatedBy: actor } });
    return { ok: true, cleared: true, before: booth, after: await get(boothNumber) };
  }

  if (!/^[A-Za-z0-9 /.\-]{1,20}$/.test(raw)) return { ok: false, reason: 'bad_value' };
  if (raw === boothNumber) {            // "showing its own identity" = no override needed
    await col().updateOne({ showId: config.showId, boothNumber },
      { $unset: { displayNumber: '' }, $set: { updatedAt: new Date(), updatedBy: actor } });
    return { ok: true, cleared: true, before: booth, after: await get(boothNumber) };
  }

  // Reject a label that another stand already shows, or that is any stand's real
  // identity — otherwise two stands would present the same number.
  const clash = await col().findOne({
    showId: config.showId,
    boothNumber: { $ne: boothNumber },
    $or: [{ displayNumber: raw }, { boothNumber: raw }],
  });
  if (clash) return { ok: false, reason: 'duplicate', clashWith: clash.boothNumber };

  await col().updateOne({ showId: config.showId, boothNumber },
    { $set: { displayNumber: raw, updatedAt: new Date(), updatedBy: actor } });
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

  const assignment = { company: a.company || null, contactId: a.contactId || null, actualPrice: newActual, notes: a.notes || '' };

  // Claim the destination FIRST, only while it is still available — so we can
  // never overwrite a booking that landed on it a moment ago.
  const claim = await col().updateOne(
    { showId: config.showId, boothNumber: toNum, status: 'available' },
    { $set: { status: movedStatus, assignment, updatedAt: new Date(), updatedBy: actor } }
  );
  if (!claim.matchedCount) return { ok: false, reason: 'to_not_available' };

  // Free the source, only if it still holds the booking we just moved.
  const freed = await col().updateOne(
    { showId: config.showId, boothNumber: fromNum, status: movedStatus },
    { $set: { status: 'available', assignment: { company: null, contactId: null, actualPrice: null, notes: '' }, updatedAt: new Date(), updatedBy: actor } }
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
      { $set: { status: 'available', assignment: { company: null, contactId: null, actualPrice: null, notes: '' }, updatedAt: new Date(), updatedBy: actor } }
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
  // Overlapping in BOTH axes = nested/overlapping footprints, not a clean
  // side-by-side merge — reject (folding overlapping stands is corruption).
  if (xOverlap > tol && yOverlap > tol) return false;
  const gapX = Math.max(g1.x, g2.x) - Math.min(a2x, b2x);
  const gapY = Math.max(g1.y, g2.y) - Math.min(a2y, b2y);
  // A genuine shared edge: real overlap along one axis, and the OTHER axis
  // touches (gap ≈ 0). A whole-aisle gap (large positive) is rejected; a deep
  // overlap (large negative) is caught above. tol is a few units for the .75pt
  // artwork stroke and float geometry — not a whole ~50-unit aisle.
  const shareV = yOverlap > tol && Math.abs(gapX) <= tol;
  const shareH = xOverlap > tol && Math.abs(gapY) <= tol;
  return shareV || shareH;
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
  const a = await get(primaryNum);
  const b = await get(secondaryNum);
  if (!a || !b) return { ok: false, reason: 'missing_booth' };
  if (primaryNum === secondaryNum) return { ok: false, reason: 'same_booth' };

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
  if (a.geometry && b.geometry &&
      (!adjacent(a.geometry, b.geometry) || !contiguousMerge(a.geometry, b.geometry))) {
    return { ok: false, reason: 'not_adjacent' };
  }

  const g1 = a.geometry, g2 = b.geometry;
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
 * Split one stand into `parts` equal columns (or rows). The original keeps the
 * first cell and its commercial state; the rest become new available stands
 * numbered `<n>-2`, `<n>-3`, … The area and list price divide evenly.
 */
async function split(boothNum, { parts = 2, axis = 'vertical', actor = null } = {}) {
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
  const g = b.geometry;
  if (!g) return { ok: false, reason: 'no_geometry' };
  // Below this every cell would round to <1 m², so refuse rather than emit
  // zero-size stands or inflate the total with a Math.max(1,…) floor.
  if ((b.sqm || 0) < n) return { ok: false, reason: 'too_small' };

  const vertical = axis === 'vertical';   // side by side
  const cellW = vertical ? g.w / n : g.w;
  const cellH = vertical ? g.h : g.h / n;

  // Distribute sqm and list price so the parts sum EXACTLY to the original:
  // each cell gets floor(total/n), and the first `remainder` cells get one
  // more. Previously every cell (primary included) took round(total/n), so
  // n×part ≠ whole and the headline stats drifted on every split.
  const share = (total, i) => {
    const base = Math.floor(total / n), rem = total - base * n;
    return base + (i < rem ? 1 : 0);
  };
  const totalSqm = b.sqm || 0, totalPrice = b.listPrice || 0;

  const cellGeom = (i) => ({
    x: vertical ? g.x + i * cellW : g.x,
    y: vertical ? g.y : g.y + i * cellH,
    w: cellW, h: cellH,
  });

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
  const splitSnapshot = { self: { geometry: g, sqm: totalSqm, listPrice: totalPrice }, created: nums };

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
      assignment: { company: null, contactId: null, actualPrice: null, notes: '' },
      clicks: 0, splitFrom: boothNum, splitAxis: vertical ? 'vertical' : 'horizontal',
      createdAt: new Date(), updatedAt: new Date(), updatedBy: actor,
    });
    created.push(nums[i - 1]);
  }
  return { ok: true, created };
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
    const upd = await col().updateOne(
      { showId: config.showId, boothNumber, status: 'available' },
      { $set: { geometry: snap.self.geometry, sqm: snap.self.sqm, listPrice: snap.self.listPrice, updatedAt: new Date() },
        $unset: { splitSnapshot: '' } }
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

/**
 * TRUE one-shot repair for the two stands the "booth got bigger and bigger" bug
 * left at half size (128, 198). It runs at most once ever — guarded by a marker
 * in the `meta` collection — because a size-only heuristic that fired on every
 * boot would clobber a LEGITIMATE later split (an admin splitting 128 into two
 * 67×67 cells matches the old half-size test exactly, and the next restart would
 * re-inflate 128 over its new sibling — re-creating the very overlap this fixes).
 *
 * On top of the one-shot flag it only acts on a stand that STILL matches the
 * exact corrupted footprint, isn't part of a live split/merge, and has no
 * sibling `-2` cell — belt and braces for the single first run.
 */
async function repairHalvedStands() {
  const meta = getDb().collection('meta');
  if (await meta.findOne({ _id: 'repair-halved-stands-v1' })) return;   // already applied — never touch again

  const FIXES = [
    { boothNumber: '128', from: { x: 2086, y: 834,  w: 67, h: 67  }, to: { x: 2086, y: 834,  w: 67,  h: 134 }, sqm: 32 },
    { boothNumber: '198', from: { x: 1650, y: 1379, w: 67, h: 101 }, to: { x: 1650, y: 1379, w: 134, h: 101 }, sqm: 48 },
  ];
  const near = (g, t) => g && ['x', 'y', 'w', 'h'].every(k => Math.abs(g[k] - t[k]) < 3);

  for (const f of FIXES) {
    const b = await get(f.boothNumber);
    if (!b || !near(b.geometry, f.from)) continue;                       // not the exact corrupted half → leave alone
    if (b.splitSnapshot || b.mergeSnapshot || b.splitFrom) continue;     // part of a live composite → not ours to touch
    if (await get(`${f.boothNumber}-2`)) continue;                       // a real split sibling exists → leave alone
    const rate = (b.sqm && b.listPrice) ? b.listPrice / b.sqm : (config.ratePerSqm || 600);
    await col().updateOne(
      { showId: config.showId, boothNumber: f.boothNumber },
      { $set: { geometry: f.to, sqm: f.sqm, listPrice: Math.round(f.sqm * rate),
                updatedAt: new Date(), updatedBy: 'repair:halved-stands' } }
    );
    console.log(`🔧 Repaired stand ${f.boothNumber} → full size (${f.sqm} m²)`);
  }
  await meta.updateOne({ _id: 'repair-halved-stands-v1' }, { $set: { done: true, at: new Date() } }, { upsert: true });
}

/**
 * ONE-SHOT: rebuild the plan from the original SVG extraction, removing every
 * split cell and merge so the layout matches the artwork again. Existing
 * bookings are carried onto the matching original stand by position (the same
 * geometry match reseed.js uses), and the admin-set shown-number and sponsor
 * flags ride along too. A booking that sat on a split cell with no original
 * equivalent is dropped (its shape no longer exists) — that's the intended
 * trade-off of collapsing the plan back to the original.
 *
 * Guarded by a meta flag so it runs exactly once, and snapshots the pre-reset
 * booths to a `booths_snapshots` collection first (Render's filesystem is
 * ephemeral, so a DB snapshot is the recovery path). Bump the version to run
 * another reset later.
 */
async function restoreOriginalLayout() {
  const db = getDb();
  const FLAG = 'restore-original-layout-v1';
  const meta = db.collection('meta');
  if (await meta.findOne({ _id: FLAG })) return { skipped: 'already-run' };

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'booth_data.json'), 'utf8'));
  } catch (e) {
    console.warn('restoreOriginalLayout: cannot read booth_data.json —', e.message);
    return { skipped: 'no-source' };
  }
  const fresh = Object.values(raw);
  if (!fresh.length) return { skipped: 'empty-source' };

  const oldBooths = await col().find({ showId: config.showId }).toArray();

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

  // Snapshot before destroying anything.
  try {
    await db.collection('booths_snapshots').insertOne({
      showId: config.showId, reason: FLAG, at: new Date(), count: oldBooths.length, booths: oldBooths });
  } catch (e) { console.warn('restoreOriginalLayout: snapshot failed —', e.message); }

  // Replace the whole set with the original extraction.
  const now = new Date();
  await col().deleteMany({ showId: config.showId });
  const docs = fresh.map(f => ({
    showId: config.showId,
    boothNumber: toNum(f),
    svgElementId: f.boothId,
    geometry: { x: f.x, y: f.y, w: f.w, h: f.h },
    sqm: f.sqm, sqmSource: 'estimated', listPrice: f.price,
    status: f.status,
    assignment: { company: null, contactId: null, actualPrice: null, notes: '' },
    clicks: 0, createdAt: now, updatedAt: now, updatedBy: 'restore-original',
  }));
  await col().insertMany(docs);
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
      clicks: m.old.clicks || 0,
      updatedAt: now, updatedBy: 'restore-original:carried',
    };
    if (m.old.displayNumber) $set.displayNumber = m.old.displayNumber;
    if (m.old.sponsored)     $set.sponsored = true;
    await col().updateOne({ showId: config.showId, boothNumber: toNum(m.next) }, { $set });
  }

  // Re-point holds: move a matched booking's hold, drop one whose stand is gone.
  const holds = await db.collection('holds').find({ showId: config.showId }).toArray();
  for (const h of holds) {
    const to = remap.get(h.boothNumber);
    if (to && to !== h.boothNumber) await db.collection('holds').updateOne({ _id: h._id }, { $set: { boothNumber: to } });
    else if (!to && !freshNums.has(h.boothNumber)) await db.collection('holds').deleteOne({ _id: h._id });
  }

  // Re-point lead stand references through the same map; drop refs now gone.
  const inqs = await db.collection('inquiries').find({ showId: config.showId }).toArray();
  for (const q of inqs) {
    if (!Array.isArray(q.boothsOfInterest) || !q.boothsOfInterest.length) continue;
    const mapped = q.boothsOfInterest.map(n => remap.get(n) || n).filter(n => freshNums.has(n));
    if (mapped.join(',') !== q.boothsOfInterest.join(','))
      await db.collection('inquiries').updateOne({ _id: q._id }, { $set: { boothsOfInterest: mapped } });
  }

  await meta.insertOne({ _id: FLAG, at: new Date(), inserted: docs.length, carried: finalMatches.length });
  console.log(`✔ restoreOriginalLayout: ${docs.length} original stands restored, ${finalMatches.length} booking(s)/override(s) carried, splits/merges removed`);
  return { ok: true, inserted: docs.length, carried: finalMatches.length };
}

/**
 * ONE-SHOT: reset to a completely blank original plan. Rebuilds the 273 stands
 * from the SVG extraction with EVERY stand available — all bookings, holds,
 * sponsor flags and shown-number overrides cleared, nothing carried. The
 * original 'sold' flags baked into the extraction are forced available too, so
 * the result is a clean, fully sell-able plan.
 *
 * Snapshots the pre-reset booths to `booths_snapshots` first (recovery path),
 * and guarded by its own meta flag so it runs exactly once. Leads/enquiries are
 * deliberately left untouched — they are sales records, not plan state.
 */
async function resetToBlankLayout() {
  const db = getDb();
  // v2 re-seeds from the LEX27 consolidated plan (262 stands, printed numbers + sizes). Bump the version
  // whenever booth_data.json changes and the plan needs a fresh re-seed.
  const FLAG = 'reset-blank-layout-v3';
  const meta = db.collection('meta');
  if (await meta.findOne({ _id: FLAG })) return { skipped: 'already-run' };

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'booth_data.json'), 'utf8'));
  } catch (e) {
    console.warn('resetToBlankLayout: cannot read booth_data.json —', e.message);
    return { skipped: 'no-source' };
  }
  const fresh = Object.values(raw);
  if (!fresh.length) return { skipped: 'empty-source' };

  const oldBooths = await col().find({ showId: config.showId }).toArray();
  try {
    await db.collection('booths_snapshots').insertOne({
      showId: config.showId, reason: FLAG, at: new Date(), count: oldBooths.length, booths: oldBooths });
  } catch (e) { console.warn('resetToBlankLayout: snapshot failed —', e.message); }

  const now = new Date();
  await col().deleteMany({ showId: config.showId });
  const docs = fresh.map(f => ({
    showId: config.showId,
    boothNumber: String(f.boothId).replace(/^booth-/, ''),
    svgElementId: f.boothId,
    geometry: { x: f.x, y: f.y, w: f.w, h: f.h },
    sqm: f.sqm, sqmSource: 'estimated', listPrice: f.price,
    status: 'available',                 // FORCE available — blank, sell-able plan
    assignment: { company: null, contactId: null, actualPrice: null, notes: '' },
    clicks: 0, createdAt: now, updatedAt: now, updatedBy: 'reset-blank',
  }));
  await col().insertMany(docs);
  await db.collection('holds').deleteMany({ showId: config.showId });

  await meta.insertOne({ _id: FLAG, at: new Date(), inserted: docs.length });
  console.log(`✔ resetToBlankLayout: ${docs.length} stands restored, all available, bookings + holds cleared`);
  return { ok: true, inserted: docs.length };
}

module.exports = { col, all, get, toPublic, toAdmin, setStatus, updateDeal, move,
                   setDisplayNumber, setSponsored, incrementClicks, stats, consolidate, split, reset,
                   repairHalvedStands, restoreOriginalLayout, resetToBlankLayout };
