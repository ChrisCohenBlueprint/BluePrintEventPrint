#!/usr/bin/env node
/**
 * Put a snapshot of an event's stands back.
 *
 * Every destructive path in this codebase takes a snapshot first and its
 * comments name that snapshot as the way back — and until this script existed
 * that was not true. Nothing anywhere read one. The snapshots were also written
 * as a single document holding every stand, which on a hall carrying inline
 * sponsor logos exceeds Mongo's 16 MB document limit and simply threw, in a
 * try/catch that logged and carried on. The recovery route was a comment.
 *
 * It is now one document per stand, indexed, aged out by TTL, and this reads it
 * back.
 *
 *   node scripts/restore-snapshot.js                          list what there is
 *   node scripts/restore-snapshot.js --id <id>                what it would do
 *   node scripts/restore-snapshot.js --id <id> --apply        do it
 *   --show <slug>                                             a named event
 *
 * What goes back is the SHAPE of the hall — merges, splits, removed stands,
 * shown numbers. Every booking stays as it is now: a snapshot is never a way to
 * put a sale or a hold back to how it was. A snapshot that would take away,
 * resize or move a stand that is booked now is refused, and the stands in the
 * way are listed — move or release them, then run it again.
 *
 * A snapshot taken on an earlier drawing switches the LIVE ARTWORK back to that
 * drawing as well, with its lounges, its unit and its colours; the dry run
 * says so before anything is written.
 *
 * Sponsor logos are NOT in a snapshot — they are inline images of up to 2 MB
 * each and they are what made the old single-document form impossible. A
 * stand still on the plan keeps its own; one coming back that had a logo is
 * named so it can be re-uploaded.
 */
const { begin, end, close, valueOf } = require('./lib/run');
const showContext = require('../server/show-context');
const booths = require('../server/models/booths');

async function main() {
  const { apply, showId } = await begin('Restore a snapshot of the stands');
  const id = valueOf('--id');

  await showContext.runAs(showId, async () => {
    const list = await booths.listSnapshots({ limit: 30 });
    if (!id) {
      if (!list.length) { console.log('  No snapshots stored for this event.'); return; }
      console.log('  Snapshots, newest first:\n');
      for (const s of list) {
        console.log(`    ${new Date(s.at).toISOString().slice(0, 19).replace('T', ' ')}  ` +
                    `${String(s.count).padStart(4)} stands   ${s.snapshotId}`);
      }
      console.log('\n  Re-run with --id <id> to see what restoring one would do.');
      return;
    }

    const r = await booths.restoreSnapshot(id, { apply, actor: 'restore-snapshot' });
    if (!r.ok && r.reason !== 'bookings_in_the_way') {
      console.log(`\nFAILED: ${r.reason}${r.boothNumber ? ` (stand ${r.boothNumber})` : ''}${r.detail ? ` — ${r.detail}` : ''}`);
      process.exitCode = 1;
      return;
    }

    const ch = r.changes || { reshaped: [], added: [], dropped: [] };
    console.log(`  ${r.stands} stand(s) in the snapshot, ${r.replacing} on the plan now`);
    console.log(`  the SHAPE goes back: ${ch.reshaped.length} stand(s) reshaped, ` +
                `${ch.added.length} coming back${ch.added.length ? ` (${ch.added.join(', ')})` : ''}, ` +
                `${ch.dropped.length} going${ch.dropped.length ? ` (${ch.dropped.join(', ')})` : ''}`);
    console.log(`  every booking is kept as it is now — ${r.bookingsKept} stand(s) sold or held`);
    // The drawing visitors see changes too, which is the one effect of this
    // that reaches beyond the stands — so it is said before it is done.
    if (r.artwork) {
      console.log(`  the LIVE ARTWORK is switched back to ${r.artwork.label} as well — every visitor sees it, ` +
                  'and its lounges, unit and colours go back with it');
    }
    if (r.logosNotRestored.length) {
      console.log(`  ${r.logosNotRestored.length} stand(s) coming back had a sponsor logo that is NOT in the snapshot ` +
                  `and will need re-uploading: ${r.logosNotRestored.join(', ')}`);
    }
    if (r.conflicts.length) {
      console.log(`\nREFUSED: ${r.conflicts.length} booked stand(s) would not survive this snapshot's plan:`);
      const what = { gone: 'would disappear', removed: 'would be taken off the plan', resized: 'would change size or place' };
      for (const c of r.conflicts) {
        console.log(`    ${String(c.boothNumber).padEnd(10)} ${String(c.status).padEnd(6)} ${(c.company || '').padEnd(28)} ${what[c.why] || c.why}`);
      }
      console.log('  Move or release them, then run this again.');
      process.exitCode = 1;
      return;
    }
    if (r.previousSnapshot) console.log(`  the stands as they were are snapshotted as ${r.previousSnapshot}`);
    end(apply);
  });

  await close();
}

main().catch(e => { console.error('Failed:', e); process.exit(1); });
