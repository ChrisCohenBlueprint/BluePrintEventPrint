const express = require('express');
const sponsors = require('../models/sponsors');
const partners = require('../models/partners');

const router = express.Router();

// Partner logos for the "In partnership with" strip. Public and safe: only the
// image, link and name are exposed.
router.get('/partners', async (_req, res, next) => {
  try { res.json({ partners: await partners.publicList() }); } catch (e) { next(e); }
});

// Public, unauthenticated — mounted before adminAuth. Returns the sponsorship
// catalogue ranked for a booth of the given size, with NO prices. Ranking is
// done server-side (using price); the buyer only ever sees names, tiers and
// perks. Sales cover cost in follow-up.
router.get('/sponsors/recommend', async (req, res, next) => {
  try {
    const sqm = Number(req.query.sqm) || 0;
    res.json({ sponsors: await sponsors.recommend(sqm) });
  } catch (e) { next(e); }
});

module.exports = router;
