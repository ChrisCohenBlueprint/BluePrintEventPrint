const express = require('express');
const path = require('path');
const QRCode = require('qrcode');

const users = require('../models/users');
const auth  = require('../auth');

const router = express.Router();

// Attempt limiters. In-memory is enough for a single instance; entries are
// pruned as they expire so the maps can't grow without bound.
const WINDOW_MS = 5 * 60 * 1000;
const ipAttempts   = new Map();   // ip -> { count, reset }
const acctFailures = new Map();   // username -> { count, reset }

function prune(map, now) { for (const [k, v] of map) if (now > v.reset) map.delete(k); }

function bump(map, key, now) {
  const rec = map.get(key) || { count: 0, reset: now + WINDOW_MS };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + WINDOW_MS; }
  rec.count++;
  map.set(key, rec);
  return rec.count;
}

// Per-IP rate limit on the login/2FA steps.
function throttle(ip, max = 10) {
  const now = Date.now();
  prune(ipAttempts, now);
  return bump(ipAttempts, ip, now) <= max;
}

// Per-account lockout, so a distributed attack can't get more guesses at one
// account just by rotating source IPs. Counts failures only; a success resets.
function accountLocked(username) {
  const rec = acctFailures.get(String(username || '').toLowerCase().trim());
  return !!rec && Date.now() <= rec.reset && rec.count >= 10;
}
function noteFailure(username) { prune(acctFailures, Date.now()); bump(acctFailures, String(username || '').toLowerCase().trim(), Date.now()); }
function clearFailures(username) { acctFailures.delete(String(username || '').toLowerCase().trim()); }

// A safe same-site redirect target: a single leading slash, and no backslash
// (browsers treat "/\evil.com" as protocol-relative → off-site). Anything else
// falls back to the account's own home.
//
// The role matters here: a rep has no admin console, so defaulting them to
// /admin would land them on a page their role can't open. A rep who arrives via
// a saved /admin link is likewise sent to /sales rather than into a bounce.
const safeNext = (v, role) => {
  const home = auth.homeFor(role);
  if (typeof v !== 'string' || !/^\/[^/\\]/.test(v)) return home;
  if (role === 'sales' && /^\/admin(\/|\.|$)/i.test(v)) return home;
  return v;
};

// ─── Pages ────────────────────────────────────────────────────────────────────
router.get('/login', async (req, res) => {
  // Checked across ALL tiers, not just admin — otherwise a signed-in rep who
  // hits /login is shown the form again instead of their dashboard.
  const live = await auth.sessionUser(req, auth.ALL_ROLES);
  if (live) return res.redirect(safeNext(req.query.next, live.role));
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'login.html'));
});

// Logout must be POST: a GET that clears the cookie lets any page force-log an
// admin out with <img src="/logout">. The GET here is now inert — it only
// redirects to the login page and never clears the session.
router.post('/logout', (req, res) => { auth.clearSessionCookie(res); res.json({ ok: true }); });
router.get('/logout',  (req, res) => res.redirect('/login'));

// ─── Step 1: password ─────────────────────────────────────────────────────────
// On success returns either a 2FA challenge (enrol or verify) plus a short-lived
// pending token. The password alone never sets the session.
router.post('/login', async (req, res) => {
  if (!throttle(req.ip)) return res.status(429).json({ ok: false, error: 'Too many attempts. Try again in a few minutes.' });

  const { username, password } = req.body || {};
  if (accountLocked(username)) {
    return res.status(429).json({ ok: false, error: 'Too many attempts. Try again in a few minutes.' });
  }

  const user = await users.findByUsername(username);
  // Run a full scrypt whether or not the account exists, so the response takes
  // the same time either way and usernames cannot be probed by timing.
  const ok = user ? users.verifyPassword(password, user.passwordHash) : (users.absorbPassword(password), false);

  if (!ok) {
    noteFailure(username);
    return res.status(401).json({ ok: false, error: 'Incorrect username or password.' });
  }
  clearFailures(username);

  if (!user.totpEnrolled) {
    // Invited accounts must present their one-time invite code before the 2FA
    // secret is handed out, so an intercepted temp password alone can't claim
    // the account. Accounts without a claim code (owner, legacy) skip this.
    if (users.needsClaim(user) && !users.checkClaim(user, req.body?.claim)) {
      noteFailure(username);   // a wrong invite code counts toward account lockout too
      return res.status(401).json({ ok: false, error: 'This account needs its one-time invite code (first login only). Ask the owner for it.' });
    }
    const { secret, recoveryCodes, otpauth } = await users.startEnrolment(user.username);
    const qr = await QRCode.toDataURL(otpauth, { margin: 1, width: 220 }).catch(() => null);
    return res.json({
      ok: true, step: 'enrol',
      pending: auth.signPending(user.username, 'enrol'),
      qr, secret, recoveryCodes,
    });
  }

  res.json({ ok: true, step: 'verify', pending: auth.signPending(user.username, 'verify') });
});

// ─── Step 2a: confirm enrolment ───────────────────────────────────────────────
router.post('/login/enrol', async (req, res) => {
  if (!throttle(req.ip)) return res.status(429).json({ ok: false, error: 'Too many attempts.' });
  const username = auth.verifyPending(req.body?.pending, 'enrol');
  if (!username) return res.status(440).json({ ok: false, error: 'Session expired. Please start again.' });
  if (accountLocked(username)) return res.status(429).json({ ok: false, error: 'Too many attempts. Try again in a few minutes.' });

  const done = await users.confirmEnrolment(username, req.body?.token);
  if (!done) {
    // Per-account lockout on the second factor too — the per-IP throttle alone
    // is defeated by a botnet, letting one pending token seed unlimited guesses.
    noteFailure(username);
    return res.status(401).json({ ok: false, error: 'That code did not match. Try the current code from your app.' });
  }
  clearFailures(username);

  auth.consumePending(req.body?.pending);   // one successful use per pending token
  const user = await users.findByUsername(username);
  auth.setSessionCookie(res, user);
  res.json({ ok: true, next: safeNext(req.body?.next, user.role) });
});

// ─── Step 2b: verify code (or recovery code) ──────────────────────────────────
router.post('/login/verify', async (req, res) => {
  if (!throttle(req.ip)) return res.status(429).json({ ok: false, error: 'Too many attempts.' });
  const username = auth.verifyPending(req.body?.pending, 'verify');
  if (!username) return res.status(440).json({ ok: false, error: 'Session expired. Please start again.' });
  if (accountLocked(username)) return res.status(429).json({ ok: false, error: 'Too many attempts. Try again in a few minutes.' });

  const user = await users.findByUsername(username);
  // The account can be deleted between the password step and here; without this
  // guard verifyTotp(null, …) threw and the request hung with no response.
  if (!user) return res.status(401).json({ ok: false, error: 'Please start again.' });
  const token = String(req.body?.token || '').trim();

  const ok = (await users.verifyTotpAndConsume(user, token)) ||
             (req.body?.recovery && await users.useRecoveryCode(username, token));
  if (!ok) {
    // Per-account lockout on the code step too (see /login/enrol) — a leaked
    // temp password otherwise buys unlimited 6-digit guesses via one IP botnet.
    noteFailure(username);
    return res.status(401).json({ ok: false, error: 'Incorrect code.' });
  }
  clearFailures(username);

  auth.consumePending(req.body?.pending);   // one successful use per pending token
  auth.setSessionCookie(res, user);
  res.json({ ok: true, next: safeNext(req.body?.next, user.role) });
});

// Who am I — lets the admin page show the signed-in user and a logout control.
router.get('/api/me', async (req, res) => {
  const s = await auth.sessionUser(req, auth.ALL_ROLES);
  if (!s) return res.status(401).json({ error: 'Not signed in' });
  res.json({ user: s.user, role: s.role, home: auth.homeFor(s.role) });
});

module.exports = router;
