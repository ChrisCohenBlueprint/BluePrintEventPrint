const totp = require('../../server/services/totp');

/**
 * Drive the 2FA login flow and return the session cookie, for the verification
 * scripts. Reads the account's TOTP secret straight from the database, so it
 * works whether or not the account is already enrolled.
 *
 * Local Mongo only — the verification scripts refuse to run against Atlas.
 */
async function loginForTest(base, { username, password, mongoUri }) {
  const { MongoClient } = require('mongodb');
  const c = new MongoClient(mongoUri);
  await c.connect();
  const users = c.db(process.env.MONGO_DB || 'blueprint').collection('users');

  let cookie = '';
  const grab = (res) => { const s = res.headers.get('set-cookie'); if (s) cookie = s.split(';')[0]; };
  const post = async (url, body) => {
    const r = await fetch(base + url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), redirect: 'manual',
    });
    grab(r);
    let d = {}; try { d = await r.json(); } catch {}
    return { status: r.status, data: d };
  };

  const step1 = await post('/login', { username, password });
  if (step1.status !== 200) { await c.close(); throw new Error(`login step 1 failed: ${step1.status}`); }

  if (step1.data.step === 'enrol') {
    const secret = step1.data.secret;
    const code = totp.codeAt(secret, Math.floor(Date.now() / 1000 / 30));
    const done = await post('/login/enrol', { pending: step1.data.pending, token: code, next: '/admin' });
    await c.close();
    if (done.status !== 200) throw new Error(`enrol failed: ${done.status}`);
    return cookie;
  }

  const user = await users.findOne({ username: String(username).toLowerCase() });
  await c.close();
  const code = totp.codeAt(user.totpSecret, Math.floor(Date.now() / 1000 / 30));
  const done = await post('/login/verify', { pending: step1.data.pending, token: code, next: '/admin' });
  if (done.status !== 200) throw new Error(`verify failed: ${done.status}`);
  return cookie;
}

module.exports = { loginForTest };
