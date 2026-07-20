#!/usr/bin/env node
/**
 * Verifies the socket layer rejects privileged events from unauthenticated
 * clients, and that public clients never receive commercial data.
 *
 *   node scripts/security-check.js [http://127.0.0.1:3000]
 */
const { io } = require('socket.io-client');

const BASE  = process.argv[2] || 'http://127.0.0.1:3000';
const USER  = process.env.ADMIN_USER || 'admin';
const PASS  = process.env.ADMIN_PASS || 'localdev-change-me';

const results = [];
const pass = (n, d = '') => { results.push({ ok: true,  n, d }); console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const fail = (n, d = '') => { results.push({ ok: false, n, d }); console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); };

const wait = (ms) => new Promise(r => setTimeout(r, ms));

function connect(cookie) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, {
      transports: ['websocket'],
      extraHeaders: cookie ? { Cookie: cookie } : {},
    });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 8000);
  });
}

function stateOnce(s) {
  return new Promise(r => s.once('state:full', r));
}

async function adminCookie() {
  const res = await fetch(`${BASE}/admin`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') },
  });
  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error('no admin cookie issued');
  return raw.split(';')[0];
}

async function main() {
  console.log(`\nSecurity check against ${BASE}\n`);

  // ── 1. Anonymous socket must not mutate ───────────────────────────────────
  console.log('Anonymous socket:');
  const anon  = await connect(null);
  const state = await stateOnce(anon);

  const target = state.find(b => b.status === 'available');
  if (!target) return fail('found an available booth to test against');

  // demo:reset used to wipe all 272 booths from any browser console.
  anon.emit('demo:reset');
  await wait(600);
  const after = await new Promise(r => { anon.emit('booth:view', { boothNumber: target.boothNumber }); anon.once('state:full', r); });
  after.length === state.length ? pass('demo:reset ignored') : fail('demo:reset ignored', 'state changed');

  let denied = 0;
  anon.on('error:auth', () => denied++);

  anon.emit('admin:setStatus', { boothNumber: target.boothNumber, status: 'sold', company: 'Attacker Ltd' });
  anon.emit('booth:book',      { boothNumber: target.boothNumber, company: 'Attacker Ltd' });
  anon.emit('booth:hold',      { boothNumber: target.boothNumber, company: 'Attacker Ltd' });
  anon.emit('booth:release',   { boothNumber: target.boothNumber });
  anon.emit('booth:update-deal', { boothNumber: target.boothNumber, actualPrice: 1, notes: 'pwned' });
  await wait(1200);

  denied === 5 ? pass('all 5 admin events denied') : fail('all 5 admin events denied', `${denied}/5 rejections`);

  // ── 2. Public payload must not leak commercial data ───────────────────────
  const leakKeys = ['assignment', 'listPriceInternal', 'notes', 'actualPrice'];
  const leaked = leakKeys.filter(k => state.some(b => k in b));
  leaked.length === 0 ? pass('public state carries no commercial fields')
                      : fail('public state carries no commercial fields', `leaked: ${leaked.join(', ')}`);

  // Price is absent from the public projection entirely, not merely nulled.
  const priced = state.filter(b => b.listPrice !== undefined || b.actualPrice !== undefined);
  priced.length === 0
    ? pass('no price of any kind reaches the public payload')
    : fail('no price of any kind reaches the public payload', `${priced.length} stands carry a price`);

  // ── 3. Verify nothing was actually written ────────────────────────────────
  const cookie = await adminCookie();
  const check  = await fetch(`${BASE}/api/booths`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') },
  }).then(r => r.json());

  const victim = check.find(b => b.boothNumber === target.boothNumber);
  victim.status === 'available' && !victim.assignment?.company
    ? pass('target booth unchanged in database')
    : fail('target booth unchanged in database', `status=${victim.status} company=${victim.assignment?.company}`);

  // ── 4. Authenticated admin can still work ─────────────────────────────────
  console.log('\nAuthenticated admin socket:');
  const admin = await connect(cookie);
  await stateOnce(admin);

  admin.emit('booth:hold', { boothNumber: target.boothNumber, company: 'Legit Co', hours: 24 });
  await wait(900);

  const post = await fetch(`${BASE}/api/booths`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') },
  }).then(r => r.json());
  const heldBooth = post.find(b => b.boothNumber === target.boothNumber);
  heldBooth.status === 'held' ? pass('admin hold succeeded') : fail('admin hold succeeded', `status=${heldBooth.status}`);

  const holdDocs = await fetch(`${BASE}/api/holds`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') },
  }).then(r => r.json());
  const h = holdDocs.find(x => x.boothNumber === target.boothNumber);
  h && new Date(h.expiresAt) > new Date()
    ? pass('hold has a real expiry', new Date(h.expiresAt).toLocaleString('en-GB'))
    : fail('hold has a real expiry');

  // Restore
  admin.emit('booth:release', { boothNumber: target.boothNumber });
  await wait(700);

  // ── 5. Enquiry capture ────────────────────────────────────────────────────
  console.log('\nEnquiry capture:');
  const ack = await new Promise(r => anon.emit('inquiry:submit', {
    name: 'Test Person', email: 'test@example.com', company: 'Test Co',
    message: 'Interested in these stands', boothNumbers: [target.boothNumber],
  }, r));
  ack?.ok ? pass('enquiry stored with contact details') : fail('enquiry stored', JSON.stringify(ack));

  const bad = await new Promise(r => anon.emit('inquiry:submit', {
    name: '', email: 'not-an-email', boothNumbers: [],
  }, r));
  !bad?.ok && bad.errors?.length ? pass('invalid enquiry rejected', `${bad.errors.length} errors`)
                                 : fail('invalid enquiry rejected');

  anon.close(); admin.close();

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('\nCheck errored:', e.message); process.exit(1); });
