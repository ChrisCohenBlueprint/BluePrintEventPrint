const express     = require('express');
const http        = require('http');
const path        = require('path');
const crypto      = require('crypto');
const helmet      = require('helmet');
const compression = require('compression');
const { Server } = require('socket.io');

const { sendPage } = require('./server/lib/send-page');

const config  = require('./server/config');
const db      = require('./server/db');
const { adminAuth } = require('./server/auth');
const sockets = require('./server/sockets');
const { showMiddleware, showForRequest } = require('./server/show-middleware');
const apiRoutes    = require('./server/routes/api');
const authRoutes   = require('./server/routes/auth-routes');
const publicRoutes = require('./server/routes/public');
const salesRoutes  = require('./server/routes/sales');
const users        = require('./server/models/users');
const partners     = require('./server/models/partners');
const tags         = require('./server/models/tags');
const planAreas    = require('./server/models/plan-areas');
const showsModel   = require('./server/models/shows');
const floorplansModel = require('./server/models/floorplans');
const menus        = require('./server/models/menus');
const booths       = require('./server/models/booths');
const sponsors     = require('./server/models/sponsors');
const holdsSvc     = require('./server/services/holds');
const tracking   = require('./server/services/tracking');

// Last-resort safety net: an unhandled promise rejection anywhere (a stray
// un-awaited DB call in a timer, say) would otherwise terminate the process on
// modern Node and drop every connected socket. Log it and keep serving — the
// individual handlers already fail their own action gracefully.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection (kept alive):', reason?.stack || reason);
});

// Flipped by the signal handlers at the bottom of start(). /healthz reports
// unhealthy from that moment, so the load balancer takes this instance out of
// rotation while the in-flight work finishes.
let shuttingDown = false;

async function start() {
  await db.connect();

  // Admin accounts + first-run bootstrap. If no account exists yet, seed one
  // from ADMIN_USER / ADMIN_PASS so the existing Render credentials keep working
  // — 2FA is then set up on that account's first login.
  await users.ensureIndexes();
  await partners.ensureIndexes();
  await menus.ensureIndexes();
  await tags.ensureIndexes();
  await showsModel.ensureIndexes();
  await floorplansModel.ensureIndexes();
  // The event this deployment already runs becomes a real row, so it is
  // editable alongside any new ones rather than living only in config.
  await showsModel.ensureSeeded();
  await planAreas.ensureIndexes();
  // These three guarantee uniqueness rather than just speed, so a missing one is
  // a correctness hole, not a slow query: two live holds on one stand, two
  // stands sharing a display number, or a duplicate sponsorship package. They
  // were defined on their models but never called from here, so they existed
  // only where a seed script had happened to run. Each reports rather than
  // throws — an index that cannot be built (pre-existing duplicates, say) must
  // be visible in the logs, but it must not stop the site coming up.
  for (const [what, run] of [
    ['booths',   () => booths.ensureIndexes()],
    ['holds',    () => holdsSvc.ensureIndexes()],
    ['sponsors', () => sponsors.ensureIndexes()],
  ]) {
    try {
      const r = await run();
      if (r && r.ok === false) console.warn(`⚠  ${what} indexes: ${r.error || 'not created'}`);
    } catch (e) { console.warn(`⚠  ${what} indexes: ${e.message}`); }
  }
  await users.bootstrap({ username: config.adminUser, password: config.adminPass });
  // Promote the configured bootstrap account to owner (team-management tier).
  // Idempotent, and safe on an already-seeded database.
  await users.ensureOwner(config.adminUser);

  // Everything above this line is idempotent and additive: indexes, a registry
  // row for the event this deployment already runs, and the bootstrap account.
  //
  // The three one-shot MIGRATIONS that used to run here do not belong in a boot
  // path and are now explicit scripts — `scripts/repair-halved-stands.js`,
  // `scripts/reset-blank-layout.js` and `scripts/seed-north-america.js`, each a
  // dry run until you pass --apply.
  //
  // They were guarded by flags in the `meta` collection, which sounds like "runs
  // exactly once" and is not: the flag lives in the same database as the data.
  // Restore a backup taken before the flag was written, point the app at a fresh
  // cluster, clone production into staging, or simply bump the version the guard
  // is keyed on, and `resetToBlankLayout()` deletes every booth and every hold on
  // the default show — on the next deploy, with nobody having asked for it.
  // A server must never decide on its own that the live data is wrong enough to
  // replace. Destroying bookings is a thing a person does, deliberately, having
  // read what the dry run says it is about to do.

  const app    = express();
  const server = http.createServer(app);

  // CORS was '*'. The socket layer now carries an auth cookie, so the origin
  // must be constrained — a wildcard origin with credentials is unsafe.
  const io = new Server(server, {
    cors: { origin: config.isProd ? (process.env.PUBLIC_ORIGIN || false) : true, credentials: true },
  });

  app.set('trust proxy', 1);          // Render terminates TLS upstream

  // ─── Compression ────────────────────────────────────────────────────────────
  // A 540 KB floorplan SVG, a 290 KB icon bundle and 73 KB of application JS all
  // went over the wire raw, on a free Render instance, to phones on exhibition
  // hall wifi. SVG and JS are text and compress to roughly a fifth of that.
  // Mounted before the routes and the static handler so it covers every one of
  // them — including the artwork, which is served from the database.
  app.use(compression());

  // ─── Security headers ───────────────────────────────────────────────────────
  // There were none at all: no CSP, no nosniff, no HSTS, and every page was
  // frameable — including /login, so the 2FA form could be clickjacked, and
  // /admin, so could the Release button.
  //
  // A nonce per request, minted here so the CSP below and send-page.js agree on
  // it. Each page carries an inline <script> (the show bootstrap, and lucide's
  // icon call); naming them by nonce is what lets script-src stay closed instead
  // of falling back to 'unsafe-inline', which would allow injected script too.
  app.use((_req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    next();
  });

  // /floorplan and /floorplan/:show are deliberately embedded in the marketing
  // site, so they — and ONLY they — may be framed by the origins named in
  // EMBED_ORIGINS. Everything else is 'none'.
  const isEmbeddablePage = (req) => {
    const p = String(req.path || '').toLowerCase();
    return p === '/floorplan' || p.startsWith('/floorplan/');
  };
  const frameAncestors = (req) =>
    (isEmbeddablePage(req) ? ["'self'", ...config.embedOrigins] : ["'none'"]).join(' ');

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:  ["'self'"],
        baseUri:     ["'self'"],
        formAction:  ["'self'"],
        objectSrc:   ["'none'"],
        // Self-hosted vendor JS under /public/vendor, the Socket.IO client
        // express serves at /socket.io/, and this request's inline scripts.
        scriptSrc:   ["'self'", (_req, res) => `'nonce-${res.locals.cspNonce}'`],
        // No inline event handlers anywhere in the markup, and none are wanted:
        // the admin table was rebuilt out of DOM nodes precisely to avoid them.
        scriptSrcAttr: ["'none'"],
        // 'unsafe-inline' is unavoidable for styles: the pages carry several
        // hundred inline style="" attributes, and a nonce cannot cover an
        // attribute. It buys an attacker markup styling, not execution.
        styleSrc:    ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc:     ["'self'", 'https://fonts.gstatic.com', 'data:'],
        // Sponsor and partner logos are stored inline as data: URIs, and a row
        // may instead point at a full https:// image the client supplied.
        imgSrc:      ["'self'", 'data:', 'blob:', 'https:'],
        mediaSrc:    ["'self'", 'data:', 'blob:', 'https:'],
        // Same-origin XHR plus the Socket.IO upgrade. ws:/wss: are spelled out
        // because not every browser matches a WebSocket against 'self'.
        connectSrc:  ["'self'", 'ws:', 'wss:'],
        frameSrc:    ["'none'"],
        frameAncestors: [(req) => frameAncestors(req)],
        // Only where there is TLS to upgrade to — locally it would rewrite
        // http://localhost asset URLs and break the page.
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
    // Set per request below, alongside frame-ancestors, so the marketing site's
    // iframe is not blocked by a blanket SAMEORIGIN.
    xFrameOptions: false,
    // Only meaningful over TLS, and a stray HSTS header from a local run would
    // pin http://localhost to https for six months.
    strictTransportSecurity: config.isProd
      ? { maxAge: 15552000, includeSubDomains: true }
      : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }));

  // X-Frame-Options for the browsers that still only understand that one. DENY
  // rather than SAMEORIGIN, and simply omitted on the pages the marketing site
  // embeds — it has no syntax for "this other origin", and frame-ancestors
  // above is what actually governs them.
  app.use((req, res, next) => {
    if (!isEmbeddablePage(req)) res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  // The floorplan artwork is UPLOADED by an admin and sanitised by regex, which
  // is not a promise anyone should make about SVG. Served under its own locked
  // policy, so even if something executable survived the strip it has no script
  // source, no network and nowhere to send anything: opened directly it can draw
  // itself and nothing else. (The page injects it via innerHTML, where the
  // page's own CSP applies instead.) The route itself is left alone.
  app.use('/floorplan.svg', (_req, res, next) => {
    res.setHeader('Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    next();
  });

  // Generous enough for an uploaded logo stored inline; Render's disk is
  // ephemeral, so images live in the database rather than on the filesystem.
  app.use(express.json({ limit: '3mb' }));

  // Which show is this request for? Resolved once and carried in async context
  // for the rest of it — see server/show-middleware.js.
  app.use(showMiddleware());

  app.get('/', (_, res) => res.redirect('/floorplan'));

  // ─── Health check ───────────────────────────────────────────────────────────
  // Render polled "/" and got a 302 from an Express process that would answer it
  // just as cheerfully with the database gone — so an instance serving nothing
  // but errors still reported healthy. This actually asks Mongo, and reports
  // itself unhealthy the moment shutdown starts, so the load balancer stops
  // sending requests into a process that is closing.
  app.get('/healthz', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    if (shuttingDown) return res.status(503).json({ ok: false, status: 'shutting down' });
    try {
      await db.getDb().command({ ping: 1 });
      res.json({ ok: true, db: 'up', uptime: Math.round(process.uptime()) });
    } catch (e) {
      console.error('Health check failed:', e.message);
      res.status(503).json({ ok: false, db: 'down' });
    }
  });

  // Login flow, mounted BEFORE adminAuth so /login, /login/*, /logout and
  // /api/me stay reachable without a session.
  app.use(authRoutes);

  // Public endpoints (price-free sponsor recommendations) — also before adminAuth.
  app.use(publicRoutes);

  // Sales sub-admin surface. MUST be mounted before adminAuth: it serves
  // /api/sales/*, which the admin guard's blanket /api/* rule would otherwise
  // reject for a rep. It applies its own (sales-tier) guard internally.
  app.use(salesRoutes);

  // Guards /admin* and /api/* — redirects page requests to /login, 401s the rest.
  app.use(adminAuth);

  app.use('/api', apiRoutes);

  // Pages, with and without a show in the path. The unprefixed forms are kept
  // deliberately: /floorplan is embedded in the marketing site via an iframe and
  // /admin is bookmarked, so moving them would break both silently.
  // What to hand a designer. Two documents: the brief (how to draw a plan the
  // app can read, in their terms) and the specification it is checked against.
  // Public on purpose — the designer has no account, and there is nothing in
  // either that the plan itself does not already show. Served fresh: a
  // correction to the brief must reach the next person to open the link.
  const doc = (file) => (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, 'docs', file));
  };
  app.get('/artwork-brief', doc('floorplan-designer-brief.html'));
  app.get('/artwork-spec',  doc('floorplan-artwork-spec.html'));

  app.get('/floorplan',        (req, res) => sendPage(res, 'floorplan.html', showForRequest(req)));
  app.get('/floorplan/:show',  (req, res) => sendPage(res, 'floorplan.html', showForRequest(req)));
  app.get('/admin',            (req, res) => sendPage(res, 'admin.html',     showForRequest(req)));
  app.get('/admin/:show',      (req, res) => sendPage(res, 'admin.html',     showForRequest(req)));

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
    // A body express itself refused is the CLIENT's problem, not a server fault.
    // Reporting these as 500 "Internal error" told an admin whose CSV or logo was
    // too big that the server had broken, so the natural response was to retry
    // the same upload rather than shrink it.
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'That upload is too large. Please use a file under about 3 MB.' });
    }
    if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      return res.status(400).json({ error: 'That request could not be read.' });
    }
    console.error('Unhandled:', err);
    res.status(500).json({ error: 'Internal error' });
  });

  // Every show's caches, not just the default — see sockets.refreshAll.
  await sockets.refreshAll();
  sockets.register(io);

  server.listen(config.port, () =>
    console.log(`BluePrint EventPrint — port ${config.port}  ·  show ${config.showId}`));

  // ─── Graceful shutdown ──────────────────────────────────────────────────────
  // Render sends SIGTERM on every deploy. This used to flush analytics and then
  // call process.exit(0) immediately, which cut every open socket mid-frame: an
  // admin whose "book stand 412" was in flight saw the action fail, and a page
  // that had just been told to reload reconnected to a process that was gone.
  // Now: stop reporting healthy, close the socket layer so clients are told to
  // reconnect (and do so against the new instance), let the in-flight HTTP
  // requests finish, then flush the analytics buffer and close the database.
  // A hard deadline underneath it all, because a shutdown that hangs is worse
  // than one that is slightly rude — Render will SIGKILL us anyway.
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${sig} — draining…`);

    const deadline = setTimeout(() => {
      console.error('Shutdown took longer than 10s — exiting anyway.');
      process.exit(1);
    }, 10_000);
    if (deadline.unref) deadline.unref();

    try {
      // Closes the Socket.IO clients and stops the listener accepting new
      // connections; its callback waits for the in-flight requests.
      await new Promise((resolve) => io.close(() => resolve()));
      // Already closed by io.close() in the normal case — this covers the case
      // where it was not, and never rejects.
      await new Promise((resolve) => server.close(() => resolve()));
      await tracking.flush();
      await db.close();
      console.log('Closed cleanly.');
    } catch (e) {
      console.error('Shutdown problem (exiting anyway):', e.message);
    }
    clearTimeout(deadline);
    process.exit(0);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch(e => { console.error('Failed to start:', e); process.exit(1); });
