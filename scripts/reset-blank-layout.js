#!/usr/bin/env node
/**
 * Reset an event to a completely blank plan.
 *
 * Rebuilds every stand from the original artwork extraction with all of them
 * AVAILABLE — bookings, holds, sponsor flags and shown-number overrides all
 * cleared. Leads and enquiries are left alone: they are sales records, not plan
 * state.
 *
 * This was a one-shot that ran at BOOT, guarded by a flag in `meta`. An
 * operation that empties an event's inventory is not something a deploy should
 * decide, so it is a script, it is a dry run by default, and it refuses an
 * event that has sold anything.
 *
 *   node scripts/reset-blank-layout.js                     what it would do
 *   node scripts/reset-blank-layout.js --apply             do it
 *   node scripts/reset-blank-layout.js --show lna --apply  a named event
 *   --force                                                override the refusal
 *
 * The stands it replaces are snapshotted first, and scripts/restore-snapshot.js
 * puts them back.
 */
const { begin, end, close } = require('./lib/run');
const showContext = require('../server/show-context');
const booths = require('../server/models/booths');

async function main() {
  const { apply, force, showId } = await begin('Reset to a blank layout');

  await showContext.runAs(showId, async () => {
    const committed = await booths.countCommitted();
    const customised = await booths.countHandwork();
    console.log(`  ${committed} stand(s) carry a real booking, hold, contact or agreed price`);
    console.log(`  ${customised} stand(s) carry hand-made work (tags, country, shown number, sponsor logo, merge/split)`);
    if (committed > 0 && !force) {
      console.log('\nREFUSED: this event has sold or reserved stands, and this clears every one of them.');
      console.log('Re-run with --force only if you genuinely mean to wipe them.');
      return;
    }

    const r = await booths.resetToBlankLayout({ apply, force });
    if (!r.ok) { console.log(`\nREFUSED: ${r.reason}${r.detail ? ` — ${r.detail}` : ''}`); return; }

    console.log(`  ${r.replacing} stand(s) stored now → ${r.stands} rebuilt from the artwork, all available`);
    if (r.holdsCleared) console.log(`  ${r.holdsCleared} hold document(s) cleared`);
    if (r.clearing.length) {
      console.log(`\n  Losing the following ${r.clearing.length} booking(s)/hold(s):`);
      for (const c of r.clearing) console.log(`    ${c.boothNumber.padEnd(10)} ${c.status.padEnd(10)} ${c.company || ''}`);
    }
    if (r.snapshotId) console.log(`\n  snapshot ${r.snapshotId}  (restore with: node scripts/restore-snapshot.js --id ${r.snapshotId})`);
    end(apply);
  });

  await close();
}

main().catch(e => { console.error('Failed:', e); process.exit(1); });
