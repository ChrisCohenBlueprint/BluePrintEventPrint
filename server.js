const express = require('express');
const http    = require('http');
const path    = require('path');
const { Server } = require('socket.io');

const config  = require('./server/config');
const db      = require('./server/db');
const { adminAuth } = require('./server/auth');
const sockets = require('./server/sockets');
const apiRoutes = require('./server/routes/api');
const tracking  = require('./server/services/tracking');

async function start() {
  await db.connect();

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

  // Guards /admin* and /api/* — both now, where /api/* was previously open.
  app.use(adminAuth);

  app.use('/api', apiRoutes);

  app.get('/floorplan', (_, res) => res.sendFile(path.join(__dirname, 'public', 'floorplan.html')));
  app.get('/admin',     (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

  // The floorplan SVG is 2.1 MB and was re-sent uncompressed on every load.
  app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '7d',
    setHeaders: (res, p) => {
      if (p.endsWith('.svg')) res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
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
