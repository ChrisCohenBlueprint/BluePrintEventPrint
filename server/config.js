require('dotenv').config();

const crypto = require('crypto');

const isProd = process.env.NODE_ENV === 'production';

// ─── Fail fast on missing secrets in production ───────────────────────────────
// Previously these silently defaulted to admin/password, which meant an
// unconfigured deploy shipped with guessable credentials.
const required = ['ADMIN_USER', 'ADMIN_PASS', 'SESSION_SECRET'];
const missing  = required.filter(k => !process.env[k]);

if (missing.length && isProd) {
  console.error(`FATAL: missing required environment variables: ${missing.join(', ')}`);
  console.error('Refusing to start in production without them.');
  process.exit(1);
}
if (missing.length) {
  console.warn(`⚠  Using development fallbacks for: ${missing.join(', ')}`);
  console.warn('   Set these in .env before deploying.');
}

module.exports = {
  isProd,
  port:      process.env.PORT || 3000,
  mongoUri:  process.env.MONGO_URI || 'mongodb://127.0.0.1:27017',
  dbName:    process.env.MONGO_DB  || 'blueprint',

  // The active show. Every collection is keyed by this so a second event
  // can be added without a schema change.
  showId:    process.env.SHOW_ID   || 'LEX26',

  adminUser: process.env.ADMIN_USER || 'admin',
  adminPass: process.env.ADMIN_PASS || 'password',

  // Signing key for the admin socket token. Random per-boot in dev, which
  // means restarting the server invalidates open admin sessions — fine locally.
  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),

  adminTokenTtlMs: 12 * 60 * 60 * 1000,   // 12h
  defaultHoldMs:   24 * 60 * 60 * 1000,   // the "24h hold" — now actually enforced

  // How long raw behavioural events are retained. Drives a TTL index, and is
  // the number that needs to match your privacy policy.
  activityRetentionDays: Number(process.env.ACTIVITY_RETENTION_DAYS || 730),

  trackingFlushMs: 3000,
};
