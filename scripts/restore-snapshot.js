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
 * Sponsor logos are NOT in a snapshot — they are inline images of up to 2 MB
 * each and they are what made the old single-document form impossible. Any
 * stand that had one is named so it can be re-uploaded.
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
    if (!r.ok) { console.log(`\nFAILED: ${r.reason}${r.detail ? ` — ${r.detail}` : ''}`); return; }

    console.log(`  ${r.stands} stand(s) in the snapshot would replace the ${r.replacing} stored now`);
    if (r.logosNotRestored.length) {
      console.log(`  ${r.logosNotRestored.length} stand(s) had a sponsor logo that is NOT in the snapshot ` +
                  `and will need re-uploading: ${r.logosNotRestored.join(', ')}`);
    }
    if (r.previousSnapshot) console.log(`  the stands being replaced were snapshotted as ${r.previousSnapshot}`);
    end(apply);
  });

  await close();
}

main().catch(e => { console.error('Failed:', e); process.exit(1); });
