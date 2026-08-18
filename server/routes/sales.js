const express = require('express');

const config   = require('../config');
const auth     = require('../auth');
const booths   = require('../models/booths');
const sponsors = require('../models/sponsors');
const settings = require('../models/settings');
const users    = require('../models/users');
const menus    = require('../models/menus');
const { sendPage } = require('../lib/send-page');
const { track } = require('../services/tracking');

/**
 * The sales sub-admin surface.
 *
 * Reps sign in through the same password + 2FA flow as an administrator, but
 * their role only unlocks this router: remaining inventory, and the bespoke
 * client proposals they build from it. Nothing here can change the floorplan.
 *
 * Mounted BEFORE adminAuth in server.js, so /api/sales/* is served here rather
 * than being swallowed by the admin guard's blanket /api/* rule.
 */
const router = express.Router();

// Every route below is behind the sales guard, which admits reps, admins and
// the owner and populates req.account.
router.use(auth.salesAuth);

const isAdmin = (req) => auth.ADMIN_ROLES.includes(req.account?.role);
// Admins and the owner see every rep's proposals; a rep sees only their own.
const scope = (req) => ({ all: isAdmin(req) });

// Audit line for a proposal action. Best-effort: a tracking hiccup must never
// fail the rep's actual request. The actor is stamped as its own 'sales' kind so
// rep activity is distinguishable from admin activity in the audit stream.
function auditMenu(req, type, meta = {}) {
  try { track({ type, boothNumber: null, actor: { kind: 'sales', userId: req.account?.user || 'unknown' }, meta }); }
  catch { /* audit best-effort */ }
}

// ─── Pages ────────────────────────────────────────────────────────────────────
router.get('/sales', (_req, res) => sendPage(res, 'sales.html'));

// The printable proposal. Behind the same auth as the rest — the client is sent
// the PDF the rep produces here, never a link to this page.
router.get('/sales/menu/:id/print', (_req, res) => sendPage(res, 'menu-print.html'));

// ─── Who am I ─────────────────────────────────────────────────────────────────
router.get('/api/sales/me', async (req, res, next) => {
  try {
    const account = await users.findByUsername(req.account.user);
    res.json({
      user: req.account.user,
      role: req.account.role,
      // Falls back to the username so the dashboard always has something to
      // greet the rep with, even before a display name is set.
      name: account?.displayName || req.account.user,
      email: account?.email || '',
      isAdmin: isAdmin(req),
      showId: config.showId,
    });
  } catch (e) { next(e); }
});

// ─── Remaining inventory ──────────────────────────────────────────────────────
/**
 * Everything a rep can still sell.
 *
 * Sponsorship: active and not sold out — the "remaining" the rep asked for.
 * Prices ARE included here, because this is the internal view a rep pitches
 * from; the client-facing proposal strips them unless the rep opts in.
 *
 * Stands: available only. Held and sold stands are excluded so a rep cannot
 * propose floor space that is already spoken for. Deal notes and the booked
 * company are never sent — those stay in the admin console.
 */
router.get('/api/sales/catalogue', async (_req, res, next) => {
  try {
    const [allSponsors, allBooths, rate] = await Promise.all([
      sponsors.all(), booths.all(), settings.rate(),
    ]);

    const remaining = allSponsors
      .filter(s => s.active !== false && s.soldOut !== true)
      .map(s => ({
        key: s.key, name: s.name, tier: s.tier,
        availability: s.availability, blurb: s.blurb, perks: s.perks || [],
        image: s.image || '', price: s.price ?? null,
      }))
      .sort((a, b) => ({ platinum: 0, gold: 1, silver: 2 }[a.tier] ?? 9) -
                      ({ platinum: 0, gold: 1, silver: 2 }[b.tier] ?? 9) ||
                      String(a.name).localeCompare(String(b.name)));

    // Sold-out packages are reported as a count only — useful context for a rep
    // ("the headline went last week") without cluttering what they can select.
    const soldOutCount = allSponsors.filter(s => s.soldOut === true).length;

    const available = allBooths
      .filter(b => b.status === 'available')
      .map(b => ({
        boothNumber: b.boothNumber,
        displayNumber: b.displayNumber || null,
        sqm: b.sqm,
        listPrice: b.listPrice ?? null,
      }))
      .sort((a, b) => String(a.boothNumber).localeCompare(String(b.boothNumber), undefined, { numeric: true }));

    res.json({ sponsors: remaining, soldOutCount, booths: available, rate, showId: config.showId });
  } catch (e) { next(e); }
});

// ─── Menus (bespoke client proposals) ─────────────────────────────────────────
router.get('/api/sales/menus', async (req, res, next) => {
  try { res.json(await menus.listFor(req.account.user, scope(req))); }
  catch (e) { next(e); }
});

router.post('/api/sales/menus', async (req, res, next) => {
  try {
    const menu = await menus.create(req.account.user, req.body || {});
    auditMenu(req, 'menu.create', { ref: menu.ref });
    res.json(menu);
  } catch (e) { next(e); }
});

router.get('/api/sales/menus/:id', async (req, res, next) => {
  try {
    const menu = await menus.get(req.params.id, req.account.user, scope(req));
    if (!menu) return res.status(404).json({ error: 'Proposal not found.' });
    res.json(menu);
  } catch (e) { next(e); }
});

router.patch('/api/sales/menus/:id', async (req, res, next) => {
  try {
    const menu = await menus.update(req.params.id, req.account.user, req.body || {}, scope(req));
    if (!menu) return res.status(404).json({ error: 'Proposal not found.' });
    res.json(menu);
  } catch (e) { next(e); }
});

router.post('/api/sales/menus/:id/duplicate', async (req, res, next) => {
  try {
    const menu = await menus.duplicate(req.params.id, req.account.user, scope(req));
    if (!menu) return res.status(404).json({ error: 'Proposal not found.' });
    res.json(menu);
  } catch (e) { next(e); }
});

router.delete('/api/sales/menus/:id', async (req, res, next) => {
  try {
    const ok = await menus.remove(req.params.id, req.account.user, scope(req));
    if (ok) auditMenu(req, 'menu.delete', { id: req.params.id });
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'Proposal not found.' });
  } catch (e) { next(e); }
});

/**
 * Resolve a saved menu into the finished document the print page renders.
 *
 * The selection is expanded against LIVE inventory, so anything that sold or was
 * withdrawn since drafting comes back flagged `unavailable` instead of being
 * presented to a client as still buyable. Prices are attached ONLY when the rep
 * ticked "show prices" on this proposal — the default document is price-free,
 * matching the public floorplan, and sales cover cost in conversation.
 */
router.get('/api/sales/menus/:id/print', async (req, res, next) => {
  try {
    const menu = await menus.get(req.params.id, req.account.user, scope(req));
    if (!menu) return res.status(404).json({ error: 'Proposal not found.' });

    const withPrices = menu.showPrices === true;

    const [allSponsors, allBooths, floorplanSponsor, owner] = await Promise.all([
      sponsors.all(), booths.all(), sponsors.getFloorplanSponsor(),
      users.findByUsername(menu.owner),
    ]);

    const sponsorById = new Map(allSponsors.map(s => [s.key, s]));
    const boothById   = new Map(allBooths.map(b => [b.boothNumber, b]));

    const sponsorItems = (menu.sponsorKeys || []).map(key => {
      const s = sponsorById.get(key);
      if (!s) return { key, name: key, missing: true, unavailable: true };
      return {
        key, name: s.name, tier: s.tier, blurb: s.blurb,
        availability: s.availability, perks: s.perks || [], image: s.image || '',
        // Withdrawn (inactive) counts as unavailable too, not just sold out.
        unavailable: s.soldOut === true || s.active === false,
        soldOut: s.soldOut === true,
        price: withPrices ? (s.price ?? null) : undefined,
      };
    });

    const boothItems = (menu.boothNumbers || []).map(n => {
      const b = boothById.get(n);
      if (!b) return { boothNumber: n, missing: true, unavailable: true };
      return {
        boothNumber: b.boothNumber,
        displayNumber: b.displayNumber || null,
        sqm: b.sqm,
        status: b.status,
        unavailable: b.status !== 'available',
        price: withPrices ? (b.listPrice ?? null) : undefined,
      };
    });

    /**
     * The floorplan figure: the artwork to draw, plus every stand's position so
     * the page can mark the proposed ones on it.
     *
     * The WHOLE plan is sent, not just the selection — the client needs the hall
     * around their stands for the highlight to mean anything, and the page maps
     * stands onto the artwork by geometry exactly as the public floorplan does.
     *
     * Deliberately minimal per stand: number, footprint, size and status. No
     * company, no price, no deal notes — this document goes to a client, and the
     * plan must not become a back door to the commercial data the rest of the
     * proposal is careful about. Status is included because it is already public
     * on the floorplan and it is what makes "here is what is left" legible.
     *
     * Omitted entirely for a sponsorship-only proposal, or when the rep has
     * turned the plan off — the page then simply has no figure to draw.
     */
    const highlight = boothItems.filter(b => !b.unavailable).map(b => b.boothNumber);
    const plan = (menu.showPlan !== false && boothItems.length) ? {
      svg: config.floorplanSvg,
      highlight,
      booths: allBooths
        .filter(b => b.geometry)
        .map(b => ({
          boothNumber: b.boothNumber,
          displayNumber: b.displayNumber || null,
          geometry: b.geometry,
          sqm: b.sqm,
          status: b.status,
          splitFrom: b.splitFrom || null,
          splitAxis: b.splitAxis || null,
        })),
    } : null;

    const custom = (menu.custom || []).map(c => ({
      title: c.title, detail: c.detail,
      price: withPrices ? (c.price ?? null) : undefined,
    }));

    // Only meaningful when prices are shown, and only over what the client can
    // actually still buy — totalling a withdrawn package would overstate the quote.
    const total = withPrices
      ? [...sponsorItems, ...boothItems, ...custom]
          .filter(i => !i.unavailable)
          .reduce((sum, i) => sum + (Number(i.price) || 0), 0)
      : null;

    res.json({
      ref: menu.ref,
      title: menu.title || 'Sponsorship & Stand Proposal',
      client: { name: menu.clientName, company: menu.clientCompany, email: menu.clientEmail },
      intro: menu.intro || '',
      preparedBy: { name: owner?.displayName || menu.owner, email: owner?.email || '' },
      showId: config.showId,
      floorplanSponsor,
      showPrices: withPrices,
      sponsors: sponsorItems,
      booths: boothItems,
      plan,
      custom,
      total,
      createdAt: menu.createdAt,
      updatedAt: menu.updatedAt,
    });
  } catch (e) { next(e); }
});

module.exports = router;
