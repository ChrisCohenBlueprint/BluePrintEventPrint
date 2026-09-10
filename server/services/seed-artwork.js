/**
 * One-shot: put North America's plan back and rebuild its stands from it.
 *
 * Why this exists rather than an instruction to click through the admin:
 * removing the printed exhibitor names OVERWROTE the stored plan, which was
 * the only copy of those names on the server. The event is now sitting on a
 * plan with none left in it and 99 stands with no exhibitors, and no amount of
 * re-importing can recover what is no longer in the file. The designer's
 * original is shipped in the repo, so the deploy can simply put it back.
 *
 * Guarded three ways:
 *   - a meta flag, so it runs exactly once however many times the app boots;
 *   - booths.importFromArtwork's own refusal on any event with real bookings,
 *     holds, contacts or agreed prices, which is what keeps Europe untouched;
 *   - it only acts on the event it names, and only if that event's stored plan
 *     is actually worse than the shipped one.
 */
const fs = require('fs');
const path = require('path');

const showContext = require('../show-context');
const showsModel = require('../models/shows');
const floorplans = require('../models/floorplans');
const settings = require('../models/settings');
const booths = require('../models/booths');
const { getDb } = require('../db');
const { extractStands, stripExhibitorNames, paletteOf } = require('../lib/extract-stands');

const FLAG = 'seed-artwork-lna-v3';   // v1 refused by the held-stand guard; v2 skipped on the restored plan
const SLUG = 'lna';
const FILE = path.join(__dirname, '..', '..', 'public', 'LNA27_Floorplan_Web-Format_24.svg');

async function seedNorthAmerica() {
  const meta = getDb().collection('meta');
  if (await meta.findOne({ _id: FLAG })) return { skipped: 'already-run' };

  const show = showsModel.list().find(s => s.slug === SLUG);
  if (!show) return { skipped: 'no-such-show' };

  let shipped;
  try { shipped = fs.readFileSync(FILE, 'utf8'); }
  catch (e) { return { skipped: 'no-shipped-file', detail: e.message }; }

  const source = extractStands(shipped);
  if (!source.stands.length) return { skipped: 'shipped-file-unreadable' };

  return showContext.runAs(show.showId, async () => {
    const stored = await floorplans.get();
    const current = stored && stored.svg ? extractStands(stored.svg) : { stands: [] };
    const namesNow = current.stands.filter(s => s.exhibitor).length;
    const namesShipped = source.stands.filter(s => s.exhibitor).length;

    // Lounges and conference tracks are sponsorable space, not sellable stands.
    const sellable = source.stands.filter(s => !s.sponsored);

    // Two separate things can be wrong, and fixing one is not fixing the other.
    // An earlier run of this restored the plan and was then refused the import,
    // so the plan was right while the stands stayed wrong — and because the
    // decision to act was made on the plan alone, every boot afterwards saw a
    // healthy plan and skipped, leaving the stands broken for good.
    const planNeedsRestoring = namesNow < namesShipped;

    const have = await booths.all();
    const standsNeedRebuilding =
      have.length !== sellable.length ||
      (namesShipped > 0 && have.filter(b => b.assignment && b.assignment.company).length === 0);

    if (!planNeedsRestoring && !standsNeedRebuilding) {
      await meta.insertOne({ _id: FLAG, at: new Date(), skipped: 'nothing-to-repair' });
      return { skipped: 'nothing-to-repair', stands: have.length, namesNow };
    }

    if (planNeedsRestoring) {
      const saved = await floorplans.save(shipped, {
        filename: 'LNA27_Floorplan_Web Format_24.svg', actor: 'deploy',
      });
      if (!saved.ok) return { skipped: 'could-not-store', reason: saved.reason };
    }
    const out = await booths.importFromArtwork(sellable, { actor: 'deploy' });
    if (!out.ok) {
      // Refused because the event has real bookings — exactly the intent. The
      // plan is restored either way; the stands are left as they are.
      await meta.insertOne({ _id: FLAG, at: new Date(), artworkRestored: true, importRefused: out.reason });
      return { artworkRestored: true, importRefused: out.reason };
    }

    if (source.unit) await settings.setUnit(source.unit === 'sqft' ? 'ft' : 'm');
    try { await settings.setPalette(paletteOf(source.fills)); }
    catch (e) { console.error('Seed: palette not stored —', e.message); }

    // The names are ours now, so they come out of the copy that gets served.
    // The uploaded original keeps them.
    let namesRemoved = 0;
    try {
      const stripped = stripExhibitorNames(shipped, source.stands.map(s => s.exhibitor).filter(Boolean));
      if (stripped.removed && (await floorplans.setDisplaySvg(stripped.svg)).ok) {
        namesRemoved = stripped.removed;
      }
    } catch (e) { console.error('Seed: names not stripped —', e.message); }

    await meta.insertOne({ _id: FLAG, at: new Date(), ...out, namesRemoved });
    return { ...out, namesRemoved, areasSkipped: source.stands.length - sellable.length,
             planRestored: planNeedsRestoring };
  });
}

module.exports = { seedNorthAmerica };
