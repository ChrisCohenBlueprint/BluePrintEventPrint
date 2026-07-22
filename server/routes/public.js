const fs = require('fs');
const path = require('path');
const express = require('express');
const sponsors = require('../models/sponsors');
const partners = require('../models/partners');

const router = express.Router();

// The original file-based strip. Moving management into the database left this
// unused, and with no rows added yet the strip vanished from the public page —
// so it stays as the fallback. Anything added in the admin takes over; until
// then the file's contents show, exactly as before.
const FALLBACK = path.join(__dirname, '..', '..', 'public', 'sponsors', 'sponsors.json');
function fileFallback() {
  try {
    const cfg = JSON.parse(fs.readFileSync(FALLBACK, 'utf8'));
    return (Array.isArray(cfg.sponsors) ? cfg.sponsors : [])
      .filter(s => s && s.image)
      .map(s => ({ name: s.name || '', image: s.image, url: s.url || null, alt: s.alt || s.name || '' }));
  } catch { return []; }
}

// Partner logos for the "In partnership with" strip. Public and safe: only the
// image, link and name are exposed.
router.get('/partners', async (_req, res, next) => {
  try {
    const list = await partners.publicList();
    res.json({ partners: list.length ? list : fileFallback() });
  } catch (e) { next(e); }
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
