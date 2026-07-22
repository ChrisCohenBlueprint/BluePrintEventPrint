const crypto = require('crypto');
const { getDb } = require('../db');
const totp = require('../services/totp');

const col = () => getDb().collection('users');

// ─── Password hashing (scrypt, from node crypto — no dependency) ──────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), salt, 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// ─── Recovery codes ───────────────────────────────────────────────────────────
// Shown once at enrolment; each works once if the phone is lost. Stored hashed,
// so a database leak does not hand over usable codes. 10 random bytes (80 bits)
// each, so the hashes are not brute-forceable even if the collection leaks —
// the previous 5 bytes (40 bits) were.
function makeRecoveryCodes(n = 8) {
  const plain = Array.from({ length: n }, () =>
    crypto.randomBytes(10).toString('hex').replace(/(.{5})(.{5})(.{5})/, '$1-$2-$3'));
  const hashed = plain.map(c => crypto.createHash('sha256').update(c).digest('hex'));
  return { plain, hashed };
}

async function ensureIndexes() {
  await col().createIndex({ username: 1 }, { unique: true });
}

const findByUsername = (username) =>
  col().findOne({ username: String(username || '').toLowerCase().trim() });

/**
 * Create or overwrite an account. Used by the bootstrap and by the create-admin
 * script. The account starts un-enrolled; 2FA is set up on first login.
 */
async function upsert({ username, password, role = 'admin' }) {
  const uname = String(username).toLowerCase().trim();
  await col().updateOne(
    { username: uname },
    { $set: {
        username: uname,
        passwordHash: hashPassword(password),
        role,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        totpSecret: null,
        totpEnrolled: false,
        recoveryHashes: [],
        createdAt: new Date(),
      } },
    { upsert: true }
  );
  return findByUsername(uname);
}

/** Seed Annie from the env credentials if no accounts exist yet. */
async function bootstrap({ username, password }) {
  if (!username || !password) return null;
  const count = await col().countDocuments();
  if (count > 0) return null;
  const user = await upsert({ username, password, role: 'admin' });
  console.log(`✅ Seeded admin account "${user.username}" — 2FA set up on first login`);
  return user;
}

/** Begin enrolment: hand back a fresh secret and the codes to display once. */
async function startEnrolment(username) {
  const user = await findByUsername(username);
  if (!user) return null;
  const secret = totp.generateSecret();
  const { plain, hashed } = makeRecoveryCodes();
  // Held as pending until the user proves they can generate a valid code.
  await col().updateOne({ username: user.username },
    { $set: { pendingSecret: secret, pendingRecovery: hashed } });
  return { secret, recoveryCodes: plain, otpauth: totp.otpauthUri(secret, { account: user.username }) };
}

/** Confirm enrolment once the user enters a code the pending secret produces. */
async function confirmEnrolment(username, token) {
  const user = await findByUsername(username);
  if (!user || !user.pendingSecret) return false;
  if (!totp.verify(user.pendingSecret, token)) return false;
  await col().updateOne({ username: user.username },
    { $set: { totpSecret: user.pendingSecret, totpEnrolled: true, recoveryHashes: user.pendingRecovery || [] },
      $unset: { pendingSecret: '', pendingRecovery: '' } });
  return true;
}

const verifyTotp = (user, token) => user.totpEnrolled && totp.verify(user.totpSecret, token);

/** Spend a recovery code (one use). Returns true if it was valid. */
async function useRecoveryCode(username, code) {
  const hash = crypto.createHash('sha256').update(String(code || '').trim()).digest('hex');
  // Atomic check-and-remove: the code must still be present for the update to
  // match. A separate read-then-pull would let two concurrent logins both pass
  // the check and spend the same code twice.
  const res = await col().updateOne(
    { username: String(username || '').toLowerCase().trim(), recoveryHashes: hash },
    { $pull: { recoveryHashes: hash } }
  );
  return res.modifiedCount === 1;
}

// ─── Team management ──────────────────────────────────────────────────────────
/** All accounts, without any secret material. */
const list = () =>
  col().find({}).project({ username: 1, role: 1, totpEnrolled: 1, createdAt: 1 })
       .sort({ createdAt: 1 }).toArray();

const count = () => col().countDocuments();

/** Reset an account's 2FA so it re-enrols on next login (lost-phone recovery). */
async function resetTotp(username) {
  const res = await col().updateOne(
    { username: String(username || '').toLowerCase().trim() },
    { $set: { totpSecret: null, totpEnrolled: false, recoveryHashes: [] },
      $unset: { pendingSecret: '', pendingRecovery: '' } });
  return res.matchedCount === 1;
}

/** Set a new password without touching 2FA. */
async function setPassword(username, password) {
  const res = await col().updateOne(
    { username: String(username || '').toLowerCase().trim() },
    { $set: { passwordHash: hashPassword(password), updatedAt: new Date() } });
  return res.matchedCount === 1;
}

async function remove(username) {
  const res = await col().deleteOne({ username: String(username || '').toLowerCase().trim() });
  return res.deletedCount === 1;
}

module.exports = {
  ensureIndexes, findByUsername, upsert, bootstrap,
  verifyPassword, verifyTotp, startEnrolment, confirmEnrolment, useRecoveryCode,
  list, count, resetTotp, setPassword, remove,
};
