#!/usr/bin/env node
/**
 * Verifies bookings survive a process restart, and that a hostile company name
 * round-trips as data rather than markup.
 *
 * Run against a server you are about to restart:
 *   node scripts/persistence-check.js write     # book a stand, then restart
 *   node scripts/persistence-check.js verify    # confirm it is still there
 */
const { io } = require('socket.io-client');

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || 'localdev-change-me';
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

const XSS  = `<img src=x onerror="alert('xss')">Acme & Co`;
const MARK = '__persist_test__';

const api = (p) => fetch(`${BASE}${p}`, { headers: { Authorization: AUTH } }).then(r => r.json());
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function adminSocket() {
  const res = await fetch(`${BASE}/admin`, { headers: { Authorization: AUTH } });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const s = io(BASE, { transports: ['websocket'], extraHeaders: { Cookie: cookie } });
  await new Promise((ok, no) => { s.on('connect', ok); s.on('connect_error', no); });
  await new Promise(ok => s.once('state:full', ok));
  return s;
}

async function write() {
  const booths = await api('/api/booths');
  const target = booths.find(b => b.status === 'available');
  if (!target) throw new Error('no available booth to test with');

  const s = await adminSocket();
  s.emit('booth:book', { boothNumber: target.boothNumber, company: XSS });
  await wait(400);
  s.emit('booth:update-deal', { boothNumber: target.boothNumber, actualPrice: 12345, notes: MARK });
  await wait(900);
  s.close();

  console.log(`Booked stand ${target.boothNumber} with a hostile company name.`);
  console.log(`Now restart the server, then run: node scripts/persistence-check.js verify ${target.boothNumber}`);
  return target.boothNumber;
}

async function verify(n) {
  const booths = await api('/api/booths');
  const b = booths.find(x => x.boothNumber === n);
  if (!b) throw new Error(`stand ${n} not found`);

  const checks = [
    ['status persisted as sold',        b.status === 'sold'],
    ['company persisted',               b.assignment?.company === XSS],
    ['negotiated price persisted',      b.assignment?.actualPrice === 12345],
    ['notes persisted',                 b.assignment?.notes === MARK],
    ['company stored verbatim, unescaped in the database',
                                        b.assignment?.company.includes('<img')],
  ];

  let ok = true;
  for (const [label, passed] of checks) {
    console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${label}`);
    if (!passed) ok = false;
  }

  const audit = await api('/api/audit');
  const rel = audit.filter(a => a.boothNumber === n);
  console.log(`  ${rel.length ? 'PASS' : 'FAIL'}  audit trail recorded (${rel.length} entries)`);
  rel.slice(0, 4).forEach(a =>
    console.log(`         ${new Date(a.ts).toLocaleTimeString('en-GB')}  ${a.type}  ${JSON.stringify(a.meta)}`));

  return ok && rel.length > 0;
}

(async () => {
  const mode = process.argv[2];
  if (mode === 'write') { await write(); process.exit(0); }
  if (mode === 'verify') {
    const n = process.argv[3];
    if (!n) throw new Error('pass the stand number');
    process.exit(await verify(n) ? 0 : 1);
  }
  console.log('usage: persistence-check.js write | verify <stand>');
  process.exit(1);
})().catch(e => { console.error(e.message); process.exit(1); });
