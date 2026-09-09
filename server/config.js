require('dotenv').config();

const crypto = require('crypto');
const showContext = require('./show-context');

// ─── Shows served by this deployment ─────────────────────────────────────────
const DEFAULT_SHOW = process.env.SHOW_ID || 'LEX26';

// "lex:LEX27,lna:LNA27" → [{ slug: 'lex', id: 'LEX27' }, …]. A malformed entry
// is dropped rather than becoming a show nobody can reach.
const SHOWS = (process.env.SHOWS || '')
  .split(',')
  .map(pair => pair.trim())
  .filter(Boolean)
  .map(pair => {
    const [slug, id] = pair.split(':').map(x => (x || '').trim());
    return slug && id ? { slug: slug.toLowerCase(), id } : null;
  })
  .filter(Boolean);

// With SHOWS unset, this deployment serves exactly one event — the one it
// always did — reachable at its own slug as well as the unprefixed paths.
if (!SHOWS.length) SHOWS.push({ slug: DEFAULT_SHOW.toLowerCase(), id: DEFAULT_SHOW });

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

// The session cookie is a bare HMAC over its payload, so a short/guessable
// SESSION_SECRET lets an attacker brute-force the key offline and then forge a
// cookie for any user — including {role:'owner'}. Require real entropy in prod.
if (isProd && (process.env.SESSION_SECRET || '').length < 32) {
  console.error('FATAL: SESSION_SECRET must be at least 32 characters in production.');
  process.exit(1);
}

module.exports = {
  isProd,
  port:      process.env.PORT || 3000,
  mongoUri:  process.env.MONGO_URI || 'mongodb://127.0.0.1:27017',
  dbName:    process.env.MONGO_DB  || 'blueprint',

  // The floorplan artwork every surface draws. Named here so the public plan,
  // the admin plan and the printed proposal cannot drift onto different files.
  floorplanSvg: process.env.FLOORPLAN_SVG || '/LEX27_Floorplan_Consolidated.svg',

  // The shows this deployment serves, as slug → id. SHOWS is a comma-separated
  // list of `slug:ID` pairs (e.g. "lex:LEX27,lna:LNA27,lme:LME27") giving the
  // URL segment for each event. Unset, it is the single configured show, so an
  // existing deploy behaves exactly as it did.
  shows: SHOWS,
  defaultShow: DEFAULT_SHOW,

  /**
   * The show the current request belongs to.
   *
   * A getter, not a value: it reads the async context set when the request
   * arrived (see show-context.js), so the ~120 `config.showId` reads across the
   * models resolve to the right event with no change to any of them. Outside a
   * request it is the default show, which is what a single-show deploy and
   * every startup task want.
   */
  get showId() { return showContext.current() || DEFAULT_SHOW; },

  // €/m², used to derive a booth's list price and to size sponsorship
  // recommendations against the buyer's likely budget.
  ratePerSqm: Number(process.env.RATE_PER_SQM || 600),

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

  // Optional. A webhook URL that receives each new enquiry as JSON — point it at
  // Zapier / Make / Slack / your CRM to turn enquiries into emails or tasks.
  notifyWebhook: process.env.NOTIFY_WEBHOOK || null,

  // ─── Data failsafe ──────────────────────────────────────────────────────────
  // A recovery key that ONLY you know: set RECOVERY_KEY on the server (never in
  // the code, and NOT your admin login). When set, the data-destroying admin
  // actions — un-booking a stand (Release, or forcing a booked stand back to
  // Available) — require it, so a stolen admin session still cannot erase your
  // bookings. Unset = off (opt-in): behaviour is unchanged until you set it.
  recoveryKey: process.env.RECOVERY_KEY || '',
  recoveryEnabled() { return !!(process.env.RECOVERY_KEY || ''); },
  recoveryOk(key) {
    const rk = process.env.RECOVERY_KEY || '';
    if (!rk) return true;                                   // failsafe disabled → allow
    const a = Buffer.from(String(key == null ? '' : key), 'utf8');
    const b = Buffer.from(rk, 'utf8');
    // timingSafeEqual throws on length mismatch; keep the compare constant-time.
    if (a.length !== b.length) { crypto.timingSafeEqual(b, b); return false; }
    return crypto.timingSafeEqual(a, b);
  },
};
