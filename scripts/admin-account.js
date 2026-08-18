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
 *   node scripts/admin-account.js seed-sales                           create a sales login per roster name
 *
 * `role` is admin (default) or sales. A sales account can only reach /sales:
 * remaining sponsorship, available stands and the client proposals built from
 * them — never the admin console.
 *
 * Against Atlas, pass the connection string for the one command:
 *   MONGO_URI="mongodb+srv://…" node scripts/admin-account.js reset-2fa annie
 */
const crypto = require('crypto');
const { connect, getDb, close } = require('../server/db');
const users = require('../server/models/users');
const { TEAM } = require('../server/data/sales-team');

// Ambiguity-free alphabet: no O/0 or I/l, because these are read aloud or typed
// from a note when the temporary password is handed over.
function genPassword(len = 14) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(len), b => chars[b % chars.length]).join('') + '!';
}

async function main() {
  const [cmd, a, b, c] = process.argv.slice(2);
  await connect();
  const db = getDb();

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
      await users.upsert({ username: a, password: b, role });
      // Role is only applied on INSERT (see users.upsert) — say so plainly
      // rather than let a re-run look like it changed an existing account.
      const saved = await users.findByUsername(a);
      console.log(`✅ Account "${a.toLowerCase()}" created/updated as ${saved.role}. 2FA will be set up on next login.`);
      if (saved.role !== role) console.log(`   (Existing account kept its ${saved.role} role — use "role" to change it.)`);
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

    /**
     * One login per name on the sales roster. Idempotent: an existing account is
     * skipped rather than having its password reset, so re-running after adding
     * a name to the roster does not lock out everyone already set up.
     */
    case 'seed-sales': {
      const created = [];
      for (const member of TEAM) {
        const username = member.name.toLowerCase().replace(/[^a-z0-9._-]/g, '');
        if (await users.findByUsername(username)) { console.log(`  · ${username} — already exists, skipped`); continue; }
        const password = genPassword();
        await users.upsert({ username, password, role: 'sales', displayName: member.name, email: member.email });
        const claim = await users.issueClaimCode(username);
        created.push({ username, password, claim });
      }
      if (!created.length) { console.log('\nNothing to do — every roster name already has a login.'); break; }
      console.log(`\n✅ Created ${created.length} sales login(s). Share each ONE-TIME set out of band:\n`);
      console.log('  USERNAME          TEMP PASSWORD        INVITE CODE');
      created.forEach(r => console.log(`  ${r.username.padEnd(17)} ${r.password.padEnd(20)} ${r.claim}`));
      console.log('\nThey sign in at /login, enter the invite code on their FIRST login only,');
      console.log('set up an authenticator app, and land on /sales.');
      console.log('This is the only time these are shown — nothing here is recoverable afterwards.\n');
      break;
    }
    case 'reset-2fa': {
      if (!a) throw new Error('usage: reset-2fa <username>');
      const r = await db.collection('users').updateOne(
        { username: a.toLowerCase().trim() },
        { $set: { totpSecret: null, totpEnrolled: false, recoveryHashes: [] },
          $unset: { pendingSecret: '', pendingRecovery: '' } });
      console.log(r.matchedCount ? `✅ 2FA cleared for "${a}". They set it up again on next login.` : `No such user "${a}".`);
      break;
    }
    case 'delete': {
      if (!a) throw new Error('usage: delete <username>');
      const r = await db.collection('users').deleteOne({ username: a.toLowerCase().trim() });
      console.log(r.deletedCount ? `✅ Deleted "${a}".` : `No such user "${a}".`);
      break;
    }
    default:
      console.log('Commands:');
      console.log('  list');
      console.log('  create <user> <pass> [admin|sales]');
      console.log('  role <user> <admin|sales>');
      console.log('  reset-2fa <user>');
      console.log('  delete <user>');
      console.log('  seed-sales                 one sales login per name in server/data/sales-team.js');
  }

  await close();
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
