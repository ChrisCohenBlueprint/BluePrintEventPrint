const express = require('express');
const path = require('path');
const QRCode = require('qrcode');

const users = require('../models/users');
const auth  = require('../auth');

const router = express.Router();

// A modest per-IP attempt limiter, so the login and 2FA steps cannot be
// brute-forced. In-memory is enough for a single instance.
const attempts = new Map();
function throttle(ip, max = 10, windowMs = 5 * 60 * 1000) {
  const now = Date.now();
  const rec = attempts.get(ip) || { count: 0, reset: now + windowMs };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + windowMs; }
  rec.count++;
  attempts.set(ip, rec);
  return rec.count <= max;
}

// A safe same-site redirect target: a single leading slash, and no backslash
// (browsers treat "/\evil.com" as protocol-relative → off-site). Anything else
// falls back to /admin.
const safeNext = (v) =>
  (typeof v === 'string' && /^\/[^/\\]/.test(v)) ? v : '/admin';

// ─── Pages ────────────────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (auth.sessionUser(req)) return res.redirect(safeNext(req.query.next));
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'login.html'));
});

router.post('/logout', (req, res) => { auth.clearSessionCookie(res); res.json({ ok: true }); });
router.get('/logout',  (req, res) => { auth.clearSessionCookie(res); res.redirect('/login'); });

// ─── Step 1: password ─────────────────────────────────────────────────────────
// On success returns either a 2FA challenge (enrol or verify) plus a short-lived
// pending token. The password alone never sets the session.
router.post('/login', async (req, res) => {
  if (!throttle(req.ip)) return res.status(429).json({ ok: false, error: 'Too many attempts. Try again in a few minutes.' });

  const { username, password } = req.body || {};
  const user = await users.findByUsername(username);
  const ok = user && users.verifyPassword(password, user.passwordHash);

  // Same response whether the user exists or not, so usernames cannot be probed.
  if (!ok) return res.status(401).json({ ok: false, error: 'Incorrect username or password.' });

  if (!user.totpEnrolled) {
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

  const done = await users.confirmEnrolment(username, req.body?.token);
  if (!done) return res.status(401).json({ ok: false, error: 'That code did not match. Try the current code from your app.' });

  const user = await users.findByUsername(username);
  auth.setSessionCookie(res, user);
  res.json({ ok: true, next: safeNext(req.body?.next) });
});

// ─── Step 2b: verify code (or recovery code) ──────────────────────────────────
router.post('/login/verify', async (req, res) => {
  if (!throttle(req.ip)) return res.status(429).json({ ok: false, error: 'Too many attempts.' });
  const username = auth.verifyPending(req.body?.pending, 'verify');
  if (!username) return res.status(440).json({ ok: false, error: 'Session expired. Please start again.' });

  const user = await users.findByUsername(username);
  // The account can be deleted between the password step and here; without this
  // guard verifyTotp(null, …) threw and the request hung with no response.
  if (!user) return res.status(401).json({ ok: false, error: 'Please start again.' });
  const token = String(req.body?.token || '').trim();

  const ok = users.verifyTotp(user, token) ||
             (req.body?.recovery && await users.useRecoveryCode(username, token));
  if (!ok) return res.status(401).json({ ok: false, error: 'Incorrect code.' });

  auth.setSessionCookie(res, user);
  res.json({ ok: true, next: safeNext(req.body?.next) });
});

// Who am I — lets the admin page show the signed-in user and a logout control.
router.get('/api/me', (req, res) => {
  const s = auth.sessionUser(req);
  if (!s) return res.status(401).json({ error: 'Not signed in' });
  res.json({ user: s.user, role: s.role });
});

module.exports = router;
