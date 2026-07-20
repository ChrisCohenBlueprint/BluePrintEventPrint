#!/usr/bin/env node
/**
 * Seed MongoDB from public/booth_data.json, and rescue any bookings still
 * sitting in a legacy booth_state.json.
 *
 * Idempotent: booths are upserted on (showId, boothNumber), so re-running after
 * a fresh extraction updates geometry without touching commercial state.
 *
 *   node scripts/migrate.js                       seed / update
 *   node scripts/migrate.js --state <file.json>   also import legacy bookings
 */
const fs   = require('fs');
const path = require('path');

const { connect, getDb, close } = require('../server/db');
const config = require('../server/config');

const argv      = process.argv.slice(2);
const stateFlag = argv.indexOf('--state');
const statePath = stateFlag > -1
  ? path.resolve(argv[stateFlag + 1])
  : path.join(__dirname, '..', 'booth_state.json');

async function main() {
  await connect();
  const db = getDb();

  // ── Show document ───────────────────────────────────────────────────────────
  await db.collection('shows').updateOne(
    { _id: config.showId },
    { $setOnInsert: {
        _id: config.showId,
        name: 'LEX26',
        svgFile: 'LEX26_Floorplan_Web-Format_57.svg',
        ratePerSqm: 600,
        createdAt: new Date(),
    } },
    { upsert: true }
  );

  // ── Booths ──────────────────────────────────────────────────────────────────
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'booth_data.json'), 'utf8'));
  const entries = Object.values(raw);

  const ops = entries.map(b => {
    // boothNumber currently holds the positional id. Once real numbers are
    // extracted (plan §07) this becomes the printed stand number and the
    // id-mismatch bug disappears with it.
    const boothNumber = String(b.boothId).replace(/^booth-/, '');
    return {
      updateOne: {
        filter: { showId: config.showId, boothNumber },
        update: {
          // Geometry and list price are re-derived from the extraction and may
          // legitimately change; commercial state must never be clobbered.
          $set: {
            svgElementId: b.boothId,
            geometry: { x: b.x, y: b.y, w: b.w, h: b.h },
            sqm: b.sqm,
            sqmSource: 'estimated',   // 283-divisor guess — see plan §07
            listPrice: b.price,
          },
          $setOnInsert: {
            showId: config.showId,
            boothNumber,
            status: b.status,
            assignment: { company: null, contactId: null, actualPrice: null, notes: '' },
            clicks: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            updatedBy: 'migration',
          },
        },
        upsert: true,
      },
    };
  });

  const res = await db.collection('booths').bulkWrite(ops, { ordered: false });
  console.log(`✅ Booths — ${res.upsertedCount} inserted, ${res.modifiedCount} updated (${entries.length} total)`);

  // ── Legacy state rescue ─────────────────────────────────────────────────────
  if (fs.existsSync(statePath)) {
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    let restored = 0;

    for (const [id, s] of Object.entries(saved)) {
      const boothNumber = String(id).replace(/^booth-/, '');
      const r = await db.collection('booths').updateOne(
        { showId: config.showId, boothNumber },
        { $set: {
            status: s.status,
            'assignment.company':     s.company ?? null,
            'assignment.actualPrice': s.actualPrice ?? null,
            'assignment.notes':       s.notes ?? '',
            clicks: s.clicks ?? 0,
            updatedAt: new Date(),
            updatedBy: 'migration:legacy-state',
        } }
      );
      if (r.matchedCount) restored++;

      // Preserve historic click history as activity events rather than
      // discarding it — this is the only behavioural data that exists so far.
      const history = Array.isArray(s.clickHistory) ? s.clickHistory : [];
      if (history.length) {
        await db.collection('activity').insertMany(
          history.map(h => ({
            ts: new Date(h.time),
            showId: config.showId,
            type: 'booth.click',
            sessionId: null,
            actor: { kind: 'visitor', userId: null },
            boothNumber,
            meta: { imported: true },
            context: { location: h.location || null },
          })),
          { ordered: false }
        ).catch(e => console.warn('  history import warning:', e.message));
      }
    }
    console.log(`✅ Legacy state — ${restored} booths restored from ${statePath}`);
  } else {
    console.log(`ℹ  No legacy booth_state.json at ${statePath} — nothing to rescue`);
  }

  const counts = await db.collection('booths').aggregate([
    { $match: { showId: config.showId } },
    { $group: { _id: '$status', n: { $sum: 1 } } },
  ]).toArray();
  console.log('\nFinal booth counts:', counts.map(c => `${c._id}=${c.n}`).join('  '));

  await close();
}

main().catch(e => { console.error('Migration failed:', e); process.exit(1); });
