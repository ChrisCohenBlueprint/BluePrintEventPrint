/**
 * A public enquiry stores what is real, once, and is never reported as failed
 * once it is stored.
 *
 *   this event  — the stand numbers, packages and areas were String() of
 *                 anything, 25 of any length each, never checked: a stored
 *                 lead could name "NOT-A-STAND" and "[object Object]". Only
 *                 short strings naming something in THIS event are kept, every
 *                 field is capped, and what was left out is reported back.
 *   per address — the only limit was per socket, so a script opening a fresh
 *                 socket per enquiry stored, webhooked and pinged the admins
 *                 without limit. One address now gets ten, then one every few
 *                 minutes — and the address is the proxy's, not the one the
 *                 client wrote into X-Forwarded-For.
 *   once        — the page sends a request id with each enquiry and every
 *                 retry of it; a retry is answered as the original was.
 *   stored      — if anything after the insert failed, the visitor was told
 *                 "Something went wrong", sent it again, and the admins never
 *                 heard of the first one.
 */
const { db, faults, boot, wait, reporter } = require('./socket-harness');

const { check, finish } = reporter();
const hex = (c) => c.repeat(32);
const enquiry = (extra = {}) => ({ firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com',
  company: 'Engines Ltd', boothNumbers: ['101'], ...extra });

(async () => {
  const { client, ask, close } = await boot();
  const realWarn = console.warn;
  console.warn = () => {};   // dropped items and refusals are expected here

  try {
    console.log('\nAn enquiry stores what exists in this event, capped');
    const e1 = await client({ ip: '198.51.100.10', sessionId: hex('c') });
    let res = await ask(e1, 'inquiry:submit', enquiry({
      boothNumbers: ['101', 'NOT-A-STAND', { $gt: '' }, '201', 'x'.repeat(5000), 102],
      sponsorKeys: ['gold', 'lna-only', 'nope', ['gold']],
      areaKeys: ['vip-lounge', 'not-an-area'],
      company: 'C'.repeat(10_000),
      message: 'M'.repeat(50_000),
    }));
    const stored = (db.store.inquiries || [])[0];
    check('stored', res && res.ok && !!stored, JSON.stringify(res).slice(0, 200));
    check('only this event\'s stands, as strings', JSON.stringify(stored.boothsOfInterest) === '["101","102"]',
          JSON.stringify(stored.boothsOfInterest).slice(0, 200));
    check('only this event\'s packages', JSON.stringify(stored.sponsorsOfInterest) === '["gold"]',
          JSON.stringify(stored.sponsorsOfInterest).slice(0, 200));
    check('only areas on this plan', JSON.stringify(stored.areasOfInterest) === '["vip-lounge"]',
          JSON.stringify(stored.areasOfInterest).slice(0, 200));
    check('free text capped', stored.contact.company.length <= 160 && stored.message.length <= 2000);
    check('what was dropped is reported back, shortened', res.dropped && res.dropped.stands.includes('NOT-A-STAND') &&
          res.dropped.stands.includes('201') && res.dropped.stands.includes('(object)') &&
          res.dropped.sponsors.includes('lna-only') && res.dropped.areas.includes('not-an-area') &&
          res.dropped.stands.every(s => s.length <= 41),
          JSON.stringify(res.dropped || null).slice(0, 300));
    res = await ask(e1, 'inquiry:submit', enquiry({ boothNumbers: ['NOT-A-STAND', '[object Object]'] }));
    check('an enquiry about nothing real is refused, saying why',
          res && res.ok === false && /no longer on this plan/.test(res.errors[0]) && db.store.inquiries.length === 1,
          JSON.stringify(res));
    const lna = await client({ show: 'lna', ip: '198.51.100.11' });
    res = await ask(lna, 'inquiry:submit', enquiry({ boothNumbers: ['201', '101'], sponsorKeys: ['lna-only', 'gold'] }));
    const lnaLead = db.store.inquiries.find(i => i.showId === 'LNA');
    check('and the other event keeps its own', res.ok && JSON.stringify(lnaLead.boothsOfInterest) === '["201"]' &&
          JSON.stringify(lnaLead.sponsorsOfInterest) === '["lna-only"]', JSON.stringify(lnaLead && lnaLead.boothsOfInterest));

    console.log('\nOne address cannot store enquiries without limit');
    db.store.inquiries = [];
    let accepted = 0, refused = 0;
    for (let i = 0; i < 14; i++) {
      const s = await client({ ip: '192.0.2.1, 203.0.113.50' });   // the proxy's hop is the right-most
      const a = await ask(s, 'inquiry:submit', enquiry({ email: `bot${i}@example.com` }));
      if (a && a.ok) accepted++; else refused++;
      s.disconnect();
    }
    check('a fresh socket per enquiry no longer resets the limit', accepted === 10 && refused === 4,
          `accepted ${accepted}, refused ${refused}`);
    const other = await client({ ip: '203.0.113.99' });
    check('another address is unaffected', (await ask(other, 'inquiry:submit', enquiry())).ok === true);
    const spoof = await client({ ip: '10.9.9.9, 203.0.113.50' });
    check('and changing the client-written part of X-Forwarded-For does not help',
          (await ask(spoof, 'inquiry:submit', enquiry())).ok === false);

    console.log('\nA retried enquiry is stored once');
    db.store.inquiries = [];
    const admin = await client({ admin: true });
    const pings = [];
    admin.on('inquiry:new', (p) => pings.push(p));
    const rid = '0123456789abcdef0123456789abcdef';
    const re = await client({ ip: '203.0.113.120' });
    const first = await ask(re, 'inquiry:submit', enquiry({ requestId: rid }));
    const second = await ask(re, 'inquiry:submit', enquiry({ requestId: rid }));
    await wait(80);
    check('both attempts are told it worked', first.ok && second.ok);
    check('with the same enquiry', String(first.id) === String(second.id));
    check('one stored, one admin ping', (db.store.inquiries || []).length === 1 && pings.length === 1,
          `${(db.store.inquiries || []).length} stored, ${pings.length} pings`);
    check('the request id is kept on the lead', db.store.inquiries[0].requestId === rid);
    const third = await ask(re, 'inquiry:submit', enquiry({ requestId: 'NOT-HEX' }));
    check('a malformed request id is ignored, not trusted', third.ok && db.store.inquiries.length === 2 &&
          !db.store.inquiries[1].requestId);
    await wait(80);   // its admin ping follows the acknowledgement

    console.log('\nA stored enquiry is never reported as failed');
    db.store.inquiries = [];
    pings.length = 0;
    const logs = [];
    admin.on('log:entry', (l) => logs.push(l));
    faults['activity.updateMany'] = async () => { throw new Error('not primary'); };
    const realError = console.error;
    console.error = () => {};
    const stuck = await client({ ip: '203.0.113.130', sessionId: hex('d') });
    const ok = await ask(stuck, 'inquiry:submit', enquiry({ email: 'grace@example.com', firstName: 'Grace' }));
    await wait(80);
    console.error = realError;
    check('the visitor is told it was received', ok && ok.ok === true, JSON.stringify(ok));
    check('it is stored once', (db.store.inquiries || []).length === 1);
    check('and the admins still hear about it', pings.length === 1 && logs.some(l => /Grace/.test(l.msg)));
    const odd = await ask(stuck, 'inquiry:submit', enquiry({ firstName: 42, lastName: { x: 1 }, name: 'Odd Person',
                                                              email: 'odd@example.com' }));
    await wait(80);
    check('a non-string name cannot turn a stored enquiry into a failure',
          odd.ok === true && pings.length === 2 && pings[1].name === 'Odd Person', JSON.stringify([odd, pings[1]]));
  } catch (e) {
    check('suite ran without throwing', false, e.stack);
  } finally {
    console.warn = realWarn;
    close();
  }
  finish();
})();
