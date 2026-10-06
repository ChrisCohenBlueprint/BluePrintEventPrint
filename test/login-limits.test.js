/**
 * The sign-in limits hold when the attempts arrive all at once.
 *
 * Every limit on /login used to be read on arrival and charged only after the
 * delay, the database read and scrypt had been awaited. A burst therefore read
 * an untouched budget, request after request, and every one of them was
 * evaluated: sixty concurrent passwords from one address against a budget of
 * ten were all checked, and four hundred concurrent codes on one pending token
 * were all checked — the right one among them signed in.
 *
 * What is asserted here:
 *
 *   one address    — a burst of wrong passwords is evaluated at most IP_MAX
 *                    times, and a success never spends from the budget.
 *   the password   — is still always checked, so a stranger's failures cannot
 *                    keep the owner out.
 *   the code       — one checked at a time per account; none checked while a
 *                    penalty is owed, right or wrong; five wrong and the
 *                    pending token is spent.
 *
 * Driven through the real router against the in-memory database, with the code
 * checks counted so "evaluated" means evaluated, not answered.
 */
const express = require('express');
const { fakeDb } = require('./fake-mongo');

const db = fakeDb({ users: [], revokedTokens: [] });
const dbPath = require.resolve('../server/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => db } };

// A clock the test can move on, so a penalty of half a minute takes no time to
// wait out. Everything the limiters read goes through Date.now.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;

const users = require('../server/models/users');
const auth  = require('../server/auth');

// Count what is EVALUATED. The password checks are the real scrypt, counted;
// the code checks are stand-ins (the real ones need a live TOTP secret) that
// take a little time, as the database write behind the real ones does.
let pwEvals = 0, codeEvals = 0;
const GOOD = '246810';
const realVerify = users.verifyPassword, realAbsorb = users.absorbPassword;
users.verifyPassword = async (...a) => { pwEvals++; return realVerify(...a); };
users.absorbPassword = async (...a) => { pwEvals++; return realAbsorb(...a); };
const slowCheck = async (token) => { codeEvals++; await new Promise(r => setTimeout(r, 15)); return token === GOOD; };
users.verifyTotpAndConsume = async (_user, token) => slowCheck(token);
users.confirmEnrolment     = async (_username, token) => slowCheck(token);
users.useRecoveryCode      = async () => false;

const router = require('../server/routes/auth-routes');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const IP_MAX = 10;
const count = (arr, status) => arr.filter(r => r.status === status).length;

(async () => {
  for (const name of ['annie', 'carol', 'dave', 'erin', 'fran', 'gina']) {
    await users.upsert({ username: name, password: `${name}-correct-password`, role: 'admin' });
  }
  // Enrolled, so a right password leads to the verify step — except fran, who
  // is part-way through first-time enrolment.
  db.store.users.forEach(u => { u.totpEnrolled = u.username !== 'fran'; });

  const app = express();
  app.set('trust proxy', true);     // so each request can say which address it is from
  app.use(express.json());
  app.use(router);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const post = async (path, body, ip) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch {}
    return { status: res.status, data, retryAfter: res.headers.get('retry-after'), cookie: res.headers.get('set-cookie') };
  };

  try {
    console.log('\nA burst of wrong passwords from one address');
    pwEvals = 0;
    const burst = await Promise.all(Array.from({ length: 60 }, () =>
      post('/login', { username: 'annie', password: 'guess' }, '10.0.0.1')));
    check(`is evaluated at most ${IP_MAX} times`, pwEvals <= IP_MAX, `${pwEvals} of 60 evaluated`);
    check('and the rest are refused', count(burst, 429) >= 60 - IP_MAX, `${count(burst, 429)} refused`);
    const after = pwEvals;
    const late = await post('/login', { username: 'annie', password: 'annie-correct-password' }, '10.0.0.1');
    check('the address is then refused without a check', late.status === 429 && pwEvals === after);

    console.log('\nThe password is still always checked');
    const owner = await post('/login', { username: 'annie', password: 'annie-correct-password' }, '10.0.0.9');
    check('the owner signs in from elsewhere while a stranger\'s penalty is owed',
          owner.status === 200 && owner.data.step === 'verify', JSON.stringify(owner.data));

    console.log('\nAn office behind one address');
    for (let i = 1; i < IP_MAX; i++) await post('/login', { username: `nobody${i}`, password: 'x' }, '10.0.0.2');
    let signedIn = 0;
    for (let i = 0; i < 15; i++) {
      const r = await post('/login', { username: 'carol', password: 'carol-correct-password' }, '10.0.0.2');
      if (r.status === 200) signedIn++;
    }
    check('fifteen people who know their passwords all get through, with one failure left in the budget',
          signedIn === 15, `${signedIn} of 15`);

    console.log('\nA burst of codes on one pending token');
    const pending = auth.signPending('dave', 'verify');
    codeEvals = 0;
    const codes = await Promise.all(Array.from({ length: 400 }, (_, i) =>
      // From four hundred addresses, so the per-address budget is no help: this
      // is the per-account limit on its own.
      post('/login/verify', { pending, token: i === 200 ? GOOD : String(100000 + i) },
           `10.1.${i >> 8}.${i & 255}`)));
    check('evaluates at most a handful', codeEvals <= 3, `${codeEvals} of 400 evaluated`);
    check('and refuses the rest unread', count(codes, 429) >= 400 - codeEvals, `${count(codes, 429)} refused`);
    check('the right code in it does not sign in unless it was the one read',
          count(codes, 200) === 0 || codeEvals === 1 && count(codes, 200) === 1);

    console.log('\nWrong codes, one after another');
    let token = auth.signPending('gina', 'verify');
    codeEvals = 0;
    let r = await post('/login/verify', { pending: token, token: '000001' }, '10.2.0.1');
    check('a wrong code is refused', r.status === 401, r.status);
    r = await post('/login/verify', { pending: token, token: GOOD }, '10.2.0.1');
    check('and while its penalty is owed even the right code is not looked at',
          r.status === 429 && codeEvals === 1 && !r.cookie, `${r.status}, ${codeEvals} evaluated`);
    check('the refusal says how long to wait', Number(r.retryAfter) > 0, r.retryAfter);
    const statuses = [];
    for (let i = 2; i <= 5; i++) {
      skew += 2 ** i * 1000;   // wait out the previous penalty
      statuses.push((await post('/login/verify', { pending: token, token: `00000${i}` }, '10.2.0.1')).status);
    }
    check('the second to fourth wrong codes are refused', statuses.slice(0, 3).every(s => s === 401), statuses.join(','));
    check('the fifth spends the pending token', statuses[3] === 440, statuses.join(','));
    skew += 64_000;
    const evals = codeEvals;
    r = await post('/login/verify', { pending: token, token: GOOD }, '10.2.0.1');
    check('after which the right code on that token is refused unread',
          r.status === 440 && codeEvals === evals && !r.cookie, `${r.status}`);

    console.log('\nThe penalty belongs to the account, not the token');
    token = auth.signPending('gina', 'verify');
    skew -= 64_000; skew += 10_000;   // inside the 32 s the fifth miss earned
    r = await post('/login/verify', { pending: token, token: GOOD }, '10.2.0.2');
    check('a fresh token does not reset it', r.status === 429 && codeEvals === evals, r.status);
    skew += 60_000;
    r = await post('/login/verify', { pending: token, token: GOOD }, '10.2.0.2');
    check('once it has run out, the right code signs in', r.status === 200 && /bp_admin=/.test(r.cookie || ''), r.status);
    token = auth.signPending('gina', 'verify');
    await post('/login/verify', { pending: token, token: '999999' }, '10.2.0.2');
    r = await post('/login/verify', { pending: token, token: '999998' }, '10.2.0.2');
    check('and a success clears it: the next miss starts again at two seconds',
          r.status === 429 && r.retryAfter === '2', `${r.status} retry ${r.retryAfter}`);

    console.log('\nA stranger cannot stop the owner at the code step');
    for (let i = 0; i < 4; i++) {
      await post('/login', { username: 'erin', password: 'wrong' }, `10.3.0.${i}`);
      skew += 30_000;
    }
    skew -= 30_000;   // the last of those penalties is still owed
    token = auth.signPending('erin', 'verify');
    r = await post('/login/verify', { pending: token, token: GOOD }, '10.3.1.1');
    check('wrong passwords owed against the account do not delay her code',
          r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);

    console.log('\nEnrolment is held to the same rules');
    skew += 60_000;
    token = auth.signPending('fran', 'enrol');
    codeEvals = 0;
    const enrol = await Promise.all(Array.from({ length: 50 }, (_, i) =>
      post('/login/enrol', { pending: token, token: String(200000 + i) }, `10.4.0.${i}`)));
    check('a burst of enrolment codes evaluates at most a handful', codeEvals <= 3,
          `${codeEvals} of 50, ${count(enrol, 429)} refused`);
    r = await post('/login/enrol', { pending: token, token: GOOD }, '10.4.1.1');
    check('and the right one is not looked at while a penalty is owed', r.status === 429 && !r.cookie, r.status);
    for (let i = 0; i < 6 && r.status !== 440; i++) {
      skew += 33_000;   // past any penalty five misses can earn
      r = await post('/login/enrol', { pending: token, token: '000000' }, '10.4.1.1');
    }
    check('five misses spend an enrolment token too, and say what that costs',
          r.status === 440 && r.data.reason === 'too_many_codes' && /fresh QR code/.test(r.data.error || ''),
          `${r.status} ${JSON.stringify(r.data)}`);
  } finally {
    server.close();
  }

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
