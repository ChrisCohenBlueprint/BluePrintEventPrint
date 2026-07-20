const express   = require('express');
const { ObjectId } = require('mongodb');

const config    = require('../config');
const booths    = require('../models/booths');
const inquiries = require('../models/inquiries');
const holds     = require('../services/holds');
const { getDb } = require('../db');

const router = express.Router();

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
