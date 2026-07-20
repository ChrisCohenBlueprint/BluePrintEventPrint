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

// ─── Express: protect admin surfaces ──────────────────────────────────────────
const ADMIN_PATHS = ['/admin.html', '/admin.js', '/admin.css'];

function adminAuth(req, res, next) {
  const isAdminPath = req.path.startsWith('/admin') || ADMIN_PATHS.includes(req.path);
  const isApiPath   = req.path.startsWith('/api/');

  // /api/* previously sat outside this check and served deal prices, company
  // names and internal notes to anyone who asked.
  if (!isAdminPath && !isApiPath) return next();

  const b64 = (req.headers.authorization || '').split(' ')[1] || '';
  const [login, password] = Buffer.from(b64, 'base64').toString().split(':');

  const ok = login && password &&
             safeEqual(login, config.adminUser) &&
             safeEqual(password, config.adminPass);

  if (!ok) {
    res.set('WWW-Authenticate', 'Basic realm="BluePrint Admin"');
    return res.status(401).send('Authentication required.');
  }

  // Issue the token the socket layer checks. HttpOnly so page scripts can't
  // read it; the browser attaches it to the websocket handshake automatically.
  const token = signToken({ user: login, role: 'admin', exp: Date.now() + config.adminTokenTtlMs });
  res.cookie
    ? res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: config.adminTokenTtlMs })
    : res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${config.adminTokenTtlMs / 1000}${config.isProd ? '; Secure' : ''}`);

  req.admin = { user: login };
  next();
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
  return async (payload = {}) => {
    if (!socket.data.isAdmin) {
      console.warn(`⚠  Denied ${type} from unauthenticated socket ${socket.id}`);
      socket.emit('error:auth', { event: type, message: 'Administrator access required.' });
      const { track } = require('./services/tracking');
      track({ type: 'security.denied', meta: { event: type }, socket });
      return;
    }
    // Async handler rejections would otherwise surface as an unhandled promise
    // rejection with no link back to the event that caused it.
    try {
      return await handler(payload);
    } catch (e) {
      console.error(`✗ ${type} failed:`, e.stack || e.message);
      socket.emit('error:action', { event: type, message: 'That action could not be completed.' });
    }
  };
}

module.exports = { adminAuth, socketAuth, requireAdmin, signToken, verifyToken, COOKIE };
