/**
 * Enough of MongoDB to test the guards honestly.
 *
 * The previous stand-in answered every countDocuments with a number the test
 * had chosen in advance, which meant a test could assert that an import is
 * refused when the count is 19 — and pass just as happily with a filter that
 * matched nothing at all. The bug that cost paying exhibitors was precisely a
 * filter that no longer matched what it was meant to, so the filter has to be
 * the thing under test.
 *
 * So this applies the real filter to real documents. It supports only what the
 * models actually use — equality on dotted paths, $in/$nin/$ne/$exists/$type,
 * and $and/$or/$nor — and throws on anything else rather than quietly treating
 * an operator it does not know as a match.
 */

const getPath = (doc, path) => path.split('.').reduce(
  (o, k) => (o == null ? undefined : (Array.isArray(o) && /^\d+$/.test(k) ? o[Number(k)] : o[k])), doc);

function matchesOp(value, op, expected, cond) {
  switch (op) {
    // $options is not a test of its own — it is $regex's flags, and arrives as
    // a sibling key in the same condition object.
    case '$options': return true;
    case '$regex': {
      const flags = (cond && typeof cond.$options === 'string') ? cond.$options : '';
      return new RegExp(expected, flags).test(String(value == null ? '' : value));
    }
    case '$in':  return expected.some(e => eq(value, e));
    case '$nin': return !expected.some(e => eq(value, e));
    case '$ne':  return !eq(value, expected);
    case '$eq':  return eq(value, expected);
    case '$exists': return (value !== undefined) === !!expected;
    case '$type': return expected === 'string' ? typeof value === 'string' : typeof value === expected;
    case '$lte': return value instanceof Date && expected instanceof Date ? value <= expected : value <= expected;
    case '$gt':  return value instanceof Date && expected instanceof Date ? value > expected : value > expected;
    default: throw new Error(`fake-mongo: unsupported operator ${op}`);
  }
}

const eq = (a, b) => {
  if (a === b) return true;
  if (a == null && b == null) return true;             // null and undefined match, as Mongo does
  if (Array.isArray(a)) return a.some(v => v === b);   // a scalar matches any element
  return false;
};

function matches(doc, filter) {
  for (const [key, cond] of Object.entries(filter || {})) {
    if (key === '$and') { if (!cond.every(c => matches(doc, c))) return false; continue; }
    if (key === '$or')  { if (!cond.some(c => matches(doc, c))) return false; continue; }
    if (key === '$nor') { if (cond.some(c => matches(doc, c))) return false; continue; }
    const value = getPath(doc, key);
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)
        && Object.keys(cond).some(k => k.startsWith('$'))) {
      for (const [op, expected] of Object.entries(cond)) {
        if (!matchesOp(value, op, expected, cond)) return false;
      }
      continue;
    }
    if (!eq(value, cond)) return false;
  }
  return true;
}

/** $set (dotted paths included), $unset, $setOnInsert, $inc, $pull. */
function applyUpdate(doc, update, { inserting = false } = {}) {
  const set = (path, v) => {
    const parts = path.split('.');
    let o = doc;
    for (const k of parts.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
    o[parts[parts.length - 1]] = v;
  };
  for (const [path, v] of Object.entries(update.$set || {})) set(path, v);
  if (inserting) for (const [path, v] of Object.entries(update.$setOnInsert || {})) set(path, v);
  for (const path of Object.keys(update.$unset || {})) {
    const parts = path.split('.');
    let o = doc;
    for (const k of parts.slice(0, -1)) { if (o == null) break; o = o[k]; }
    if (o) delete o[parts[parts.length - 1]];
  }
  for (const [path, v] of Object.entries(update.$inc || {})) set(path, (getPath(doc, path) || 0) + v);
  return doc;
}

function project(doc, spec) {
  if (!spec) return doc;
  const keys = Object.keys(spec).filter(k => k !== '_id');
  const excluding = keys.length && keys.every(k => !spec[k]);
  if (excluding) { const out = { ...doc }; for (const k of keys) delete out[k]; return out; }
  const out = {};
  for (const k of keys) if (getPath(doc, k) !== undefined) out[k] = getPath(doc, k);
  if (doc._id !== undefined && spec._id !== 0) out._id = doc._id;
  return out;
}

/**
 * Enough of the aggregation pipeline for booths.stats().
 *
 * Only what that one pipeline uses: a `$match`, then a `$group` on a null id
 * whose every accumulator is a `$sum` — of a field path, of the literal 1, or
 * of a `$cond` that counts or adds a field when a status matches. Anything else
 * throws, for the same reason the query matcher does: a stand-in that quietly
 * returns nothing for an expression it does not understand lets a broken
 * aggregate pass as an empty hall.
 *
 * It exists because the headline totals — the hall's area, its revenue, how
 * much is still for sale — are computed ONLY here. Without it nothing could
 * check that a stand taken off the plan leaves them, or that merging and
 * splitting leave them alone.
 */
function evalExpr(doc, expr) {
  if (typeof expr === 'number' || typeof expr === 'boolean' || expr === null) return expr;
  if (typeof expr === 'string') return expr.startsWith('$') ? getPath(doc, expr.slice(1)) : expr;
  if (expr && typeof expr === 'object') {
    if (expr.$cond) {
      const [test, yes, no] = expr.$cond;
      return evalExpr(doc, test) ? evalExpr(doc, yes) : evalExpr(doc, no);
    }
    if (expr.$eq) return evalExpr(doc, expr.$eq[0]) === evalExpr(doc, expr.$eq[1]);
    if (expr.$ne) return evalExpr(doc, expr.$ne[0]) !== evalExpr(doc, expr.$ne[1]);
  }
  throw new Error(`fake-mongo: unsupported aggregation expression ${JSON.stringify(expr)}`);
}

function aggregate(docs, pipeline) {
  let rows = docs;
  for (const stage of pipeline || []) {
    const [op] = Object.keys(stage);
    if (op === '$match') { rows = rows.filter(d => matches(d, stage.$match)); continue; }
    if (op === '$group') {
      const spec = stage.$group;
      if (spec._id !== null) throw new Error('fake-mongo: only $group on a null _id is supported');
      const out = { _id: null };
      for (const [field, acc] of Object.entries(spec)) {
        if (field === '_id') continue;
        if (!acc || acc.$sum === undefined) throw new Error(`fake-mongo: unsupported accumulator ${JSON.stringify(acc)}`);
        out[field] = rows.reduce((sum, d) => sum + (Number(evalExpr(d, acc.$sum)) || 0), 0);
      }
      rows = rows.length ? [out] : [];
      continue;
    }
    throw new Error(`fake-mongo: unsupported aggregation stage ${op}`);
  }
  return rows;
}

/**
 * `calls` records every operation with its filter, so a test can still assert
 * on ordering — that the snapshot happens before the delete, say.
 */
function fakeDb(initial = {}) {
  const store = {};
  const calls = [];
  let ids = 0;
  const docsIn = (name) => (store[name] = store[name] || []);
  for (const [name, rows] of Object.entries(initial)) {
    store[name] = rows.map(r => ({ _id: ++ids, ...r }));
  }

  const collection = (name) => {
    const docs = () => docsIn(name);
    const find = (filter = {}) => {
      let spec = null, order = null, cap = null;
      const cursor = {
        project: (s) => { spec = s; return cursor; },
        // sort and limit used to be accepted and ignored. Anything that reads
        // "the newest N" — the plan's history, the list of snapshots — then
        // came back in insertion order and uncapped, so a test could assert on
        // an ordering the real database would not have produced. They are the
        // whole meaning of those queries, so they are applied.
        sort: (o) => { order = o; return cursor; },
        limit: (n) => { cap = n; return cursor; },
        toArray: async () => {
          let rows = docs().filter(d => matches(d, filter));
          if (order) {
            const keys = Object.entries(order);
            rows = rows.slice().sort((a, b) => {
              for (const [k, dir] of keys) {
                const av = getPath(a, k), bv = getPath(b, k);
                if (av === bv) continue;
                const less = av == null ? true : bv == null ? false : av < bv;
                return (less ? -1 : 1) * (dir < 0 ? -1 : 1);
              }
              return 0;
            });
          }
          if (cap != null) rows = rows.slice(0, cap);
          return rows.map(d => project(d, spec));
        },
      };
      calls.push(['find', name, filter]);
      return cursor;
    };
    return {
      find,
      findOne: async (filter = {}) => { calls.push(['findOne', name, filter]); return docs().find(d => matches(d, filter)) || null; },
      countDocuments: async (filter = {}) => { calls.push(['count', name, filter]); return docs().filter(d => matches(d, filter)).length; },
      distinct: async (field, filter = {}) => {
        calls.push(['distinct', name, filter]);
        return [...new Set(docs().filter(d => matches(d, filter)).map(d => getPath(d, field)))];
      },
      insertOne: async (doc) => { calls.push(['insertOne', name, doc]); docs().push({ _id: ++ids, ...doc }); return { insertedId: ids }; },
      insertMany: async (rows) => { calls.push(['insertMany', name, rows]); for (const r of rows) docs().push({ _id: ++ids, ...r }); return { insertedCount: rows.length }; },
      deleteOne: async (filter) => {
        calls.push(['deleteOne', name, filter]);
        const i = docs().findIndex(d => matches(d, filter));
        if (i > -1) docs().splice(i, 1);
        return { deletedCount: i > -1 ? 1 : 0 };
      },
      deleteMany: async (filter = {}) => {
        calls.push(['deleteMany', name, filter]);
        const keep = docs().filter(d => !matches(d, filter));
        const n = docs().length - keep.length;
        store[name] = keep;
        return { deletedCount: n };
      },
      updateOne: async (filter, update, opts = {}) => {
        calls.push(['updateOne', name, filter, update]);
        const d = docs().find(x => matches(x, filter));
        if (d) { applyUpdate(d, update); return { matchedCount: 1, modifiedCount: 1 }; }
        if (opts.upsert) {
          const fresh = applyUpdate({ _id: ++ids, ...plainOf(filter) }, update, { inserting: true });
          docs().push(fresh);
          return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
        }
        return { matchedCount: 0, modifiedCount: 0 };
      },
      updateMany: async (filter, update) => {
        calls.push(['updateMany', name, filter, update]);
        const hit = docs().filter(d => matches(d, filter));
        hit.forEach(d => applyUpdate(d, update));
        return { matchedCount: hit.length, modifiedCount: hit.length };
      },
      bulkWrite: async (ops) => {
        calls.push(['bulkWrite', name, ops]);
        let modified = 0, upserted = 0;
        for (const op of ops) {
          const o = op.updateOne;
          const d = docs().find(x => matches(x, o.filter));
          if (d) { applyUpdate(d, o.update); modified++; }
          else if (o.upsert) { docs().push(applyUpdate({ _id: ++ids, ...plainOf(o.filter) }, o.update, { inserting: true })); upserted++; }
        }
        return { modifiedCount: modified, upsertedCount: upserted };
      },
      aggregate: (pipeline) => {
        calls.push(['aggregate', name, pipeline]);
        const rows = aggregate(docs(), pipeline);
        return { toArray: async () => rows };
      },
      createIndex: async () => 'index',
      createIndexes: async () => ['index'],
    };
  };

  return { collection, calls, store };
}

// The equality parts of a filter, which is what an upsert seeds the new
// document from.
const plainOf = (filter) => Object.fromEntries(
  Object.entries(filter).filter(([k, v]) =>
    !k.startsWith('$') && (v == null || typeof v !== 'object' || v instanceof Date)));

module.exports = { fakeDb, matches, applyUpdate, getPath, aggregate };
