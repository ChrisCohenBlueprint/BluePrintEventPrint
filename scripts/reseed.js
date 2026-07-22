#!/usr/bin/env node
/**
 * Re-seed booths from a fresh extraction, carrying commercial state across.
 *
 * A re-extraction renumbers stands, so a plain upsert on boothNumber would
 * leave the old records behind and attach bookings to the wrong stands. This
 * matches old to new by geometry instead: a stand that occupies the same place
 * on the plan is the same stand, whatever number it now has.
 *
 *   node scripts/reseed.js --dry     inspect the mapping, write nothing
 *   node scripts/reseed.js           apply
 */
const fs   = require('fs');
const path = require('path');

const { connect, getDb, close } = require('../server/db');
const config = require('../server/config');

const DRY = process.argv.includes('--dry');
const TOL = 3;   // drawing units

const centre = (g) => ({ x: g.x + g.w / 2, y: g.y + g.h / 2 });
const near = (a, b) => Math.abs(a.x - b.x) < TOL && Math.abs(a.y - b.y) < TOL;

function hasState(b) {
  const a = b.assignment || {};
  return b.status !== 'available' || a.company || a.actualPrice || a.notes || (b.clicks || 0) > 0;
}

async function main() {
  await connect();
  const db = getDb();

  const oldBooths = await db.collection('booths').find({ showId: config.showId }).toArray();
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'booth_data.json'), 'utf8'));
  const fresh = Object.values(raw);

  console.log(`Existing: ${oldBooths.length} stands   Fresh extraction: ${fresh.length} stands`);

  const carried = oldBooths.filter(hasState);
  console.log(`Stands carrying commercial state: ${carried.length}`);

  // ── Match old -> new by position AND size ──────────────────────────────────
  // Centre alone is not enough: a resized or split stand can share a centre with
  // a different new stand, carrying a booking onto the wrong footprint. Require
  // the size to be close too, and pick the best (nearest) match rather than the
  // first hit.
  const sizeClose = (a, b) => Math.abs(a.w - b.w) < TOL * 4 && Math.abs(a.h - b.h) < TOL * 4;
  const matches = [];
  const orphans = [];
  for (const o of carried) {
    if (!o.geometry) { orphans.push(o); continue; }
    const oc = centre(o.geometry);
    const cands = fresh
      .filter(f => near(centre({ x: f.x, y: f.y, w: f.w, h: f.h }), oc) && sizeClose(o.geometry, f))
      .map(f => ({ f, d: Math.abs(centre({ x: f.x, y: f.y, w: f.w, h: f.h }).x - oc.x) +
                          Math.abs(centre({ x: f.x, y: f.y, w: f.w, h: f.h }).y - oc.y) }))
      .sort((p, q) => p.d - q.d);
    if (cands.length) matches.push({ old: o, next: cands[0].f });
    else orphans.push(o);
  }

  // A new stand must not receive two different old bookings. If two old stands
  // both match one new stand, keep the nearest and orphan the rest for manual
  // re-assignment rather than silently overwriting one booking with another.
  const byNew = new Map();
  for (const m of matches) {
    const key = m.next.boothId;
    const prev = byNew.get(key);
    if (!prev) { byNew.set(key, m); continue; }
    console.log(`  ⚠ two old stands (${prev.old.boothNumber}, ${m.old.boothNumber}) map to new ${key}`);
    orphans.push(m.old);   // keep prev, orphan the later one
  }
  const dedupedMatches = [...byNew.values()];

  console.log(`  matched to a new stand : ${dedupedMatches.length}`);
  console.log(`  no positional match    : ${orphans.length}`);
  matches.length = 0; matches.push(...dedupedMatches);

  for (const m of matches) {
    const a = m.old.assignment || {};
    const to = String(m.next.boothId).replace(/^booth-/, '');
    if (m.old.boothNumber !== to || m.old.status !== 'available') {
      console.log(`    ${m.old.boothNumber} -> ${to}   ${m.old.status}` +
                  (a.company ? `  "${a.company}"` : ''));
    }
  }
  for (const o of orphans) {
    const a = o.assignment || {};
    console.log(`    ORPHAN ${o.boothNumber}  ${o.status}` + (a.company ? `  "${a.company}"` : '') +
                '   — its shape is no longer on the plan; re-assign by hand');
  }

  if (DRY) {
    console.log('\n--dry: nothing written.');
    await close();
    return;
  }

  // ── Snapshot, replace, restore ─────────────────────────────────────────────
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(__dirname, '..', `booths-backup-${stamp}.json`);
  fs.writeFileSync(backup, JSON.stringify(oldBooths, null, 2));
  console.log(`\nBackup written: ${path.basename(backup)}`);

  await db.collection('booths').deleteMany({ showId: config.showId });

  const docs = fresh.map(f => {
    const boothNumber = String(f.boothId).replace(/^booth-/, '');
    return {
      showId: config.showId,
      boothNumber,
      svgElementId: f.boothId,
      geometry: { x: f.x, y: f.y, w: f.w, h: f.h },
      sqm: f.sqm,
      sqmSource: 'estimated',
      listPrice: f.price,
      status: f.status,
      assignment: { company: null, contactId: null, actualPrice: null, notes: '' },
      clicks: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      updatedBy: 'reseed',
    };
  });
  await db.collection('booths').insertMany(docs);
  console.log(`Inserted ${docs.length} stands`);

  let restored = 0;
  for (const m of matches) {
    const to = String(m.next.boothId).replace(/^booth-/, '');
    const a = m.old.assignment || {};
    await db.collection('booths').updateOne(
      { showId: config.showId, boothNumber: to },
      { $set: {
          status: m.old.status,
          'assignment.company':     a.company ?? null,
          'assignment.contactId':   a.contactId ?? null,
          'assignment.actualPrice': a.actualPrice ?? null,
          'assignment.notes':       a.notes ?? '',
          clicks: m.old.clicks || 0,
          updatedAt: new Date(),
          updatedBy: 'reseed:carried',
      } }
    );
    restored++;
  }
  console.log(`Restored commercial state onto ${restored} stands`);

  // Hold documents point at the old numbering; re-point the ones we can.
  const holds = await db.collection('holds').find({ showId: config.showId }).toArray();
  for (const h of holds) {
    const m = matches.find(x => x.old.boothNumber === h.boothNumber);
    const to = m ? String(m.next.boothId).replace(/^booth-/, '') : null;
    if (to && to !== h.boothNumber) {
      await db.collection('holds').updateOne({ _id: h._id }, { $set: { boothNumber: to } });
      console.log(`  hold ${h.boothNumber} -> ${to}`);
    } else if (!to) {
      await db.collection('holds').deleteOne({ _id: h._id });
      console.log(`  hold ${h.boothNumber} removed — stand no longer exists`);
    }
  }

  const counts = await db.collection('booths').aggregate([
    { $match: { showId: config.showId } },
    { $group: { _id: '$status', n: { $sum: 1 } } },
  ]).toArray();
  console.log('\nFinal:', counts.map(c => `${c._id}=${c.n}`).join('  '));
  console.log('\nActivity history is left untouched — it references stand numbers');
  console.log('that have changed, so historic per-stand analytics predating this');
  console.log('re-seed will be attributed to the old numbering.');

  await close();
}

main().catch(e => { console.error('Re-seed failed:', e); process.exit(1); });
