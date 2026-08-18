const crypto = require('crypto');
const { getDb } = require('../db');
const totp = require('../services/totp');

const col = () => getDb().collection('users');

// The three account tiers. 'sales' is the sub-admin used by the reps: same
// password + 2FA sign-in, but it only unlocks /sales.
const ROLES = ['owner', 'admin', 'sales'];
const cleanRole = (r) => (ROLES.includes(String(r || '').toLowerCase().trim())
  ? String(r).toLowerCase().trim() : 'admin');

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

// A fixed decoy hash so a login for an unknown username can still run one full
// scrypt, matching the timing of a real account. Without this, a missing user
// returned instantly and its non-existence leaked through response latency.
const DECOY_HASH = hashPassword('bp-timing-decoy');
const absorbPassword = (password) => { verifyPassword(password, DECOY_HASH); };

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
 * The minimum a request needs to authorise a session: does the account still
 * exist, what is its role, and its current token version. Read on every admin
 * request, so it is projected down to just these fields.
 */
const findAuth = (username) =>
  col().findOne(
    { username: String(username || '').toLowerCase().trim() },
    { projection: { username: 1, role: 1, tokenVersion: 1 } }
  );

/**
 * Create or overwrite an account. Used by the bootstrap and by the create-admin
 * script. The account starts un-enrolled; 2FA is set up on first login.
 */
async function upsert({ username, password, role = 'admin', displayName, email }) {
  const uname = String(username).toLowerCase().trim();
  const $set = {
    username: uname,
    passwordHash: hashPassword(password),
    updatedAt: new Date(),
  };
  // Profile fields are optional and only written when supplied, so re-running
  // upsert to reset a password never blanks a rep's name or email.
  if (displayName != null) $set.displayName = String(displayName).trim().slice(0, 60);
  if (email != null)       $set.email = String(email).trim().slice(0, 120);

  await col().updateOne(
    { username: uname },
    { $set,
      // Role is set only on INSERT, never overwritten. Otherwise the
      // break-glass "reset password" path (admin-account.js create annie …)
      // would re-run upsert with the default role:'admin' and silently DEMOTE
      // the owner, locking everyone out of team management.
      $setOnInsert: {
        role: cleanRole(role),
        totpSecret: null,
        totpEnrolled: false,
        recoveryHashes: [],
        // Bumped whenever the account's credentials change or it is removed;
        // the live session token embeds this number, so raising it revokes
        // every token already issued for the account.
        tokenVersion: 0,
        createdAt: new Date(),
      } },
    { upsert: true }
  );
  return findByUsername(uname);
}

/** Seed the owner from the env credentials if no accounts exist yet. */
async function bootstrap({ username, password }) {
  if (!username || !password) return null;
  const count = await col().countDocuments();
  if (count > 0) return null;
  const user = await upsert({ username, password, role: 'owner' });
  console.log(`✅ Seeded owner account "${user.username}" — 2FA set up on first login`);
  return user;
}

/**
 * Guarantee the configured bootstrap account is the owner. Team management
 * (creating/removing admins, resetting a colleague's password or 2FA) is
 * restricted to the owner, so on deploy the existing bootstrap admin is
 * promoted in place — nobody is logged out and the role simply gains authority.
 */
async function ensureOwner(username) {
  const uname = String(username || '').toLowerCase().trim();
  if (!uname) return;
  await col().updateOne({ username: uname }, { $set: { role: 'owner' } });
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
  const step = totp.verifyStep(user.pendingSecret, token);
  if (step < 0) return false;
  // Record the step used at enrolment so the very same code can't be replayed
  // to log in immediately afterwards. The one-time invite code is consumed here
  // too — enrolment is complete, it has done its job.
  await col().updateOne({ username: user.username },
    { $set: { totpSecret: user.pendingSecret, totpEnrolled: true, recoveryHashes: user.pendingRecovery || [], lastTotpStep: step },
      $unset: { pendingSecret: '', pendingRecovery: '', claimHash: '' } });
  return true;
}

// ─── Invite / claim code ──────────────────────────────────────────────────────
// A one-time code the owner issues when creating an account (or resetting its
// 2FA). It must be presented alongside the temp password before the account can
// enrol an authenticator — so an intercepted temp password ALONE cannot claim
// the account. Accounts with no claimHash (the bootstrap owner, legacy admins)
// don't require one, so this can never lock out an existing user.
const CLAIM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeClaimCode() {
  return Array.from(crypto.randomBytes(9), b => CLAIM_ALPHABET[b % CLAIM_ALPHABET.length]).join('');
}
const claimHash = (code) => crypto.createHash('sha256').update(String(code || '').trim().toUpperCase()).digest('hex');

/** Issue (or re-issue) a one-time invite code; returns the plaintext to show once. */
async function issueClaimCode(username) {
  const code = makeClaimCode();
  const res = await col().updateOne(
    { username: String(username || '').toLowerCase().trim() },
    { $set: { claimHash: claimHash(code) } }
  );
  return res.matchedCount ? code : null;
}
/** True only when the account carries a claim code and still needs to enrol. */
const needsClaim = (user) => !!(user && user.claimHash && !user.totpEnrolled);
/** Accounts with no claimHash never require a code; otherwise it must match. */
const checkClaim = (user, code) => !user || !user.claimHash || claimHash(code) === user.claimHash;

const verifyTotp = (user, token) => user.totpEnrolled && totp.verify(user.totpSecret, token);

/**
 * Verify a TOTP code AND spend it, so it cannot be replayed within its window.
 * The matched step is stored as lastTotpStep; codes at or below it are refused
 * next time. The write is conditional (only advances the step), so two
 * concurrent logins can't both accept the same code.
 */
async function verifyTotpAndConsume(user, token) {
  if (!user?.totpEnrolled) return false;
  const step = totp.verifyStep(user.totpSecret, token, { after: user.lastTotpStep || 0 });
  if (step < 0) return false;
  const res = await col().updateOne(
    { username: user.username, $or: [{ lastTotpStep: { $lt: step } }, { lastTotpStep: { $exists: false } }] },
    { $set: { lastTotpStep: step } }
  );
  // Only the request that actually advanced the step succeeds. Two concurrent
  // logins can both pass verifyStep on the same code; the conditional write
  // matches for exactly one, and returning that result (not an unconditional
  // true) is what makes the code genuinely single-use under concurrency.
  return res.modifiedCount === 1;
}

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
  col().find({}).project({ username: 1, role: 1, totpEnrolled: 1, createdAt: 1,
                           displayName: 1, email: 1 })
       .sort({ createdAt: 1 }).toArray();

/** Update a rep's display name / email without touching credentials. */
async function setProfile(username, { displayName, email } = {}) {
  const $set = { updatedAt: new Date() };
  if (displayName != null) $set.displayName = String(displayName).trim().slice(0, 60);
  if (email != null)       $set.email = String(email).trim().slice(0, 120);
  const res = await col().updateOne(
    { username: String(username || '').toLowerCase().trim() }, { $set });
  return res.matchedCount === 1;
}

/**
 * Move an existing account between tiers (admin ↔ sales). Bumps tokenVersion so
 * a demoted admin's live session is revoked immediately rather than keeping
 * admin authority until the 12h token expires. The owner is never re-roled here
 * — that tier is the recovery anchor and is managed through the bootstrap env.
 */
async function setRole(username, role) {
  const uname = String(username || '').toLowerCase().trim();
  const current = await findByUsername(uname);
  if (!current || current.role === 'owner') return false;
  const res = await col().updateOne({ username: uname },
    { $set: { role: cleanRole(role), updatedAt: new Date() }, $inc: { tokenVersion: 1 } });
  return res.matchedCount === 1;
}

const count = () => col().countDocuments();

/** Reset an account's 2FA so it re-enrols on next login (lost-phone recovery). */
async function resetTotp(username) {
  const res = await col().updateOne(
    { username: String(username || '').toLowerCase().trim() },
    { $set: { totpSecret: null, totpEnrolled: false, recoveryHashes: [] },
      // Resetting 2FA is a recovery/offboarding action — end any live session
      // for the account so a stolen cookie cannot outlive the reset.
      $inc: { tokenVersion: 1 },
      $unset: { pendingSecret: '', pendingRecovery: '' } });
  return res.matchedCount === 1;
}

/** Set a new password without touching 2FA. */
async function setPassword(username, password) {
  const res = await col().updateOne(
    { username: String(username || '').toLowerCase().trim() },
    // Bump tokenVersion so changing the password logs out existing sessions.
    { $set: { passwordHash: hashPassword(password), updatedAt: new Date() },
      $inc: { tokenVersion: 1 } });
  return res.matchedCount === 1;
}

async function remove(username) {
  const res = await col().deleteOne({ username: String(username || '').toLowerCase().trim() });
  return res.deletedCount === 1;
}

module.exports = {
  ensureIndexes, findByUsername, findAuth, upsert, bootstrap, ensureOwner,
  verifyPassword, absorbPassword, verifyTotp, verifyTotpAndConsume,
  startEnrolment, confirmEnrolment, useRecoveryCode,
  issueClaimCode, needsClaim, checkClaim,
  list, count, resetTotp, setPassword, setProfile, setRole, remove, ROLES,
};
