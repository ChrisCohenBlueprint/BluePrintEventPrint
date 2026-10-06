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
 * Put a plan straight into the live slot, as a revision of its own. Used by
 * the seed that restores a shipped plan; an admin upload goes through
 * createDraft and is made live as a separate step.
 *
 * It used to write the live slot directly and unset its revisionId, which
 * left the revision it replaced still marked live. The next adoption then
 * made a second live one: "Make live again" on the first was refused as
 * already live, going back to a history point on it changed nothing, and
 * names repeated. Now the plan is numbered on in its edition and made live by
 * makeLive like any other, the one it replaces is superseded, and what was
 * live before is handed back so a caller whose next step fails can put it
 * back with restoreLive.
 */
async function save(svg, { filename = 'floorplan.svg', actor = null, showId = config.showId } = {}) {
  const p = prepare(svg);
  if (!p.ok) return p;
  return withPlanLock(showId, async () => {
    // Entered as superseded rather than as a draft: it is not waiting for
    // anyone to read it, and if the caller puts the old plan back it stays
    // listed as a plan that was offered, which is what it is.
    const rev = await insertRevision(p, { filename, actor, showId, status: 'superseded' });
    const made = await makeLive(rev.revisionId, { actor, showId });
    return { ok: true, removed: p.removed, bytes: rev.bytes, version: made.version,
             filename: rev.filename, spec: p.spec, revision: made.revision, previous: made.previous };
  });
}

async function remove(showId = config.showId) {
  return withPlanLock(showId, async () => {
    await adopt(showId);
    const live = await col().findOne({ showId });
    const revisionId = live && live.revisionId;
    const r = await col().deleteOne({ showId });
    // The revision that was live is kept, superseded, so it can be put back.
    if (revisionId) {
      await revisions().updateOne({ showId, revisionId },
        { $set: { status: 'superseded', supersededAt: new Date() } });
    }
    return r.deletedCount === 1;
  });
}

// ─── One change to a plan at a time ───────────────────────────────────────────
/**
 * Run `fn` with this event's plan to itself.
 *
 * Every write here is a read followed by a write — which plan is live, then
 * replace it; the highest name used, then the next — and nothing made the pair
 * atomic. Two adoptions at once made two live revisions; two uploads at once
 * made two drafts both called LNA27.1; two plans made live at once could each
 * import the OTHER's drawing, and the one refused could put the old plan back
 * over the one that succeeded. This runs on one instance by design, so an
 * in-process queue per event is enough; the unique indexes below are the
 * backstop if that ever stops being true.
 *
 * Re-entrant: work already holding an event's lock — making a plan live from
 * inside a publish, adopting from inside an upload — runs straight through
 * rather than waiting on itself. Events never wait on each other.
 */
const { AsyncLocalStorage } = require('async_hooks');
const lockHeld = new AsyncLocalStorage();
const lockTails = new Map();

function withPlanLock(showId, fn) {
  const held = lockHeld.getStore();
  if (held && held.has(showId)) return (async () => fn())();
  const before = lockTails.get(showId) || Promise.resolve();
  let release;
  const mine = new Promise((resolve) => { release = resolve; });
  const tail = before.then(() => mine);
  lockTails.set(showId, tail);
  return before
    .then(() => lockHeld.run(new Set([...(held || []), showId]), fn))
    .finally(() => {
      release();
      if (lockTails.get(showId) === tail) lockTails.delete(showId);
    });
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

/**
 * The two rules every revision write keeps, enforced by the database too: a
 * name is used once per event, and an event has at most one live revision.
 * The lock above is what keeps them; these refuse the write if it ever fails
 * to. A database that already breaks a rule — two live revisions left by the
 * seed before it was fixed — cannot have the index built, and that is
 * reported rather than thrown: it must be visible, and it must not stop the
 * site starting. Adoption repairs the live one as it goes.
 */
const ensureRevisionIndexes = async () => {
  await revisions().createIndex({ revisionId: 1 }, { unique: true, name: 'revision_unique' });
  await revisions().createIndex({ showId: 1, seq: -1 }, { name: 'show_seq' });
  for (const [key, opts] of [
    [{ showId: 1, label: 1 }, { unique: true, name: 'show_label_unique' }],
    [{ showId: 1 }, { unique: true, name: 'show_one_live', partialFilterExpression: { status: 'live' } }],
  ]) {
    try { await revisions().createIndex(key, opts); }
    catch (e) { console.warn(`⚠  floorplan_revisions.${opts.name} not created: ${e.message}`); }
  }
};

const newRevisionId = () => require('crypto').randomBytes(6).toString('hex');

/**
 * The edition a filename names, if any: LEX27_Floorplan.svg → LEX27. Only
 * believed when its letters are this event's own, so LNA's file uploaded to
 * Europe by mistake does not rename Europe's plans.
 *
 * "This event's own" is the id without an edition on the end of it. Compared
 * against the whole id, an event created as LEX26 — the default id, and the
 * shape the new-event form suggests (LNA28) — never matched its own files, so
 * LEX27_….svg was adopted as "LEX26" and each re-issue became "LEX26.1".
 */
function editionFromFilename(filename, showId) {
  const m = /^([A-Za-z]{2,6})[ _-]?(\d{2,4})(?![\d])/.exec(String(filename || ''));
  if (!m) return null;
  const own = String(showId || '').replace(/[ _-]?\d+$/, '');
  if (own.toUpperCase() !== m[1].toUpperCase()) return null;
  return `${m[1].toUpperCase()}${m[2]}`;
}

const labelOf = (edition, point) => (point ? `${edition}.${point}` : edition);

/**
 * The next point in an edition: one past the highest ever used in it, drafts
 * set aside included, so a name is never handed to a second drawing. Only the
 * newest revision used to be asked, and a plan adopted after a discarded draft
 * took that draft's name again.
 */
async function nextPoint(showId, edition) {
  const same = await revisions().find({ showId, edition }).toArray();
  return same.length ? Math.max(...same.map(r => r.point || 0)) + 1 : 0;
}

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
  const first = await col().findOne({ showId });
  if (!first || !first.svg || first.revisionId) return first;
  return withPlanLock(showId, async () => {
    // Read again under the lock: a caller that queued behind another adoption
    // finds the plan already adopted, rather than adopting it a second time.
    const live = await col().findOne({ showId });
    if (!live || !live.svg || live.revisionId) return live;
    const edition = editionFromFilename(live.filename, showId) || String(showId).toUpperCase();
    const last = await revisions().find({ showId }).sort({ seq: -1 }).limit(1).toArray();
    const seq = ((last[0] && last[0].seq) || 0) + 1;
    // A plan restored by the seed lands under an edition that may already have
    // points; continue the count rather than reusing a name.
    const point = await nextPoint(showId, edition);
    // A revision still marked live while the slot names none is not what is
    // live — it is what a plan written straight into the slot left behind —
    // and leaving it so would make two.
    await revisions().updateMany({ showId, status: 'live' },
      { $set: { status: 'superseded', supersededAt: new Date() } });
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
  });
}

/**
 * A prepared drawing, stored as the next revision of this event's plan. The
 * caller holds the plan lock: the name is chosen and written as one step.
 */
async function insertRevision(p, { filename, actor, showId, status }) {
  const live = await adopt(showId);
  const last = await revisions().find({ showId }).sort({ seq: -1 }).limit(1).toArray();
  const prev = last[0] || null;
  const named = editionFromFilename(filename, showId);
  // Continue the live plan's edition unless the file names a different one;
  // an event with nothing live starts at the edition the file names, or its id.
  const base = live && live.revisionId
    ? await revisions().findOne({ showId, revisionId: live.revisionId }) : null;
  const edition = named || (base && base.edition) || (prev && prev.edition) || String(showId).toUpperCase();
  const point = await nextPoint(showId, edition);
  const rev = {
    showId, revisionId: newRevisionId(), seq: ((prev && prev.seq) || 0) + 1,
    edition, point, label: labelOf(edition, point), status,
    svg: p.clean, displaySvg: null,
    filename: String(filename).slice(0, 120), bytes: Buffer.byteLength(p.clean, 'utf8'),
    spec: p.spec, uploadedAt: new Date(), uploadedBy: actor,
  };
  await revisions().insertOne(rev);
  return rev;
}

/**
 * Store an upload as a draft. Any draft already waiting is set aside — kept,
 * marked discarded — because two drafts competing to be "the next plan" is a
 * question nobody should have to answer.
 */
async function createDraft(svg, { filename = 'floorplan.svg', actor = null, showId = config.showId } = {}) {
  const p = prepare(svg);
  if (!p.ok) return p;
  return withPlanLock(showId, async () => {
    await revisions().updateMany({ showId, status: 'draft' },
      { $set: { status: 'discarded', discardedAt: new Date() } });
    const rev = await insertRevision(p, { filename, actor, showId, status: 'draft' });
    return { ok: true, removed: p.removed, spec: p.spec, revision: summary(rev) };
  });
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
  return withPlanLock(showId, async () => {
    const rev = await getRevision(revisionId, { showId });
    if (!rev) return { ok: false, reason: 'no_such_revision' };
    if (rev.status === 'live') return { ok: true, revision: summary(rev), previous: null, unchanged: true };

    // Detached copies: what a driver hands back is not guaranteed to be
    // separate from what the writes below change, and these are what
    // restoreLive puts back if the step after this fails.
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

    // Superseded BEFORE the new one is marked live, so there is never a moment
    // with two — which the database now refuses.
    if (before && before.revisionId) {
      await revisions().updateOne({ showId, revisionId: before.revisionId },
        { $set: { status: 'superseded', supersededAt: now } });
    }
    await revisions().updateOne({ showId, revisionId: rev.revisionId },
      { $set: { status: 'live', publishedAt: now, publishedBy: actor } });
    return { ok: true, revision: summary({ ...rev, status: 'live', publishedAt: now, publishedBy: actor }),
             previous: { live: before || null, revStatus },
             version: doc.version };
  });
}

/**
 * Undo a makeLive whose follow-up failed: the live slot goes back to exactly
 * what it held, and the revisions to the states they were in.
 */
async function restoreLive(revisionId, previous, { showId = config.showId } = {}) {
  if (!previous) return;
  return withPlanLock(showId, async () => {
    const { live, revStatus } = previous;
    // The revision that briefly went live is stood down FIRST, so the one it
    // replaced is never live alongside it.
    await revisions().updateOne({ showId, revisionId },
      { $set: { status: revStatus }, $unset: { publishedAt: '', publishedBy: '' } });
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
  });
}

/** Set a draft aside without making it live. It is kept, marked discarded. */
async function discard(revisionId, { showId = config.showId } = {}) {
  return withPlanLock(showId, async () => {
    const rev = await getRevision(revisionId, { showId });
    if (!rev) return { ok: false, reason: 'no_such_revision' };
    if (rev.status !== 'draft') return { ok: false, reason: 'not_draft' };
    await revisions().updateOne({ showId, revisionId: rev.revisionId },
      { $set: { status: 'discarded', discardedAt: new Date() } });
    return { ok: true };
  });
}

/** The revision in the live slot now, if it has one. */
async function liveRevisionId(showId = config.showId) {
  const live = await col().findOne({ showId });
  return (live && live.revisionId) || null;
}

module.exports = { setDisplaySvg, col, ensureIndexes, get, save, remove, sanitise, MAX_BYTES,
                   revisions, ensureRevisionIndexes, editionFromFilename, adopt, createDraft,
                   getRevision, listRevisions, makeLive, restoreLive, discard, liveRevisionId,
                   withPlanLock };
