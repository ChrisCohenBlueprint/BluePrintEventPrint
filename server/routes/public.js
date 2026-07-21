const express = require('express');
const sponsors = require('../models/sponsors');

const router = express.Router();

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
