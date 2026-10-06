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
 *
 * The markup is read the way a browser reads it, not by what it looks like.
 * The regular expressions this replaced matched the tidy form of each thing
 * and a browser is far more forgiving, so `<rect/onload=…>` (a slash where the
 * space would be), a <script> or <foreignObject> never closed, and
 * `javascr&#105;pt:` all went through untouched — and the admin was told the
 * file was unchanged. Now:
 *
 *  - every "<" is read as the start of a tag, following the HTML tokenizer's
 *    rules for names, quotes and separators. Every one, not only those a
 *    single pass would reach: a browser starts a tag wherever its own context
 *    says so (after a comment that ends at "--!>", after a <style>, before the
 *    <svg> root), and a "<" that is really text only costs a needless check;
 *  - an attribute is judged on its decoded value, with the tabs and newlines a
 *    URL parser ignores taken out;
 *  - an element with no closing tag takes everything after it with it, as a
 *    browser would have made all of that its content;
 *  - removing something can join what was either side of it into something
 *    new, so the result is read again until nothing more is found.
 */
const isWs = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';
const SCRIPT_URL = /(?:java|vb)script:/i;

// Character references, decoded once as the parser decodes an attribute.
// Only the named ones that can spell out a URL scheme or hide a separator are
// needed; the numeric forms cover everything else.
const NAMED_REFS = { colon: ':', tab: '\t', newline: '\n', sol: '/', lpar: '(', rpar: ')',
                     amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: '\u00a0' };
function decodeRefs(v) {
  return v.replace(/&#x([0-9a-f]+);?|&#(\d+);?|&([a-z]+);?/gi, (m, hex, dec, name) => {
    if (name) return NAMED_REFS[name.toLowerCase()] ?? m;
    const cp = parseInt(hex || dec, hex ? 16 : 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '\ufffd';
  });
}

/** Why this attribute has to go, or null. `quoted` says how its value was written. */
function attributeDanger(name, value, quoted) {
  const local = name.slice(name.lastIndexOf(':') + 1);
  if (/^on[a-z]/i.test(local)) return 'inline event handlers';
  // `src=x/onerror=…` is one unquoted value to an HTML parser, but it is
  // written to look like two attributes to anything that splits at the slash.
  // Nothing honest is written that way, so it goes either way.
  if (value && !quoted && /\/on[a-z]+\s*=/i.test(value)) return 'inline event handlers';
  // A whole HTML document in an attribute, run as this page's own origin.
  if (/^srcdoc$/i.test(local)) return 'embedded documents';
  // javascript: anywhere in a value, not just at the start of an href — an
  // <animate values="…"> or <set to="…"> can put one into a link.
  if (value && /[:&]/.test(value) &&
      SCRIPT_URL.test(decodeRefs(value).replace(/[\u0000-\u0020\u007f]/g, ''))) return 'javascript: links';
  return null;
}

// <script> and <foreignObject>, with any namespace prefix: the prefix makes no
// difference to an HTML parser and every difference to an XML one.
const BLOCK = /^(?:[^\s/>]*:)?(script|foreignobject)$/;

/**
 * Everything that has to go from `s`, as [start, end, label] ranges.
 * Returns null if reading it took more work than any real file could need.
 */
function findUnsafe(s) {
  const cuts = [];
  let budget = 64 * s.length + 1e6;

  // Where a tag name that starts at `from` ends. Searches started inside the
  // last answer end at the same place, which keeps a run of "<a<a<a…" linear.
  let nameFrom = -1, nameTo = -1;
  const nameEnd = (from) => {
    if (from >= nameFrom && from <= nameTo) return nameTo;
    let i = from;
    while (i < s.length && !isWs(s[i]) && s[i] !== '/' && s[i] !== '>') i++;
    budget -= i - from;
    nameFrom = from; nameTo = i;
    return i;
  };

  // Two tags read from different "<" that reach the same point between
  // attributes read identically from there on. Remember where each read went,
  // so the second stops at once. A typed array rather than a Map, so a file of
  // a few million tiny attributes costs four bytes a character, not a Map
  // entry each: the tag's end + 1, negative if it closed itself, 0 if unread.
  const settled = new Int32Array(s.length + 1);

  /** Read the attributes from `i` to the end of the tag, flagging as it goes. */
  function readAttributes(i) {
    const visited = [];
    let result = null;
    while (!result) {
      while (i < s.length && isWs(s[i])) i++;
      if (i >= s.length) { result = { end: s.length, selfClosing: false }; break; }
      const known = settled[i];
      if (known) { result = { end: Math.abs(known) - 1, selfClosing: known < 0 }; break; }
      visited.push(i);
      if (--budget < 0) return null;
      const c = s[i];
      if (c === '>') { result = { end: i + 1, selfClosing: false }; break; }
      if (c === '/') {
        if (s[i + 1] === '>') { result = { end: i + 2, selfClosing: true }; break; }
        i++;                     // a stray slash separates attributes, as a space does
        continue;
      }
      // The attribute's name: its first character whatever it is (even "="),
      // then up to a separator or "=".
      const start = i++;
      while (i < s.length && !isWs(s[i]) && s[i] !== '/' && s[i] !== '>' && s[i] !== '=') i++;
      const name = s.slice(start, i);
      let end = i, value = null, j = i, quoted = false;
      while (j < s.length && isWs(s[j])) j++;
      if (s[j] === '=') {
        j++;
        while (j < s.length && isWs(s[j])) j++;
        const q = s[j];
        if (q === '"' || q === "'") {
          quoted = true;
          const close = s.indexOf(q, j + 1);
          value = s.slice(j + 1, close === -1 ? s.length : close);
          j = close === -1 ? s.length : close + 1;
        } else if (q !== '>') {
          const from = j;
          while (j < s.length && !isWs(s[j]) && s[j] !== '>') j++;
          value = s.slice(from, j);
        }
        end = i = j;
      }
      budget -= end - start;
      const why = attributeDanger(name, value, quoted);
      if (why) cuts.push([start, end, why]);
    }
    const mark = (result.end + 1) * (result.selfClosing ? -1 : 1);
    for (const v of visited) settled[v] = mark;
    return result;
  }

  // Where the first closing tag for a block, from `from` on, ends — or the end
  // of the file if there is none. Remembered per element, so a file of
  // unclosed <script>s is not searched to its end once for each.
  const closes = {};
  const closeAfter = (local, from) => {
    const c = closes[local];
    if (c && from >= c.from && (c.at === -1 || from <= c.at)) return c.end;
    const re = new RegExp(`</(?:[^\\s/>]*:)?${local}(?=[\\s/>]|$)`, 'ig');
    re.lastIndex = from;
    const m = re.exec(s);
    budget -= (m ? m.index : s.length) - from;
    let end = s.length;
    if (m) {
      const tail = readAttributes(m.index + m[0].length);
      end = tail ? tail.end : s.length;
    }
    closes[local] = { from, at: m ? m.index : -1, end };
    return end;
  };

  for (let at = s.indexOf('<'); at !== -1; at = s.indexOf('<', at + 1)) {
    if (budget < 0) return null;
    let i = at + 1;
    const closing = s[i] === '/';
    if (closing) i++;
    // A tag name starts with a letter for HTML; XML also allows "_", ":" and
    // anything beyond ASCII. Either is read.
    if (!/[A-Za-z_:\u0080-\uffff]/.test(s[i] || '')) continue;
    const nEnd = nameEnd(i);
    // Only the last characters of a long name can make it a block element.
    const name = s.slice(Math.max(i, nEnd - 14), nEnd).toLowerCase();
    const block = (nEnd - i <= 14 ? name : `:${name.split(':').pop()}`).match(BLOCK);
    const tag = readAttributes(nEnd);
    if (!tag) return null;
    if (closing || !block) continue;
    const label = block[1] === 'script' ? 'script blocks' : 'foreignObject';
    const end = tag.selfClosing ? tag.end : closeAfter(block[1], tag.end);
    if (end === null) return null;
    cuts.push([at, end, label]);
  }

  // XML can declare an entity whose text is markup or a javascript: link and
  // use it anywhere — <!ENTITY x "&#60;script…"> then &x; — and a standalone
  // SVG is parsed as XML. Illustrator declares harmless ones (namespace URLs),
  // so only those carrying markup or a script link go.
  const entity = /<!ENTITY\b(?:[^>"']|"[^"]*"|'[^']*')*>?/gi;
  for (let m; (m = entity.exec(s));) {
    const text = decodeRefs(m[0].slice(2)).replace(/[\u0000-\u0020\u007f]/g, '');
    if (text.includes('<') || SCRIPT_URL.test(text)) cuts.push([m.index, m.index + m[0].length, 'entity declarations']);
  }
  // An XML stylesheet instruction can name an XSLT transform, which writes a
  // new document — scripts and all — when the SVG is opened on its own.
  // Illustrator never writes one.
  const pi = /<\?xml-stylesheet\b[\s\S]*?(?:\?>|$)/gi;
  for (let m; (m = pi.exec(s));) cuts.push([m.index, m.index + m[0].length, 'stylesheet instructions']);
  return cuts;
}

function sanitise(svg) {
  const removed = new Set();
  let out = String(svg);

  // Each pass removes something, so the file shrinks every time round; a real
  // export needs one pass, or two. A file still producing new things to remove
  // after ten has been built to, and is made inert outright.
  for (let pass = 0; ; pass++) {
    const cuts = findUnsafe(out);
    if (cuts && !cuts.length) break;
    if (!cuts || pass === 10) {
      out = out.replace(/</g, '&lt;');
      removed.add('all markup (the file could not be read safely)');
      break;
    }
    cuts.sort((a, b) => a[0] - b[0]);
    let next = '', pos = 0;
    for (const [start, end, label] of cuts) {
      removed.add(label);
      if (end <= pos) continue;                      // inside a range already cut
      let from = Math.max(start, pos);
      // An attribute goes with the space before it, so a tidy file stays tidy.
      if (from === start) while (from > pos && isWs(out[from - 1])) from--;
      next += out.slice(pos, from);
      pos = end;
    }
    out = next + out.slice(pos);
  }

  return { svg: out, removed: [...removed] };
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
