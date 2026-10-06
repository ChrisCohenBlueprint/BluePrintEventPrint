#!/usr/bin/env node
/**
 * Put the shipped stands — server/data/booth_data.json, the extraction of the
 * original Europe artwork — into an event NOBODY HAS WORKED ON YET, and, only
 * when asked, rescue bookings from a legacy booth_state.json.
 *
 * WHAT THIS IS FOR NOW. Stands normally come from an event's own artwork
 * (Admin → Settings → Import). This script predates that, and what is left of
 * its job is seeding an empty event — a fresh database, or a new event that is
 * to start from the original Europe plan. It is not a repair tool, and it
 * will not run over an event that has been sold from or laid out by hand.
 *
 * It used to write on every run, with no dry run and no way to name the event,
 * and its one guard asked only whether the stand numbers overlapped. Europe's
 * do, so on the live event it passed and then rewrote every stand's shape,
 * size and price from the file: a merged, sold block went back to one 9 m²
 * stand at half the price, still sold to its exhibitor, and the stand it had
 * absorbed came back beside it as available — the same floor sellable twice.
 * Splits were reverted and deleted stands returned. And whenever a
 * booth_state.json lay in the project folder and the meta flag was missing —
 * any restored or cloned database — it overwrote live bookings with whatever
 * that file said. So, now:
 *
 *   - it is a dry run until --apply, and --show picks the event;
 *   - it REFUSES an event with any committed stand (sold, held, a contact or
 *     an agreed price) or any hand-made work (merged, split, removed, tagged,
 *     renumbered, sponsored). There is no override: an event in that state is
 *     past seeding, and an artwork import or scripts/reset-blank-layout.js is
 *     the tool that knows how to rebuild one;
 *   - list prices come from the event's own rate, not the file's, so seeding
 *     never puts an old rate back;
 *   - a booth_state.json is read only when it is named with --state.
 *
 *   node scripts/migrate.js                          what it would do
 *   node scripts/migrate.js --apply                  do it
 *   node scripts/migrate.js --show lna --apply       a named event
 *   node scripts/migrate.js --state <file> --apply   also import legacy bookings (once per database)
 *   --force                                          seed even when the stand numbers barely match
 */
const fs   = require('fs');
const path = require('path');

const { begin, end, close, valueOf } = require('./lib/run');
const showContext = require('../server/show-context');
const booths = require('../server/models/booths');
const settings = require('../server/models/settings');

const LEGACY_FLAG = 'legacy-state-import-v1';
const numberOf = (b) => String(b.boothId).replace(/^booth-/, '');

async function main() {
  const stateArg = valueOf('--state');   // read first: a bare --state stops the script before it connects
  const { apply, force, showId, db } = await begin('Seed stands from the shipped extraction');

  await showContext.runAs(showId, async () => {
    const col = db.collection('booths');

    // ── Has anyone worked on this event? ──────────────────────────────────────
    const committed  = await booths.countCommitted(showId);
    const customised = await booths.countHandwork(showId);
    console.log(`  ${committed} stand(s) carry a real booking, hold, contact or agreed price`);
    console.log(`  ${customised} stand(s) carry hand-made work (merged, split, removed, tags, country, shown number, sponsor)`);
    if (committed || customised) {
      const named = await col.find({ showId, $or: [booths.commercialFilter(), booths.handworkFilter()] })
        .project({ boothNumber: 1, status: 1, assignment: 1 }).toArray();
      console.log('\nREFUSED: this event has been sold from or laid out by hand, and seeding it from the');
      console.log('shipped file would put stands back over that work. There is no override. To rebuild a');
      console.log('worked event use an artwork import in the admin, or scripts/reset-blank-layout.js.');
      for (const b of named.slice(0, 20)) {
        console.log(`    ${String(b.boothNumber).padEnd(10)} ${String(b.status).padEnd(10)} ${b.assignment?.company || ''}`);
      }
      if (named.length > 20) console.log(`    … and ${named.length - 20} more`);
      process.exitCode = 1;
      return;
    }

    // ── What the file would do ────────────────────────────────────────────────
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'data', 'booth_data.json'), 'utf8'));
    const entries = Object.values(raw);
    const existing = await col.find({ showId }).toArray();
    const have = new Map(existing.map(b => [b.boothNumber, b]));

    // Guard against the renumber footgun: if the file's numbers barely overlap
    // what is stored, its geometry would land on the wrong stands. reseed.js
    // re-matches by position instead.
    if (existing.length) {
      const overlap = entries.filter(b => have.has(numberOf(b))).length / entries.length;
      if (overlap < 0.8 && !force) {
        console.log(`\nREFUSED: only ${Math.round(overlap * 100)}% of the file's stand numbers match the ${existing.length} stored.`);
        console.log('This looks like a RENUMBER — seeding would put shapes on the wrong stands.');
        console.log('Use scripts/reseed.js (it matches by position), or --force if this is really meant.');
        process.exitCode = 1;
        return;
      }
    }

    // The event's own rate: the file's prices are an old rate's.
    const rate = await settings.rate();
    const listPrice = (sqm) => Math.round((Number(sqm) || 0) * rate);

    const inserts = [], updates = [];
    for (const b of entries) {
      const boothNumber = numberOf(b);
      const geometry = { x: b.x, y: b.y, w: b.w, h: b.h };
      const cur = have.get(boothNumber);
      if (!cur) { inserts.push({ b, boothNumber, geometry }); continue; }
      const same = cur.geometry && ['x', 'y', 'w', 'h'].every(k => cur.geometry[k] === geometry[k]) &&
                   cur.sqm === b.sqm && cur.listPrice === listPrice(b.sqm);
      if (!same) updates.push({ b, boothNumber, geometry, cur });
    }
    const inFile = new Set(entries.map(numberOf));
    const untouched = existing.filter(b => !inFile.has(b.boothNumber)).length;

    console.log(`\n  ${entries.length} stand(s) in the file, ${existing.length} stored for ${showId}, at ${rate} per unit`);
    console.log(`  ${inserts.length} to add`);
    console.log(`  ${updates.length} stored stand(s) to take the file's shape, size and list price`);
    for (const u of updates.slice(0, 20)) {
      console.log(`    ${u.boothNumber.padEnd(10)} ${u.cur.sqm} → ${u.b.sqm}   ${u.cur.listPrice} → ${listPrice(u.b.sqm)}`);
    }
    if (updates.length > 20) console.log(`    … and ${updates.length - 20} more`);
    if (untouched) console.log(`  ${untouched} stored stand(s) the file does not mention, left as they are`);

    // ── Legacy bookings, only when named ─────────────────────────────────────
    let legacy = null;
    if (stateArg) {
      const statePath = path.resolve(stateArg);
      const already = await db.collection('meta').findOne({ _id: LEGACY_FLAG });
      if (already) {
        console.log(`\n  Legacy state already imported into this database (${new Date(already.at).toISOString()}) — not again.`);
      } else if (!fs.existsSync(statePath)) {
        console.log(`\nREFUSED: --state names ${statePath}, which does not exist.`);
        process.exitCode = 1;
        return;
      } else {
        legacy = { statePath, saved: JSON.parse(fs.readFileSync(statePath, 'utf8')) };
        const rows = Object.entries(legacy.saved);
        console.log(`\n  Legacy state from ${statePath}: ${rows.length} stand(s) will take its status and booking`);
        for (const [id, st] of rows.slice(0, 20)) {
          console.log(`    ${String(id).replace(/^booth-/, '').padEnd(10)} ${String(st.status).padEnd(10)} ${st.company || ''}`);
        }
        if (rows.length > 20) console.log(`    … and ${rows.length - 20} more`);
      }
    }

    if (!apply) { end(false); return; }

    // ── Apply ────────────────────────────────────────────────────────────────
    // Nothing worked on means nothing to lose — but a stored stand is about to
    // change shape, so the set is kept to come back to all the same.
    if (existing.length && updates.length) {
      const snap = await booths.snapshot('migrate', existing, { actor: 'migrate', showId });
      if (!snap.ok) {
        console.log(`\nABORTED: the snapshot failed (${snap.error}), so nothing was changed.`);
        process.exitCode = 1;
        return;
      }
      console.log(`\n  snapshot ${snap.snapshotId}  (restore with: node scripts/restore-snapshot.js --id ${snap.snapshotId})`);
    }

    const now = new Date();
    const ops = [
      ...updates.map(u => ({ updateOne: {
        filter: { showId, boothNumber: u.boothNumber },
        update: { $set: { svgElementId: u.b.boothId, geometry: u.geometry, sqm: u.b.sqm, sqmSource: 'estimated',
                          listPrice: listPrice(u.b.sqm), updatedAt: now, updatedBy: 'migration' } },
      } })),
      ...inserts.map(i => ({ updateOne: {
        filter: { showId, boothNumber: i.boothNumber },
        update: {
          $set: { svgElementId: i.b.boothId, geometry: i.geometry, sqm: i.b.sqm, sqmSource: 'estimated',
                  listPrice: listPrice(i.b.sqm) },
          $setOnInsert: {
            showId, boothNumber: i.boothNumber, status: 'available',
            assignment: { company: null, contactId: null, actualPrice: null, notes: '', tags: [], country: null },
            clicks: 0, createdAt: now, updatedAt: now, updatedBy: 'migration',
          },
        },
        upsert: true,
      } })),
    ];
    if (ops.length) {
      const res = await col.bulkWrite(ops, { ordered: false });
      console.log(`  Booths — ${res.upsertedCount} added, ${res.modifiedCount} updated`);
    }

    if (legacy) {
      let restored = 0;
      for (const [id, st] of Object.entries(legacy.saved)) {
        const boothNumber = String(id).replace(/^booth-/, '');
        const r = await col.updateOne(
          { showId, boothNumber },
          { $set: {
              status: st.status,
              'assignment.company':     st.company ?? null,
              'assignment.actualPrice': st.actualPrice ?? null,
              'assignment.notes':       st.notes ?? '',
              clicks: st.clicks ?? 0,
              updatedAt: new Date(),
              updatedBy: 'migration:legacy-state',
          } });
        if (r.matchedCount) restored++;

        // Historic click history becomes activity events rather than being
        // discarded — it was the only behavioural data there was.
        const history = Array.isArray(st.clickHistory) ? st.clickHistory : [];
        if (history.length) {
          await db.collection('activity').insertMany(history.map(h => ({
            ts: new Date(h.time), showId, type: 'booth.click', sessionId: null,
            actor: { kind: 'visitor', userId: null }, boothNumber,
            meta: { imported: true }, context: { location: h.location || null },
          })), { ordered: false }).catch(e => console.warn('  history import warning:', e.message));
        }
      }
      // One-shot per database: a second run must never revert bookings made since.
      await db.collection('meta').updateOne({ _id: LEGACY_FLAG }, { $set: { at: new Date() } }, { upsert: true });
      console.log(`  Legacy state — ${restored} stand(s) restored from ${legacy.statePath} (marked one-shot)`);
    }

    const after = await col.find({ showId }).project({ status: 1 }).toArray();
    const counts = after.reduce((m, b) => ({ ...m, [b.status]: (m[b.status] || 0) + 1 }), {});
    console.log(`\n  ${showId} now: ${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join('  ')}`);
    end(true);
  });

  await close();
}

main().catch(e => { console.error('Migration failed:', e); process.exit(1); });
