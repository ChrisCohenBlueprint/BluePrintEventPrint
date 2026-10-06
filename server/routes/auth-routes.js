const express = require('express');
const path = require('path');
const QRCode = require('qrcode');

const users = require('../models/users');
const auth  = require('../auth');

const router = express.Router();

// Attempt limiters. In-memory is enough for a single instance; entries are
// pruned as they expire so the maps can't grow without bound.
//
// Every check that decides whether an attempt may go ahead is made
// SYNCHRONOUSLY, before the handler's first await. They used to be made on
// arrival and charged only after the delay, the database read and scrypt had
// all been awaited — so a burst sent in one go read the budget before any of it
// was spent, and every request in it was evaluated. Sixty concurrent passwords
// from one address against a budget of ten were all checked; four hundred
// concurrent codes on one pending token were all checked, and the right one
// signed in.
const WINDOW_MS = 5 * 60 * 1000;
const ipAttempts   = new Map();   // ip -> { count, reset }   failures in the window
const ipInFlight   = new Map();   // ip -> attempts being evaluated right now
const acctFailures = new Map();   // username -> { count, nextAt, reset }   wrong passwords
const codeFailures = new Map();   // username -> { count, nextAt, reset }   wrong codes
const codeBusy     = new Set();   // usernames with a code being checked right now

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
//
// An attempt still being evaluated holds a place in the bucket until it is
// answered — it might yet be a failure. That is what stops a burst: once the
// failures plus the attempts in flight reach the budget, the next one is
// refused without being looked at. A success hands its place back and spends
// nothing, so the office above is only ever turned away if ten of its sign-ins
// are being checked in the same instant.
const IP_MAX = 10;

/**
 * Claim a place in this IP's budget for one attempt.
 * @returns {Function|null} a release function, to be called exactly once when
 *   the attempt has been answered; null if the budget is spent.
 */
function reserveIp(ip, max = IP_MAX) {
  const now = Date.now();
  prune(ipAttempts, now);
  const rec = ipAttempts.get(ip);
  const failures = rec && now <= rec.reset ? rec.count : 0;
  const busy = ipInFlight.get(ip) || 0;
  if (failures + busy >= max) return null;
  ipInFlight.set(ip, busy + 1);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const left = (ipInFlight.get(ip) || 1) - 1;
    if (left > 0) ipInFlight.set(ip, left); else ipInFlight.delete(ip);
  };
}
function noteIpFailure(ip) { prune(ipAttempts, Date.now()); bump(ipAttempts, ip, Date.now()); }

// ─── Per-account: a progressive delay, not a lock ─────────────────────────────
// Ten wrong passwords used to lock a username outright for five minutes, and the
// lock was checked BEFORE the password was verified. That handed any anonymous
// stranger a denial-of-service against the owner's own account: ten guesses
// every five minutes and she could never sign in again, for as long as the
// attacker cared to keep it up.
//
// So the PASSWORD is always checked, and the penalty only ever costs a failed
// attempt time: each failure pushes the next attempt out by min(2^failures, 300)
// seconds, an attempt made inside that window waits (briefly) and is answered
// with how long is left, and one correct password clears the record outright.
// Whoever knows the password gets through; whoever doesn't pays a cost that
// doubles. The per-IP budget above and scrypt's own cost remain what bound the
// volume of password guessing — a limiter that can be turned against the
// account it protects is the worse of the two bugs.
//
// The CODE steps are strict instead, because only someone who has just given
// the right password can reach them, so nothing a stranger does can lock the
// owner out of them. Wrong codes are counted on their own record (codeFailures)
// — a stranger's wrong passwords never delay the owner's code — with the same
// doubling delay, but here it is enforced: while a penalty is owed the code is
// not looked at, whether or not it is right. One code per account is checked
// at a time, and five wrong codes burn the pending token (auth.missPending), so
// a further guess means giving the password again.
const MAX_DELAY_S = 300;           // the cap: 5 minutes between guesses
const MAX_HOLD_MS = 2000;          // never park a request for longer than this

/** Seconds still owed on this account's penalty, 0 if it is clear. */
function accountDelay(username, map = acctFailures) {
  const rec = map.get(uname(username));
  if (!rec) return 0;
  const left = rec.nextAt - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/**
 * Pay the part of the password penalty that is charged in wall-clock time.
 * Capped, so the process is never full of sockets parked for minutes; the
 * remainder is reported to the caller instead.
 */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function payDelay(username) {
  const owed = accountDelay(username);
  if (owed) await sleep(Math.min(owed * 1000, MAX_HOLD_MS));
  return owed;
}

/** Record a failure and return the seconds before the next attempt is free. */
function noteFailure(username, map = acctFailures) {
  const key = uname(username);
  const now = Date.now();
  prune(map, now);
  const prev = map.get(key);
  const rec  = prev && now <= prev.reset ? prev : { count: 0, nextAt: 0, reset: 0 };
  rec.count += 1;
  const waitS = Math.min(2 ** rec.count, MAX_DELAY_S);
  rec.nextAt = now + waitS * 1000;
  // Forgotten entirely once the penalty has run out plus the usual window, so
  // yesterday's typo is not still counted against you tomorrow.
  rec.reset  = rec.nextAt + WINDOW_MS;
  map.set(key, rec);
  return waitS;
}
function clearFailures(username, map = acctFailures) { map.delete(uname(username)); }

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

/**
 * Wrap a sign-in step so it holds a place in its IP's budget while it runs.
 *
 * The place is claimed here, before the step's first await (see reserveIp), and
 * handed back however the step ends. A step that fails charges its failure
 * (noteIpFailure) before handing the place back, so the two are never both
 * missing from the count.
 */
const attempt = (step) => async (req, res) => {
  const release = reserveIp(req.ip);
  if (!release) return res.status(429).json({ ok: false, error: 'Too many attempts. Try again in a few minutes.' });
  try { await step(req, res); }
  finally { release(); }
};

// ─── Step 1: password ─────────────────────────────────────────────────────────
// On success returns either a 2FA challenge (enrol or verify) plus a short-lived
// pending token. The password alone never sets the session.
router.post('/login', attempt(async (req, res) => {
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
}));

// ─── Step 2: the code ─────────────────────────────────────────────────────────
/**
 * Everything a code step decides BEFORE it looks at the code: is the pending
 * token good, is another code for this account already being checked, and is a
 * penalty still owed. All synchronous, so a burst cannot slip past together.
 *
 * Answers the request itself and returns null when the attempt may not go
 * ahead. Otherwise returns the username with the account's code slot held;
 * the caller gives it back with endCodeStep() when it has answered.
 */
function beginCodeStep(req, res, purpose) {
  const username = auth.verifyPending(req.body?.pending, purpose);
  if (!username) { res.status(440).json({ ok: false, error: 'Session expired. Please start again.' }); return null; }
  if (codeBusy.has(uname(username))) {
    res.status(429).json({ ok: false, error: 'A code for this account is already being checked. Try again in a moment.' });
    return null;
  }
  const owed = accountDelay(username, codeFailures);
  if (owed) { tooSoon(res, owed); return null; }
  codeBusy.add(uname(username));
  return username;
}
const endCodeStep = (username) => codeBusy.delete(uname(username));

/**
 * A wrong code: charge it to the IP and to the account's code record, and
 * spend the pending token if that was its fifth.
 */
function wrongCode(req, res, username, { message, burnt }) {
  noteIpFailure(req.ip);
  noteFailure(username, codeFailures);
  if (auth.missPending(req.body?.pending)) {
    return res.status(440).json({ ok: false, reason: 'too_many_codes', error: burnt });
  }
  return res.status(401).json({ ok: false, error: message });
}

// ─── Step 2a: confirm enrolment ───────────────────────────────────────────────
router.post('/login/enrol', attempt(async (req, res) => {
  const username = beginCodeStep(req, res, 'enrol');
  if (!username) return;
  try {
    const done = await users.confirmEnrolment(username, req.body?.token);
    if (!done) {
      return wrongCode(req, res, username, {
        message: 'That code did not match. Try the current code from your app.',
        // Signing in again starts a new enrolment, so the codes on screen go.
        burnt: 'Too many incorrect codes. Sign in again and you will be given a fresh QR code and a fresh set of recovery codes.',
      });
    }
    clearFailures(username, codeFailures);

    auth.consumePending(req.body?.pending);   // one successful use per pending token
    const user = await users.findByUsername(username);
    auth.setSessionCookie(res, user);
    res.json({ ok: true, next: safeNext(req.body?.next, user.role) });
  } finally { endCodeStep(username); }
}));

// ─── Step 2b: verify code (or recovery code) ──────────────────────────────────
router.post('/login/verify', attempt(async (req, res) => {
  const username = beginCodeStep(req, res, 'verify');
  if (!username) return;
  try {
    const user = await users.findByUsername(username);
    // The account can be deleted between the password step and here; without this
    // guard verifyTotp(null, …) threw and the request hung with no response.
    if (!user) return res.status(401).json({ ok: false, error: 'Please start again.' });
    const token = String(req.body?.token || '').trim();

    const ok = (await users.verifyTotpAndConsume(user, token)) ||
               (req.body?.recovery && await users.useRecoveryCode(username, token));
    if (!ok) {
      return wrongCode(req, res, username, {
        message: 'Incorrect code.',
        burnt: 'Too many incorrect codes. Enter your password again.',
      });
    }
    clearFailures(username, codeFailures);

    auth.consumePending(req.body?.pending);   // one successful use per pending token
    auth.setSessionCookie(res, user);
    res.json({ ok: true, next: safeNext(req.body?.next, user.role) });
  } finally { endCodeStep(username); }
}));

// Who am I — lets the admin page show the signed-in user and a logout control.
router.get('/api/me', async (req, res) => {
  const s = await auth.sessionUser(req, auth.ALL_ROLES);
  if (!s) return res.status(401).json({ error: 'Not signed in' });
  res.json({ user: s.user, role: s.role, home: auth.homeFor(s.role) });
});

module.exports = router;
