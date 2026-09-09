const fs = require('fs');
const path = require('path');
const express = require('express');
const sponsors = require('../models/sponsors');
const partners = require('../models/partners');
const countries = require('../data/countries');
const floorplans = require('../models/floorplans');
const shows = require('../models/shows');
const config = require('../config');

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

// The built-in country list, for the admin's assign dropdown and the public
// floorplan's search filter. Static data with no per-show state, so it is
// public and cacheable — the alternative (pushing 249 rows down the socket on
// every connect) would cost every visitor the same bytes on every reconnect.
router.get('/countries', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.json({ countries: countries.COUNTRIES.map(c => ({ code: c.code, name: c.name, flag: c.flag, aliases: c.aliases })) });
});

/**
 * The current show's floorplan artwork.
 *
 * Public, because the plan itself is public. Served from the database when a
 * plan has been uploaded for this show, and otherwise from the file shipped in
 * the repo — which is what keeps the event already running working with no
 * migration and no upload.
 *
 * Cached hard but keyed by version, so a newly uploaded plan is fetched rather
 * than the browser reusing the old one.
 */
router.get('/floorplan.svg', async (req, res, next) => {
  try {
    // ?show=lna asks for a named event rather than the one this request is
    // scoped to — that is what lets Settings show every event's plan side by
    // side. An unknown slug falls back to the current show rather than
    // erroring: a broken preview should not be a broken page.
    const named = req.query.show ? shows.bySlug(String(req.query.show)) : null;
    const stored = await floorplans.get(named ? named.showId : undefined);
    res.type('image/svg+xml');
    if (stored && stored.svg) {
      res.set('ETag', `"${stored.version}"`);
      res.set('Cache-Control', 'public, max-age=300');
      if (req.get('If-None-Match') === `"${stored.version}"`) return res.status(304).end();
      return res.send(stored.svg);
    }
    // Nothing uploaded for this show: the artwork that ships with the app.
    const file = path.join(__dirname, '..', '..', 'public',
                           String(config.floorplanSvg).replace(/^\//, ''));
    res.set('Cache-Control', 'public, max-age=300');
    return res.sendFile(file);
  } catch (e) { next(e); }
});

module.exports = router;
