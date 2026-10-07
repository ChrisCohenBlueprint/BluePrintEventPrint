const config = require('../config');
const { getDb } = require('../db');
const showContext = require('../show-context');
const inFlight = require('../lib/in-flight');

/**
 * Every enquiry, sent on to Make — and from there to Salesforce and Dotdigital.
 *
 * Each enquiry is POSTed as JSON to one webhook: the address of a Make
 * "Custom webhook", which hands it to whatever the scenario does next. The
 * address is pasted into Settings by the owner (NOTIFY_WEBHOOK in the
 * environment still works, and is used when nothing has been saved there).
 *
 * This used to be one attempt and a console.warn. An enquiry that arrived while
 * Make was slow, down or being edited reached Salesforce never, and nothing
 * anywhere said so — a lost lead found weeks later, if at all. Now:
 *
 *   - the outcome of every send is stored on the enquiry (`delivery`), so the
 *     console can say "sent to Make at 12:03", or that it was not, and why;
 *   - a send that fails is tried again on a back-off for about a day, from a
 *     loop that names each enquiry's event explicitly (it has no request);
 *   - an address Make has refused for good (a deleted webhook answers 410) is
 *     not hammered — it is marked failed and left for a person to resend;
 *   - a send is claimed before it is made, so the retry loop and someone
 *     pressing Resend can never post the same enquiry twice at the same time.
 *
 * A failed send never affects the enquiry itself: the visitor has already been
 * told it arrived, and it is in the console regardless.
 */

const META_ID = 'enquiry-webhook';
const meta = () => getDb().collection('meta');
const enquiries = () => getDb().collection('inquiries');

// After the Nth failed attempt, wait BACKOFF_MIN[N-1] minutes. Eight attempts
// over roughly 22 hours: long enough to ride out an outage or a scenario
// switched off for an evening, short enough that a stale lead is not sent days
// late without anyone choosing to.
const BACKOFF_MIN = [1, 5, 15, 60, 180, 360, 720];
const MAX_ATTEMPTS = BACKOFF_MIN.length + 1;
const TIMEOUT_MS = 8_000;          // inside shutdown's drain, so a deploy waits for it
const STALE_CLAIM_MS = 5 * 60_000; // a send this old that never finished was cut off

// ─── Where to send ────────────────────────────────────────────────────────────

/** The webhook in force, and where it came from. */
async function hookSetting() {
  const row = await meta().findOne({ _id: META_ID });
  if (row && typeof row.url === 'string' && row.url) {
    return { url: row.url, source: 'settings', updatedAt: row.updatedAt || null, updatedBy: row.updatedBy || null };
  }
  if (config.notifyWebhook) return { url: config.notifyWebhook, source: 'env', updatedAt: null, updatedBy: null };
  return { url: null, source: null, updatedAt: null, updatedBy: null };
}

/**
 * A webhook address worth storing. HTTPS only — this carries people's names,
 * emails and phone numbers — except on this machine, where the tests and a
 * local catcher run on plain http.
 */
function checkUrl(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return { ok: true, url: null };
  if (v.length > 500) return { ok: false, error: 'That address is too long to be a webhook.' };
  let u;
  try { u = new URL(v); } catch { return { ok: false, error: 'That is not a web address — paste the whole address Make gives you.' }; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    return { ok: false, error: 'The address must start with https:// — enquiries carry people\'s contact details.' };
  }
  if (u.username || u.password) return { ok: false, error: 'Paste the webhook address without a username or password in it.' };
  return { ok: true, url: u.toString() };
}

async function setHook(raw, { actor = null } = {}) {
  const c = checkUrl(raw);
  if (!c.ok) return c;
  if (!c.url) await meta().deleteOne({ _id: META_ID });
  else {
    await meta().updateOne({ _id: META_ID },
      { $set: { url: c.url, updatedAt: new Date(), updatedBy: actor } }, { upsert: true });
  }
  return { ok: true, url: c.url };
}

/** The address as an admin who is not the owner sees it: where, not the key. */
function masked(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const tail = u.pathname.replace(/\/+$/, '').slice(-4);
    return `${u.protocol}//${u.host}/…${tail}`;
  } catch { return '…'; }
}

// ─── What is sent ─────────────────────────────────────────────────────────────

const joinOr = (list, none = '') => (list.length ? list.join(', ') : none);
const round2 = (n) => Math.round(n * 100) / 100;

/** The address the console is served from, for a link back to the lead. */
function baseUrl() {
  const raw = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';
  return raw.replace(/\/+$/, '') || null;
}

/**
 * The JSON Make receives for one enquiry.
 *
 * Flat, ready-to-map fields first — Make maps a field by picking it from the
 * sample it was shown, and "standList" drops straight into a Salesforce text
 * field where an array of objects would need an iterator. The arrays are there
 * too, for a scenario that wants them.
 *
 * Every field the first version sent keeps its name and its meaning, so a hook
 * already wired to it (a Slack channel, a Zap) goes on working.
 *
 * Must run inside the enquiry's own event (showContext), because the stand
 * sizes, package names and currency are that event's.
 */
async function payloadFor(doc, { test = false } = {}) {
  const db = getDb();
  const showId = doc.showId || config.showId;
  const showsModel = require('../models/shows');
  const settings = require('../models/settings');
  const planAreas = require('../models/plan-areas');
  const show = showsModel.byId(showId) || { showId, slug: String(showId).toLowerCase(), name: showId };
  const st = await settings.get();
  const unit = st.unit === 'ft' ? 'ft²' : 'm²';

  const c = doc.contact || {};
  const nums = (doc.boothsOfInterest || []).map(String);
  const rows = nums.length
    ? await db.collection('booths').find({ showId, boothNumber: { $in: nums } }).toArray()
    : [];
  const standDetails = nums.map(n => {
    const b = rows.find(r => r.boothNumber === n) || {};
    return {
      number: n,
      shownAs: b.displayNumber || n,
      size: typeof b.sqm === 'number' ? b.sqm : null,
      listPrice: typeof b.listPrice === 'number' ? b.listPrice : null,
      status: b.status || null,
    };
  });
  const sized = standDetails.filter(s => s.size != null);
  const priced = standDetails.filter(s => s.listPrice != null);

  const sponsorKeys = (doc.sponsorsOfInterest || []).map(String);
  const sponsorRows = sponsorKeys.length
    ? await db.collection('sponsors').find({ showId, key: { $in: sponsorKeys } }).toArray()
    : [];
  const sponsorshipDetails = sponsorKeys.map(k => ({ key: k, name: (sponsorRows.find(r => r.key === k) || {}).name || k }));

  const areaKeys = (doc.areasOfInterest || []).map(String);
  let areaRows = [];
  if (areaKeys.length) { try { areaRows = await planAreas.all(); } catch { areaRows = []; } }
  const shipped = new Map(require('../data/plan-areas').AREAS.map(a => [a.key, a]));
  const areaDetails = areaKeys.map(k => ({ key: k, name: (areaRows.find(a => a.key === k) || shipped.get(k) || {}).label || k }));

  const standList = joinOr(standDetails.map(s => (s.size != null ? `${s.shownAs} (${s.size} ${unit})` : s.shownAs)));
  const sponsorshipNames = joinOr(sponsorshipDetails.map(s => s.name));
  const areaNames = joinOr(areaDetails.map(a => a.name));
  const id = doc._id != null ? String(doc._id) : null;
  const base = baseUrl();
  const consoleUrl = base && id && !test ? `${base}/admin/${encodeURIComponent(show.slug)}#lead=${encodeURIComponent(id)}` : null;
  const receivedAt = (doc.createdAt instanceof Date ? doc.createdAt : new Date()).toISOString();

  // Salesforce will not create a Lead without a last name and a company, and
  // the form asks for neither (a waiting-list request asks only for an email).
  // These are never empty, so they can be mapped straight across.
  const leadLastName = c.lastName || c.name || (c.email ? c.email.split('@')[0] : '') || '[not provided]';
  const leadCompany = c.company || '[not provided]';

  const description = [
    `${doc.kind === 'waitlist' ? 'Waiting-list request' : 'Enquiry'} from the ${show.name} floorplan.`,
    standList ? `Stands: ${standList}` : null,
    sponsorshipNames ? `Sponsorship: ${sponsorshipNames}` : null,
    areaNames ? `Areas: ${areaNames}` : null,
    doc.message ? `Message: ${doc.message}` : null,
    c.heardAbout ? `Heard about us: ${c.heardAbout}` : null,
    consoleUrl ? `In the console: ${consoleUrl}` : null,
  ].filter(Boolean).join('\n');

  return {
    // ── As the first version sent them ──
    event: 'inquiry.new',
    show: showId,
    name: c.name || '',
    firstName: c.firstName || null,
    lastName: c.lastName || null,
    email: c.email || '',
    phone: c.phone || null,
    company: c.company || null,
    jobTitle: c.jobTitle || null,
    heardAbout: c.heardAbout || null,
    stands: nums,
    sponsorships: sponsorKeys,
    message: doc.message || null,
    receivedAt,
    text: `New enquiry from ${c.name || c.email || 'someone'}` +
          (c.company ? ` (${c.company})` : '') +
          ` — ${show.name}, stands ${standList || 'none listed'}. Reply: ${c.email || '—'}`,

    // ── Added for Make, Salesforce and Dotdigital ──
    version: 2,
    test,
    enquiryId: id,
    kind: doc.kind || 'enquiry',
    eventId: showId,
    eventSlug: show.slug,
    eventName: show.name,
    standList,
    standCount: nums.length,
    standDetails,
    totalSize: sized.length ? round2(sized.reduce((t, s) => t + s.size, 0)) : null,
    sizeUnit: unit,
    listPriceTotal: priced.length ? round2(priced.reduce((t, s) => t + s.listPrice, 0)) : null,
    currency: st.currency,
    sponsorshipNames,
    sponsorshipDetails,
    areas: areaKeys,
    areaNames,
    areaDetails,
    leadLastName,
    leadCompany,
    leadSource: 'Floorplan enquiry',
    description,
    consoleUrl,
  };
}

// ─── Sending ──────────────────────────────────────────────────────────────────

const permanent = (status) => status >= 400 && status < 500 && status !== 408 && status !== 429;

async function post(url, payload) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return { ok: true, status: res.status };
    let said = '';
    try { said = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 200); } catch { /* nothing to read */ }
    return { ok: false, status: res.status, error: `Make answered ${res.status}${said ? ` — ${said}` : ''}` };
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, status: null, error: timedOut ? `No answer within ${TIMEOUT_MS / 1000} seconds` : `Could not reach it — ${e.message}` };
  }
}

/**
 * Send one stored enquiry and write down what happened.
 *
 * Claimed first: the claim is a conditional write that only one caller can
 * win, so a Resend pressed while the retry loop is sending the same enquiry
 * gets "already being sent" instead of a second Salesforce lead.
 */
async function deliver(id, { manual = false } = {}) {
  const doc = await enquiries().findOne({ _id: id });
  if (!doc) return { ok: false, reason: 'not_found' };

  return showContext.runAs(doc.showId || config.showId, async () => {
    const hook = await hookSetting();
    if (!hook.url) return { ok: false, reason: 'not_configured' };

    const now = new Date();
    const claim = await enquiries().updateOne(
      { _id: id, $or: [{ 'delivery.status': { $ne: 'sending' } },
                       { 'delivery.claimedAt': { $lte: new Date(now.getTime() - STALE_CLAIM_MS) } }] },
      { $set: { 'delivery.status': 'sending', 'delivery.claimedAt': now } });
    if (!claim.matchedCount) return { ok: false, reason: 'busy' };

    let result;
    try { result = await post(hook.url, await payloadFor(doc)); }
    catch (e) { result = { ok: false, status: null, error: `Could not prepare it — ${e.message}` }; }

    const attempts = ((doc.delivery && doc.delivery.attempts) || 0) + 1;
    const at = new Date();
    let host = null;
    try { host = new URL(hook.url).host; } catch { /* stored addresses always parse */ }
    const delivery = result.ok
      ? { status: 'sent', attempts, lastAttemptAt: at, sentAt: at, httpStatus: result.status,
          error: null, nextAttemptAt: null, to: host, manual }
      : { status: 'failed', attempts, lastAttemptAt: at, sentAt: (doc.delivery && doc.delivery.sentAt) || null,
          httpStatus: result.status, error: result.error, to: host, manual,
          // Retried on the back-off unless Make refused it for good, or the
          // attempts have run out; either way Resend in the console still works.
          nextAttemptAt: permanent(result.status) || attempts >= MAX_ATTEMPTS
            ? null : new Date(at.getTime() + BACKOFF_MIN[attempts - 1] * 60_000) };
    await enquiries().updateOne({ _id: id }, { $set: { delivery } });
    if (!result.ok) console.warn(`Enquiry ${id}: not delivered to Make (attempt ${attempts}) — ${result.error}`);
    return { ok: result.ok, delivery, error: result.error || null };
  });
}

/**
 * A new enquiry has been stored. Called without awaiting by inquiries.create,
 * after the visitor has been answered. Counted in flight so a deploy waits for
 * the send rather than cutting it off half-recorded.
 */
async function newInquiry(doc) {
  if (!doc || doc._id == null) return;
  const hook = await hookSetting();
  if (!hook.url) return;
  return inFlight.run(() => deliver(doc._id));
}

/**
 * A made-up enquiry for this event, sent so Make can learn the fields.
 *
 * Make's Custom webhook has to be shown one example before its fields can be
 * mapped. Without this, the only way to give it one was to send a real
 * enquiry from the public page — which became a real lead. It is marked
 * `test: true`, so a scenario can filter it out once it is set up.
 */
async function sendTest({ actor = null } = {}) {
  const hook = await hookSetting();
  if (!hook.url) return { ok: false, reason: 'not_configured' };
  const db = getDb();
  const showId = config.showId;
  const some = await db.collection('booths')
    .find({ showId, status: 'available', removed: { $ne: true } }).limit(2).toArray();
  const pkg = await db.collection('sponsors').find({ showId }).limit(1).toArray();
  const sample = {
    _id: `test-${Date.now().toString(36)}`,
    showId,
    kind: 'enquiry',
    createdAt: new Date(),
    contact: {
      name: 'Test Enquiry', firstName: 'Test', lastName: 'Enquiry',
      email: 'test.enquiry@example.com', phone: '+44 20 7946 0000',
      company: 'Example Lubricants Ltd', jobTitle: 'Procurement Manager', heardAbout: 'Other',
    },
    boothsOfInterest: some.map(b => b.boothNumber),
    sponsorsOfInterest: pkg.map(p => p.key),
    areasOfInterest: [],
    message: `A test enquiry sent from the console${actor ? ` by ${actor}` : ''} so Make can learn the fields. Nobody asked for these stands.`,
  };
  const result = await post(hook.url, await payloadFor(sample, { test: true }));
  return { ...result, to: (() => { try { return new URL(hook.url).host; } catch { return null; } })() };
}

/** How sending is going, for the Settings card. */
async function status() {
  const hook = await hookSetting();
  const col = enquiries();
  const [retrying, gaveUp, lastSent] = await Promise.all([
    col.countDocuments({ 'delivery.status': 'failed', 'delivery.nextAttemptAt': { $exists: true, $ne: null } }),
    col.countDocuments({ 'delivery.status': 'failed', 'delivery.nextAttemptAt': null }),
    col.find({ 'delivery.status': 'sent' }).sort({ 'delivery.sentAt': -1 }).limit(1).toArray(),
  ]);
  return { ...hook, retrying, gaveUp,
           lastSentAt: lastSent[0] && lastSent[0].delivery ? lastSent[0].delivery.sentAt : null };
}

/**
 * Try again whatever is due, across every event.
 *
 * Reads by delivery state, not by show, and each send enters its enquiry's own
 * event (deliver does) — a timer has no request to take an event from. Also
 * picks up a send that was claimed and never finished (the process stopped
 * mid-send), once its claim is old enough to be certainly dead.
 */
async function retryDue({ limit = 20 } = {}) {
  const now = new Date();
  const due = await enquiries().find({ $or: [
    // $ne: null is explicit rather than left to MongoDB's type rules, so an
    // enquiry Make refused for good (no next try) is never picked up.
    { 'delivery.status': 'failed', 'delivery.nextAttemptAt': { $ne: null, $lte: now } },
    { 'delivery.status': 'sending', 'delivery.claimedAt': { $lte: new Date(now.getTime() - STALE_CLAIM_MS) } },
  ] }).limit(limit).toArray();
  let sent = 0;
  for (const d of due) {
    try { if ((await inFlight.run(() => deliver(d._id))).ok) sent++; }
    catch (e) { console.error(`Enquiry ${d._id}: retry failed —`, e.message); }
  }
  return { due: due.length, sent };
}

function startRetryLoop() {
  const t = setInterval(() => {
    retryDue().catch(e => console.error('Enquiry retry pass failed:', e.message));
  }, 60_000);
  if (t.unref) t.unref();
  return t;
}

module.exports = { newInquiry, deliver, sendTest, status, retryDue, startRetryLoop,
                   hookSetting, setHook, checkUrl, masked, payloadFor, MAX_ATTEMPTS };
