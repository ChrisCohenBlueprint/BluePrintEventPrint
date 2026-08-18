const { getDb } = require('../db');
const config    = require('../config');
const { track, attributeSession } = require('../services/tracking');

const col = () => getDb().collection('inquiries');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clean = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';

// Fixed options for "How did you hear about us?" — anything off this list is
// dropped so the field stays a clean, reportable dimension (with "Other" as the
// catch-all the form itself offers).
const HEARD_OPTIONS = ['Recommendation', 'Google/Bing Search', 'Marketing Email', 'Advertisement', 'Other'];

/**
 * Validate and store an enquiry.
 *
 * The public form has always collected a name and email and then thrown them
 * away — booth:book only ever transmitted `company`. This is the first point at
 * which those details are actually persisted.
 */
async function create({ name, firstName, lastName, email, phone, company, jobTitle, heardAbout,
                        message, boothNumbers = [], sponsorKeys = [], sessionId = null }) {
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

  const hasBooths   = Array.isArray(boothNumbers) && boothNumbers.length;
  const hasSponsors = Array.isArray(sponsorKeys) && sponsorKeys.length;

  const errors = [];
  if (!contact.name)                errors.push('Please enter your name.');
  if (!EMAIL_RE.test(contact.email)) errors.push('Please enter a valid email address.');
  // A stand or a sponsorship option — either is a valid lead. Requiring a stand
  // meant that removing the last stand while keeping sponsors left the enquiry
  // permanently un-submittable.
  if (!hasBooths && !hasSponsors) errors.push('Please select at least one stand or sponsorship option.');
  if (errors.length) return { ok: false, errors };

  const doc = {
    showId: config.showId,
    sessionId,
    contact,
    boothsOfInterest: (Array.isArray(boothNumbers) ? boothNumbers : []).slice(0, 25).map(String),
    sponsorsOfInterest: Array.isArray(sponsorKeys) ? sponsorKeys.slice(0, 25).map(String) : [],
    message: clean(message, 2000),
    source:  'floorplan',
    status:  'new',
    createdAt: new Date(),
  };

  const { insertedId } = await col().insertOne(doc);

  track({ type: 'inquiry.submit', meta: { booths: doc.boothsOfInterest, email: contact.email }, sessionId });

  // Fire the outbound notification without blocking the response. Its own error
  // handling ensures a webhook failure never affects the enquiry.
  require('../services/notify').newInquiry(doc);

  // Retroactively attach every event this visitor generated before identifying
  // themselves, so the lead arrives with its full browsing history (plan §04).
  const linked = await attributeSession(sessionId, insertedId);

  // boothsOfInterest is returned so callers notify on the STORED, validated
  // list rather than re-reading the raw request payload.
  return { ok: true, id: insertedId, boothsOfInterest: doc.boothsOfInterest, eventsLinked: linked };
}

/**
 * Recent enquiries. By default only the live ones; pass { archived: true } for
 * the shelf. Archived leads are kept (never auto-deleted) but hidden from the
 * working list so it stays focused on what still needs actioning.
 */
const recent = (limit = 100, { archived = false } = {}) =>
  col().find({ showId: config.showId, archived: archived ? true : { $ne: true } })
       .sort({ createdAt: -1 }).limit(limit).toArray();

/** An enquiry plus the browsing history that led to it — the sales view. */
async function withHistory(id) {
  const inquiry = await col().findOne({ _id: id });
  if (!inquiry) return null;
  // A lead with no session has no browsing trail. Querying activity by a null
  // sessionId would match EVERY anonymous/migration-imported event that also
  // has sessionId:null, splicing unrelated history onto this one lead.
  if (!inquiry.sessionId) return { ...inquiry, history: [] };
  const history = await getDb().collection('activity')
    .find({ sessionId: inquiry.sessionId })
    .sort({ ts: 1 }).limit(500).toArray();
  return { ...inquiry, history };
}

const STATUSES = ['new', 'contacted', 'won', 'lost'];

/** Move a lead through the sales pipeline. */
async function setStatus(id, status) {
  if (!STATUSES.includes(status)) return { ok: false, error: 'Invalid status.' };
  const res = await col().updateOne({ _id: id }, { $set: { status, updatedAt: new Date() } });
  return res.matchedCount ? { ok: true, status } : { ok: false, error: 'Lead not found.' };
}

/** Assign a lead to a member of the sales team (or clear the assignment). */
async function assign(id, member) {
  const res = await col().updateOne({ _id: id }, {
    $set: { assignedTo: member ? { name: member.name, email: member.email } : null, updatedAt: new Date() },
  });
  return res.matchedCount === 1;
}

/** Shelve a lead (or restore it) without deleting anything. Reversible. */
async function setArchived(id, archived) {
  const res = await col().updateOne({ _id: id }, { $set: { archived: !!archived, updatedAt: new Date() } });
  return res.matchedCount === 1;
}

/** Permanently delete a lead. */
async function remove(id) {
  const res = await col().deleteOne({ _id: id });
  return res.deletedCount === 1;
}

/** Record that the lead was forwarded, so repeat sends are visible. */
async function recordSend(id, { to, cc, by }) {
  const res = await col().updateOne({ _id: id }, {
    $set: { lastSentAt: new Date(), lastSentTo: to, lastSentBy: by || null },
    $inc: { sendCount: 1 },
    // Keep only the most recent 50 sends so repeated forwards can't grow the
    // document toward Mongo's 16 MB limit.
    $push: { sendLog: { $each: [{ at: new Date(), to, cc, by: by || null }], $slice: -50 } },
  });
  return res.matchedCount === 1;
}

module.exports = { col, create, recent, withHistory, setStatus, STATUSES, assign, recordSend, setArchived, remove };
