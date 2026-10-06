const { getDb } = require('../db');

/**
 * Start a new event from an existing one.
 *
 * A new edition (LEX28 after LEX27) or a new location sells the same way as the
 * event it follows: the same rate, currency and units, the same colours, the
 * same business activities to tag exhibitors with, the same sponsorship
 * packages. Re-entering all of that by hand for every new event is how one of
 * them ends up quoting in the wrong currency.
 *
 * What is copied is the CONFIGURATION, never the trading: no stands, bookings,
 * holds, leads, proposals or plan. The plan in particular stays behind, because
 * its colours say which stands are sold — reading last year's drawing into a
 * new event would sell its stands to last year's exhibitors.
 *
 * Packages arrive un-sold-out and on offer: last year's sold-out badge is not
 * true of this year. The floorplan sponsor is left behind for the same reason.
 */
const SETTINGS_FIELDS = ['ratePerSqm', 'unit', 'currency', 'palette'];

async function copyConfiguration(fromId, toId) {
  const db = getDb();
  const copied = { settings: [], activities: 0, packages: 0 };

  const src = await db.collection('settings').findOne({ _id: fromId });
  if (src) {
    const $set = {};
    for (const k of SETTINGS_FIELDS) if (src[k] !== undefined && src[k] !== null) $set[k] = src[k];
    if (Object.keys($set).length) {
      await db.collection('settings').updateOne({ _id: toId },
        { $set: { ...$set, copiedFrom: fromId, updatedAt: new Date() } }, { upsert: true });
      copied.settings = Object.keys($set);
    }
  }

  // `_id` is dropped so each copy is a document of its own; the keys stay the
  // same, so an activity or package is recognisably the same thing next year.
  const tags = await db.collection('tags').find({ showId: fromId }).toArray();
  if (tags.length) {
    await db.collection('tags').insertMany(tags.map(({ _id, ...t }) => ({ ...t, showId: toId })));
    copied.activities = tags.length;
  }

  // A package sold out last year comes across ON OFFER. Every sponsor write
  // path stores sold out as inactive too (sponsors.js: active = !soldOut), so
  // clearing the badge alone left last year's sell-outs — the headline
  // packages, as a rule — hidden from the reps' catalogue and the public plan
  // of the new event. A package an admin took off sale by hand (inactive, not
  // sold out) was a decision about the package, not about last year's sales,
  // and it stays off sale.
  const packages = await db.collection('sponsors').find({ showId: fromId }).toArray();
  if (packages.length) {
    await db.collection('sponsors').insertMany(packages.map(({ _id, ...p }) => ({
      ...p, showId: toId, soldOut: false, ...(p.soldOut === true ? { active: true } : {}), copiedFrom: fromId,
    })));
    copied.packages = packages.length;
  }

  return copied;
}

module.exports = { copyConfiguration, SETTINGS_FIELDS };
