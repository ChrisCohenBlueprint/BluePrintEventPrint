#!/usr/bin/env node
/**
 * Manage admin accounts and recover from a 2FA lockout.
 *
 * This is the break-glass tool: anyone with the database connection string can
 * reset a password or clear 2FA, so losing a phone never means losing access.
 *
 *   node scripts/admin-account.js list
 *   node scripts/admin-account.js create <username> <password>   create / reset password
 *   node scripts/admin-account.js reset-2fa <username>           clear 2FA (re-enrols next login)
 *   node scripts/admin-account.js delete <username>
 *
 * Against Atlas, pass the connection string for the one command:
 *   MONGO_URI="mongodb+srv://…" node scripts/admin-account.js reset-2fa annie
 */
const { connect, getDb, close } = require('../server/db');
const users = require('../server/models/users');

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  await connect();
  const db = getDb();

  switch (cmd) {
    case 'list': {
      const rows = await db.collection('users').find({}).project({ username: 1, role: 1, totpEnrolled: 1 }).toArray();
      if (!rows.length) console.log('No admin accounts.');
      rows.forEach(u => console.log(`  ${u.username}  (${u.role})  2FA: ${u.totpEnrolled ? 'enrolled' : 'not set up'}`));
      break;
    }
    case 'create': {
      if (!a || !b) throw new Error('usage: create <username> <password>');
      await users.upsert({ username: a, password: b });
      console.log(`✅ Account "${a.toLowerCase()}" created/updated. 2FA will be set up on next login.`);
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
      console.log('Commands: list | create <user> <pass> | reset-2fa <user> | delete <user>');
  }

  await close();
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
