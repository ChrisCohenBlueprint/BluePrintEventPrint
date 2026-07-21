const crypto = require('crypto');
const config = require('./config');

const COOKIE = 'bp_admin';

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
    if (i > 0) acc[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
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
  const token = signToken({ user: user.username, role: user.role || 'admin', exp: Date.now() + config.adminTokenTtlMs });
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieAttrs()}; Max-Age=${config.adminTokenTtlMs / 1000}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieAttrs()}; Max-Age=0`);
}

function sessionUser(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return verifyToken(cookies[COOKIE]);   // null if absent, tampered or expired
}

// ─── Express: protect admin surfaces ──────────────────────────────────────────
// Auth is now a session cookie set by the login flow, replacing the shared
// HTTP Basic Auth. A page request without a valid session is redirected to the
// login page; an API or asset request gets a 401.
const ADMIN_PATHS = ['/admin.html', '/admin.js', '/admin.css'];

function adminAuth(req, res, next) {
  // Express matches routes case-insensitively and express.static resolves
  // percent-encoding, so the guard normalises both before comparing. Without
  // this, /API/booths and /ADMIN were reachable unauthenticated.
  let p = req.path;
  try { p = decodeURIComponent(p); } catch { /* malformed escape: match on raw */ }
  p = p.toLowerCase().replace(/\/{2,}/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);

  const isAdminPath = p === '/admin' || p.startsWith('/admin/') || ADMIN_PATHS.includes(p) ||
                      p.startsWith('/admin.');
  const isApiPath   = p === '/api' || p.startsWith('/api/');
  if (!isAdminPath && !isApiPath) return next();

  const session = sessionUser(req);
  if (session) { req.admin = { user: session.user }; return next(); }

  // Not authenticated. HTML page requests go to the login screen; everything
  // else (XHR, assets) gets a clean 401.
  const wantsHtml = (req.headers.accept || '').includes('text/html') && req.method === 'GET';
  if (wantsHtml) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  return res.status(401).json({ error: 'Authentication required.' });
}

// ─── Socket.IO: identify admins at handshake ──────────────────────────────────
// Without this the socket layer accepted admin:* events from any anonymous
// visitor, which made the HTTP auth above decorative.
function socketAuth(socket, next) {
  const cookies = parseCookies(socket.handshake.headers.cookie || '');
  const payload = verifyToken(cookies[COOKIE]);

  socket.data.isAdmin = payload?.role === 'admin';
  socket.data.user    = payload?.user || null;
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
function signPending(username, purpose) {
  return signToken({ pending: username, purpose, exp: Date.now() + 5 * 60 * 1000 });
}
function verifyPending(token, purpose) {
  const p = verifyToken(token);
  if (!p || !p.pending || p.purpose !== purpose) return null;
  return p.pending;
}

module.exports = {
  adminAuth, socketAuth, requireAdmin, signToken, verifyToken, COOKIE,
  setSessionCookie, clearSessionCookie, sessionUser, signPending, verifyPending,
};
