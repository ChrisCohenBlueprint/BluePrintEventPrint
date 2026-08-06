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

  // Guard against the renumber footgun. migrate keys on boothNumber and only
  // updates geometry, so if a fresh extraction RENUMBERED the stands it would
  // silently paste new geometry onto whatever booking currently holds that
  // number — decoupling commercial state from position. If the incoming numbers
  // barely overlap what's already stored, refuse and point at reseed.js (which
  // re-matches by position and carries bookings across).
  const existing = await db.collection('booths')
    .find({ showId: config.showId }).project({ boothNumber: 1 }).toArray();
  if (existing.length) {
    const have = new Set(existing.map(b => b.boothNumber));
    const incoming = entries.map(b => String(b.boothId).replace(/^booth-/, ''));
    const overlap = incoming.filter(n => have.has(n)).length / incoming.length;
    if (overlap < 0.8 && !argv.includes('--force')) {
      console.error(`REFUSING: only ${Math.round(overlap * 100)}% of incoming stand numbers match the existing data.`);
      console.error('This looks like a RENUMBER. migrate would decouple bookings from position.');
      console.error('Use scripts/reseed.js (re-matches by position, carries bookings), or --force to override.');
      await close();
      process.exit(1);
    }
  }

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
  // ONE-SHOT. This block does an unconditional $set of status/company/price/
  // notes/clicks for every booth named in the state file, and imports its click
  // history. Re-running it after real bookings exist would revert those bookings
  // and duplicate the history. A meta marker guarantees it applies at most once,
  // even if booth_state.json reappears or the script is re-run.
  const LEGACY_FLAG = 'legacy-state-import-v1';
  const alreadyImported = await db.collection('meta').findOne({ _id: LEGACY_FLAG });
  if (alreadyImported) {
    console.log(`ℹ  Legacy state already imported (${new Date(alreadyImported.at).toISOString()}) — skipping`);
  } else if (fs.existsSync(statePath)) {
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
    await db.collection('meta').updateOne(
      { _id: LEGACY_FLAG }, { $set: { at: new Date() } }, { upsert: true });
    console.log(`✅ Legacy state — ${restored} booths restored from ${statePath} (marked one-shot)`);
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
