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
const acctFailures = new Map();   // username -> { count, nextAt, reset }

function prune(map, now) { for (const [k, v] of map) if (now > v.reset) map.delete(k); }

function bump(map, key, now) {
  const rec = map.get(key) || { count: 0, reset: now + WINDOW_MS };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + WINDOW_MS; }
  rec.count++;
  map.set(key, rec);
  return rec.count;
}

const uname = (username) => String(username || '').toLowerCase().trim();

// ─── Per-IP budget: FAILURES only ─────────────────────────────────────────────
// This used to count every attempt, successful ones included. A sales office
// behind one NAT address therefore shared ten sign-ins per five minutes between
// everyone in it — on a busy morning the eleventh person to log in correctly was
// told to try again later. Only a failed attempt spends from the bucket now, so
// people who know their password are never rationed.
const IP_MAX = 10;
function ipAllowed(ip, max = IP_MAX) {
  const now = Date.now();
  prune(ipAttempts, now);
  const rec = ipAttempts.get(ip);
  return !rec || now > rec.reset || rec.count < max;
}
function noteIpFailure(ip) { prune(ipAttempts, Date.now()); bump(ipAttempts, ip, Date.now()); }

// ─── Per-account: a progressive delay, not a lock ─────────────────────────────
// Ten wrong passwords used to lock a username outright for five minutes, and the
// lock was checked BEFORE the password was verified. That handed any anonymous
// stranger a denial-of-service against the owner's own account: ten guesses
// every five minutes and she could never sign in again, for as long as the
// attacker cared to keep it up.
//
// Now the credential is ALWAYS checked, and the penalty only ever costs a failed
// attempt time: each failure pushes the next attempt out by min(2^failures, 300)
// seconds, an attempt made inside that window waits (briefly) and is answered
// with how long is left, and one correct password or code clears the record
// outright. Whoever knows the secret gets in; whoever doesn't pays a cost that
// doubles. The per-IP budget above and scrypt's own cost remain what bound the
// volume of guessing — a limiter that can be turned against the account it
// protects is the worse of the two bugs.
const MAX_DELAY_S = 300;           // the cap: 5 minutes between guesses
const MAX_HOLD_MS = 2000;          // never park a request for longer than this

/** Seconds still owed on this account's penalty, 0 if it is clear. */
function accountDelay(username) {
  const rec = acctFailures.get(uname(username));
  if (!rec) return 0;
  const left = rec.nextAt - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/**
 * Pay the part of the penalty that is charged in wall-clock time. Capped, so
 * the process is never full of sockets parked for minutes; the remainder is
 * reported to the caller instead.
 */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function payDelay(username) {
  const owed = accountDelay(username);
  if (owed) await sleep(Math.min(owed * 1000, MAX_HOLD_MS));
  return owed;
}

/** Record a failure and return the seconds before the next attempt is free. */
function noteFailure(username) {
  const key = uname(username);
  const now = Date.now();
  prune(acctFailures, now);
  const prev = acctFailures.get(key);
  const rec  = prev && now <= prev.reset ? prev : { count: 0, nextAt: 0, reset: 0 };
  rec.count += 1;
  const waitS = Math.min(2 ** rec.count, MAX_DELAY_S);
  rec.nextAt = now + waitS * 1000;
  // Forgotten entirely once the penalty has run out plus the usual window, so
  // yesterday's typo is not still counted against you tomorrow.
  rec.reset  = rec.nextAt + WINDOW_MS;
  acctFailures.set(key, rec);
  return waitS;
}
function clearFailures(username) { acctFailures.delete(uname(username)); }

// The message a throttled failure gets. Deliberately the same wording whether
// the username exists or not.
const tooSoon = (res, waitS) => res.status(429)
  .set('Retry-After', String(waitS))
  .json({ ok: false, error: `Too many attempts. Try again in ${waitS < 60 ? `${waitS} seconds` : `${Math.ceil(waitS / 60)} minutes`}.` });

// A safe same-site redirect target: a single leading slash, and no backslash
// (browsers treat "/\evil.com" as protocol-relative → off-site). Anything else
// falls back to the account's own home.
//
// Whitespace and control characters are rejected outright. The old test used
// the class [^/\\], which admits a tab or a newline — so ?next=/%09/evil.com
// passed, and since the browser strips the tab before navigating, the value
// login.js assigns to location.href became //evil.com, i.e. https://evil.com/.
// This value is handed straight to the browser as a destination, so it is
// validated by what a URL parser will make of it, not by what it looks like.
//
// The role matters here: a rep has no admin console, so defaulting them to
// /admin would land them on a page their role can't open. A rep who arrives via
// a saved /admin link is likewise sent to /sales rather than into a bounce.
const safeNext = (v, role) => {
  const home = auth.homeFor(role);
  if (typeof v !== 'string') return home;
  if (/[\u0000-\u0020\u007f\\]/.test(v)) return home;   // any control char, space or backslash
  if (!/^\/[^/\\]/.test(v)) return home;                 // exactly one leading slash
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
// Signing out RETIRES the session as well as clearing the cookie. Clearing the
// cookie alone only asks the browser to forget it; a copy taken beforehand —
// off a shared machine, out of a proxy log — stayed valid for the rest of its
// twelve hours, so "log out" protected nobody who had actually lost it.
router.post('/logout', async (req, res) => {
  // A database that is down must not stop someone signing out: clear the cookie
  // either way and log the part that failed.
  try { await auth.revokeSession(req); }
  catch (e) { console.error('Logout could not revoke the session token:', e.message); }
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});
router.get('/logout',  (req, res) => res.redirect('/login'));

// ─── Step 1: password ─────────────────────────────────────────────────────────
// On success returns either a 2FA challenge (enrol or verify) plus a short-lived
// pending token. The password alone never sets the session.
router.post('/login', async (req, res) => {
  if (!ipAllowed(req.ip)) return res.status(429).json({ ok: false, error: 'Too many attempts. Try again in a few minutes.' });

  const { username, password } = req.body || {};
  // Pay any outstanding penalty BEFORE checking, and check regardless of it —
  // the person who knows the password is never turned away (see noteFailure).
  const owed = await payDelay(username);

  const user = await users.findByUsername(username);
  // Run a full scrypt whether or not the account exists, so the response takes
  // the same time either way and usernames cannot be probed by timing.
  // Both of these are async now: scrypt no longer runs on the event loop.
  const ok = user ? await users.verifyPassword(password, user.passwordHash)
                  : (await users.absorbPassword(password), false);

  if (!ok) {
    noteIpFailure(req.ip);
    const waitS = noteFailure(username);
    if (owed) return tooSoon(res, waitS);
    return res.status(401).json({ ok: false, error: 'Incorrect username or password.' });
  }
  clearFailures(username);

  if (!user.totpEnrolled) {
    // Invited accounts must present their one-time invite code before the 2FA
    // secret is handed out, so an intercepted temp password alone can't claim
    // the account. Accounts without a claim code (owner, legacy) skip this.
    if (users.needsClaim(user) && !users.checkClaim(user, req.body?.claim)) {
      noteIpFailure(req.ip);
      noteFailure(username);   // a wrong invite code carries the same growing delay
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
  if (!ipAllowed(req.ip)) return res.status(429).json({ ok: false, error: 'Too many attempts.' });
  const username = auth.verifyPending(req.body?.pending, 'enrol');
  if (!username) return res.status(440).json({ ok: false, error: 'Session expired. Please start again.' });
  const owed = await payDelay(username);

  const done = await users.confirmEnrolment(username, req.body?.token);
  if (!done) {
    // The growing per-account delay applies to the second factor too — the
    // per-IP budget alone is defeated by a botnet, letting one pending token
    // seed unlimited guesses at a six-digit code.
    noteIpFailure(req.ip);
    const waitS = noteFailure(username);
    if (owed) return tooSoon(res, waitS);
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
  if (!ipAllowed(req.ip)) return res.status(429).json({ ok: false, error: 'Too many attempts.' });
  const username = auth.verifyPending(req.body?.pending, 'verify');
  if (!username) return res.status(440).json({ ok: false, error: 'Session expired. Please start again.' });
  const owed = await payDelay(username);

  const user = await users.findByUsername(username);
  // The account can be deleted between the password step and here; without this
  // guard verifyTotp(null, …) threw and the request hung with no response.
  if (!user) return res.status(401).json({ ok: false, error: 'Please start again.' });
  const token = String(req.body?.token || '').trim();

  const ok = (await users.verifyTotpAndConsume(user, token)) ||
             (req.body?.recovery && await users.useRecoveryCode(username, token));
  if (!ok) {
    // The same growing delay on the code step (see /login/enrol) — a leaked
    // password otherwise buys unlimited 6-digit guesses via one IP botnet.
    noteIpFailure(req.ip);
    const waitS = noteFailure(username);
    if (owed) return tooSoon(res, waitS);
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
