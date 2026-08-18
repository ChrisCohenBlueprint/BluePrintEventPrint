const { ObjectId } = require('mongodb');
const { getDb } = require('../db');
const config = require('../config');

/**
 * Bespoke client menus — the proposals a sales rep assembles.
 *
 * A menu is a named selection of what is still on the table for one client:
 * remaining sponsorship packages, available stands, and any free-text line the
 * rep needs for something the catalogue doesn't cover. It is a SELECTION, not a
 * snapshot: only the keys/numbers are stored, and the contents are resolved
 * live whenever the proposal is opened or printed. That is deliberate — a
 * package that sells out between drafting and printing shows as withdrawn
 * rather than being quietly proposed to a client who can no longer buy it.
 *
 * Menus belong to the rep who created them. Admins and the owner can see every
 * menu; a rep only ever sees, edits and prints their own.
 */

const col = () => getDb().collection('menus');

async function ensureIndexes() {
  await col().createIndex({ showId: 1, owner: 1, updatedAt: -1 });
  await col().createIndex({ showId: 1, ref: 1 }, { unique: true });
}

// ─── Reference number ─────────────────────────────────────────────────────────
// A short human-readable id for the printed document, so a rep and a client can
// refer to the same proposal on a call. Sequential per show via an atomic $inc,
// which is why two reps drafting at the same moment can't collide on one number.
async function nextRef() {
  const doc = await getDb().collection('counters').findOneAndUpdate(
    { _id: `menus:${config.showId}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  // The driver returns the document directly on v6+, or wrapped in `.value` on
  // older releases; accept either so a driver bump can't silently break refs.
  const seq = (doc && (doc.seq ?? doc.value?.seq)) || 1;
  return `${config.showId}-P${String(seq).padStart(3, '0')}`;
}

// ─── Field cleaning ───────────────────────────────────────────────────────────
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

// Sponsor keys and stand numbers are used verbatim in database queries and are
// rendered into the proposal, so both are constrained to a safe shape and the
// list length is capped — an unbounded array would let one request pull the
// whole catalogue into a single document.
const KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;
const uniq = (a) => [...new Set(a)];

const cleanKeys = (v) => Array.isArray(v)
  ? uniq(v.map(k => String(k || '').trim()).filter(k => KEY_RE.test(k))).slice(0, 60)
  : [];

function cleanCustom(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map(it => ({
      title:  str(it?.title, 120),
      detail: str(it?.detail, 400),
      // An unparseable or negative price is dropped rather than stored as NaN,
      // which would corrupt the proposal total.
      price:  Number.isFinite(Number(it?.price)) && Number(it?.price) >= 0 ? Number(it.price) : null,
    }))
    .filter(it => it.title)
    .slice(0, 25);
}

/** The editable surface of a menu. Only supplied keys are written. */
function cleanFields(f = {}) {
  const $set = {};
  if ('title'         in f) $set.title         = str(f.title, 120);
  if ('clientName'    in f) $set.clientName    = str(f.clientName, 120);
  if ('clientCompany' in f) $set.clientCompany = str(f.clientCompany, 120);
  if ('clientEmail'   in f) $set.clientEmail   = str(f.clientEmail, 160);
  if ('intro'         in f) $set.intro         = str(f.intro, 1500);
  if ('sponsorKeys'   in f) $set.sponsorKeys   = cleanKeys(f.sponsorKeys);
  if ('boothNumbers'  in f) $set.boothNumbers  = cleanKeys(f.boothNumbers);
  if ('custom'        in f) $set.custom        = cleanCustom(f.custom);
  // Off by default: the client-facing document is price-free like the public
  // floorplan, and a rep has to opt in per proposal to put numbers in writing.
  if ('showPrices'    in f) $set.showPrices    = f.showPrices === true || f.showPrices === 'true';
  // ON by default — the opposite of showPrices. A plan showing the client where
  // their stands sit is the point of the document, so it is opt-OUT (for a
  // sponsorship-only proposal, or when the rep wants a one-page quote).
  // Proposals drafted before this existed have no field at all, which reads as
  // on, so they gain the plan without needing a migration.
  if ('showPlan'      in f) $set.showPlan      = !(f.showPlan === false || f.showPlan === 'false');
  return $set;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────
async function create(owner, fields = {}) {
  const doc = {
    showId: config.showId,
    ref: await nextRef(),
    owner: String(owner || '').toLowerCase().trim(),
    title: '', clientName: '', clientCompany: '', clientEmail: '', intro: '',
    sponsorKeys: [], boothNumbers: [], custom: [], showPrices: false, showPlan: true,
    ...cleanFields(fields),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const res = await col().insertOne(doc);
  return { ...doc, _id: res.insertedId };
}

/**
 * A rep's menus, newest first. `all` (admins only) drops the owner filter — the
 * caller is responsible for deciding who is allowed to ask for it.
 */
const listFor = (owner, { all = false } = {}) =>
  col().find(all ? { showId: config.showId }
                 : { showId: config.showId, owner: String(owner || '').toLowerCase().trim() })
       .sort({ updatedAt: -1 }).limit(500).toArray();

/**
 * Fetch one menu, enforcing ownership in the QUERY rather than after the read.
 * Checking afterwards would still have loaded another rep's client details into
 * memory (and into any error log) before rejecting.
 */
function get(id, owner, { all = false } = {}) {
  if (!ObjectId.isValid(id)) return Promise.resolve(null);
  const q = { _id: new ObjectId(id), showId: config.showId };
  if (!all) q.owner = String(owner || '').toLowerCase().trim();
  return col().findOne(q);
}

async function update(id, owner, fields, { all = false } = {}) {
  if (!ObjectId.isValid(id)) return null;
  const $set = cleanFields(fields);
  if (!Object.keys($set).length) return get(id, owner, { all });
  $set.updatedAt = new Date();
  const q = { _id: new ObjectId(id), showId: config.showId };
  if (!all) q.owner = String(owner || '').toLowerCase().trim();
  const res = await col().updateOne(q, { $set });
  return res.matchedCount ? get(id, owner, { all }) : null;
}

/** Copy a menu — the fast path for "same proposal, different client". */
async function duplicate(id, owner, { all = false } = {}) {
  const src = await get(id, owner, { all });
  if (!src) return null;
  const { _id, ref, createdAt, updatedAt, owner: srcOwner, ...rest } = src;
  return create(owner, { ...rest, title: `${src.title || 'Proposal'} (copy)` });
}

async function remove(id, owner, { all = false } = {}) {
  if (!ObjectId.isValid(id)) return false;
  const q = { _id: new ObjectId(id), showId: config.showId };
  if (!all) q.owner = String(owner || '').toLowerCase().trim();
  const res = await col().deleteOne(q);
  return res.deletedCount === 1;
}

module.exports = { col, ensureIndexes, create, listFor, get, update, duplicate, remove };
