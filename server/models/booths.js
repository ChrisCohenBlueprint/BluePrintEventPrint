const { getDb } = require('../db');
const config    = require('../config');

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
    viewers: b.viewers || 0,
    interest: b.clicks || 0,
  };
}

const toAdmin = (b) => b;

async function setStatus(boothNumber, status, { company = null, actor = null } = {}) {
  const before = await get(boothNumber);
  if (!before) return null;

  await col().updateOne(
    { showId: config.showId, boothNumber },
    { $set: {
        status,
        'assignment.company': company,
        updatedAt: new Date(),
        updatedBy: actor,
    } }
  );
  return { before, after: await get(boothNumber) };
}

async function updateDeal(boothNumber, { actualPrice, notes, actor = null }) {
  const before = await get(boothNumber);
  if (!before) return null;

  const $set = { updatedAt: new Date(), updatedBy: actor };
  if (actualPrice !== undefined) $set['assignment.actualPrice'] = actualPrice;
  if (notes       !== undefined) $set['assignment.notes']       = notes;

  await col().updateOne({ showId: config.showId, boothNumber }, { $set });
  return { before, after: await get(boothNumber) };
}

async function incrementClicks(boothNumber) {
  await col().updateOne({ showId: config.showId, boothNumber }, { $inc: { clicks: 1 } });
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
  if (a.status !== 'available' || b.status !== 'available') {
    return { ok: false, reason: 'not_available' };
  }

  const g1 = a.geometry, g2 = b.geometry;
  const box = (g1 && g2) ? {
    x: Math.min(g1.x, g2.x), y: Math.min(g1.y, g2.y),
    w: Math.max(g1.x + g1.w, g2.x + g2.w) - Math.min(g1.x, g2.x),
    h: Math.max(g1.y + g1.h, g2.y + g2.h) - Math.min(g1.y, g2.y),
  } : g1;

  await col().updateOne(
    { showId: config.showId, boothNumber: primaryNum },
    { $set: {
        sqm: (a.sqm || 0) + (b.sqm || 0),
        listPrice: (a.listPrice || 0) + (b.listPrice || 0),
        geometry: box,
        mergedFrom: [...(a.mergedFrom || []), secondaryNum],
        updatedAt: new Date(), updatedBy: actor,
    } }
  );
  await col().deleteOne({ showId: config.showId, boothNumber: secondaryNum });
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
  if (b.status !== 'available') return { ok: false, reason: 'not_available' };
  const n = Math.max(2, Math.min(6, parts | 0));
  const g = b.geometry;
  if (!g) return { ok: false, reason: 'no_geometry' };

  const vertical = axis === 'vertical';   // side by side
  const cellW = vertical ? g.w / n : g.w;
  const cellH = vertical ? g.h : g.h / n;
  const sqm   = Math.max(1, Math.round((b.sqm || 0) / n));
  const price = Math.round((b.listPrice || 0) / n);

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

  await col().updateOne(
    { showId: config.showId, boothNumber: boothNum },
    { $set: { geometry: cellGeom(0), sqm, listPrice: price, updatedAt: new Date(), updatedBy: actor } }
  );

  const created = [];
  for (let i = 1; i < n; i++) {
    await col().insertOne({
      showId: config.showId, boothNumber: nums[i - 1],
      svgElementId: null, geometry: cellGeom(i),
      sqm, sqmSource: 'split', listPrice: price, status: 'available',
      assignment: { company: null, contactId: null, actualPrice: null, notes: '' },
      clicks: 0, splitFrom: boothNum,
      createdAt: new Date(), updatedAt: new Date(), updatedBy: actor,
    });
    created.push(nums[i - 1]);
  }
  return { ok: true, created };
}

module.exports = { col, all, get, toPublic, toAdmin, setStatus, updateDeal,
                   incrementClicks, stats, consolidate, split };
