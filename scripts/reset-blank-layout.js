#!/usr/bin/env node
/**
 * Reset an event to a completely blank plan.
 *
 * Rebuilds every stand from the original artwork extraction with all of them
 * AVAILABLE — bookings, holds, sponsor flags and shown-number overrides all
 * cleared — and prices them at the event's own rate. Leads and enquiries are
 * left alone: they are sales records, not plan state.
 *
 * This was a one-shot that ran at BOOT, guarded by a flag in `meta`. An
 * operation that empties an event's inventory is not something a deploy should
 * decide, so it is a script, it is a dry run by default, and it refuses an
 * event that has sold anything.
 *
 *   node scripts/reset-blank-layout.js             what it would do
 *   node scripts/reset-blank-layout.js --apply     do it
 *   --force                                        override the refusal
 *
 * EUROPE ONLY. The blank plan is read from server/data/booth_data.json, which
 * is Europe's hall — the stands read off LEX27 — and belongs to the event the
 * deployment was set up with (SHOW_ID). Any other event is refused rather than
 * rebuilt as a copy of Europe: `--show lna` used to be the example here, and it
 * would have replaced North America's hall with Europe's stands at Europe's
 * prices. Another event's blank plan is its own artwork, re-read from the
 * console with Replace everything.
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
    if (!r.ok && r.reason === 'wrong_event') {
      console.log(`\nREFUSED: the blank plan this rebuilds from is ${r.belongsTo}'s hall, not ${r.showId}'s.`);
      console.log(`Rebuilding ${r.showId} from it would replace its stands with ${r.belongsTo}'s. Re-read ${r.showId}'s own`);
      console.log('artwork from the console (Settings → the event → Replace everything) instead.');
      process.exitCode = 1;
      return;
    }
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
