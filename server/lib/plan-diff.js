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
 * stable between revisions.
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

  const added = [], moved = [], resized = [], unchanged = [], missing = [];

  for (const [n, s] of plan) {
    const b = have.get(n);
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

  for (const [n, b] of have) {
    if (plan.has(n)) continue;
    missing.push({ boothNumber: n, status: b.status,
                   company: (b.assignment && b.assignment.company) || null,
                   // What an update would do with it — see importFromArtwork's `keep`.
                   committed: b.status === 'sold' || b.status === 'held' ||
                              !!(b.assignment && (b.assignment.company || b.assignment.actualPrice)) });
  }

  const committedMissing = missing.filter(m => m.committed);
  return {
    added, moved, resized, unchanged, missing,
    // The one line the admin needs before deciding anything.
    summary: {
      added: added.length, moved: moved.length, resized: resized.length,
      unchanged: unchanged.length, missing: missing.length,
      committedMissing: committedMissing.length,
    },
  };
}

module.exports = { diffStands };
