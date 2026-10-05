#!/usr/bin/env node
/**
 * What is off the plan, and how to put it back — from a terminal.
 *
 *   node scripts/removed-stands.js                      list what is off the plan
 *   node scripts/removed-stands.js --stand 132          what putting it back would do
 *   node scripts/removed-stands.js --stand 132 --apply  put it back
 *   --show <slug>                                       a named event
 *
 * The console is the place to do this — Tools → Removed Stands, or Tools → Plan
 * History for anything older. This exists for when the console cannot answer:
 * a deployment that has the Remove button but not yet the list beside it, a
 * page that will not load, or wanting to know what state an event is in without
 * clicking through it.
 *
 * Nothing is destroyed by a removal, so nothing here RECOVERS anything — the
 * stand kept its number, its shape, its size and its price, and this clears the
 * flag that took it off the plan.
 *
 * A stand that has gone from the plan but is not listed here was not removed:
 * it was merged into a neighbour, or carved up by a split. Those are undone by
 * Tools → Reset, or by scripts/restore-snapshot.js.
 *
 * Read-only unless --apply, like every script here.
 */
const { begin, end, close, valueOf } = require('./lib/run');
const showContext = require('../server/show-context');
const booths = require('../server/models/booths');

const UNIT = 'm²';

async function main() {
  const { apply, showId } = await begin('Stands taken off the plan');
  const wanted = valueOf('--stand');

  await showContext.runAs(showId, async () => {
    const gone = await booths.removedStands();

    if (!gone.length) {
      console.log('  Nothing is off the plan on this event.\n');
      console.log('  A stand that has gone but is not listed here was not REMOVED — it was');
      console.log('  merged into a neighbour or carved up by a split. Tools → Reset undoes');
      console.log('  those, and Tools → Plan History goes back to before any change at all.');
      return;
    }

    console.log(`  ${gone.length} stand${gone.length === 1 ? '' : 's'} off the plan, newest first:\n`);
    for (const b of gone) {
      const when = b.removedAt ? new Date(b.removedAt).toISOString().slice(0, 16).replace('T', ' ') : 'date not recorded';
      console.log(`    ${String(b.boothNumber).padEnd(10)} ${String(b.sqm ?? '?').padStart(4)} ${UNIT}   ` +
                  `taken off ${when}` + (b.removedBy ? ` by ${b.removedBy}` : '') +
                  (b.displayNumber ? `   (shown as ${b.displayNumber})` : '') +
                  (b.removedReason ? `   — ${b.removedReason}` : ''));
    }

    if (!wanted) {
      console.log('\n  Re-run with --stand <number> to see what putting one back would do.');
      return;
    }

    const target = gone.find(b => String(b.boothNumber) === String(wanted));
    if (!target) {
      console.log(`\n  Stand ${wanted} is not one of them — it is still on the plan, or it was never removed.`);
      return;
    }

    console.log(`\n  Stand ${target.boothNumber} goes back on the plan at ${target.sqm ?? '?'} ${UNIT}, ` +
                'exactly as it was, available.');
    if (!apply) return end(apply);

    const r = await booths.restoreRemoved(String(target.boothNumber), { actor: 'removed-stands-script' });
    if (!r.ok) {
      console.log(`\nFAILED: ${r.reason}`);
      process.exitCode = 1;
      return;
    }
    end(apply);
  });

  await close();
}

main().catch(e => { console.error('Failed:', e); process.exit(1); });
