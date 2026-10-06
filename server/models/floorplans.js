const { getDb } = require('../db');
const config = require('../config');

/**
 * The floorplan artwork for each show.
 *
 * Stored in the database rather than on disk because Render's filesystem is
 * wiped on every deploy — an uploaded plan written to disk would vanish at the
 * next push. An SVG here is 0.5–2 MB against Mongo's 16 MB document limit, so
 * it fits comfortably.
 *
 * A show with nothing uploaded falls back to the file shipped in the repo, so
 * the event already running keeps its artwork with no migration.
 */
const col = () => getDb().collection('floorplans');

const ensureIndexes = () =>
  col().createIndex({ showId: 1 }, { unique: true, name: 'show_unique' });

// Generous next to a 2 MB plan, and far below the document limit.
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Make an uploaded SVG safe to inline into a page.
 *
 * This matters more than it looks. The artwork is injected with innerHTML on
 * the PUBLIC floorplan, so anything executable inside it runs for every
 * visitor. innerHTML does not run <script> tags, but it very much honours
 * `onload=` and friends, and a designer's export can carry them innocently.
 *
 * Stripped rather than rejected: a plan that fails to upload the day before a
 * show, with no explanation an organiser can act on, is worse than a plan with
 * its interactivity removed. What is removed is reported back so the upload is
 * not silently altered.
 */
function sanitise(svg) {
  const removed = [];
  let out = String(svg);

  const drop = (re, label) => {
    const before = out;
    out = out.replace(re, '');
    if (out !== before) removed.push(label);
  };

  drop(/<script\b[\s\S]*?<\/script\s*>/gi, 'script blocks');
  drop(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, 'foreignObject');
  // Inline handlers: on… attributes in either quoting style, or unquoted.
  drop(/\son[a-z]+\s*=\s*"[^"]*"/gi, 'inline event handlers');
  drop(/\son[a-z]+\s*=\s*'[^']*'/gi, 'inline event handlers');
  drop(/\son[a-z]+\s*=\s*[^\s>]+/gi, 'inline event handlers');
  // javascript: in href/xlink:href.
  drop(/(?:xlink:)?href\s*=\s*"\s*javascript:[^"]*"/gi, 'javascript: links');
  drop(/(?:xlink:)?href\s*=\s*'\s*javascript:[^']*'/gi, 'javascript: links');

  return { svg: out, removed: [...new Set(removed)] };
}

/** The stored artwork for the current show, or null to use the shipped file. */
async function get(showId = config.showId) {
  return col().findOne({ showId });
}

/**
 * Record the version of the artwork to SHOW, leaving the uploaded original
 * untouched.
 *
 * The names printed inside stands are removed for display once we hold them
 * ourselves. Overwriting the stored plan to do that destroyed the only copy of
 * those names: a second import then read a plan with no names left in it and
 * produced 99 stands with no exhibitors, silently, with no way back short of
 * re-uploading the file. The original is what every extraction reads; this is
 * only what gets served.
 */
async function setDisplaySvg(svg, { showId = config.showId } = {}) {
  const text = String(svg || '');
  if (!text.trim()) return { ok: false, reason: 'empty' };
  await col().updateOne({ showId }, { $set: {
    displaySvg: text,
    displayBytes: Buffer.byteLength(text, 'utf8'),
    version: Date.now().toString(36),   // so browsers fetch the new one
  } });
  // The revision this is a display copy OF keeps it too, so making that
  // revision live again later does not bring every printed name back.
  const live = await col().findOne({ showId });
  if (live && live.revisionId) {
    await revisions().updateOne({ showId, revisionId: live.revisionId },
      { $set: { displaySvg: text } });
  }
  return { ok: true, bytes: Buffer.byteLength(text, 'utf8') };
}

/**
 * Everything an upload has to pass before it is stored anywhere — live or as a
 * draft — and the artwork report that goes with it.
 */
function prepare(svg) {
  const text = String(svg || '');
  if (!text.trim()) return { ok: false, reason: 'empty' };
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) return { ok: false, reason: 'too_large' };
  // A cheap sanity check before anything is stored: this must be an SVG, not a
  // PDF or a PNG someone renamed.
  if (!/<svg[\s>]/i.test(text)) return { ok: false, reason: 'not_svg' };

  const { svg: clean, removed } = sanitise(text);

  // Checked against the artwork spec and RECORDED, never enforced. The plan
  // running Europe scores 3/8 against this spec, so refusing a file that fails
  // would refuse a live show's own artwork. What the report is for is telling a
  // designer, in clause numbers, exactly what to correct.
  let spec = null;
  try {
    const { validate, SPEC } = require('../lib/artwork-spec');
    const r = validate(clean);
    spec = { spec: SPEC, passed: r.passed, total: r.total,
             failedClauses: r.failedClauses, results: r.results };
  } catch (e) {
    console.error('Artwork validation failed to run:', e.message);
  }
  return { ok: true, clean, removed, spec };
}

/**
 * Write a plan straight to the live slot, with no revision. Used by the seed
 * that restores a shipped plan; an admin upload goes through createDraft.
 */
async function save(svg, { filename = 'floorplan.svg', actor = null } = {}) {
  const p = prepare(svg);
  if (!p.ok) return p;
  const { clean, removed, spec } = p;

  const doc = {
    showId: config.showId,
    svg: clean,
    filename: String(filename).slice(0, 120),
    bytes: Buffer.byteLength(clean, 'utf8'),
    // Changes on every upload, so the browser fetches the new plan rather than
    // the one it cached — the artwork is served with a long cache life.
    version: Date.now().toString(36),
    uploadedAt: new Date(),
    uploadedBy: actor,
    spec,
  };
  await col().updateOne({ showId: config.showId },
    { $set: doc, $unset: { displaySvg: '', displayBytes: '', revisionId: '', label: '' } }, { upsert: true });
  return { ok: true, removed, bytes: doc.bytes, version: doc.version,
           filename: doc.filename, spec };
}

async function remove(showId = config.showId) {
  await adopt(showId);
  const live = await col().findOne({ showId });
  const r = await col().deleteOne({ showId });
  // The revision that was live is kept, superseded, so it can be put back.
  if (live && live.revisionId) {
    await revisions().updateOne({ showId, revisionId: live.revisionId },
      { $set: { status: 'superseded', supersededAt: new Date() } });
  }
  return r.deletedCount === 1;
}

// ─── Revisions ────────────────────────────────────────────────────────────────
/**
 * Every plan an event has been given, kept, under an id and a name.
 *
 * The live slot above held exactly one plan and every upload overwrote it: the
 * moment a re-issued drawing went up, the one it replaced was gone, and it went
 * up straight onto the public page — before anyone had read what it did to
 * the stands under it.
 *
 * So an upload now lands as a DRAFT revision. The public page carries on
 * showing the live plan; the admin reads the draft against the event's stands,
 * and only making it live copies it into the live slot. Nothing about the
 * public link changes — /floorplan/lex always shows whichever revision is live.
 *
 * Revisions are named the way the office already names a plan: the first is
 * the edition (LEX27), each re-issue adds a point (LEX27.1, LEX27.2). The
 * edition is read from the file's name when it carries one, else carried over
 * from the plan it replaces.
 *
 * The live slot stays the thing every reader reads — the public page, the
 * footprint cache, the palette — so none of them needed to learn about any of
 * this.
 */
const revisions = () => getDb().collection('floorplan_revisions');

const ensureRevisionIndexes = async () => {
  await revisions().createIndex({ revisionId: 1 }, { unique: true, name: 'revision_unique' });
  await revisions().createIndex({ showId: 1, seq: -1 }, { name: 'show_seq' });
};

const newRevisionId = () => require('crypto').randomBytes(6).toString('hex');

/**
 * The edition a filename names, if any: LEX27_Floorplan.svg → LEX27. Only
 * believed when it starts with this event's own id, so LNA's file uploaded to
 * Europe by mistake does not rename Europe's plans.
 */
function editionFromFilename(filename, showId) {
  const m = /^([A-Za-z]{2,6})[ _-]?(\d{2,4})(?![\d])/.exec(String(filename || ''));
  if (!m) return null;
  if (String(showId).toUpperCase() !== m[1].toUpperCase()) return null;
  return `${m[1].toUpperCase()}${m[2]}`;
}

const labelOf = (edition, point) => (point ? `${edition}.${point}` : edition);

/** Without the drawing itself: listings never need the bytes. */
const summary = (r) => r && ({
  revisionId: r.revisionId, label: r.label, edition: r.edition, point: r.point, seq: r.seq,
  status: r.status, filename: r.filename, bytes: r.bytes,
  uploadedAt: r.uploadedAt, uploadedBy: r.uploadedBy,
  publishedAt: r.publishedAt || null, publishedBy: r.publishedBy || null,
  spec: r.spec ? { passed: r.spec.passed, total: r.spec.total, failedClauses: r.spec.failedClauses } : null,
});

/**
 * Give a plan uploaded before revisions existed a revision of its own, so the
 * first re-issue has something to be ".1" of, and something to go back to.
 * Idempotent: a live plan that already has a revision is left alone.
 */
async function adopt(showId = config.showId) {
  const live = await col().findOne({ showId });
  if (!live || !live.svg || live.revisionId) return live;
  const edition = editionFromFilename(live.filename, showId) || String(showId).toUpperCase();
  const last = await revisions().find({ showId }).sort({ seq: -1 }).limit(1).toArray();
  const seq = ((last[0] && last[0].seq) || 0) + 1;
  // A plan restored by the seed lands under an edition that may already have
  // points; continue the count rather than reusing a name.
  const point = last[0] && last[0].edition === edition ? (last[0].point || 0) + 1 : 0;
  const rev = {
    showId, revisionId: newRevisionId(), seq, edition, point, label: labelOf(edition, point),
    status: 'live', svg: live.svg, displaySvg: live.displaySvg || null,
    filename: live.filename, bytes: live.bytes, spec: live.spec || null,
    uploadedAt: live.uploadedAt || new Date(), uploadedBy: live.uploadedBy || null,
    publishedAt: live.uploadedAt || new Date(), publishedBy: live.uploadedBy || null,
    adopted: true,
  };
  await revisions().insertOne(rev);
  await col().updateOne({ showId }, { $set: { revisionId: rev.revisionId, label: rev.label } });
  return { ...live, revisionId: rev.revisionId, label: rev.label };
}

/**
 * Store an upload as a draft. Any draft already waiting is set aside — kept,
 * marked discarded — because two drafts competing to be "the next plan" is a
 * question nobody should have to answer.
 */
async function createDraft(svg, { filename = 'floorplan.svg', actor = null, showId = config.showId } = {}) {
  const p = prepare(svg);
  if (!p.ok) return p;
  const live = await adopt(showId);

  const last = await revisions().find({ showId }).sort({ seq: -1 }).limit(1).toArray();
  const prev = last[0] || null;
  const named = editionFromFilename(filename, showId);
  // Continue the live plan's edition unless the file names a different one;
  // an event with nothing live starts at the edition the file names, or its id.
  const base = live && live.revisionId
    ? await revisions().findOne({ showId, revisionId: live.revisionId }) : null;
  const edition = named || (base && base.edition) || (prev && prev.edition) || String(showId).toUpperCase();
  // The point counts on from the highest point used in this edition, so a
  // discarded draft's name is never handed to a different drawing.
  const sameEdition = await revisions().find({ showId, edition }).toArray();
  const point = sameEdition.length ? Math.max(...sameEdition.map(r => r.point || 0)) + 1 : 0;

  await revisions().updateMany({ showId, status: 'draft' },
    { $set: { status: 'discarded', discardedAt: new Date() } });

  const rev = {
    showId, revisionId: newRevisionId(), seq: ((prev && prev.seq) || 0) + 1,
    edition, point, label: labelOf(edition, point), status: 'draft',
    svg: p.clean, displaySvg: null,
    filename: String(filename).slice(0, 120), bytes: Buffer.byteLength(p.clean, 'utf8'),
    spec: p.spec, uploadedAt: new Date(), uploadedBy: actor,
  };
  await revisions().insertOne(rev);
  return { ok: true, removed: p.removed, spec: p.spec, revision: summary(rev) };
}

/** One revision, drawing included. Scoped to the event unless asked otherwise. */
async function getRevision(revisionId, { showId = config.showId, anyShow = false } = {}) {
  const filter = anyShow ? { revisionId: String(revisionId) } : { showId, revisionId: String(revisionId) };
  return revisions().findOne(filter);
}

/** Newest first, without the drawings. */
async function listRevisions({ showId = config.showId, limit = 50 } = {}) {
  await adopt(showId);
  const rows = await revisions().find({ showId }).sort({ seq: -1 }).limit(limit).toArray();
  return rows.map(summary);
}

/**
 * Put a revision in the live slot. The one it replaces is kept, superseded.
 *
 * Returns what was live before, so a caller whose next step fails (the stand
 * import refusing) can put it straight back with restoreLive.
 */
async function makeLive(revisionId, { actor = null, showId = config.showId } = {}) {
  const rev = await getRevision(revisionId, { showId });
  if (!rev) return { ok: false, reason: 'no_such_revision' };
  if (rev.status === 'live') return { ok: true, revision: summary(rev), previous: null, unchanged: true };

  // Detached copies: what a driver hands back is not guaranteed to be
  // separate from what the writes below change, and these are what restoreLive
  // puts back if the step after this fails.
  const before = structuredClone(await adopt(showId));
  const revStatus = rev.status;
  const now = new Date();
  const doc = {
    showId, svg: rev.svg, filename: rev.filename, bytes: rev.bytes,
    version: Date.now().toString(36), uploadedAt: rev.uploadedAt, uploadedBy: rev.uploadedBy,
    spec: rev.spec || null, revisionId: rev.revisionId, label: rev.label,
  };
  const set = rev.displaySvg
    ? { $set: { ...doc, displaySvg: rev.displaySvg, displayBytes: Buffer.byteLength(rev.displaySvg, 'utf8') } }
    : { $set: doc, $unset: { displaySvg: '', displayBytes: '' } };
  await col().updateOne({ showId }, set, { upsert: true });

  if (before && before.revisionId) {
    await revisions().updateOne({ showId, revisionId: before.revisionId },
      { $set: { status: 'superseded', supersededAt: now } });
  }
  await revisions().updateOne({ showId, revisionId: rev.revisionId },
    { $set: { status: 'live', publishedAt: now, publishedBy: actor } });
  return { ok: true, revision: summary({ ...rev, status: 'live', publishedAt: now, publishedBy: actor }),
           previous: { live: before || null, revStatus },
           version: doc.version };
}

/**
 * Undo a makeLive whose follow-up failed: the live slot goes back to exactly
 * what it held, and the revisions to the states they were in.
 */
async function restoreLive(revisionId, previous, { showId = config.showId } = {}) {
  if (!previous) return;
  const { live, revStatus } = previous;
  if (live) {
    const { _id, ...doc } = live;
    // Fields the restored plan did not have must not survive from the one
    // that briefly replaced it — a display copy above all.
    const $unset = {};
    for (const k of ['displaySvg', 'displayBytes', 'revisionId', 'label']) if (!(k in doc)) $unset[k] = '';
    await col().updateOne({ showId }, Object.keys($unset).length ? { $set: doc, $unset } : { $set: doc },
                          { upsert: true });
    if (live.revisionId) {
      await revisions().updateOne({ showId, revisionId: live.revisionId },
        { $set: { status: 'live' }, $unset: { supersededAt: '' } });
    }
  } else {
    await col().deleteOne({ showId });
  }
  await revisions().updateOne({ showId, revisionId },
    { $set: { status: revStatus }, $unset: { publishedAt: '', publishedBy: '' } });
}

/** Set a draft aside without making it live. It is kept, marked discarded. */
async function discard(revisionId, { showId = config.showId } = {}) {
  const rev = await getRevision(revisionId, { showId });
  if (!rev) return { ok: false, reason: 'no_such_revision' };
  if (rev.status !== 'draft') return { ok: false, reason: 'not_draft' };
  await revisions().updateOne({ showId, revisionId: rev.revisionId },
    { $set: { status: 'discarded', discardedAt: new Date() } });
  return { ok: true };
}

/** The revision in the live slot now, if it has one. */
async function liveRevisionId(showId = config.showId) {
  const live = await col().findOne({ showId });
  return (live && live.revisionId) || null;
}

module.exports = { setDisplaySvg, col, ensureIndexes, get, save, remove, sanitise, MAX_BYTES,
                   revisions, ensureRevisionIndexes, editionFromFilename, adopt, createDraft,
                   getRevision, listRevisions, makeLive, restoreLive, discard, liveRevisionId };
