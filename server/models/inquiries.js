const { getDb } = require('../db');
const config    = require('../config');
const { track, attributeSession } = require('../services/tracking');

const col = () => getDb().collection('inquiries');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clean = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';

/**
 * Validate and store an enquiry.
 *
 * The public form has always collected a name and email and then thrown them
 * away — booth:book only ever transmitted `company`. This is the first point at
 * which those details are actually persisted.
 */
async function create({ name, email, phone, company, message, boothNumbers = [], sponsorKeys = [], sessionId = null }) {
  const contact = {
    name:    clean(name, 120),
    email:   clean(email, 200).toLowerCase(),
    phone:   clean(phone, 40),
    company: clean(company, 160),
  };

  const errors = [];
  if (!contact.name)                errors.push('Please enter your name.');
  if (!EMAIL_RE.test(contact.email)) errors.push('Please enter a valid email address.');
  if (!Array.isArray(boothNumbers) || !boothNumbers.length) errors.push('Please select at least one stand.');
  if (errors.length) return { ok: false, errors };

  const doc = {
    showId: config.showId,
    sessionId,
    contact,
    boothsOfInterest: boothNumbers.slice(0, 25).map(String),
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

  return { ok: true, id: insertedId, eventsLinked: linked };
}

const recent = (limit = 100) =>
  col().find({ showId: config.showId }).sort({ createdAt: -1 }).limit(limit).toArray();

/** An enquiry plus the browsing history that led to it — the sales view. */
async function withHistory(id) {
  const inquiry = await col().findOne({ _id: id });
  if (!inquiry) return null;
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

module.exports = { col, create, recent, withHistory, setStatus, STATUSES };
