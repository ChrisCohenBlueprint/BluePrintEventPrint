/**
 * Every enquiry reaches Make — and from there Salesforce and Dotdigital — or
 * the console says it has not.
 *
 *   payload  — what Make is shown: the event by name, the stands with their
 *              sizes, the package and area NAMES from this event, fields
 *              Salesforce insists on that are never empty, a link back to the
 *              lead; and every field the first version sent, unchanged.
 *   retry    — it was one attempt and a console.warn, so an enquiry that
 *              arrived while Make was down reached Salesforce never, silently.
 *              A failure is now recorded on the enquiry and tried again on a
 *              back-off; a webhook Make has deleted (410) is not hammered.
 *   once     — the retry loop and someone pressing Resend cannot both post the
 *              same enquiry at the same moment.
 *   settings — the address is saved from the console, by the owner only, and
 *              only over https; a test enquiry teaches Make the fields without
 *              a real lead being made.
 */
process.env.SHOW_ID = 'LEX';
process.env.SHOWS = 'lex:LEX,lna:LNA';
process.env.PUBLIC_URL = 'https://floor.example/';
delete process.env.NOTIFY_WEBHOOK;

const http = require('http');
const express = require('express');
const { ObjectId } = require('mongodb');
const { fakeDb } = require('./fake-mongo');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const AREA = require('../server/data/plan-areas').AREAS[0];
const OTHER_SHOW_LEAD = new ObjectId().toHexString();
const THIS_SHOW_LEAD = new ObjectId().toHexString();

const db = fakeDb({
  booths: [
    { showId: 'LNA', boothNumber: '201', displayNumber: 'A12', status: 'available', sqm: 12, listPrice: 7200 },
    { showId: 'LNA', boothNumber: '202', status: 'available', sqm: 9.5, listPrice: 5700 },
    { showId: 'LEX', boothNumber: '101', status: 'available', sqm: 24, listPrice: 14400 },
  ],
  // Europe's copy of the same package key first, so a lookup across events
  // would find the wrong name.
  sponsors: [{ showId: 'LEX', key: 'gold', name: 'Gold Package (Europe)' },
             { showId: 'LNA', key: 'gold', name: 'Gold Package (North America)' }],
  inquiries: [
    { _id: OTHER_SHOW_LEAD, showId: 'LNA', createdAt: new Date(), status: 'new',
      contact: { name: 'Other Event', email: 'o@example.com' }, boothsOfInterest: ['201'] },
    { _id: THIS_SHOW_LEAD, showId: 'LEX', createdAt: new Date(), status: 'new',
      contact: { name: 'This Event', email: 't@example.com', company: 'Acme' }, boothsOfInterest: ['101'] },
  ],
});
// Route ids arrive as ObjectIds; the seeded leads carry hex strings.
const plain = (v) => v instanceof ObjectId ? v.toHexString()
  : Array.isArray(v) ? v.map(plain)
  : v && typeof v === 'object' && !(v instanceof Date) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
  : v;
const realCollection = db.collection;
db.collection = (name) => {
  const c = realCollection(name);
  ['find', 'findOne', 'updateOne', 'countDocuments', 'deleteOne'].forEach(op => {
    const f = c[op]; c[op] = (filter, ...rest) => f(plain(filter), ...rest);
  });
  return c;
};
const dbPath = require.resolve('../server/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => db } };

const config = require('../server/config');
config.trackingFlushMs = 60_000;
const showContext = require('../server/show-context');
const inquiries = require('../server/models/inquiries');
const notify = require('../server/services/notify');
const api = require('../server/routes/api');

// ── A stand-in for Make's webhook ────────────────────────────────────────────
const make = { got: [], answers: [], delay: 0 };
const catcher = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', async () => {
    if (make.delay) await sleep(make.delay);
    const code = make.answers.length ? make.answers.shift() : 200;
    try { make.got.push(JSON.parse(body)); } catch { make.got.push(body); }
    res.writeHead(code, { 'Content-Type': 'text/plain' });
    res.end(code === 200 ? 'Accepted' : code === 410 ? 'There is no scenario listening for this webhook.' : 'Oops');
  });
});
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(20); } return false; };
const stored = (id) => db.store.inquiries.find(d => String(d._id) === String(id));

(async () => {
  await new Promise(r => catcher.listen(0, '127.0.0.1', r));
  const hook = `http://127.0.0.1:${catcher.address().port}/hook`;

  const app = express();
  app.use(express.json());
  let role = 'owner';
  app.use((req, _res, next) => { req.admin = { user: 'chris', role }; showContext.runAs('LEX', next); });
  app.use('/api', api);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {},
                                        body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  try {
    console.log('\nWith no address saved, nothing is sent and nothing breaks');
    const quiet = await showContext.runAs('LNA', () => inquiries.create({
      firstName: 'Quiet', email: 'quiet@example.com', boothNumbers: ['201'] }));
    await sleep(100);
    check('the enquiry is stored as ever', quiet.ok === true, JSON.stringify(quiet).slice(0, 120));
    check('and Make is not called', make.got.length === 0);
    check('and no delivery is recorded', !stored(quiet.id)?.delivery, JSON.stringify(stored(quiet.id)?.delivery));

    console.log('\nThe address is saved from the console — by the owner, over https');
    role = 'admin';
    let r = await call('/integrations/enquiry-webhook', { method: 'PUT', body: { url: hook } });
    check('an admin who is not the owner cannot change it', r.status === 403, JSON.stringify(r.body));
    role = 'owner';
    r = await call('/integrations/enquiry-webhook', { method: 'PUT', body: { url: 'http://hook.eu1.make.com/abc' } });
    check('plain http to the internet is refused, in words', r.status === 400 && /https/.test(r.body.error), JSON.stringify(r.body));
    r = await call('/integrations/enquiry-webhook', { method: 'PUT', body: { url: 'not a url' } });
    check('and so is something that is not an address', r.status === 400, JSON.stringify(r.body));
    r = await call('/integrations/enquiry-webhook', { method: 'PUT', body: { url: hook } });
    check('the owner saves it', r.status === 200 && r.body.connected === true, JSON.stringify(r.body));
    role = 'admin';
    r = await call('/integrations/enquiry-webhook');
    check('an admin sees it is connected, but not the key in the address',
          r.body.connected === true && r.body.editable === false && !r.body.url.includes('/hook') && r.body.url.includes('127.0.0.1'),
          JSON.stringify(r.body));
    role = 'owner';

    console.log('\nWhat Make receives');
    const e = await showContext.runAs('LNA', () => inquiries.create({
      firstName: 'Ana', email: 'ana@example.com', phone: '+1 555 0100', jobTitle: 'Buyer',
      boothNumbers: ['201', '202'], sponsorKeys: ['gold'], areaKeys: [AREA.key], message: 'Corner if possible' }));
    check('the enquiry is stored', e.ok === true, JSON.stringify(e).slice(0, 160));
    await until(() => make.got.length === 1);
    const p = make.got[0] || {};
    check('Make is sent it once', make.got.length === 1, String(make.got.length));
    check('named by its event, not the default one', p.eventId === 'LNA' && p.eventSlug === 'lna' && !!p.eventName, `${p.eventId} ${p.eventSlug} ${p.eventName}`);
    check('with the stands as the plan shows them, sizes included',
          p.standList === 'A12 (12 m²), 202 (9.5 m²)' && p.standCount === 2 && p.totalSize === 21.5 && p.sizeUnit === 'm²',
          `${p.standList} · ${p.totalSize} ${p.sizeUnit}`);
    check('their list prices, totalled, in the event\'s currency', p.listPriceTotal === 12900 && p.currency === 'EUR',
          `${p.listPriceTotal} ${p.currency}`);
    check('this event\'s package name, not another event\'s', p.sponsorshipNames === 'Gold Package (North America)', p.sponsorshipNames);
    check('the area by its name', p.areaNames === AREA.label, p.areaNames);
    check('Salesforce\'s required fields are never empty',
          p.leadLastName === 'Ana' && p.leadCompany === '[not provided]' && p.leadSource === 'Floorplan enquiry',
          `${p.leadLastName} / ${p.leadCompany}`);
    check('with a link back to the lead in this event\'s console',
          p.consoleUrl === `https://floor.example/admin/lna#lead=${e.id}`, p.consoleUrl);
    check('a description ready to paste into the lead', /A12 \(12 m²\)/.test(p.description) && /Corner if possible/.test(p.description));
    check('it is a real enquiry, not a test', p.test === false && p.version === 2 && p.enquiryId === String(e.id));
    check('every field the first version sent is still there, meaning the same',
          p.event === 'inquiry.new' && p.show === 'LNA' && p.email === 'ana@example.com' &&
          JSON.stringify(p.stands) === '["201","202"]' && JSON.stringify(p.sponsorships) === '["gold"]' &&
          typeof p.text === 'string' && typeof p.receivedAt === 'string');
    await until(() => stored(e.id)?.delivery?.status === 'sent');
    const d1 = stored(e.id).delivery || {};
    check('and the enquiry records that it was sent', d1.status === 'sent' && d1.attempts === 1 && d1.sentAt instanceof Date && d1.to === new URL(hook).host,
          JSON.stringify(d1));

    console.log('\nA send that fails is tried again, not lost');
    make.answers.push(500);
    const f = await showContext.runAs('LNA', () => inquiries.create({ firstName: 'Ben', lastName: 'Ng', company: 'Ng Oils',
                                                                     email: 'ben@example.com', boothNumbers: ['201'] }));
    await until(() => stored(f.id)?.delivery?.status === 'failed');
    const d2 = stored(f.id).delivery || {};
    const wait = d2.nextAttemptAt instanceof Date ? Math.round((d2.nextAttemptAt - d2.lastAttemptAt) / 1000) : null;
    check('the failure is recorded, in Make\'s words', d2.status === 'failed' && /500/.test(d2.error), JSON.stringify(d2));
    check('with the next try a minute away', d2.attempts === 1 && wait === 60, `${wait}s`);
    let pass = await notify.retryDue();
    check('it is not retried before then', pass.due === 0 && stored(f.id).delivery.status === 'failed', JSON.stringify(pass));
    stored(f.id).delivery.nextAttemptAt = new Date(Date.now() - 1000);
    pass = await notify.retryDue();
    check('when it is due, it is sent', pass.sent === 1 && stored(f.id).delivery.status === 'sent' && stored(f.id).delivery.attempts === 2,
          JSON.stringify(stored(f.id).delivery));
    const g = make.got[make.got.length - 1] || {};
    check('as the same enquiry, with its own event and stand', g.enquiryId === String(f.id) && g.eventId === 'LNA' && g.standList === 'A12 (12 m²)' &&
          g.leadLastName === 'Ng' && g.leadCompany === 'Ng Oils', `${g.enquiryId} ${g.standList}`);

    console.log('\nA webhook Make has deleted is not hammered');
    make.answers.push(410);
    const h = await showContext.runAs('LNA', () => inquiries.create({ firstName: 'Cy', email: 'cy@example.com', boothNumbers: ['202'] }));
    await until(() => stored(h.id)?.delivery?.status === 'failed');
    check('it is marked failed with no next try', stored(h.id).delivery.nextAttemptAt === null && /410/.test(stored(h.id).delivery.error),
          JSON.stringify(stored(h.id).delivery));
    const before = make.got.length;
    pass = await notify.retryDue();
    check('and the retry loop leaves it alone', make.got.length === before, JSON.stringify(pass));
    r = await call('/integrations/enquiry-webhook');
    check('the console is told one could not be delivered', r.body.gaveUp >= 1, JSON.stringify(r.body));

    console.log('\nOne send at a time per enquiry');
    make.delay = 200;
    const [x, y] = await Promise.all([notify.deliver(h.id, { manual: true }), notify.deliver(h.id, { manual: true })]);
    make.delay = 0;
    check('two sends at once: one goes, the other is told it is busy',
          [x, y].filter(v => v.ok).length === 1 && [x, y].some(v => v.reason === 'busy'), JSON.stringify([x.reason || x.ok, y.reason || y.ok]));
    check('and Make receives it once', make.got.length === before + 1, String(make.got.length - before));
    // A send cut off mid-way (the process stopped) is picked up once its claim is stale.
    stored(h.id).delivery = { status: 'sending', claimedAt: new Date(Date.now() - 10 * 60_000), attempts: 3 };
    pass = await notify.retryDue();
    check('a send cut off mid-way is finished by the retry loop', stored(h.id).delivery.status === 'sent', JSON.stringify(stored(h.id).delivery));

    console.log('\nResend from the console, for this event\'s leads only');
    r = await call(`/inquiries/${OTHER_SHOW_LEAD}/deliver`, { method: 'POST' });
    check('another event\'s lead is not found from this one', r.status === 404, JSON.stringify(r.body));
    r = await call(`/inquiries/${THIS_SHOW_LEAD}/deliver`, { method: 'POST' });
    check('this event\'s lead is sent', r.status === 200 && r.body.delivery.status === 'sent', JSON.stringify(r.body));
    const t = make.got[make.got.length - 1] || {};
    check('as this event\'s', t.eventId === 'LEX' && t.standList === '101 (24 m²)', `${t.eventId} ${t.standList}`);

    console.log('\nA test enquiry teaches Make the fields, and says it is a test');
    const n = make.got.length;
    r = await call('/integrations/enquiry-webhook/test', { method: 'POST' });
    const s = make.got[n] || {};
    check('it is sent', r.status === 200 && make.got.length === n + 1, JSON.stringify(r.body));
    check('marked as a test, with no lead to link to', s.test === true && s.consoleUrl === null && /^test-/.test(s.enquiryId), `${s.test} ${s.enquiryId}`);
    check('filled from this event so every field has a real example', s.eventId === 'LEX' && s.standCount >= 1 && !!s.sponsorshipNames,
          `${s.standList} · ${s.sponsorshipNames}`);
    check('and no enquiry is stored for it', !db.store.inquiries.some(q => String(q._id).startsWith('test-')));
    make.answers.push(404);
    r = await call('/integrations/enquiry-webhook/test', { method: 'POST' });
    check('a test Make refuses says so', r.status === 502 && /404/.test(r.body.error), JSON.stringify(r.body));

    console.log('\nThe address can be taken away again');
    r = await call('/integrations/enquiry-webhook', { method: 'PUT', body: { url: '' } });
    const off = await call('/integrations/enquiry-webhook');
    check('clearing it disconnects', r.status === 200 && off.body.connected === false, JSON.stringify(off.body));
  } finally {
    server.close();
    catcher.close();
  }

  const failed = out.filter(x => !x).length;
  console.log(`\n${failed ? `${failed} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
