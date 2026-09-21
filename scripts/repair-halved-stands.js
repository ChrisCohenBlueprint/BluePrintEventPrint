#!/usr/bin/env node
/**
 * Repair the two stands the "booth got bigger and bigger" bug left at half size
 * (128 and 198), restoring each to its full artwork cell with the area and list
 * price to match, and preserving its status, exhibitor and €/m².
 *
 * IT IS ALMOST CERTAINLY DEAD, and the dry run is the proof. The coordinates it
 * matches (stand 128 at x:2086) belong to the LEX26 drawing space; the plan in
 * use is LEX27, whose 262 stands are keyed by their PRINTED number and none of
 * which sits further right than x:1654. There is no stand 128 or 198 to find.
 * It nevertheless ran on every boot and wrote its completion flag whether or
 * not it had matched anything, which is what made it look like a repair that
 * had been done rather than one that could never fire. Run it and it will tell
 * you, per stand, exactly why it matched nothing.
 *
 * Kept rather than deleted because the same repair against a restored LEX26
 * database would still be the right one.
 *
 *   node scripts/repair-halved-stands.js                     what it would do
 *   node scripts/repair-halved-stands.js --apply             do it
 *   node scripts/repair-halved-stands.js --show lex --apply  a named event
 */
const { begin, end, close } = require('./lib/run');
const showContext = require('../server/show-context');
const booths = require('../server/models/booths');

async function main() {
  const { apply, force, showId } = await begin('Repair halved stands');

  await showContext.runAs(showId, async () => {
    // A geometry repair touches no booking, but it can reshape a SOLD stand, so
    // the same guard applies: an event that is selling is not somewhere to run
    // a blind coordinate match without saying so.
    const committed = await booths.countCommitted();
    console.log(`  ${committed} stand(s) carry a real booking, hold, contact or agreed price`);
    if (committed > 0 && !force) {
      console.log('\nREFUSED: this event has sold or reserved stands. Re-run with --force if you mean it.');
      return;
    }

    const r = await booths.repairHalvedStands({ apply });
    for (const s of r.skipped) console.log(`  - ${s.boothNumber}: ${s.why}`);
    for (const p of r.planned) {
      const g = (b) => `${Math.round(b.w)}×${Math.round(b.h)}`;
      console.log(`  - ${p.boothNumber}: ${g(p.from)} ${p.fromSqm}m² → ${g(p.to)} ${p.sqm}m² €${p.listPrice}  (${p.status})`);
    }
    if (!r.planned.length) {
      console.log('\nNothing matches. As expected — see the header: this repair cannot fire on LEX27 data.');
      return;
    }
    end(apply);
  });

  await close();
}

main().catch(e => { console.error('Failed:', e); process.exit(1); });
