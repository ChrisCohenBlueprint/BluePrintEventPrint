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
    { key: { showId: 1, boothNumber: 1 },            name: 'show_booth' },
  ]);

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
    { key: { ts: 1 }, expireAfterSeconds: config.activityRetentionDays * 86400, name: 'activity_ttl' },
    { key: { showId: 1, type: 1, ts: -1 },      name: 'show_type_time' },
    { key: { showId: 1, boothNumber: 1, ts: -1 }, name: 'booth_time' },
    { key: { sessionId: 1, ts: -1 },            name: 'session_time' },
  ]);

  // ── accessCodes ─────────────────────────────────────────────────────────────
  await db.collection('accessCodes').createIndexes([
    { key: { codeHash: 1 }, unique: true, name: 'code_unique' },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'code_ttl' },
  ]);

  console.log('✅ Indexes ensured');
}

const getDb = () => {
  if (!db) throw new Error('Database not connected — call connect() first');
  return db;
};

const close = async () => { if (client) await client.close(); db = null; };

module.exports = { connect, getDb, close };
