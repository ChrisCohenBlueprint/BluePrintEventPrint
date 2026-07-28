/**
 * One-off repair for the two stands the "booth got bigger and bigger" bug left
 * at half size (128 and 198). It restores each to the full artwork cell and
 * doubles the area/price accordingly, preserving status and exhibitor.
 *
 * Safe by design:
 *   - dry run by default; pass --apply to write
 *   - only touches the two named stands, and only if they are still at the
 *     expected half size (so re-running after a fix is a no-op)
 *   - preserves each stand's price-per-m² (listPrice / sqm)
 *
 * Usage:
 *   MONGO_URI="mongodb+srv://…"  node scripts/fix-halved-stands.js           # dry run
 *   MONGO_URI="mongodb+srv://…"  node scripts/fix-halved-stands.js --apply   # write
 */
const { MongoClient } = require('mongodb');

const SHOW = process.env.SHOW_ID || 'LEX26';
const APPLY = process.argv.includes('--apply');

// Target = the full artwork rectangle each stand should occupy.
const FIXES = [
  { boothNumber: '128', geometry: { x: 2086, y: 834,  w: 67,  h: 134 }, sqm: 32, expectHalf: { w: 67,  h: 67 } },
  { boothNumber: '198', geometry: { x: 1650, y: 1379, w: 134, h: 101 }, sqm: 48, expectHalf: { w: 67,  h: 101 } },
];

(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('Set MONGO_URI to the production connection string.'); process.exit(1); }
  const client = new MongoClient(uri);
  await client.connect();
  const col = client.db(process.env.MONGO_DB || 'blueprint').collection('booths');

  for (const fix of FIXES) {
    const b = await col.findOne({ showId: SHOW, boothNumber: fix.boothNumber });
    if (!b) { console.log(`- ${fix.boothNumber}: not found, skipping`); continue; }

    const g = b.geometry || {};
    const isHalf = Math.abs(g.w - fix.expectHalf.w) < 3 && Math.abs(g.h - fix.expectHalf.h) < 3;
    if (!isHalf) { console.log(`- ${fix.boothNumber}: already ${Math.round(g.w)}x${Math.round(g.h)} (not the expected half) — leaving untouched`); continue; }

    const rate = (b.sqm && b.listPrice) ? b.listPrice / b.sqm : 600;
    const listPrice = Math.round(fix.sqm * rate);
    console.log(`- ${fix.boothNumber}: ${Math.round(g.w)}x${Math.round(g.h)} ${b.sqm}m² €${b.listPrice}  ->  ${fix.geometry.w}x${fix.geometry.h} ${fix.sqm}m² €${listPrice}  (${b.status})`);

    if (APPLY) {
      await col.updateOne(
        { showId: SHOW, boothNumber: fix.boothNumber },
        { $set: { geometry: fix.geometry, sqm: fix.sqm, listPrice, updatedAt: new Date(), updatedBy: 'repair:halved-stands' } }
      );
    }
  }

  console.log(APPLY ? '\n✅ Applied.' : '\n(dry run — re-run with --apply to write)');
  await client.close();
})().catch(e => { console.error(e); process.exit(1); });
