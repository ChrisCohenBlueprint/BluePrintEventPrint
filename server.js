const express = require('express');
const http    = require('http');
const path    = require('path');
const { Server } = require('socket.io');

const config  = require('./server/config');
const db      = require('./server/db');
const { adminAuth } = require('./server/auth');
const sockets = require('./server/sockets');
const apiRoutes    = require('./server/routes/api');
const authRoutes   = require('./server/routes/auth-routes');
const publicRoutes = require('./server/routes/public');
const users        = require('./server/models/users');
const partners     = require('./server/models/partners');
const tracking   = require('./server/services/tracking');

async function start() {
  await db.connect();

  // Admin accounts + first-run bootstrap. If no account exists yet, seed one
  // from ADMIN_USER / ADMIN_PASS so the existing Render credentials keep working
  // — 2FA is then set up on that account's first login.
  await users.ensureIndexes();
  await partners.ensureIndexes();
  await users.bootstrap({ username: config.adminUser, password: config.adminPass });

  const app    = express();
  const server = http.createServer(app);

  // CORS was '*'. The socket layer now carries an auth cookie, so the origin
  // must be constrained — a wildcard origin with credentials is unsafe.
  const io = new Server(server, {
    cors: { origin: config.isProd ? (process.env.PUBLIC_ORIGIN || false) : true, credentials: true },
  });

  app.set('trust proxy', 1);          // Render terminates TLS upstream
  app.use(express.json({ limit: '32kb' }));

  app.get('/', (_, res) => res.redirect('/floorplan'));

  // Login flow, mounted BEFORE adminAuth so /login, /login/*, /logout and
  // /api/me stay reachable without a session.
  app.use(authRoutes);

  // Public endpoints (price-free sponsor recommendations) — also before adminAuth.
  app.use(publicRoutes);

  // Guards /admin* and /api/* — redirects page requests to /login, 401s the rest.
  app.use(adminAuth);

  app.use('/api', apiRoutes);

  app.get('/floorplan', (_, res) => res.sendFile(path.join(__dirname, 'public', 'floorplan.html')));
  app.get('/admin',     (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

  // Caching: the big floorplan SVG never changes, so cache it hard. Everything
  // else (HTML/CSS/JS) must revalidate on every load — otherwise a deploy's new
  // markup pairs with a browser's stale stylesheet and the page renders broken
  // until a manual hard-refresh. `no-cache` still allows an efficient 304 when
  // the file is unchanged; it just forbids using the cached copy blind.
  app.use(express.static(path.join(__dirname, 'public'), {
    etag: true,
    setHeaders: (res, p) => {
      if (p.endsWith('.svg')) res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      else res.setHeader('Cache-Control', 'no-cache');
    },
  }));

  app.use((err, _req, res, _next) => {
    console.error('Unhandled:', err);
    res.status(500).json({ error: 'Internal error' });
  });

  await sockets.refresh();
  sockets.register(io);

  server.listen(config.port, () =>
    console.log(`BluePrint EventPrint — port ${config.port}  ·  show ${config.showId}`));

  // Flush buffered analytics before exit rather than dropping them.
  const shutdown = async (sig) => {
    console.log(`\n${sig} — flushing and closing…`);
    try { await tracking.flush(); await db.close(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch(e => { console.error('Failed to start:', e); process.exit(1); });
