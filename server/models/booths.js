const { getDb } = require('../db');
const config    = require('../config');

const col = () => getDb().collection('booths');

const PUBLIC_STATUSES = { available: 'available', held: 'reserved', sold: 'taken', reserved: 'reserved' };

const all = () => col().find({ showId: config.showId }).toArray();

const get = (boothNumber) => col().findOne({ showId: config.showId, boothNumber });

/**
 * Projection sent to the public floorplan.
 *
 * Deal price, negotiated amounts, internal notes and the customer's company
 * name are all withheld — a held booth reads as "reserved" with no indication
 * of who holds it or what they paid.
 */
function toPublic(b) {
  return {
    boothNumber: b.boothNumber,
    svgElementId: b.svgElementId,
    status:  PUBLIC_STATUSES[b.status] || 'taken',
    sqm:     b.sqm,
    listPrice: b.status === 'available' ? b.listPrice : null,
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

module.exports = { col, all, get, toPublic, toAdmin, setStatus, updateDeal, incrementClicks, stats };
