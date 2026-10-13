/**
 * What a re-issued plan changes, stand by stand, BEFORE anything is written.
 *
 * A hall gets extended, a row gets redrawn, a designer sends "v03" — and the
 * organiser needs to know what that drawing does to an event that is already
 * selling: which stands are new, which have moved, and above all which sold
 * stands the drawing has quietly dropped. That is not something to discover
 * after an import; it is what the preview shows so the import can be judged.
 *
 * Matching is by stand NUMBER, which is the stand's identity everywhere else in
 * the app. A renumbered plan therefore reads as "removed" plus "added" — which
 * is the honest answer, and why the designer brief asks for numbers to be kept
 * stable between revisions. The one exception is a stand renumbered HERE: a
 * drawing that prints the number it shows is drawing that stand.
 */

// Drawing units. A stand that has shifted by less than this has not moved in
// any sense a person would notice, and an export can jitter by that much.
const TOL = 1;

const near = (a, b) => Math.abs((a || 0) - (b || 0)) < TOL;
const sameBox = (g, h) => !!(g && h) && near(g.x, h.x) && near(g.y, h.y) && near(g.w, h.w) && near(g.h, h.h);
const sameSize = (g, h) => !!(g && h) && near(g.w, h.w) && near(g.h, h.h);

/**
 * @param fromPlan  stands as extractStands() returns them (number, geometry, area, status)
 * @param existing  this event's stored stands (boothNumber, geometry, sqm, status, assignment)
 */
function diffStands(fromPlan, existing) {
  const plan = new Map((fromPlan || []).map(s => [String(s.number), s]));
  const have = new Map((existing || []).map(b => [String(b.boothNumber), b]));
  // Numbers that live on inside a merged block. A drawing that still prints
  // 103 after 102 and 103 were merged is not adding a stand: the update keeps
  // the block whole and leaves 103 inside it (importFromArtwork's `absorbed`),
  // so calling it "new" promised a stand the import would never create.
  const inside = new Map();
  for (const b of existing || []) {
    for (const n of b.mergedFrom || []) inside.set(String(n), String(b.boothNumber));
  }
  // A stand renumbered here is drawn under the number it shows; the update
  // reads that drawn number as the stand (importFromArtwork's `renumbered`).
  const key = (v) => String(v == null ? '' : v).trim().toLowerCase();
  const shown = new Map();
  for (const b of existing || []) {
    if (b.displayNumber && b.displayNumber !== b.boothNumber && !plan.has(String(b.boothNumber))) {
      shown.set(key(b.displayNumber), String(b.boothNumber));
    }
  }

  const added = [], absorbed = [], renumbered = [], moved = [], resized = [], unchanged = [], missing = [];

  for (const [n, s] of plan) {
    const b = have.get(n);
    if (!b && inside.has(n)) { absorbed.push({ boothNumber: n, into: inside.get(n) }); continue; }
    if (!b && shown.has(key(n))) {
      renumbered.push({ boothNumber: n, stand: shown.get(key(n)) });
      shown.delete(key(n));
      continue;
    }
    if (!b) { added.push({ boothNumber: n, area: s.area ?? null, status: s.status || 'available' }); continue; }
    const row = { boothNumber: n, status: b.status, company: (b.assignment && b.assignment.company) || null };
    if (sameBox(s.geometry, b.geometry)) {
      unchanged.push(row);
    } else if (sameSize(s.geometry, b.geometry)) {
      moved.push(row);
    } else {
      resized.push({ ...row, from: b.sqm ?? null, to: s.area ?? null });
    }
  }

  const drawnAs = new Set(renumbered.map(r => r.stand));
  for (const [n, b] of have) {
    if (plan.has(n) || drawnAs.has(n)) continue;
    missing.push({ boothNumber: n, status: b.status,
                   company: (b.assignment && b.assignment.company) || null,
                   // What an update would do with it — see importFromArtwork's `keep`.
                   committed: b.status === 'sold' || b.status === 'held' ||
                              !!(b.assignment && (b.assignment.company || b.assignment.actualPrice)) });
  }

  const committedMissing = missing.filter(m => m.committed);
  return {
    added, absorbed, renumbered, moved, resized, unchanged, missing,
    // The one line the admin needs before deciding anything.
    summary: {
      added: added.length, absorbed: absorbed.length, renumbered: renumbered.length, moved: moved.length, resized: resized.length,
      unchanged: unchanged.length, missing: missing.length,
      committedMissing: committedMissing.length,
    },
  };
}

module.exports = { diffStands };
