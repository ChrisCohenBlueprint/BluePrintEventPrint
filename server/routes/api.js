const express   = require('express');
const { ObjectId } = require('mongodb');

const config    = require('../config');
const booths    = require('../models/booths');
const inquiries = require('../models/inquiries');
const sponsors  = require('../models/sponsors');
const users     = require('../models/users');
const partners  = require('../models/partners');
const salesTeam = require('../data/sales-team');
const holds     = require('../services/holds');
const { getDb } = require('../db');

const router = express.Router();

// ─── Team: admin accounts ─────────────────────────────────────────────────────
// Behind adminAuth like everything under /api. Any admin can manage the team.
// A new admin gets a username + temporary password here, shares it out of band,
// and sets up their own 2FA on first login.
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

router.get('/admins', async (_req, res, next) => {
  try { res.json(await users.list()); } catch (e) { next(e); }
});

router.post('/admins', async (req, res, next) => {
  try {
    const username = String(req.body?.username || '').toLowerCase().trim();
    const password = String(req.body?.password || '');
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username must be 2–32 chars: letters, numbers, . _ -' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (await users.findByUsername(username)) return res.status(409).json({ error: 'That username already exists.' });
    await users.upsert({ username, password, role: 'admin' });
    res.json({ ok: true, username });
  } catch (e) { next(e); }
});

router.post('/admins/:username/reset-2fa', async (req, res, next) => {
  try {
    const ok = await users.resetTotp(req.params.username);
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'No such account.' });
  } catch (e) { next(e); }
});

router.post('/admins/:username/password', async (req, res, next) => {
  try {
    const password = String(req.body?.password || '');
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const ok = await users.setPassword(req.params.username, password);
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'No such account.' });
  } catch (e) { next(e); }
});

router.delete('/admins/:username', async (req, res, next) => {
  try {
    const target = String(req.params.username || '').toLowerCase().trim();
    // Never leave the system with no admins — that would lock everyone out.
    if (await users.count() <= 1) return res.status(400).json({ error: 'Cannot delete the last admin.' });
    // Deleting the account you are signed in as would be confusing; block it.
    if (req.admin && req.admin.user === target) return res.status(400).json({ error: 'You cannot delete your own account.' });
    const ok = await users.remove(target);
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'No such account.' });
  } catch (e) { next(e); }
});

// ─── Sponsors (admin — includes price) ────────────────────────────────────────
router.get('/sponsors', async (_req, res, next) => {
  try { res.json(await sponsors.all()); } catch (e) { next(e); }
});

router.patch('/sponsors/:key', async (req, res, next) => {
  try {
    const body = req.body || {};
    if ('price' in body) {
      if (body.price === '' || body.price == null) body.price = null;
      else {
        const n = Number(body.price);
        // A non-numeric price used to be stored as NaN, corrupting the catalogue
        // and silently breaking recommendation ranking.
        if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'Price must be a non-negative number.' });
        body.price = n;
      }
    }
    // Coerce honestly: the strings "false"/"0" are false, not truthy.
    const truthy = v => v === true || v === 'true' || v === 1 || v === '1';
    if ('active'  in body) body.active  = truthy(body.active);
    if ('soldOut' in body) body.soldOut = truthy(body.soldOut);
    const updated = await sponsors.setFields(req.params.key, body);
    if (!updated) return res.status(404).json({ error: 'No such sponsor.' });
    res.json(updated);
  } catch (e) { next(e); }
});

// Everything here sits behind adminAuth, applied in server.js before the
// router is mounted. These endpoints return company names, negotiated prices
// and internal notes, and were previously public.

router.get('/stats', async (_req, res, next) => {
  try { res.json(await booths.stats()); } catch (e) { next(e); }
});

router.get('/booths', async (_req, res, next) => {
  try { res.json(await booths.all()); } catch (e) { next(e); }
});

router.get('/holds', async (_req, res, next) => {
  try { res.json(await holds.active()); } catch (e) { next(e); }
});

router.get('/inquiries', async (_req, res, next) => {
  try { res.json(await inquiries.recent(Number(_req.query.limit) || 100)); } catch (e) { next(e); }
});

// One lead with the full browsing history that preceded it.
router.get('/inquiries/:id', async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await inquiries.withHistory(new ObjectId(req.params.id));
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) { next(e); }
});

// ─── Partner logos (the public "In partnership with" strip) ───────────────────
router.get('/partners', async (_req, res, next) => {
  try { res.json(await partners.all()); } catch (e) { next(e); }
});

router.post('/partners', async (req, res, next) => {
  try {
    const r = await partners.create(req.body || {});
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) { next(e); }
});

router.patch('/partners/:id', async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const r = await partners.update(req.params.id, req.body || {});
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) { next(e); }
});

router.delete('/partners/:id', async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const ok = await partners.remove(req.params.id);
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'Partner not found.' });
  } catch (e) { next(e); }
});

// ─── Forwarding an enquiry to the sales team ──────────────────────────────────
router.get('/sales-team', (_req, res) => {
  res.json({ team: salesTeam.TEAM, manager: salesTeam.MANAGER });
});

router.post('/inquiries/:id/assign', async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const name = req.body?.name;
    // An empty name clears the assignment.
    const member = name ? salesTeam.findMember(name) : null;
    if (name && !member) return res.status(400).json({ error: 'Unknown team member.' });
    const ok = await inquiries.assign(new ObjectId(req.params.id), member);
    res.status(ok ? 200 : 404).json(ok ? { ok: true, assignedTo: member } : { error: 'Lead not found.' });
  } catch (e) { next(e); }
});

/**
 * Forward the enquiry. Records the send, fires the notification webhook if one
 * is configured (that's the hook for real automation later), and returns a
 * ready-to-open email so it can be sent today with no mail server: the browser
 * opens it pre-addressed to the assigned person, copying the manager.
 */
router.post('/inquiries/:id/send', async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const lead = await inquiries.col().findOne({ _id: new ObjectId(req.params.id) });
    if (!lead) return res.status(404).json({ error: 'Lead not found.' });

    const member = salesTeam.findMember(req.body?.name) || lead.assignedTo;
    if (!member) return res.status(400).json({ error: 'Assign this enquiry to someone first.' });

    const c = lead.contact || {};
    const stands = (lead.boothsOfInterest || []).join(', ') || 'none specified';
    const sponsorKeys = lead.sponsorsOfInterest || [];
    let sponsorNames = sponsorKeys;
    if (sponsorKeys.length) {
      const rows = await sponsors.col().find({ key: { $in: sponsorKeys } }).project({ key: 1, name: 1 }).toArray();
      sponsorNames = sponsorKeys.map(k => (rows.find(r => r.key === k) || {}).name || k);
    }

    const subject = `New ${config.showId} enquiry — ${c.name || 'Unknown'}${c.company ? ` (${c.company})` : ''}`;
    const body = [
      `A new enquiry came in from the ${config.showId} floorplan.`,
      '',
      `Name:     ${c.name || '—'}`,
      `Email:    ${c.email || '—'}`,
      `Phone:    ${c.phone || '—'}`,
      `Company:  ${c.company || '—'}`,
      '',
      `Stands of interest:  ${stands}`,
      `Sponsorship interest: ${sponsorNames.length ? sponsorNames.join(', ') : 'none'}`,
      '',
      `Message: ${lead.message || '—'}`,
      '',
      `Received: ${new Date(lead.createdAt).toLocaleString('en-GB')}`,
      `Assigned to: ${member.name}`,
    ].join('\n');

    const to = member.email;
    const cc = salesTeam.MANAGER.email;

    // Fire the webhook if configured — this is where real automation plugs in.
    if (config.notifyWebhook) {
      fetch(config.notifyWebhook, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'enquiry.forward', to, cc, subject, body, lead }),
      }).catch(e => console.error('Forward webhook failed:', e.message));
    }

    await inquiries.assign(new ObjectId(req.params.id), member);
    await inquiries.recordSend(new ObjectId(req.params.id), { to, cc, by: req.admin?.user });

    res.json({ ok: true, to, cc, subject, body, webhook: !!config.notifyWebhook });
  } catch (e) { next(e); }
});

// Move a lead through the pipeline: new → contacted → won / lost.
router.patch('/inquiries/:id', async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const r = await inquiries.setStatus(new ObjectId(req.params.id), req.body?.status);
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) { next(e); }
});

// Recent activity for one stand — replaces the 20-entry in-memory clickHistory.
router.get('/booths/:n/activity', async (req, res, next) => {
  try {
    const rows = await getDb().collection('activity')
      .find({ showId: config.showId, boothNumber: String(req.params.n) })
      .sort({ ts: -1 }).limit(Number(req.query.limit) || 25).toArray();
    res.json(rows);
  } catch (e) { next(e); }
});

// ─── Demand heatmap ───────────────────────────────────────────────────────────
// Pre-aggregated so the dashboard reads a summary rather than scanning the
// full event stream.
router.get('/analytics/demand', async (req, res, next) => {
  try {
    const days  = Number(req.query.days) || 30;
    const since = new Date(Date.now() - days * 86400_000);

    const rows = await getDb().collection('activity').aggregate([
      { $match: { showId: config.showId, ts: { $gte: since }, boothNumber: { $ne: null },
                  type: { $in: ['booth.click', 'booth.view', 'booth.dwell'] } } },
      { $group: {
          _id: '$boothNumber',
          clicks:   { $sum: { $cond: [{ $eq: ['$type', 'booth.click'] }, 1, 0] } },
          views:    { $sum: { $cond: [{ $eq: ['$type', 'booth.view'] },  1, 0] } },
          dwellMs:  { $sum: { $ifNull: ['$meta.ms', 0] } },
          sessions: { $addToSet: '$sessionId' },
      } },
      { $project: { boothNumber: '$_id', _id: 0, clicks: 1, views: 1, dwellMs: 1,
                    uniqueSessions: { $size: '$sessions' } } },
      { $sort: { clicks: -1 } },
    ]).toArray();

    res.json({ since, days, booths: rows });
  } catch (e) { next(e); }
});

// ─── Funnel ───────────────────────────────────────────────────────────────────
router.get('/analytics/funnel', async (req, res, next) => {
  try {
    const days  = Number(req.query.days) || 30;
    const since = new Date(Date.now() - days * 86400_000);
    const act   = getDb().collection('activity');

    const [sessions, browsed, clicked, inquired] = await Promise.all([
      act.distinct('sessionId', { showId: config.showId, ts: { $gte: since }, type: 'session.start' }),
      act.distinct('sessionId', { showId: config.showId, ts: { $gte: since }, type: 'booth.view' }),
      act.distinct('sessionId', { showId: config.showId, ts: { $gte: since }, type: 'booth.click' }),
      act.distinct('sessionId', { showId: config.showId, ts: { $gte: since }, type: 'inquiry.submit' }),
    ]);

    const n = a => a.filter(Boolean).length;
    res.json({ since, days, steps: [
      { step: 'Visited',  count: n(sessions) },
      { step: 'Viewed a stand', count: n(browsed) },
      { step: 'Clicked a stand', count: n(clicked) },
      { step: 'Enquired', count: n(inquired) },
    ] });
  } catch (e) { next(e); }
});

// ─── Audit trail ──────────────────────────────────────────────────────────────
router.get('/audit', async (req, res, next) => {
  try {
    const rows = await getDb().collection('activity')
      .find({ showId: config.showId,
              type: { $in: ['booth.status_change', 'deal.update', 'hold.create',
                            'hold.release', 'hold.expire', 'security.denied'] } })
      .sort({ ts: -1 }).limit(Number(req.query.limit) || 200).toArray();
    res.json(rows);
  } catch (e) { next(e); }
});

module.exports = router;
