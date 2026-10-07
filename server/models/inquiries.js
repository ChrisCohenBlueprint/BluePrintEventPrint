const { getDb } = require('../db');
const config    = require('../config');
const { track, attributeSession } = require('../services/tracking');
const booths    = require('./booths');
const sponsors  = require('./sponsors');
const planAreas = require('./plan-areas');

const col = () => getDb().collection('inquiries');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clean = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';

// Fixed options for "How did you hear about us?" — anything off this list is
// dropped so the field stays a clean, reportable dimension (with "Other" as the
// catch-all the form itself offers).
const HEARD_OPTIONS = ['Recommendation', 'Google/Bing Search', 'Marketing Email', 'Advertisement', 'Other'];

// ─── What the enquiry is about ────────────────────────────────────────────────
// Stands, sponsorship packages and plan areas, each a list of keys from the
// public form. They were kept as String() of whatever arrived, 25 of any length
// each, and never checked against anything: a stored lead could name
// "NOT-A-STAND", "[object Object]" and a megabyte of padding, and go to sales,
// the webhook and every admin's log like that. Now each list keeps only short
// strings that name something in THIS event, and says what it dropped.
const MAX_INTEREST = 25;    // per list, as stored
const MAX_SCANNED  = 100;   // entries looked at at all; the rest are dropped unread
const KEY_MAX      = 64;    // longer than any stand number or key we issue

// How a dropped entry is reported back: short, and never the value itself if it
// was not a string.
const describe = (v) => typeof v === 'string'
  ? (v.length > 40 ? `${v.slice(0, 40)}…` : v)
  : `(${v === null ? 'null' : Array.isArray(v) ? 'list' : typeof v})`;

/** Split a raw list into candidate keys and what was refused on sight. */
function candidates(list) {
  const keep = [], bad = [];
  if (!Array.isArray(list)) return { keep, bad };
  for (const v of list.slice(0, MAX_SCANNED)) {
    // A stand number may arrive as a number from an older client; nothing else
    // that is not a string means anything here.
    const s = typeof v === 'string' ? v.trim()
            : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
    if (s === '') continue;
    if (s && s.length <= KEY_MAX) { if (!keep.includes(s)) keep.push(s); }
    else bad.push(describe(v));
  }
  if (list.length > MAX_SCANNED) bad.push(`(${list.length - MAX_SCANNED} more)`);
  return { keep, bad };
}

/**
 * Keep the stands, packages and areas that exist in the current show, in the
 * order given, at most MAX_INTEREST of each. Existence, not availability: a
 * stand sold a minute ago is still a lead worth having.
 */
async function ofInterest({ boothNumbers, sponsorKeys, areaKeys }) {
  const s = candidates(boothNumbers), p = candidates(sponsorKeys), a = candidates(areaKeys);
  const showId = config.showId;
  const [standRows, packageRows, areaRows] = await Promise.all([
    s.keep.length ? booths.col().find({ showId, boothNumber: { $in: s.keep } }).project({ boothNumber: 1 }).toArray() : [],
    p.keep.length ? sponsors.col().find({ showId, key: { $in: p.keep } }).project({ key: 1 }).toArray() : [],
    a.keep.length ? planAreas.all() : [],
  ]);
  const split = ({ keep, bad }, known) => {
    const ok = keep.filter(k => known.has(k));
    return {
      list: ok.slice(0, MAX_INTEREST),
      dropped: bad.concat(keep.filter(k => !known.has(k)).map(describe),
                          ok.length > MAX_INTEREST ? [`(${ok.length - MAX_INTEREST} over the limit)`] : [])
                  .slice(0, MAX_INTEREST),
    };
  };
  return {
    stands:   split(s, new Set(standRows.map(r => r.boothNumber))),
    sponsors: split(p, new Set(packageRows.map(r => r.key))),
    areas:    split(a, new Set(areaRows.map(r => r.key))),
    offered:  s.keep.length + s.bad.length + p.keep.length + p.bad.length + a.keep.length + a.bad.length,
  };
}

// The page sends a random id with each enquiry and the same id with every retry
// of it, so an enquiry whose acknowledgement was lost is stored once however
// often it is re-sent. Unique per show in the database (server/db.js).
const REQUEST_ID_RE = /^[a-f0-9]{32}$/;

/** The answer a retry gets: the original enquiry's own success. */
const replay = (prior) => ({ ok: true, id: prior._id, boothsOfInterest: prior.boothsOfInterest || [], duplicate: true });

/**
 * Validate and store an enquiry.
 *
 * The public form has always collected a name and email and then thrown them
 * away — booth:book only ever transmitted `company`. This is the first point at
 * which those details are actually persisted.
 */
async function create({ name, firstName, lastName, email, phone, company, jobTitle, heardAbout,
                        message, boothNumbers = [], sponsorKeys = [], areaKeys = [], sessionId = null,
                        kind = 'enquiry', requestId = null }) {
  const reqId = typeof requestId === 'string' && REQUEST_ID_RE.test(requestId) ? requestId : null;
  // A retry of an enquiry already stored is answered as the original was, before
  // anything else — it is the same enquiry, whatever has changed since.
  if (reqId) {
    const prior = await col().findOne({ showId: config.showId, requestId: reqId });
    if (prior) return replay(prior);
  }

  // A waiting-list request ("tell me if this stand frees up") asks for an email
  // and nothing else, because asking a browsing visitor for their full name to
  // be told about a stand they cannot have yet loses most of them. It is still
  // a lead and still belongs here, so the only rule that relaxes is the name.
  const isWaitlist = kind === 'waitlist';
  const first = clean(firstName, 80);
  const last  = clean(lastName, 80);
  // Prefer the split name; fall back to a legacy single `name` field so older
  // clients (or an API caller) still work.
  const fullName = [first, last].filter(Boolean).join(' ') || clean(name, 120);
  const heard = clean(heardAbout, 60);

  const contact = {
    name:      fullName,
    firstName: first,
    lastName:  last,
    email:     clean(email, 200).toLowerCase(),
    phone:     clean(phone, 40),
    company:   clean(company, 160),
    jobTitle:  clean(jobTitle, 120),
    heardAbout: HEARD_OPTIONS.includes(heard) ? heard : '',
  };

  const interest = await ofInterest({ boothNumbers, sponsorKeys, areaKeys });

  const errors = [];
  if (!contact.name && !isWaitlist) errors.push('Please enter your name.');
  if (!EMAIL_RE.test(contact.email)) errors.push('Please enter a valid email address.');
  // A stand or a sponsorship option — either is a valid lead. Requiring a stand
  // meant that removing the last stand while keeping sponsors left the enquiry
  // permanently un-submittable. A sponsorable area — the VIP Lounge, a
  // conference track — is a lead in its own right too.
  if (!interest.stands.list.length && !interest.sponsors.list.length && !interest.areas.list.length) {
    errors.push(interest.offered
      // Something was picked, but none of it is on this event's plan now — a
      // stand merged or re-numbered since the page loaded, most likely.
      ? 'Those stands or options are no longer on this plan. Please refresh the page and choose again.'
      : 'Please select at least one stand, area or sponsorship option.');
  }
  if (errors.length) return { ok: false, errors };

  const doc = {
    showId: config.showId,
    sessionId,
    contact,
    boothsOfInterest:   interest.stands.list,
    sponsorsOfInterest: interest.sponsors.list,
    areasOfInterest:    interest.areas.list,
    message: clean(message, 2000),
    source:  'floorplan',
    // Sales needs to tell "wants this stand" from "wants to hear if it frees
    // up" at a glance: the second is a lead to sit on, not one to call today.
    kind:    isWaitlist ? 'waitlist' : 'enquiry',
    status:  'new',
    createdAt: new Date(),
    ...(reqId ? { requestId: reqId } : {}),
  };

  let insertedId;
  try {
    ({ insertedId } = await col().insertOne(doc));
  } catch (e) {
    // Two copies of one retry both missed the lookup above; the unique index
    // let the first in. The second is that same enquiry.
    if (reqId && e?.code === 11000) {
      const prior = await col().findOne({ showId: config.showId, requestId: reqId });
      if (prior) return replay(prior);
    }
    throw e;
  }

  // ── Stored. From here on the answer is "received", whatever else fails. ──
  // Everything below used to be able to throw out of create() — attributing the
  // history is a database write of its own — and the visitor was then told the
  // enquiry had failed, sent it again, and sales got two. Each step is now best
  // effort and logged.
  try {
    track({ type: 'inquiry.submit', meta: { booths: doc.boothsOfInterest, email: contact.email }, sessionId });
  } catch (e) { console.error(`Enquiry ${insertedId} stored, but not recorded in the activity log:`, e.message); }

  // Fire the outbound notification without blocking the response. Its own error
  // handling ensures a webhook failure never affects the enquiry; the catch is
  // for anything that escapes it.
  // With its id: the send is recorded on the stored enquiry, so the console can
  // say whether it reached Make.
  Promise.resolve()
    .then(() => require('../services/notify').newInquiry({ ...doc, _id: insertedId }))
    .catch(e => console.warn(`Enquiry ${insertedId}: notification failed:`, e.message));

  // Retroactively attach every event this visitor generated before identifying
  // themselves, so the lead arrives with its full browsing history (plan §04).
  // If this fails the history is not lost: withHistory() also reads this
  // session's unattributed events from before the enquiry.
  let linked = 0;
  try {
    linked = await attributeSession(sessionId, insertedId);
  } catch (e) {
    console.error(`Enquiry ${insertedId} stored, but its browsing history was not linked:`, e.message);
  }

  const dropped = { stands: interest.stands.dropped, sponsors: interest.sponsors.dropped, areas: interest.areas.dropped };
  const droppedAny = dropped.stands.length + dropped.sponsors.length + dropped.areas.length;
  if (droppedAny) {
    console.warn(`Enquiry ${insertedId}: dropped ${droppedAny} unknown or malformed item(s) — ` +
      JSON.stringify(dropped).slice(0, 300));
  }

  // boothsOfInterest is returned so callers notify on the STORED, validated
  // list rather than re-reading the raw request payload. `dropped` tells the
  // caller what was left out, and why it was not a stand of this event.
  return { ok: true, id: insertedId, boothsOfInterest: doc.boothsOfInterest, eventsLinked: linked,
           ...(droppedAny ? { dropped } : {}) };
}

/**
 * Recent enquiries. By default only the live ones; pass { archived: true } for
 * the shelf. Archived leads are kept (never auto-deleted) but hidden from the
 * working list so it stays focused on what still needs actioning.
 */
const recent = (limit = 100, { archived = false } = {}) =>
  col().find({ showId: config.showId, archived: archived ? true : { $ne: true } })
       .sort({ createdAt: -1 }).limit(limit).toArray();

/**
 * Every write below is scoped to the show as well as the `_id`.
 *
 * An ObjectId is unique, so filtering on it alone did find the right document —
 * but one deployment serves several events, and a lead belongs to one of them.
 * Filtering on `_id` only meant a sales rep working Europe could archive,
 * re-assign, re-status or DELETE a North American lead if an id reached the
 * wrong console, with nothing in the query to stop it. Adding the show makes
 * the scoping a property of the data access rather than of the caller being
 * careful, which is how every other model here works.
 */
const scoped = (id) => ({ _id: id, showId: config.showId });

/** One lead, if it belongs to the current show. */
const get = (id) => col().findOne(scoped(id));

/**
 * An enquiry plus the browsing history that led to it — the sales view.
 *
 * Only the events that belong to THIS contact. Reading the whole session was
 * wrong whenever a browser was shared — a stand-side tablet, a family laptop:
 * B's lead showed A's browsing and A's inquiry.submit, A's email in it, and
 * anything browsed after B had enquired as well, none of which is "the history
 * that preceded it". So the trail is:
 *
 *   - events attributed to this contact (attributeSession stamps them with the
 *     enquiry's id when it is made), or to an earlier enquiry by the same
 *     person in the same session — a returning visitor's whole trail; and
 *   - events the session left unattributed — attribution is best effort, and
 *     can fail after the enquiry is stored — from before this enquiry and
 *     after the last one somebody ELSE made on that browser.
 */
async function withHistory(id) {
  const inquiry = await get(id);
  if (!inquiry) return null;
  // A lead with no session has no browsing trail. Querying activity by a null
  // sessionId would match EVERY anonymous/migration-imported event that also
  // has sessionId:null, splicing unrelated history onto this one lead.
  if (!inquiry.sessionId) return { ...inquiry, history: [] };

  const until = inquiry.createdAt instanceof Date ? inquiry.createdAt : null;
  const email = inquiry.contact?.email || null;
  const earlier = await col()
    .find({ showId: config.showId, sessionId: inquiry.sessionId, ...(until ? { createdAt: { $lte: until } } : {}) })
    .project({ contact: 1, createdAt: 1 }).toArray();
  const same = (x) => String(x._id) === String(inquiry._id);
  const mine = earlier.filter(x => same(x) || (email && x.contact?.email === email)).map(x => x._id);
  if (!mine.some(x => String(x) === String(inquiry._id))) mine.push(inquiry._id);
  const since = earlier
    .filter(x => !same(x) && x.contact?.email !== email && x.createdAt instanceof Date)
    .reduce((latest, x) => (!latest || x.createdAt > latest ? x.createdAt : latest), null);

  const ts = {};
  if (until) ts.$lte = until;
  if (since) ts.$gt = since;
  const history = await getDb().collection('activity')
    .find({
      showId: config.showId,
      sessionId: inquiry.sessionId,
      $or: [
        { 'actor.contactId': { $in: mine } },
        { 'actor.contactId': { $exists: false }, ...(Object.keys(ts).length ? { ts } : {}) },
      ],
    })
    .sort({ ts: 1 }).limit(500).toArray();
  return { ...inquiry, history };
}

const STATUSES = ['new', 'contacted', 'won', 'lost'];

/** Move a lead through the sales pipeline. */
async function setStatus(id, status) {
  if (!STATUSES.includes(status)) return { ok: false, error: 'Invalid status.' };
  const res = await col().updateOne(scoped(id), { $set: { status, updatedAt: new Date() } });
  return res.matchedCount ? { ok: true, status } : { ok: false, error: 'Lead not found.' };
}

/** Assign a lead to a member of the sales team (or clear the assignment). */
async function assign(id, member) {
  const res = await col().updateOne(scoped(id), {
    $set: { assignedTo: member ? { name: member.name, email: member.email } : null, updatedAt: new Date() },
  });
  return res.matchedCount === 1;
}

/** Shelve a lead (or restore it) without deleting anything. Reversible. */
async function setArchived(id, archived) {
  const res = await col().updateOne(scoped(id), { $set: { archived: !!archived, updatedAt: new Date() } });
  return res.matchedCount === 1;
}

/** Permanently delete a lead. */
async function remove(id) {
  const res = await col().deleteOne(scoped(id));
  return res.deletedCount === 1;
}

/** Record that the lead was forwarded, so repeat sends are visible. */
async function recordSend(id, { to, cc, by }) {
  const res = await col().updateOne(scoped(id), {
    $set: { lastSentAt: new Date(), lastSentTo: to, lastSentBy: by || null },
    $inc: { sendCount: 1 },
    // Keep only the most recent 50 sends so repeated forwards can't grow the
    // document toward Mongo's 16 MB limit.
    $push: { sendLog: { $each: [{ at: new Date(), to, cc, by: by || null }], $slice: -50 } },
  });
  return res.matchedCount === 1;
}

module.exports = { col, create, recent, get, withHistory, setStatus, STATUSES, assign, recordSend, setArchived, remove };
