/**
 * Put North America's plan back and rebuild its stands from it.
 *
 * Why this exists rather than an instruction to click through the admin:
 * removing the printed exhibitor names OVERWROTE the stored plan, which was
 * the only copy of those names on the server. The event was left sitting on a
 * plan with none left in it and 99 stands with no exhibitors, and no amount of
 * re-importing could recover what was no longer in the file. The designer's
 * original is shipped in the repo, so the repair can simply put it back.
 *
 * IT NO LONGER RUNS AT BOOT. It used to, guarded by a flag in `meta`, which
 * meant a deploy could rewrite an event's inventory with nobody having asked
 * and nobody watching — and, worse, a run that restored the plan and was then
 * refused the import wrote its flag anyway, so every later boot saw a healthy
 * plan, skipped, and left the stands broken for good. It is now a function with
 * a DRY RUN as its default, driven by scripts/seed-north-america.js, which
 * prints the database, the event and every change before anything is written.
 *
 * Still guarded three ways:
 *   - a deliberate --apply, so nothing happens by accident;
 *   - booths.importFromArtwork's own refusal on any event with real bookings,
 *     holds, contacts, agreed prices or hand-made layout work, which is what
 *     keeps Europe untouched;
 *   - it only acts on the event it names.
 *
 * It is also the last automatic path that would have written REAL CUSTOMER
 * NAMES into a fresh database: the shipped artwork carries 78 exhibitors, and
 * a boot-time seed baked them into every database this code was ever run
 * against. Behind --apply, that is a person importing an event's own plan,
 * which is the whole point of the feature.
 */
const fs = require('fs');
const path = require('path');

const showContext = require('../show-context');
const showsModel = require('../models/shows');
const floorplans = require('../models/floorplans');
const planAreas = require('../models/plan-areas');
const settings = require('../models/settings');
const booths = require('../models/booths');
const { getDb } = require('../db');
const { extractStands, stripExhibitorNames, paletteOf } = require('../lib/extract-stands');

const SLUG = 'lna';
const FILE = path.join(__dirname, '..', '..', 'public', 'LNA27_Floorplan_Web-Format_24.svg');
// Kept as a record of what was done and when, NOT as a gate. A flag that
// decides whether a repair runs is a flag that can disable it after a
// half-finished run, which is exactly what happened.
const RAN = 'seed-artwork-lna';

async function seedNorthAmerica({ apply = false, force = false, actor = 'deploy' } = {}) {
  const meta = getDb().collection('meta');

  const show = showsModel.list().find(s => s.slug === SLUG);
  if (!show) return { skipped: 'no-such-show' };

  let shipped;
  try { shipped = fs.readFileSync(FILE, 'utf8'); }
  catch (e) { return { skipped: 'no-shipped-file', detail: e.message }; }

  const source = extractStands(shipped);
  if (!source.stands.length) return { skipped: 'shipped-file-unreadable', warnings: source.warnings };

  return showContext.runAs(show.showId, async () => {
    const stored = await floorplans.get();
    const current = stored && stored.svg ? extractStands(stored.svg) : { stands: [] };
    const namesNow = current.stands.filter(s => s.exhibitor).length;
    const namesShipped = source.stands.filter(s => s.exhibitor).length;

    // Lounges and conference tracks are sponsorable space, not sellable stands.
    const sellable = source.stands.filter(s => !s.sponsored);
    const areas = source.stands.filter(s => s.sponsored);

    // Two separate things can be wrong, and fixing one is not fixing the other.
    // An earlier run of this restored the plan and was then refused the import,
    // so the plan was right while the stands stayed wrong.
    const planNeedsRestoring = namesNow < namesShipped;

    // Does the stored inventory match what the plan says? Compared as a whole
    // rather than by a list of specific symptoms: earlier versions checked only
    // whether the plan had names, then only the stand count, and each time the
    // defect actually present fell outside the check.
    //
    // This is now a REPORT, not a decision. Comparing tallies cannot tell a
    // broken import from an admin legitimately merging two stands — one merge
    // changes the total and made this declare the whole inventory in need of
    // rebuilding — so what to do about a difference is left to the person
    // reading it, and the import's own guards decide what may be overwritten.
    const tally = (rows, status, company) => ({
      total: rows.length,
      available: rows.filter(status('available')).length,
      sold: rows.filter(status('sold')).length,
      held: rows.filter(status('held')).length,
      named: rows.filter(company).length,
    });
    const want = tally(sellable, (st) => (r) => r.status === st, (r) => !!r.exhibitor && r.status !== 'available');
    const have = await booths.all();
    const got = tally(have, (st) => (r) => r.status === st, (r) => !!(r.assignment && r.assignment.company));
    const standsDiffer = Object.keys(want).some(k => want[k] !== got[k]);

    const report = {
      showId: show.showId, slug: SLUG,
      planNeedsRestoring, namesNow, namesShipped,
      standsDiffer, want, got,
      sellable: sellable.length, areas: areas.length,
      committed: await booths.countCommitted(),
      customised: await booths.countHandwork(),
      warnings: source.warnings,
    };

    if (!apply) return { ok: true, dryRun: true, ...report };

    if (planNeedsRestoring) {
      const saved = await floorplans.save(shipped, {
        filename: 'LNA27_Floorplan_Web Format_24.svg', actor,
      });
      if (!saved.ok) return { ok: false, ...report, reason: 'could-not-store', detail: saved.reason };
    }

    const out = await booths.importFromArtwork(sellable, { actor, force });
    if (!out.ok) {
      // Refused because the event has real bookings or hand-made work — exactly
      // the intent. The plan is restored either way; the stands are left alone.
      await meta.updateOne({ _id: RAN },
        { $set: { at: new Date(), artworkRestored: planNeedsRestoring, importRefused: out.reason } },
        { upsert: true });
      return { ok: false, ...report, artworkRestored: planNeedsRestoring, importRefused: out.reason, import: out };
    }

    // The plan's own sponsorable areas — its lounges and conference tracks —
    // stored against THIS event. Without this every show was served Europe's.
    let storedAreas = null;
    try { storedAreas = await planAreas.replaceFromArtwork(areas, { actor }); }
    catch (e) { console.error('Seed: areas not stored —', e.message); }

    if (source.unit) await settings.setUnit(source.unit === 'sqft' ? 'ft' : 'm');
    // A palette an admin has chosen for the event outranks the one read off
    // the plan; setPaletteFromArtwork is what knows the difference.
    try { await settings.setPaletteFromArtwork(paletteOf(source.fills)); }
    catch (e) { console.error('Seed: palette not stored —', e.message); }

    // The names are ours now, so they come out of the copy that gets served.
    // The uploaded original keeps them.
    let namesRemoved = 0;
    try {
      const stripped = stripExhibitorNames(shipped, source.printedNames);
      if (stripped.removed && (await floorplans.setDisplaySvg(stripped.svg)).ok) {
        namesRemoved = stripped.removed;
      }
    } catch (e) { console.error('Seed: names not stripped —', e.message); }

    await meta.updateOne({ _id: RAN }, { $set: { at: new Date(), ...out, namesRemoved } }, { upsert: true });
    return { ok: true, ...report, ...out, namesRemoved, storedAreas,
             planRestored: planNeedsRestoring };
  });
}

module.exports = { seedNorthAmerica, SLUG, FILE };
