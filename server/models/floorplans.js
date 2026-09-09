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

async function save(svg, { filename = 'floorplan.svg', actor = null } = {}) {
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
  await col().updateOne({ showId: config.showId }, { $set: doc }, { upsert: true });
  return { ok: true, removed, bytes: doc.bytes, version: doc.version,
           filename: doc.filename, spec };
}

async function remove(showId = config.showId) {
  const r = await col().deleteOne({ showId });
  return r.deletedCount === 1;
}

module.exports = { col, ensureIndexes, get, save, remove, sanitise, MAX_BYTES };
