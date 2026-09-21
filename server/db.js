const { MongoClient } = require('mongodb');
const config = require('./config');

let client;
let db;

async function connect() {
  if (db) return db;

  client = new MongoClient(config.mongoUri, {
    serverSelectionTimeoutMS: 8000,
    retryWrites: true,
  });

  await client.connect();
  db = client.db(config.dbName);
  console.log(`✅ MongoDB connected — ${config.dbName}`);

  await ensureIndexes();
  return db;
}

async function ensureIndexes() {
  // ── booths ──────────────────────────────────────────────────────────────────
  // boothNumber is the business key once real numbers are extracted (plan §07).
  // Until then it holds the positional id, but the uniqueness constraint is
  // already correct.
  await db.collection('booths').createIndexes([
    { key: { showId: 1, boothNumber: 1 }, unique: true, name: 'show_booth_unique' },
    { key: { showId: 1, status: 1 },                    name: 'show_status' },
  ]);

  // ── holds ───────────────────────────────────────────────────────────────────
  // TTL index: Mongo deletes the document itself when expiresAt passes.
  // This is what makes "Hold (24h)" real rather than cosmetic. No cron needed.
  await db.collection('holds').createIndexes([
    { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'hold_ttl' },
  ]);
  // The lookup index on (showId, boothNumber) is created by
  // services/holds.ensureIndexes() as a UNIQUE one, so a stand can never end up
  // with two live hold documents. Mongo refuses a second index over the same key
  // pattern, so the non-unique `show_booth` that used to be created here made
  // that unique index impossible — holds.ensureIndexes() reported the conflict
  // instead of throwing, which is why it went unnoticed. Drop the old one if a
  // database still carries it; the unique index serves exactly the same reads.
  await dropLegacyIndex('holds', 'show_booth');

  // ── inquiries ───────────────────────────────────────────────────────────────
  await db.collection('inquiries').createIndexes([
    { key: { showId: 1, createdAt: -1 }, name: 'show_recent' },
    { key: { sessionId: 1 },             name: 'session' },
    { key: { 'contact.email': 1 },       name: 'email' },
  ]);

  // ── activity ────────────────────────────────────────────────────────────────
  // Append-only behavioural + audit stream. Retention is enforced by TTL so the
  // collection cannot grow without bound and the privacy commitment is
  // structurally guaranteed rather than a policy someone has to remember.
  await db.collection('activity').createIndexes([
    { key: { showId: 1, type: 1, ts: -1 },      name: 'show_type_time' },
    { key: { showId: 1, boothNumber: 1, ts: -1 }, name: 'booth_time' },
    { key: { sessionId: 1, ts: -1 },            name: 'session_time' },
  ]);
  await ensureTtl('activity', 'activity_ttl', { ts: 1 }, config.activityRetentionDays * 86400);

  // ── accessCodes ─────────────────────────────────────────────────────────────
  await db.collection('accessCodes').createIndexes([
    { key: { codeHash: 1 }, unique: true, name: 'code_unique' },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'code_ttl' },
  ]);

  // ── revokedTokens ───────────────────────────────────────────────────────────
  // Session ids retired by signing out (server/auth.js). Each row carries the
  // token's own expiry and the TTL index drops it then, so the list only ever
  // holds sessions that would otherwise still be accepted.
  await db.collection('revokedTokens').createIndexes([
    { key: { jti: 1 }, unique: true, name: 'jti_unique' },
    { key: { exp: 1 }, expireAfterSeconds: 0, name: 'revoked_ttl' },
  ]);

  console.log('✅ Indexes ensured');
}

/**
 * Create or UPDATE a TTL index.
 *
 * createIndex is only idempotent while the options match. Re-running it with the
 * same name and a different expireAfterSeconds raises IndexOptionsConflict (85),
 * which rejected connect() and took the process down on boot — so changing
 * ACTIVITY_RETENTION_DAYS, the one number the privacy policy is supposed to
 * drive, made the server refuse to start and the only way back was to know to go
 * and drop the index by hand in Atlas. The lifetime of an existing index is
 * changed with collMod instead, and a collMod that cannot do it (an older server,
 * or an index whose KEY changed rather than its expiry) falls back to dropping
 * and recreating. An empty retention would delete everything immediately, so a
 * nonsensical value is refused rather than acted on.
 */
async function ensureTtl(collection, name, key, seconds, fallbackSeconds = 730 * 86400) {
  const wanted = Number(seconds);
  // A garbled ACTIVITY_RETENTION_DAYS must never become a SHORT retention: that
  // would quietly delete the audit trail. Anything under an hour, or not a
  // number at all, falls back to the documented default and says so.
  const expireAfterSeconds = Number.isFinite(wanted) && wanted >= 3600
    ? Math.floor(wanted) : fallbackSeconds;
  if (expireAfterSeconds !== wanted) {
    console.warn(`⚠  ${collection}.${name}: retention "${seconds}" is not usable — keeping ${expireAfterSeconds}s`);
  }
  try {
    await db.collection(collection).createIndex(key, { name, expireAfterSeconds });
    return;
  } catch (e) {
    if (e?.code !== 85) throw e;                    // IndexOptionsConflict, nothing else
  }
  try {
    await db.command({ collMod: collection, index: { name, expireAfterSeconds } });
    console.log(`✅ ${collection}.${name} retention updated to ${expireAfterSeconds}s`);
  } catch (e) {
    console.warn(`⚠  collMod on ${collection}.${name} failed (${e.message}) — recreating the index`);
    await db.collection(collection).dropIndex(name).catch(() => {});
    await db.collection(collection).createIndex(key, { name, expireAfterSeconds });
  }
}

/**
 * Drop an index this codebase no longer wants, if the database still has it.
 *
 * Used where an index was REPLACED by one over the same keys with different
 * options — Mongo will not hold both, so the old one has to go before the new
 * one can be created. Missing index (code 27) is the normal case on any
 * database created after the change, so it is not an error. Anything else is
 * reported and swallowed: an index that could not be dropped is a degraded
 * constraint, not a reason to refuse to serve the site.
 */
async function dropLegacyIndex(collection, name) {
  try {
    await db.collection(collection).dropIndex(name);
    console.log(`✅ dropped superseded index ${collection}.${name}`);
  } catch (e) {
    if (e?.code === 27 || /index not found/i.test(e?.message || '')) return;
    console.warn(`⚠  could not drop ${collection}.${name}: ${e.message}`);
  }
}

const getDb = () => {
  if (!db) throw new Error('Database not connected — call connect() first');
  return db;
};

const close = async () => { if (client) await client.close(); db = null; };

module.exports = { connect, getDb, close };
