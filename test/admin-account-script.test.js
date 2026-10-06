/**
 * The break-glass account tool does what the Team tab does.
 *
 * scripts/admin-account.js is what someone reaches for when an account is
 * compromised or a phone is lost, and it was weaker than the console it stands
 * in for. `create` over an existing account went through users.upsert and
 * `reset-2fa` through a hand-written update; neither bumped tokenVersion, so a
 * reset made because a session was stolen left that session working for the
 * rest of its twelve hours. And an account it created got no invite code, so
 * its temporary password alone was enough to claim it.
 *
 * Driven against the in-memory database — never a real one.
 */
const { fakeDb } = require('./fake-mongo');

const db = fakeDb({ users: [] });
const connectCalls = [];
const dbPath = require.resolve('../server/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  connect: async (opts) => { connectCalls.push(opts); return db; },
  getDb: () => db,
  close: async () => {},
} };

const users = require('../server/models/users');
const { main } = require('../scripts/admin-account');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const row = (name) => db.store.users.find(u => u.username === name);

/** Run one command and return what it printed. */
async function run(...argv) {
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { await main(argv); } finally { console.log = log; }
  return lines.join('\n');
}
const inviteIn = (text) => (text.match(/invite code: ([A-Z0-9]+)/) || [])[1] || null;

(async () => {
  await users.upsert({ username: 'annie', password: 'owner-password', role: 'owner' });
  await users.upsert({ username: 'bob', password: 'old-password', role: 'admin' });
  Object.assign(row('annie'), { totpEnrolled: true, tokenVersion: 2 });
  Object.assign(row('bob'), { totpEnrolled: true, tokenVersion: 5, totpSecret: 'S', recoveryHashes: ['h'] });

  console.log('\nResetting a password');
  let said = await run('create', 'bob', 'new-password');
  check('signs the account out everywhere', row('bob').tokenVersion === 6, String(row('bob').tokenVersion));
  check('with the new password working and the old one not',
        await users.verifyPassword('new-password', row('bob').passwordHash) &&
        !await users.verifyPassword('old-password', row('bob').passwordHash));
  check('and says so', /signed out/.test(said), said);
  check('an enrolled account needs no invite code', !inviteIn(said) && !row('bob').claimHash);
  said = await run('create', 'bob', 'another-password', 'sales');
  check('the role is left alone, and it says how to change it', row('bob').role === 'admin' && /use "role"/.test(said), said);

  console.log('\nCreating a rep');
  said = await run('create', 'carol', 'temp-password', 'sales');
  const code = inviteIn(said);
  check('the account is created as sales', row('carol') && row('carol').role === 'sales');
  check('with a one-time invite code, printed once', !!code, said);
  check('which is what the first sign-in needs alongside the password',
        users.needsClaim(row('carol')) && users.checkClaim(row('carol'), code) && !users.checkClaim(row('carol'), ''));
  said = await run('create', 'dave', 'temp-password');
  check('an admin gets one too, as in the Team tab', !!inviteIn(said) && users.needsClaim(row('dave')));

  console.log('\nResetting a rep who has not signed in yet');
  said = await run('create', 'carol', 'second-temp-password');
  const fresh = inviteIn(said);
  check('issues a fresh invite code in place of the old one',
        fresh && fresh !== code && users.checkClaim(row('carol'), fresh) && !users.checkClaim(row('carol'), code));

  console.log('\nResetting 2FA');
  said = await run('reset-2fa', 'bob');
  check('clears it', row('bob').totpEnrolled === false && row('bob').totpSecret === null && row('bob').recoveryHashes.length === 0);
  check('and signs the account out everywhere', row('bob').tokenVersion === 8, String(row('bob').tokenVersion));
  check('and re-enrolling needs a fresh invite code', !!inviteIn(said) && users.needsClaim(row('bob')), said);
  said = await run('reset-2fa', 'annie');
  check('the owner is signed out too', row('annie').tokenVersion === 3);
  check('but can re-enrol from her password alone', !inviteIn(said) && !users.needsClaim(row('annie')), said);
  said = await run('reset-2fa', 'nobody');
  check('an unknown name is reported, not created', /No such user/.test(said) && !row('nobody'));

  console.log('\nDeleting');
  said = await run('delete', 'dave');
  check('removes the account', !row('dave') && /Deleted/.test(said));

  said = await run('list');
  check('list shows who is left and where they are with 2FA',
        /carol\s+sales\s+2FA: not set up/.test(said) && /annie\s+owner/.test(said) && !/dave/.test(said), said);

  console.log('\nThe tool itself');
  check('never builds indexes on the database it is pointed at',
        connectCalls.length > 0 && connectCalls.every(o => o && o.indexes === false), JSON.stringify(connectCalls[0]));
  said = await run();
  const listed = said.split('\n').slice(1).map(l => l.trim().split(' ')[0]);
  check('its help lists exactly the commands it has',
        listed.join(',') === 'list,create,role,reset-2fa,delete', listed.join(','));

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
