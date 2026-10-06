#!/usr/bin/env node
/**
 * Manage accounts and recover from a 2FA lockout.
 *
 * This is the break-glass tool: anyone with the database connection string can
 * reset a password or clear 2FA, so losing a phone never means losing access.
 *
 *   node scripts/admin-account.js list
 *   node scripts/admin-account.js create <username> <password> [role]  create / reset password
 *   node scripts/admin-account.js role <username> <admin|sales>        change access level
 *   node scripts/admin-account.js reset-2fa <username>                 clear 2FA (re-enrols next login)
 *   node scripts/admin-account.js delete <username>
 *
 * `role` is admin (default) or sales. A sales account can only reach /sales:
 * remaining sponsorship, available stands and the client proposals built from
 * them — never the admin console.
 *
 * It does what the Team tab does, through the same model functions, so the
 * two cannot drift apart:
 *
 *  - resetting a password or 2FA signs the account out everywhere at once
 *    (its tokenVersion is bumped). This used to go through users.upsert and a
 *    hand-written update, neither of which did, so a break-glass reset after a
 *    stolen session left that session alive for the rest of its twelve hours;
 *  - an account that still has to set up its authenticator is given a one-time
 *    invite code, printed once, which must be entered with the password on
 *    first sign-in. Without it a temporary password alone claimed the account.
 *    The owner is exempt, as in the Team tab: it is the recovery anchor and
 *    must always be able to enrol from its password alone.
 *
 * Against Atlas, pass the connection string for the one command:
 *   MONGO_URI="mongodb+srv://…" node scripts/admin-account.js reset-2fa annie
 */
const { connect, getDb, close } = require('../server/db');
const users = require('../server/models/users');

/** Issue an invite code if this account needs one, and print it once. */
async function inviteIfNeeded(username) {
  const user = await users.findByUsername(username);
  if (!user || user.totpEnrolled || user.role === 'owner') return null;
  const code = await users.issueClaimCode(user.username);
  console.log(`   One-time invite code: ${code}`);
  console.log('   Shown once. Give it to them separately from the password — both are needed on first sign-in.');
  return code;
}

async function main(argv = process.argv.slice(2)) {
  const [cmd, a, b, c] = argv;
  // An operator's tool must never alter live indexes as a side effect of
  // looking up an account.
  await connect({ indexes: false });
  const db = getDb();

  try {
    switch (cmd) {
      case 'list': {
        const rows = await db.collection('users').find({}).project({ username: 1, role: 1, totpEnrolled: 1 }).toArray();
        if (!rows.length) console.log('No accounts.');
        rows.forEach(u => console.log(`  ${u.username.padEnd(16)} ${String(u.role || 'admin').padEnd(6)}  2FA: ${u.totpEnrolled ? 'enrolled' : 'not set up'}`));
        break;
      }

      case 'create': {
        if (!a || !b) throw new Error('usage: create <username> <password> [admin|sales]');
        const role = c === 'sales' ? 'sales' : 'admin';
        const existing = await users.findByUsername(a);
        if (existing) {
          // A reset, not a creation: setPassword bumps tokenVersion, so every
          // session the account already has ends now. Role is left alone —
          // say so plainly rather than let a re-run look like it changed it.
          await users.setPassword(existing.username, b);
          console.log(`✅ Password reset for "${existing.username}" (${existing.role}). Every live session for the account has been signed out.`);
          if (existing.role !== role && c) console.log(`   (Its role is still ${existing.role} — use "role" to change it.)`);
        } else {
          await users.upsert({ username: a, password: b, role });
          console.log(`✅ Account "${a.toLowerCase().trim()}" created as ${role}. 2FA will be set up on first sign-in.`);
        }
        await inviteIfNeeded(a);
        break;
      }

      case 'role': {
        if (!a || !['admin', 'sales'].includes(b)) throw new Error('usage: role <username> <admin|sales>');
        const ok = await users.setRole(a, b);
        console.log(ok
          ? `✅ "${a}" is now ${b}. Any live session for the account has been revoked.`
          : `No such user "${a}", or it is the owner account (which cannot be re-roled).`);
        break;
      }

      case 'reset-2fa': {
        if (!a) throw new Error('usage: reset-2fa <username>');
        // users.resetTotp, not a hand-rolled update: it is the one that also
        // signs the account out everywhere.
        const ok = await users.resetTotp(a);
        if (!ok) { console.log(`No such user "${a}".`); break; }
        console.log(`✅ 2FA cleared for "${a}" and every live session signed out. They set it up again on next sign-in.`);
        await inviteIfNeeded(a);
        break;
      }

      case 'delete': {
        if (!a) throw new Error('usage: delete <username>');
        const ok = await users.remove(a);
        console.log(ok ? `✅ Deleted "${a}".` : `No such user "${a}".`);
        break;
      }

      default:
        console.log('Commands:');
        console.log('  list');
        console.log('  create <user> <pass> [admin|sales]   create, or reset an existing password');
        console.log('  role <user> <admin|sales>');
        console.log('  reset-2fa <user>');
        console.log('  delete <user>');
    }
  } finally {
    await close();
  }
}

if (require.main === module) {
  main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
}

module.exports = { main };
