#!/usr/bin/env node
/**
 * Put North America's plan back and rebuild its stands from it.
 *
 * The event's stored plan had its printed exhibitor names stripped out IN
 * PLACE, destroying the only copy of them on the server; the designer's
 * original is shipped in the repo, so this restores it and re-reads the stands
 * from it. See server/services/seed-artwork.js for the full account.
 *
 * It used to run on every boot behind a flag in `meta` — which meant a deploy
 * could rewrite an event's inventory unasked, and, because the flag was written
 * even when the import was refused, could leave the stands broken permanently.
 * It also baked 78 real exhibitor names into any database this code was run
 * against. Now it is a person's decision, taken with the numbers in front of
 * them.
 *
 *   node scripts/seed-north-america.js            what it would do
 *   node scripts/seed-north-america.js --apply    do it
 *   --force                                       override the import's refusal
 *
 * The event is fixed: it only ever acts on the show with slug "lna".
 */
const { begin, end, close } = require('./lib/run');
const { seedNorthAmerica, SLUG } = require('../server/services/seed-artwork');

async function main() {
  const { apply, force } = await begin(`Seed North America from the shipped artwork (event "${SLUG}")`);

  const r = await seedNorthAmerica({ apply, force });

  if (r.skipped) { console.log(`Nothing done: ${r.skipped}${r.detail ? ` — ${r.detail}` : ''}`); await close(); return; }

  console.log(`  plan       stored copy has ${r.namesNow} exhibitor name(s), the shipped original has ${r.namesShipped}`);
  console.log(`             ${r.planNeedsRestoring ? 'WOULD BE RESTORED from the shipped file' : 'is already the better copy — left alone'}`);
  console.log(`  artwork    ${r.sellable} sellable stand(s), ${r.areas} sponsorable area(s)`);
  console.log(`  stored     ${JSON.stringify(r.got)}`);
  console.log(`  plan says  ${JSON.stringify(r.want)}`);
  console.log(`  ${r.standsDiffer ? 'They DIFFER.' : 'They agree.'}  (a legitimate merge or split will also show as a difference)`);
  console.log(`  guard      ${r.committed} committed stand(s), ${r.customised} carrying hand-made work`);
  for (const w of r.warnings || []) console.log(`  warning    ${w}`);

  if (r.importRefused) {
    console.log(`\nThe import was REFUSED: ${r.importRefused}. The plan is restored; the stands are untouched.`);
    console.log('That is the guard doing its job. --force only if you are certain.');
  } else if (r.ok && !r.dryRun) {
    console.log(`\n  imported   ${r.imported} stand(s) — ${r.sold} sold, ${r.available} available, ${r.held} on hold`);
    if (r.created !== undefined) {
      console.log(`             ${r.created} created, ${r.refreshed} re-read from the plan, ` +
                  `${r.reshaped} kept their booking, ${r.untouched} left alone (merged/split)`);
    }
    if (r.storedAreas) console.log(`  areas      ${r.storedAreas.areas} stored against this event`);
    console.log(`  names      ${r.namesRemoved} taken off the served copy of the plan`);
    if (r.snapshotId) console.log(`  snapshot   ${r.snapshotId}`);
  }

  end(apply);
  await close();
}

main().catch(e => { console.error('Failed:', e); process.exit(1); });
