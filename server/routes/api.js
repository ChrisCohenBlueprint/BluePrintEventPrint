const express   = require('express');
const { ObjectId } = require('mongodb');

const config    = require('../config');
const booths    = require('../models/booths');
const inquiries = require('../models/inquiries');
const sponsors  = require('../models/sponsors');
const users     = require('../models/users');
const auth      = require('../auth');
const partners  = require('../models/partners');
const planAreas = require('../models/plan-areas');
const showsModel = require('../models/shows');
const floorplans = require('../models/floorplans');
const settings   = require('../models/settings');
const { extractStands, stripExhibitorNames, paletteOf } = require('../lib/extract-stands');
const showContext = require('../show-context');
const boothsModel = require('../models/booths');
const sockets   = require('../sockets');
const planAreaData = new Map(require('../data/plan-areas').AREAS.map(a => [a.key, a]));
const holds     = require('../services/holds');
const { getDb } = require('../db');
const { track } = require('../services/tracking');
const csv       = require('../lib/csv');

const router = express.Router();

/**
 * Re-enter your own password to confirm a change.
 *
 * The same gate the €/unit rate and releasing a stand already use: an
 * authenticated session is not enough for something this consequential,
 * because a session left open on an unattended machine is not the person.
 *
 * Sent as a header rather than in the body, because the floorplan upload's body
 * IS the SVG. The failure path absorbs the attempt against a decoy hash so a
 * wrong password takes the same time as a right one — a fast rejection tells an
 * attacker the username was wrong.
 */
async function confirmPassword(req, res, what) {
  const who = req.admin?.user;

  // Five wrong passwords buy this account a pause. Without it the gate below
  // could be guessed at full speed by whoever already holds the session — which
  // is the exact situation it exists to survive — and a wrong attempt reached
  // no log at all. The throttle is per-account and only gates re-confirmation,
  // so it can never lock anyone out of signing in.
  const gate = auth.checkSecretThrottle(who);
  if (!gate.ok) {
    res.status(429).json({
      error: `Too many incorrect passwords — wait ${Math.ceil(gate.retryAfter / 60)} minute(s) and try again. ${cap(what)}.`,
    });
    return false;
  }

  const supplied = String(req.get('X-Confirm-Password') || '');
  const account = await users.findByUsername(who);
  // AWAITED. verifyPassword hashes on a worker now, so it returns a promise —
  // and an un-awaited promise is truthy, which makes `!verifyPassword(…)`
  // always false. Every password, right or wrong, would have been accepted here.
  if (!account || !await users.verifyPassword(supplied, account.passwordHash)) {
    await users.absorbPassword(supplied);      // constant-time on the failure path
    auth.registerSecretFailure(who, { what });
    res.status(403).json({ error: `Password incorrect — ${what}.` });
    return false;
  }
  auth.clearSecretFailures(who);
  return true;
}

/** Sentence-case a clause like "the floorplan was not changed". */
const cap = (s) => (s ? String(s)[0].toUpperCase() + String(s).slice(1) : '');

// ─── Floorplan artwork ───────────────────────────────────────────────────────
// One plan per show. Uploaded as a RAW body rather than JSON: a 2 MB SVG
// base64'd into a JSON string would breach the 3 MB body limit the rest of the
// app uses, and there is no reason to encode it at all.
const rawSvg = express.text({ type: ['image/svg+xml', 'text/plain', 'application/octet-stream'],
                              limit: '8mb' });

/**
 * Every event's artwork at once, for the Settings page that shows them side by
 * side. One row per event rather than one request per event, so the page does
 * not fan out and half-render while the rest arrive.
 */
router.get('/floorplans', async (_req, res, next) => {
  try {
    const rows = await Promise.all(showsModel.list().map(sh =>
      showContext.runAs(sh.showId, async () => {
        const id = sh.showId || config.defaultShow;
        const f = await floorplans.get(id);
        const boothCount = await boothsModel.col().countDocuments({ showId: id });
        return {
          slug: sh.slug, showId: id, name: sh.name || id, active: sh.active !== false,
          uploaded: !!f,
          filename: f ? f.filename : config.floorplanSvg,
          bytes: f ? f.bytes : null,
          uploadedAt: f ? f.uploadedAt : null,
          uploadedBy: f ? f.uploadedBy : null,
          // Only for plans that were uploaded. Artwork shipped with the app is
          // deliberately not scored: it belongs to a running show that is not
          // being changed, and a failing badge on it would only invite someone
          // to "fix" a live event.
          spec: f && f.spec ? { passed: f.spec.passed, total: f.spec.total,
                                failedClauses: f.spec.failedClauses } : null,
          boothCount,
        };
      })));
    res.json(rows);
  } catch (e) { next(e); }
});

router.get('/floorplan/meta', async (_req, res, next) => {
  try {
    const f = await floorplans.get();
    const booths = await boothsModel.col().countDocuments({ showId: config.showId });
    res.json(f
      ? { uploaded: true, filename: f.filename, bytes: f.bytes,
          uploadedAt: f.uploadedAt, uploadedBy: f.uploadedBy, boothCount: booths }
      : { uploaded: false, filename: config.floorplanSvg, boothCount: booths });
  } catch (e) { next(e); }
});

router.post('/floorplan', rawSvg, async (req, res, next) => {
  try {
    if (!await confirmPassword(req, res, 'the floorplan was not changed')) return;
    const r = await floorplans.save(req.body, {
      filename: String(req.get('X-Filename') || 'floorplan.svg'),
      actor: req.admin?.user || null,
    });
    if (!r.ok) {
      const why = r.reason === 'empty'     ? 'the file was empty'
                : r.reason === 'not_svg'   ? 'that does not look like an SVG'
                : r.reason === 'too_large' ? 'the file is larger than 8 MB'
                : 'it could not be stored';
      return res.status(400).json({ error: `Could not upload the floorplan — ${why}.` });
    }
    track({ type: 'floorplan.upload', boothNumber: null, actor: req.admin?.user || 'unknown',
            meta: { bytes: r.bytes, removed: r.removed } });
    res.json({ ok: true, ...r });
  } catch (e) { next(e); }
});


/**
 * What the stored artwork says this event's stands are.
 *
 * A preview: it reads and reports, and writes nothing. Import is a separate,
 * password-gated call, because reading a plan is cheap and reversible while
 * replacing an event's inventory is neither.
 */
router.get('/stands/preview', async (_req, res, next) => {
  try {
    const f = await floorplans.get();
    if (!f || !f.svg) {
      return res.json({ ok: false, reason: 'no_artwork',
        message: 'No floorplan has been uploaded for this event yet.' });
    }
    const r = extractStands(f.svg);
    // The same measure the import itself applies, so the button the admin sees
    // and the answer it gets can never disagree.
    const committed = await booths.countCommitted();
    res.json({
      ok: true,
      stands: r.stands.filter(s => !s.sponsored).length,
      named: r.stands.filter(s => !s.sponsored && s.exhibitor).length,
      // What the plan's own colours say each stand is.
      byStatus: r.stands.filter(s => !s.sponsored)
        .reduce((a, s) => { a[s.status] = (a[s.status] || 0) + 1; return a; }, {}),
      // Sponsorable space — counted, but not imported as stands.
      sponsored: r.stands.filter(s => s.sponsored).length,
      areas: r.stands.filter(s => s.sponsored).map(s => s.exhibitor || s.number),
      fills: r.fills,
      unit: r.unit,
      totalArea: r.stands.reduce((a, s) => a + (s.area || 0), 0),
      warnings: r.warnings,
      // Named so the admin can say plainly why import is unavailable rather
      // than offering a button that fails.
      committed,
      existing: await booths.col().countDocuments({ showId: config.showId }),
      sample: r.stands.filter(s => !s.sponsored).slice(0, 10)
        .map(s => ({ number: s.number, area: s.area, exhibitor: s.exhibitor, status: s.status })),
    });
  } catch (e) { next(e); }
});

/**
 * Read the stands out of this event's artwork and make them its inventory.
 *
 * Two writes, in this order, so a failure cannot leave names shown twice:
 * the stands are imported first, and only then is the artwork re-stored with
 * its printed exhibitor names removed. If the second write fails the names are
 * drawn from our data over the artwork's own — visibly wrong, and fixable by
 * re-running — whereas the reverse leaves stands with no names at all and no
 * indication why.
 */
router.post('/stands/import', async (req, res, next) => {
  try {
    if (!await confirmPassword(req, res, 'no stands were imported')) return;

    const f = await floorplans.get();
    if (!f || !f.svg) {
      return res.status(400).json({ error: 'No floorplan has been uploaded for this event yet.' });
    }

    const r = extractStands(f.svg);   // the original, names intact
    if (!r.stands.length) {
      return res.status(400).json({
        error: 'No stands could be read from this floorplan.',
        detail: r.warnings[0] || null,
      });
    }

    // Lounges, conference tracks and the like are sponsorable space, not
    // sellable stands, so they are left in the artwork rather than becoming
    // inventory with a status and a price.
    const sellable = r.stands.filter(s => !s.sponsored);
    const out = await booths.importFromArtwork(sellable, {
      actor: req.admin?.user || null,
      force: req.query.force === '1',
    });
    if (!out.ok) {
      if (out.reason === 'has_bookings') {
        return res.status(409).json({
          error: `This event already has ${out.committed} stands sold or on hold. Importing replaces every stand, so it is refused here — bookings would be lost.`,
        });
      }
      return res.status(400).json({ error: 'The stands could not be imported.' });
    }

    // The unit follows the plan: it printed ft² or m², and that is the truth
    // for this event. It is a display label, so this changes no number.
    if (r.unit) await settings.setUnit(r.unit === 'sqft' ? 'ft' : 'm');

    // Paint the app in the colours this plan is drawn in, so a stand keeps the
    // colour the designer chose for it instead of the hall being repainted in
    // another event's palette.
    try { await settings.setPalette(paletteOf(r.fills)); }
    catch (e) { console.error('Stand import: palette not stored —', e.message); }

    // Now the artwork's own names come out of the copy we SHOW, so ours are the
    // only ones drawn. The uploaded original keeps its names: overwriting it
    // destroyed the only place they existed, and the next import then produced
    // 99 stands with no exhibitors and no way back.
    let namesRemoved = 0;
    try {
      // Every name the plan prints inside a shape, including any on shapes
      // dropped as duplicates — those have no stand of ours to draw over them,
      // so if they are left they stay printed for good.
      const stripped = stripExhibitorNames(f.svg, r.printedNames);
      if (stripped.removed) {
        const saved = await floorplans.setDisplaySvg(stripped.svg);
        if (saved.ok) namesRemoved = stripped.removed;
      }
    } catch (e) {
      // Not fatal: the stands are in, and the only symptom is the artwork's
      // old names showing under ours until this is run again.
      console.error('Stand import: could not strip printed names —', e.message);
    }

    // The stands are in the database; now make the running server aware of
    // them. Without this the import is invisible to every open page — and to
    // every page opened afterwards, since the cache is only warmed at boot.
    try { await sockets.notifyStands(); }
    catch (e) { console.error('Stand import: viewers not refreshed —', e.message); }

    track({ type: 'stands.import', boothNumber: null, actor: req.admin?.user || 'unknown',
            meta: { imported: out.imported, sold: out.sold, replaced: out.replaced } });
    res.json({ ok: true, ...out, namesRemoved, unit: r.unit,
               areasSkipped: r.stands.length - sellable.length, warnings: r.warnings });
  } catch (e) { next(e); }
});

router.delete('/floorplan', async (req, res, next) => {
  try {
    if (!await confirmPassword(req, res, 'the floorplan was not removed')) return;
    const gone = await floorplans.remove();
    track({ type: 'floorplan.revert', boothNumber: null, actor: req.admin?.user || 'unknown', meta: {} });
    res.json({ ok: true, reverted: gone });
  } catch (e) { next(e); }
});

// ─── Shows ───────────────────────────────────────────────────────────────────
// The events this deployment serves. Listed for any admin; created and edited
// by the owner only — adding a show adds a whole parallel set of data, and
// retiring one takes an event off the air.
router.get('/shows', async (_req, res, next) => {
  try { res.json(showsModel.list()); } catch (e) { next(e); }
});

router.post('/shows', requireOwner, async (req, res, next) => {
  try {
    const r = await showsModel.create(req.body || {});
    if (!r.ok) {
      const why = r.reason === 'bad_slug'   ? 'the URL name must be lowercase letters, numbers or dashes'
                : r.reason === 'bad_id'     ? 'the show id must be letters, numbers, - or _'
                : r.reason === 'slug_taken' ? 'that URL name is already used'
                : r.reason === 'id_taken'   ? 'that show id already exists'
                : 'it could not be created';
      return res.status(400).json({ error: `Could not add the show — ${why}.` });
    }
    auditTeam(req, 'show.create', r.show.showId, { slug: r.show.slug });
    // A new show starts with no cached state; warm it so it serves immediately.
    try { await sockets.refreshAll(); } catch (e) { console.error('Warm failed:', e.message); }
    res.status(201).json(r.show);
  } catch (e) { next(e); }
});

router.patch('/shows/:showId', requireOwner, async (req, res, next) => {
  try {
    const r = await showsModel.update(req.params.showId, req.body || {});
    if (!r.ok) {
      return res.status(r.reason === 'missing' ? 404 : 400).json({
        error: r.reason === 'missing'    ? 'No such show.'
             : r.reason === 'slug_taken' ? 'That URL name is already used.'
             : 'The URL name must be lowercase letters, numbers or dashes.' });
    }
    auditTeam(req, 'show.update', req.params.showId, req.body || {});
    res.json(r.show);
  } catch (e) { next(e); }
});

// ─── Team: admin accounts ─────────────────────────────────────────────────────
// Behind adminAuth like everything under /api. Creating/removing accounts and
// resetting a colleague's password or 2FA is restricted to the OWNER — any
// admin could otherwise set a peer's password and log in as them. A new admin
// gets a username + temporary password, shares it out of band, and sets up
// their own 2FA on first login.
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

// Owner-only guard for the team-management routes.
function requireOwner(req, res, next) {
  if (req.admin?.role === 'owner') return next();
  return res.status(403).json({ error: 'Only the owner account can manage team members.' });
}

// One line in the audit stream per team-management action, so account changes
// are attributable after the fact (previously they were unlogged).
function auditTeam(req, action, target, meta = {}) {
  try { track({ type: 'admin.team', boothNumber: null, actor: req.admin?.user || 'unknown',
                meta: { action, target, ...meta } }); } catch { /* audit best-effort */ }
}

// Same idea for lead management (archive/restore/delete), so a removed enquiry
// is at least attributable in the audit stream.
function auditLead(req, action, leadId, meta = {}) {
  try { track({ type: 'lead.admin', boothNumber: null, actor: req.admin?.user || 'unknown',
                meta: { action, leadId, ...meta } }); } catch { /* audit best-effort */ }
}

// Listing the team is readable by any admin; mutations below require owner.
router.get('/admins', async (_req, res, next) => {
  try { res.json(await users.list()); } catch (e) { next(e); }
});

router.post('/admins', requireOwner, async (req, res, next) => {
  try {
    const username = String(req.body?.username || '').toLowerCase().trim();
    const password = String(req.body?.password || '');
    // Only these two tiers can be created here. 'owner' is deliberately not
    // offered — it is the recovery anchor and is set from the bootstrap env, so
    // the API must never be able to mint a second one.
    const role = req.body?.role === 'sales' ? 'sales' : 'admin';
    const displayName = String(req.body?.displayName || '').trim();
    const email = String(req.body?.email || '').trim();

    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username must be 2–32 chars: letters, numbers, . _ -' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (await users.findByUsername(username)) return res.status(409).json({ error: 'That username already exists.' });

    await users.upsert({ username, password, role, displayName, email });
    // One-time invite code — must be shared out of band and entered on first
    // login, so the temp password alone can't claim the account.
    const claim = await users.issueClaimCode(username);
    auditTeam(req, 'create', username, { role });
    res.json({ ok: true, username, role, claim });
  } catch (e) { next(e); }
});

/**
 * Move an account between the admin and sales tiers.
 *
 * Owner-only, like every other team mutation, and it revokes the target's live
 * session (users.setRole bumps tokenVersion) — otherwise an admin demoted to
 * sales would keep full admin authority until their 12h token expired.
 */
router.patch('/admins/:username/role', requireOwner, async (req, res, next) => {
  try {
    const role = req.body?.role;
    if (!['admin', 'sales'].includes(role)) return res.status(400).json({ error: 'Role must be admin or sales.' });
    const target = String(req.params.username || '').toLowerCase().trim();
    // Changing your own role could drop you out of the console mid-session.
    if (req.admin?.user === target) return res.status(400).json({ error: 'You cannot change your own role.' });
    const ok = await users.setRole(target, role);
    if (!ok) return res.status(400).json({ error: 'No such account, or it is the owner.' });
    auditTeam(req, 'set-role', target, { role });
    res.json({ ok: true, role });
  } catch (e) { next(e); }
});

/** Set a member's display name / email — what a rep's proposals are signed with. */
router.patch('/admins/:username/profile', requireOwner, async (req, res, next) => {
  try {
    const ok = await users.setProfile(req.params.username, {
      displayName: req.body?.displayName, email: req.body?.email,
    });
    if (!ok) return res.status(404).json({ error: 'No such account.' });
    auditTeam(req, 'set-profile', req.params.username);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/admins/:username/reset-2fa', requireOwner, async (req, res, next) => {
  try {
    const target = await users.findByUsername(req.params.username);
    const ok = await users.resetTotp(req.params.username);
    if (!ok) return res.status(404).json({ error: 'No such account.' });
    // Re-enrolling an admin needs a fresh invite code, else a reset would re-open
    // the temp-password-only claim window. The OWNER is exempt: it is the
    // recovery anchor, so it must always be able to re-enrol from its password
    // alone (a lost invite code could otherwise lock everyone out permanently).
    const claim = target?.role === 'owner' ? null : await users.issueClaimCode(req.params.username);
    auditTeam(req, 'reset-2fa', req.params.username);
    res.json({ ok: true, claim });
  } catch (e) { next(e); }
});

router.post('/admins/:username/password', requireOwner, async (req, res, next) => {
  try {
    const password = String(req.body?.password || '');
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const ok = await users.setPassword(req.params.username, password);
    if (ok) auditTeam(req, 'set-password', req.params.username);
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'No such account.' });
  } catch (e) { next(e); }
});

router.delete('/admins/:username', requireOwner, async (req, res, next) => {
  try {
    const target = String(req.params.username || '').toLowerCase().trim();
    // Never leave the system with no admins — that would lock everyone out.
    if (await users.count() <= 1) return res.status(400).json({ error: 'Cannot delete the last admin.' });
    // Deleting the account you are signed in as would be confusing; block it.
    if (req.admin && req.admin.user === target) return res.status(400).json({ error: 'You cannot delete your own account.' });
    // The owner account is the team-management tier; removing it via the API
    // would orphan that authority. It is managed through the bootstrap env.
    const targetAccount = await users.findByUsername(target);
    if (targetAccount?.role === 'owner') return res.status(400).json({ error: 'The owner account cannot be deleted here.' });
    const ok = await users.remove(target);
    if (ok) auditTeam(req, 'delete', target);
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'No such account.' });
  } catch (e) { next(e); }
});

// ─── Sponsors (admin — includes price) ────────────────────────────────────────
router.get('/sponsors', async (_req, res, next) => {
  try { res.json(await sponsors.all()); } catch (e) { next(e); }
});

/**
 * Export the live catalogue as CSV — the other half of the import.
 *
 * The intended workflow is round-trip: download this, edit it in a spreadsheet,
 * upload it back. The `key` column is what matches a row to an existing package,
 * so it is exported first and should be left alone.
 */
router.get('/sponsors/export.csv', async (_req, res, next) => {
  try {
    const rows = await sponsors.toCsvRows();
    const body = csv.toCsv(sponsors.CSV_HEADERS, rows);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${config.showId}-sponsorship-${stamp}.csv"`);
    res.send(body);
  } catch (e) { next(e); }
});

/** A blank template with the headers and one worked example row. */
router.get('/sponsors/template.csv', (_req, res) => {
  const body = csv.toCsv(sponsors.CSV_HEADERS, [[
    '', 'Networking Lounge', 'platinum', '34950', '2 Available',
    'A branded lounge for visitors to relax and meet.',
    'Your branding throughout the lounge | Furniture in your colours | 20 VIP passes',
    '', '', 'true', 'false',
  ]]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="sponsorship-template.csv"');
  res.send(body);
});

/**
 * Bulk import. Rows are matched to existing packages on `key`, or on an exact
 * name when the key column is blank, so a spreadsheet edited without the key
 * still updates rather than duplicating.
 *
 * `dryRun` returns the same report without writing anything — the admin runs it
 * first and shows the summary for confirmation, so nobody discovers what an
 * upload did after the fact. `removeMissing` deletes packages the file does not
 * mention, making the spreadsheet the whole truth.
 */
router.post('/sponsors/import', async (req, res, next) => {
  try {
    const text = String(req.body?.csv ?? '');
    if (!text.trim()) return res.status(400).json({ error: 'That file is empty.' });
    if (text.length > 2_000_000) return res.status(400).json({ error: 'That file is too large (limit ~2 MB).' });

    const { headers, rows } = csv.parseCsvObjects(text);
    if (!headers.includes('name')) {
      return res.status(400).json({ error: 'The file needs a header row with at least a "name" column. Download the template to see the format.' });
    }
    if (!rows.length) return res.status(400).json({ error: 'That file has a header row but no packages under it.' });
    if (rows.length > 500) return res.status(400).json({ error: 'That file has more than 500 rows.' });

    const dryRun = req.body?.dryRun === true;
    const report = await sponsors.importRows(rows, { removeMissing: req.body?.removeMissing === true, dryRun });
    if (!dryRun) {
      track({ type: 'sponsor.import', boothNumber: null, actor: req.admin?.user || 'unknown',
              meta: { created: report.created.length, updated: report.updated.length,
                      removed: report.removed.length, errors: report.errors.length } });
    }
    res.json(report);
  } catch (e) { next(e); }
});

/** Add a single package by hand. */
router.post('/sponsors', async (req, res, next) => {
  try {
    const r = await sponsors.create(req.body || {});
    if (!r.ok) return res.status(400).json(r);
    track({ type: 'sponsor.create', boothNumber: null, actor: req.admin?.user || 'unknown',
            meta: { key: r.sponsor.key, name: r.sponsor.name } });
    res.json(r);
  } catch (e) { next(e); }
});

/**
 * Delete a package. Proposals and enquiries that reference it are left alone —
 * both resolve keys at read time and already show an unresolvable one as
 * withdrawn, so a document already sent to a client stays honest.
 */
router.delete('/sponsors/:key', async (req, res, next) => {
  try {
    const ok = await sponsors.remove(req.params.key);
    if (ok) track({ type: 'sponsor.delete', boothNumber: null, actor: req.admin?.user || 'unknown',
                    meta: { key: req.params.key } });
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'No such package.' });
  } catch (e) { next(e); }
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
    // Reject an oversized inline image rather than let it be silently truncated
    // into a corrupt one (partners already reject; sponsors used the truncating
    // shared helper).
    if ('image' in body && typeof body.image === 'string' && body.image.length > 2_000_000) {
      return res.status(400).json({ error: 'That image is too large to store. Please use one under ~1.5 MB.' });
    }
    // Coerce honestly: the strings "false"/"0" are false, not truthy.
    const truthy = v => v === true || v === 'true' || v === 1 || v === '1';
    if ('active'  in body) body.active  = truthy(body.active);
    if ('soldOut' in body) body.soldOut = truthy(body.soldOut);
    const updated = await sponsors.setFields(req.params.key, body);
    if (!updated) return res.status(404).json({ error: 'No such sponsor.' });

    // A package that has sold out takes the areas it sells with it, so the plan
    // stops advertising the Networking Lounge the moment the lounge is gone.
    // Only areas LINKED to this package move; an unlinked one is managed by
    // hand and must not shift underneath its admin.
    if ('soldOut' in body) {
      try {
        const moved = await planAreas.applyPackageSoldOut(req.params.key, updated.soldOut === true,
                                                          { actor: req.admin?.user || null });
        if (moved) await sockets.notifyAreas();
      } catch (e) { console.error('Area sold-out cascade failed:', e.message); }
    }

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

router.get('/inquiries', async (req, res, next) => {
  try {
    const archived = req.query.archived === '1' || req.query.archived === 'true';
    res.json(await inquiries.recent(Math.max(1, Math.min(Number(req.query.limit) || 100, 500)), { archived }));
  } catch (e) { next(e); }
});

// Shelve / restore a lead — reversible, keeps the record.
router.post('/inquiries/:id/archive', async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const archived = req.body?.archived !== false;   // default to archiving
    const ok = await inquiries.setArchived(new ObjectId(req.params.id), archived);
    if (ok) auditLead(req, archived ? 'archive' : 'restore', req.params.id);
    res.status(ok ? 200 : 404).json(ok ? { ok: true, archived } : { error: 'Lead not found.' });
  } catch (e) { next(e); }
});

// Permanently delete a lead.
router.delete('/inquiries/:id', async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const ok = await inquiries.remove(new ObjectId(req.params.id));
    if (ok) auditLead(req, 'delete', req.params.id);
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'Lead not found.' });
  } catch (e) { next(e); }
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
/**
 * Who a lead can be forwarded to.
 *
 * This used to be a nine-name array in server/data/sales-team.js, every one of
 * them carrying the SAME email address, and nothing in the Team tab could reach
 * it. So a rep created as a real `sales` account never appeared in "Send to" —
 * they could not be assigned a lead at all — while every forward that did go out
 * landed in one inbox regardless of whose name was picked. The roster is now the
 * accounts themselves, which is the only list that can be both complete and
 * current.
 *
 * Admins and the owner are included alongside the reps: leads were being
 * forwarded to admins by name long before the sales tier existed, and an admin
 * still takes one. An account with no email is LISTED but cannot be sent to —
 * saying so is better than hiding the person, which is how the original bug
 * felt from the outside.
 */
const ROSTER_ROLES = ['sales', 'admin', 'owner'];

const memberName = (u) => (u.displayName || '').trim() || u.username;

const toMember = (u) => ({
  name: memberName(u),
  email: (u.email || '').trim(),
  username: u.username,
  role: u.role || 'admin',
});

async function rosterMembers() {
  const rows = await users.list();
  return rows
    .filter(u => ROSTER_ROLES.includes(u.role || 'admin'))
    // Reps first — they are who a lead should normally go to — then by name.
    .sort((a, b) =>
      ((a.role === 'sales' ? 0 : 1) - (b.role === 'sales' ? 0 : 1)) ||
      memberName(a).localeCompare(memberName(b)))
    .map(toMember);
}

/**
 * The person copied on every forward, so a lead is never lost if the assigned
 * person misses it. The owner account — the one tier there is exactly one of —
 * rather than a name written into the source.
 */
async function rosterManager() {
  const rows = await users.list();
  const owner = rows.find(u => u.role === 'owner' && (u.email || '').trim());
  return owner ? toMember(owner) : null;
}

/** Resolve a picked name back to a member. Username matches too, so renaming
 *  a rep's display name doesn't orphan the leads already assigned to them. */
async function findMember(name) {
  const want = String(name || '').toLowerCase().trim();
  if (!want) return null;
  const team = await rosterMembers();
  return team.find(m => m.name.toLowerCase() === want) ||
         team.find(m => m.username.toLowerCase() === want) || null;
}

router.get('/sales-team', async (_req, res, next) => {
  try {
    const [team, manager] = await Promise.all([rosterMembers(), rosterManager()]);
    res.json({ team, manager });
  } catch (e) { next(e); }
});

router.post('/inquiries/:id/assign', async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const name = req.body?.name;
    // An empty name clears the assignment.
    const member = name ? await findMember(name) : null;
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

    const member = (await findMember(req.body?.name)) || lead.assignedTo;
    if (!member) return res.status(400).json({ error: 'Assign this enquiry to someone first.' });
    // An account with no email cannot be forwarded to. Refusing by name says
    // what to fix; composing a mailto: to an empty address does not.
    if (!member.email) {
      return res.status(400).json({
        error: `${member.name} has no email address on their account — add one under Team, then send again.`,
      });
    }

    const c = lead.contact || {};
    const stands = (lead.boothsOfInterest || []).join(', ') || 'none specified';
    const areaNames = (lead.areasOfInterest || [])
      .map(k => (planAreaData.get(k) || {}).label || k);
    const sponsorKeys = lead.sponsorsOfInterest || [];
    let sponsorNames = sponsorKeys;
    if (sponsorKeys.length) {
      const rows = await sponsors.col().find({ key: { $in: sponsorKeys } }).project({ key: 1, name: 1 }).toArray();
      sponsorNames = sponsorKeys.map(k => (rows.find(r => r.key === k) || {}).name || k);
    }

    // A mail SUBJECT is a single header line. The name and company come from the
    // public enquiry form, so any newline in them is flattened here rather than
    // relied on being neutralised by whichever mail client the mailto: opens.
    const oneLine = (v) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim();
    const subject = `New ${config.showId} enquiry — ${oneLine(c.name) || 'Unknown'}${c.company ? ` (${oneLine(c.company)})` : ''}`;
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
      `Areas of interest:   ${areaNames.length ? areaNames.join(', ') : 'none'}`,
      '',
      `Message: ${lead.message || '—'}`,
      '',
      `Received: ${new Date(lead.createdAt).toLocaleString('en-GB')}`,
      `Assigned to: ${member.name}`,
    ].join('\n');

    const to = member.email;
    // No owner account with an email means nobody to copy — send to the
    // assignee alone rather than to the literal string "undefined".
    const manager = await rosterManager();
    const cc = manager ? manager.email : '';

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
      .sort({ ts: -1 }).limit(Math.max(1, Math.min(Number(req.query.limit) || 25, 500))).toArray();
    res.json(rows);
  } catch (e) { next(e); }
});

// ─── Demand heatmap ───────────────────────────────────────────────────────────
// Pre-aggregated so the dashboard reads a summary rather than scanning the
// full event stream.
router.get('/analytics/demand', async (req, res, next) => {
  try {
    const days  = Math.max(1, Math.min(Number(req.query.days) || 30, 365));   // clamp: no full-collection scan, no Invalid Date
    const since = new Date(Date.now() - days * 86400_000);

    const rows = await getDb().collection('activity').aggregate([
      { $match: { showId: config.showId, ts: { $gte: since }, boothNumber: { $ne: null },
                  'actor.kind': 'visitor',       // real visitors, not admin browsing
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
    const days  = Math.max(1, Math.min(Number(req.query.days) || 30, 365));   // clamp (see /analytics/demand)
    const since = new Date(Date.now() - days * 86400_000);
    const act   = getDb().collection('activity');

    // Only real visitors (not admins browsing the plan), and — for the top of
    // the funnel — only sessions that actually DID something. A bare
    // session.start with no interaction is a bot/scraper socket connection or an
    // instant bounce; counting those made the conversion rate look far worse
    // than reality. The first step is therefore "engaged visits".
    const base = { showId: config.showId, ts: { $gte: since }, 'actor.kind': 'visitor' };
    const ENGAGED = ['booth.view', 'booth.click', 'booth.dwell', 'plan.zoom', 'consent.granted', 'inquiry.submit'];

    const [rawSessions, engaged, browsed, clicked, inquired] = await Promise.all([
      act.distinct('sessionId', { ...base, type: 'session.start' }),
      act.distinct('sessionId', { ...base, type: { $in: ENGAGED } }),
      act.distinct('sessionId', { ...base, type: 'booth.view' }),
      act.distinct('sessionId', { ...base, type: 'booth.click' }),
      act.distinct('sessionId', { ...base, type: 'inquiry.submit' }),
    ]);

    const n = a => a.filter(Boolean).length;
    const rawVisits = n(rawSessions), engagedVisits = n(engaged);
    res.json({
      since, days,
      rawVisits,                                  // total connections, for reference
      botsFiltered: Math.max(0, rawVisits - engagedVisits),
      steps: [
        { step: 'Engaged visit',   count: engagedVisits },
        { step: 'Viewed a stand',  count: n(browsed) },
        { step: 'Clicked a stand', count: n(clicked) },
        { step: 'Enquired',        count: n(inquired) },
      ],
    });
  } catch (e) { next(e); }
});

// ─── Audit trail ──────────────────────────────────────────────────────────────
/**
 * What has actually happened on this event.
 *
 * The admin's Activity Log was a socket feed and nothing else: it started empty
 * on every refresh, which is precisely the moment an operator reloads to find
 * out what just happened. This is the history behind it.
 *
 * Every type that changes a stand or the plan is included — the old list left
 * out splits, merges, moves, renumbers and artwork uploads, so the three
 * operations most likely to be asked about after the fact were the three the
 * log could not answer for. Browsing events (booth.view, plan.zoom, …) stay out:
 * they are analytics, and they would bury the operational lines by a hundred
 * to one.
 */
const AUDIT_TYPES = [
  'booth.status_change', 'deal.update', 'hold.create', 'hold.release', 'hold.expire',
  'hold.extend', 'booth.restore', 'booth.consolidate', 'booth.split', 'booth.reset',
  'booth.move', 'booth.set_number', 'booth.set_tags', 'booth.set_country', 'booth.set_logo',
  'unmerge', 'unsplit', 'floorplan.upload', 'floorplan.revert', 'stands.import',
  'sponsor.create', 'sponsor.delete', 'sponsor.import', 'enquiry.forward',
  'lead.admin', 'admin.team', 'security.denied', 'security.secret_failed',
];

router.get('/audit', async (req, res, next) => {
  try {
    const q = { showId: config.showId };

    // A caller-supplied type is intersected with the allow-list rather than
    // trusted, so this endpoint can never be turned into a reader of the raw
    // behavioural stream by passing ?type=session.start.
    const wanted = String(req.query.type || '').split(',').map(t => t.trim()).filter(Boolean);
    const types = wanted.length ? wanted.filter(t => AUDIT_TYPES.includes(t)) : AUDIT_TYPES;
    if (!types.length) return res.json([]);
    q.type = { $in: types };

    if (req.query.booth) q.boothNumber = String(req.query.booth);
    if (req.query.actor) q['actor.userId'] = String(req.query.actor);

    // Free text over the company names the event carried. Escaped — a lead's
    // company name is visitor input, and an unescaped '(' would make this throw
    // rather than simply match nothing.
    const text = String(req.query.q || '').trim();
    if (text) {
      const rx = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      q.$or = [
        { boothNumber: rx },
        { 'meta.company': rx },
        { 'meta.to': rx },
        { 'actor.userId': rx },
      ];
    }

    const rows = await getDb().collection('activity')
      .find(q)
      .sort({ ts: -1 }).limit(Math.max(1, Math.min(Number(req.query.limit) || 200, 1000))).toArray();
    res.json(rows);
  } catch (e) { next(e); }
});

/** The distinct actors seen in the audit window, for the log's filter. */
router.get('/audit/actors', async (_req, res, next) => {
  try {
    const rows = await getDb().collection('activity')
      .distinct('actor.userId', { showId: config.showId, type: { $in: AUDIT_TYPES } });
    res.json(rows.filter(Boolean).sort());
  } catch (e) { next(e); }
});

// ─── Holds: extending one, and undoing a release ──────────────────────────────

/**
 * The gate that un-booking a stand goes through.
 *
 * Exactly the one Release itself uses in the socket layer: the recovery key
 * when RECOVERY_KEY is set (so a stolen admin session still cannot touch a
 * booking), and the admin's own login password when it is not. Shares the
 * confirmation throttle with confirmPassword above, because it is the same
 * secret being guessed either way.
 */
async function confirmDestructive(req, res, what) {
  const who = req.admin?.user;
  const supplied = String(req.get('X-Confirm-Password') || '');

  const gate = auth.checkSecretThrottle(who);
  if (!gate.ok) {
    res.status(429).json({
      error: `Too many incorrect attempts — wait ${Math.ceil(gate.retryAfter / 60)} minute(s) and try again. ${cap(what)}.`,
    });
    return false;
  }

  if (config.recoveryEnabled()) {
    if (!config.recoveryOk(supplied)) {
      auth.registerSecretFailure(who, { what });
      res.status(403).json({ error: `Recovery key incorrect — ${what}.` });
      return false;
    }
  } else {
    const account = await users.findByUsername(who);
    // Awaited — see confirmPassword. An un-awaited promise is truthy.
    if (!account || !await users.verifyPassword(supplied, account.passwordHash)) {
      await users.absorbPassword(supplied);
      auth.registerSecretFailure(who, { what });
      res.status(403).json({ error: `Password incorrect — ${what}.` });
      return false;
    }
  }
  auth.clearSecretFailures(who);
  return true;
}

/**
 * Give a hold more time.
 *
 * A hold silently expires after 24 hours and the stand goes back on sale with
 * no warning to anyone. The admin can now see the clock (GET /holds) — this is
 * the other half: the button that stops it running out.
 *
 * The new expiry is measured from whichever is LATER, now or the current
 * expiry, so extending a hold with 20 hours left genuinely adds 24 rather than
 * shortening it to 24 from this moment.
 */
router.post('/holds/:boothNumber/extend', async (req, res, next) => {
  try {
    const n = String(req.params.boothNumber);
    const hours = Math.max(1, Math.min(Number(req.body?.hours) || 24, 24 * 30));

    const booth = await booths.get(n);
    if (!booth) return res.status(404).json({ error: `Stand ${n} not found.` });
    if (booth.status !== 'held') {
      return res.status(409).json({ error: `Stand ${n} is not on hold — nothing to extend.` });
    }

    const current = (await holds.active()).find(h => h.boothNumber === n);
    const now = Date.now();
    const from = current && current.expiresAt ? Math.max(now, new Date(current.expiresAt).getTime()) : now;
    const durationMs = (from + hours * 3600_000) - now;

    const r = await holds.forceHold(n, {
      company: booth.assignment?.company || 'Pending',
      durationMs,
      actor: req.admin?.user || null,
    });
    track({ type: 'hold.extend', boothNumber: n, actor: req.admin?.user || 'unknown',
            meta: { hours, expiresAt: r.expiresAt, company: booth.assignment?.company || null } });

    // Nothing on the booth document changed, but every other admin's clock is
    // now wrong. A stands broadcast is what their pages already listen for.
    try { await sockets.notifyStands(); } catch (e) { console.error('Hold extend broadcast failed:', e.message); }

    res.json({ ok: true, boothNumber: n, expiresAt: r.expiresAt });
  } catch (e) { next(e); }
});

/**
 * Put a released booking back.
 *
 * Release destroys a booking outright — the company, the negotiated price, the
 * notes, the tags — and the only recovery was to retype all of it from memory.
 * This restores the snapshot the console held immediately before the release.
 *
 * Two things make it safe. It is gated exactly as Release is, so it is no
 * easier to perform than the thing it reverses. And it REFUSES unless the stand
 * is still available: if someone has taken it in the meantime, restoring would
 * quietly overwrite their booking, which is a worse outcome than the one being
 * undone.
 *
 * The snapshot travelling from the client grants no authority an admin does not
 * already have — booth:book already lets them assign any stand to any company —
 * but it is stamped into the audit trail either way, so a restore is never an
 * unattributed change of company.
 */
router.post('/booths/:boothNumber/restore', async (req, res, next) => {
  try {
    const n = String(req.params.boothNumber);
    const snap = req.body?.assignment || {};
    const status = req.body?.status === 'held' ? 'held' : 'sold';
    const company = String(snap.company || '').trim();
    if (!company) return res.status(400).json({ error: 'Nothing to restore — the snapshot has no company.' });

    const booth = await booths.get(n);
    if (!booth) return res.status(404).json({ error: `Stand ${n} not found.` });
    if (booth.status !== 'available') {
      return res.status(409).json({
        error: `Stand ${n} is ${booth.status} again${booth.assignment?.company ? ` (${booth.assignment.company})` : ''} — it was not restored, so whoever took it keeps it.`,
      });
    }

    if (!await confirmDestructive(req, res, `stand ${n} was not restored`)) return;

    // expect:['available'] closes the gap between the check above and this
    // write: a booking landing in between makes the write simply not match.
    const r = await booths.setStatus(n, status, { company, actor: req.admin?.user || null, expect: ['available'] });
    if (!r) return res.status(404).json({ error: `Stand ${n} not found.` });
    if (!r.changed) return res.status(409).json({ error: `Stand ${n} was taken while restoring — it was left as it is.` });

    // A hold has to have a hold document or the expiry sweep reclaims the stand
    // within the minute — the same trap admin:setStatus fell into.
    if (status === 'held') {
      await holds.forceHold(n, { company, actor: req.admin?.user || null });
    }

    // The rest of the deal, each through the model's own guarded write.
    if (snap.actualPrice !== undefined || snap.notes !== undefined) {
      await booths.updateDeal(n, {
        actualPrice: snap.actualPrice === undefined ? undefined : snap.actualPrice,
        notes: snap.notes === undefined ? undefined : String(snap.notes || ''),
        actor: req.admin?.user || null,
      });
    }
    if (Array.isArray(snap.tags) && snap.tags.length) {
      await booths.setTags(n, snap.tags, { actor: req.admin?.user || null });
    }
    if (snap.country) {
      await booths.setCountry(n, snap.country, { actor: req.admin?.user || null });
    }

    track({ type: 'booth.restore', boothNumber: n, actor: req.admin?.user || 'unknown',
            meta: { company, status, restoredPrice: snap.actualPrice ?? null } });

    try { await sockets.notifyStands(); } catch (e) { console.error('Restore broadcast failed:', e.message); }

    res.json({ ok: true, boothNumber: n, status, company });
  } catch (e) { next(e); }
});

module.exports = router;
