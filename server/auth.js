const crypto = require('crypto');
const config = require('./config');
const users  = require('./models/users');

const COOKIE = 'bp_admin';

// Both roles may use the admin surfaces; only 'owner' may manage team accounts.
const ADMIN_ROLES = ['admin', 'owner'];

// The sales tier: a sub-admin who signs in with the same password + 2FA flow but
// only ever reaches /sales. They see remaining inventory and build client
// proposals; they can neither book a stand nor open the admin console, so a
// compromised rep account cannot alter the floorplan or read the deal notes.
const SALES_ROLES = ['sales'];

// Everyone holding a real account. The sales dashboard admits all three — an
// owner checking what a rep sees is legitimate — while the admin surfaces stay
// ADMIN_ROLES-only.
const ALL_ROLES = [...ADMIN_ROLES, ...SALES_ROLES];

// ─── Constant-time string compare ─────────────────────────────────────────────
// Length is compared first because timingSafeEqual throws on length mismatch.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ─── Signed admin token ───────────────────────────────────────────────────────
// Format: base64(payload).hmac — stateless, so it survives a restart as long as
// SESSION_SECRET is stable, and needs no session store.
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac  = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;

  const expected = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  if (!safeEqual(mac, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(header = '') {
  return header.split(';').reduce((acc, part) => {
    const i = part.indexOf('=');
    if (i > 0) {
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      // A malformed value (e.g. a lone "%") makes decodeURIComponent throw a
      // URIError. This runs on every request before auth — including the
      // unauthenticated /login path — so an unhandled throw here would let any
      // visitor hang requests with `Cookie: bp_admin=%`. Fall back to the raw
      // value instead of rejecting.
      try { acc[k] = decodeURIComponent(v); } catch { acc[k] = v; }
    }
    return acc;
  }, {});
}

// ─── Session cookie ───────────────────────────────────────────────────────────
// The Secure flag has to be identical when setting and clearing, or the browser
// treats them as different cookies and sign-out fails to clear the session on
// the live HTTPS site (it works locally over HTTP precisely because neither has
// Secure). Keep both through this one attribute string.
const cookieAttrs = () =>
  `HttpOnly; SameSite=Lax; Path=/${config.isProd ? '; Secure' : ''}`;

function setSessionCookie(res, user) {
  const token = signToken({
    user: user.username, role: user.role || 'admin',
    v: user.tokenVersion || 0,               // revocation stamp, checked on every request
    exp: Date.now() + config.adminTokenTtlMs,
  });
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieAttrs()}; Max-Age=${config.adminTokenTtlMs / 1000}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieAttrs()}; Max-Age=0`);
}

/**
 * Resolve the signed session to a live account, or null.
 *
 * The cryptographic checks (valid HMAC, not expired, not a pending token, admin
 * role) are necessary but no longer sufficient: the token is also matched
 * against the account's current `tokenVersion` in the database, so deleting an
 * admin or resetting their password/2FA revokes their session immediately
 * rather than leaving it valid until the 12h token expiry. Async because it
 * reads the DB — every caller awaits it.
 */
async function sessionUser(req, roles = ADMIN_ROLES) {
  const cookies = parseCookies(req.headers.cookie || '');
  const payload = verifyToken(cookies[COOKIE]);   // null if absent, tampered or expired
  if (!payload || payload.pending || payload.purpose || !roles.includes(payload.role)) return null;

  let account;
  try { account = await users.findAuth(payload.user); }
  catch { return null; }                           // DB unavailable → fail closed
  // Account gone (deleted) or its token version moved on (password/2FA reset) →
  // the cookie is stale. Existing pre-upgrade tokens/accounts both read as 0.
  // The role is re-checked against the DB, not just the token, so demoting an
  // admin to sales takes effect on their next request rather than in 12h.
  if (!account || !roles.includes(account.role)) return null;
  if ((account.tokenVersion || 0) !== (payload.v || 0)) return null;
  // Return the CURRENT role from the DB, not the token's — an account promoted
  // to owner gains that authority without having to log in again.
  return { ...payload, role: account.role };
}

// ─── Express: protect admin surfaces ──────────────────────────────────────────
// Auth is now a session cookie set by the login flow, replacing the shared
// HTTP Basic Auth. A page request without a valid session is redirected to the
// login page; an API or asset request gets a 401.
const ADMIN_PATHS = ['/admin.html', '/admin.js'];
const SALES_PATHS = ['/sales.html', '/sales.js', '/sales.css',
                     '/menu-print.html', '/menu-print.js', '/menu-print.css'];

/**
 * Presentation-only assets shared by the admin console and the sales dashboard.
 *
 * The sales page is built on the same design tokens, sidebar and controls, so it
 * links admin.css too. Left in ADMIN_PATHS that stylesheet was 403'd for the very
 * reps the page is for, and the dashboard rendered completely unstyled. It
 * carries no data — only colours and layout — so it is gated on being signed in
 * rather than on holding an admin role. Anything that returns data stays
 * admin-only.
 */
const SHARED_ASSETS = ['/admin.css'];

// Express matches routes case-insensitively and express.static resolves
// percent-encoding, so every guard normalises both before comparing. Without
// this, /API/booths and /ADMIN were reachable unauthenticated.
function normalisePath(req) {
  let p = req.path;
  try { p = decodeURIComponent(p); } catch { /* malformed escape: match on raw */ }
  p = p.toLowerCase().replace(/\/{2,}/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

// Where an account belongs when it lands with no explicit destination. A rep has
// no admin console to go to, so sending them to /admin would bounce them
// straight back to the login screen.
const homeFor = (role) => (role === 'sales' ? '/sales' : '/admin');

// Shared "you are not signed in" response: page requests go to the login
// screen, everything else (XHR, assets) gets a clean 401.
function denyUnauthenticated(req, res) {
  const wantsHtml = (req.headers.accept || '').includes('text/html') && req.method === 'GET';
  if (wantsHtml) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  return res.status(401).json({ error: 'Authentication required.' });
}

async function adminAuth(req, res, next) {
  const p = normalisePath(req);

  // The shared stylesheet is deliberately excluded from the /admin. prefix rule —
  // salesAuth (which runs first) has already required a signed-in account for it.
  const isAdminPath = !SHARED_ASSETS.includes(p) &&
                      (p === '/admin' || p.startsWith('/admin/') || ADMIN_PATHS.includes(p) ||
                       p.startsWith('/admin.'));
  const isApiPath   = p === '/api' || p.startsWith('/api/');
  if (!isAdminPath && !isApiPath) return next();

  const session = await sessionUser(req);
  if (session) { req.admin = { user: session.user, role: session.role }; return next(); }

  // A signed-in REP is authenticated but not authorised here. Redirecting them
  // to /login would be a dead end — the login page sees a valid session and
  // bounces them back, looping. Send them to their own dashboard instead, and
  // give their XHRs a 403 (not a 401) so the client can tell "wrong tier" from
  // "session expired".
  const rep = await sessionUser(req, SALES_ROLES);
  if (rep) {
    const wantsHtml = (req.headers.accept || '').includes('text/html') && req.method === 'GET';
    if (wantsHtml) return res.redirect('/sales');
    return res.status(403).json({ error: 'This area is for administrators.' });
  }

  return denyUnauthenticated(req, res);
}

// ─── Express: protect the sales dashboard ─────────────────────────────────────
// Mounted BEFORE adminAuth so /api/sales/* is handled here rather than being
// caught by the admin guard's blanket /api/* rule. Admins and the owner are
// allowed through too, so they can see exactly what a rep sees.
async function salesAuth(req, res, next) {
  const p = normalisePath(req);

  const isSalesPath = p === '/sales' || p.startsWith('/sales/') || SALES_PATHS.includes(p) ||
                      p.startsWith('/sales.') || SHARED_ASSETS.includes(p);
  const isSalesApi  = p === '/api/sales' || p.startsWith('/api/sales/');
  if (!isSalesPath && !isSalesApi) return next();

  const session = await sessionUser(req, ALL_ROLES);
  if (!session) return denyUnauthenticated(req, res);

  req.account = { user: session.user, role: session.role };
  next();
}

// ─── Socket.IO: identify admins at handshake ──────────────────────────────────
// Without this the socket layer accepted admin:* events from any anonymous
// visitor, which made the HTTP auth above decorative.
async function socketAuth(socket, next) {
  const cookies = parseCookies(socket.handshake.headers.cookie || '');
  const payload = verifyToken(cookies[COOKIE]);

  let isAdmin = false, role = null;
  if (payload && ADMIN_ROLES.includes(payload.role) && !payload.pending && !payload.purpose) {
    try {
      const account = await users.findAuth(payload.user);
      // Same revocation check as the HTTP path: a deleted account or a bumped
      // token version means the socket must not be treated as an admin.
      if (account && ADMIN_ROLES.includes(account.role) &&
          (account.tokenVersion || 0) === (payload.v || 0)) {
        isAdmin = true; role = account.role;
      }
    } catch { isAdmin = false; }               // DB unavailable → not admin
  }
  socket.data.isAdmin = isAdmin;
  socket.data.role    = role;
  socket.data.user    = isAdmin ? payload.user : null;
  next();
}

// Wraps a handler so it only runs for authenticated admins. Rejected attempts
// are recorded — an attacker probing admin events is worth knowing about.
function requireAdmin(socket, type, handler) {
  // Socket.IO passes a callback as the final argument when the client uses
  // socket.emit(event, payload, cb). Surfacing it lets a handler confirm success
  // or failure back to the specific caller, so the admin UI can stop reporting
  // "saved" before the write has actually happened.
  return async (payload = {}, ack) => {
    if (typeof payload === 'function') { ack = payload; payload = {}; }

    if (!socket.data.isAdmin) {
      console.warn(`⚠  Denied ${type} from unauthenticated socket ${socket.id}`);
      socket.emit('error:auth', { event: type, message: 'Administrator access required.' });
      const { track } = require('./services/tracking');
      track({ type: 'security.denied', meta: { event: type }, socket });
      if (typeof ack === 'function') ack({ ok: false, error: 'Administrator access required.' });
      return;
    }
    // Async handler rejections would otherwise surface as an unhandled promise
    // rejection with no link back to the event that caused it.
    try {
      // The handler's return value is its acknowledgement. Returning
      // { ok: false, error } reports a business-rule failure; returning nothing
      // is treated as success. Either way the caller always gets a response.
      const result = await handler(payload);
      if (typeof ack === 'function') ack({ ok: true, ...(result || {}) });
    } catch (e) {
      console.error(`✗ ${type} failed:`, e.stack || e.message);
      socket.emit('error:action', { event: type, message: 'That action could not be completed.' });
      if (typeof ack === 'function') ack({ ok: false, error: 'That action could not be completed.' });
    }
  };
}

// ─── Pending-login token ──────────────────────────────────────────────────────
// Carries state between the password step and the 2FA step without a session
// store. Signed with SESSION_SECRET, short-lived, and NOT an auth cookie — it
// only proves the password was accepted and the user still owes a code.
// Pending tokens are single-use once a login step succeeds: the jti is recorded
// here and rejected thereafter, so a captured token can't be replayed for the
// rest of its 5-minute life. In-memory is sufficient (a token only lives 5 min);
// entries are pruned as they expire.
const spentPending = new Map();   // jti -> expiry ms
function prunePending(now) { for (const [j, exp] of spentPending) if (exp < now) spentPending.delete(j); }

function signPending(username, purpose) {
  return signToken({
    pending: username, purpose,
    jti: crypto.randomBytes(9).toString('base64url'),
    exp: Date.now() + 5 * 60 * 1000,
  });
}
function verifyPending(token, purpose) {
  const p = verifyToken(token);
  if (!p || !p.pending || p.purpose !== purpose) return null;
  if (p.jti && spentPending.has(p.jti)) return null;   // already used
  return p.pending;
}
/** Mark a pending token spent — called after the step it authorised succeeds. */
function consumePending(token) {
  const p = verifyToken(token);
  if (!p || !p.jti) return;
  prunePending(Date.now());
  spentPending.set(p.jti, p.exp || Date.now() + 5 * 60 * 1000);
}

module.exports = {
  adminAuth, salesAuth, socketAuth, requireAdmin, signToken, verifyToken, COOKIE,
  setSessionCookie, clearSessionCookie, sessionUser,
  signPending, verifyPending, consumePending,
  ADMIN_ROLES, SALES_ROLES, ALL_ROLES, homeFor,
};
