/**
 * A resent enquiry is the same enquiry, and the server can tell.
 *
 * The page gives the server 12 seconds to acknowledge an enquiry and then
 * tells the visitor "We did not hear back". The enquiry may well have been
 * saved — it is the ACK that was lost — and the visitor, told to try again,
 * presses Send again. That was a second lead for the same person and the
 * same stands, for sales to discover and merge by hand.
 *
 * Each enquiry now carries a requestId: 32 lowercase hex, minted once, sent
 * unchanged on every retry of that enquiry, and replaced after a successful
 * send. The server de-duplicates on it.
 *
 * "That enquiry" means what is being sent. A visitor who adds a stand or
 * corrects their email before trying again is sending something different,
 * and gets a new id: were it de-duplicated against the first attempt, the
 * change would be thrown away while the page reported success — the visitor
 * would be told an enquiry went that did not. A second lead is the lesser
 * harm.
 */
const { start, openPage, artworkRects, stand, reporter, wait } = require('./floorplan-stub');

const { check, finish } = reporter();
const HEX32 = /^[0-9a-f]{32}$/;

(async () => {
  const srv = await start();
  const { page, errors } = await openPage(srv.browser, `${srv.base}/floorplan`);
  await wait(1200);
  const rects = await artworkRects(page, 20);
  await page.evaluate(s => window.__fire('state:full', s), rects.map((g, i) => stand(i, g)));
  await wait(800);

  await page.evaluate(() => { selectBooth('100'); toggleShortlist('100'); });
  await page.fill('#eq-first', 'Pat');
  await page.fill('#eq-email', 'pat@example.com');

  const sends = () => page.evaluate(() => window.__emits.filter(x => x.e === 'inquiry:submit').map(x => x.p));
  const errorText = () => page.evaluate(() => document.getElementById('eq-errors').textContent);

  console.log('\nAn acknowledgement that never arrives');
  await page.evaluate(() => { window.__acks['inquiry:submit'] = 'never'; });
  await page.clock.install();
  await page.click('#eq-submit');
  await page.clock.runFor(12500);
  check('the visitor is told nothing came back', /did not hear back/.test(await errorText()), await errorText());
  await page.click('#eq-submit');
  await page.clock.runFor(12500);
  let s = await sends();
  check('each attempt carries a request id', s.length === 2 && s.every(p => HEX32.test(p.requestId || '')),
        s.map(p => p.requestId).join(', '));
  check('and a retry carries the SAME one', HEX32.test(s[0].requestId || '') && s[0].requestId === s[1].requestId);

  console.log('\nA rejection, then a retry');
  await page.evaluate(() => { window.__acks['inquiry:submit'] = { ok: false, errors: ['Too many submissions. Please wait a moment.'] }; });
  await page.click('#eq-submit');
  await page.clock.runFor(200);
  s = await sends();
  check('is still the same enquiry', s[2] && HEX32.test(s[2].requestId || '') && s[2].requestId === s[0].requestId);

  console.log('\nChanging the enquiry before trying again');
  await page.evaluate(() => { selectBooth('101'); toggleShortlist('101'); });
  await page.evaluate(() => { window.__acks['inquiry:submit'] = { ok: true }; });
  await page.click('#eq-submit');
  await page.clock.runFor(200);
  s = await sends();
  check('makes it a different one', s[3] && HEX32.test(s[3].requestId) && s[3].requestId !== s[0].requestId,
        `${s[0].requestId} -> ${s[3] && s[3].requestId}`);
  const sent = await page.evaluate(() => !document.getElementById('eq-success').classList.contains('hidden'));
  check('which is sent', sent);

  console.log('\nThe next enquiry');
  await page.click('#eq-again');
  await page.evaluate(() => { selectBooth('100'); toggleShortlist('100'); });
  await page.click('#eq-submit');
  await page.clock.runFor(200);
  s = await sends();
  check('gets a new id, even for the same stand', s[4] && HEX32.test(s[4].requestId)
        && !s.slice(0, 4).some(p => p.requestId === s[4].requestId), s[4] && s[4].requestId);

  console.log('\nThe waiting list');
  // The same pipeline and the same deadline, so the same protection.
  const held = rects.map((g, i) => stand(i, g, i === 5 ? { status: 'held' } : {}));
  await page.evaluate(s => window.__fire('state:full', s), held);
  await page.clock.runFor(200);
  await page.evaluate(() => { selectBooth('105'); window.__acks['inquiry:submit'] = 'never'; });
  await page.fill('#wl-email', 'pat@example.com');
  await page.click('#wl-submit');
  await page.clock.runFor(12500);
  await page.click('#wl-submit');
  await page.clock.runFor(12500);
  const wl = (await sends()).filter(p => p.kind === 'waitlist');
  check('a waiting-list request carries an id too', wl.length === 2 && HEX32.test(wl[0].requestId || ''),
        wl.map(p => p.requestId).join(', '));
  check('kept across its retry', wl.length === 2 && HEX32.test(wl[0].requestId || '') && wl[0].requestId === wl[1].requestId);
  check('and its own, not the enquiry\'s', wl.length && !s.some(p => p.requestId === wl[0].requestId));

  console.log('\nWhat the server says back');
  // The answers the server can now give (server/models/inquiries.js): a
  // retry of one already stored is replayed as a success marked duplicate,
  // and a stored enquiry says which of its items no longer existed.
  const shown = () => page.evaluate(() => ({
    success: !document.getElementById('eq-success').classList.contains('hidden'),
    dropped: (document.getElementById('eq-dropped')?.hidden === false
      ? document.getElementById('eq-dropped').textContent.replace(/\s+/g, ' ').trim() : ''),
    errors: document.getElementById('eq-errors').textContent,
  }));
  const sendWith = async (ack, stands) => {
    await page.evaluate(({ ack, stands }) => {
      document.getElementById('eq-again').click();
      stands.forEach(n => { selectBooth(n); toggleShortlist(n); });
      window.__acks['inquiry:submit'] = ack;
    }, { ack, stands });
    await page.click('#eq-submit');
    await page.clock.runFor(200);
    return shown();
  };
  let v = await sendWith({ ok: true, id: 'x', dropped: { stands: ['104'], sponsors: [], areas: [] } }, ['100', '104']);
  check('a stored enquiry that lost an item is still sent', v.success, JSON.stringify(v));
  check('and the visitor is told plainly what was left out', /Stand 104 was not included/.test(v.dropped)
        && /no longer on this plan/.test(v.dropped), v.dropped);
  v = await sendWith({ ok: true, id: 'x', duplicate: true }, ['100']);
  check('a replayed duplicate is a success', v.success && v.dropped === '', JSON.stringify(v));
  const refusal = 'Those stands or options are no longer on this plan. Please refresh the page and choose again.';
  v = await sendWith({ ok: false, errors: [refusal] }, ['100']);
  check('a refusal is shown in the server\'s own words', !v.success && v.errors === refusal, v.errors);

  check('the page raised no errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  await srv.close();
  finish();
})().catch((e) => { console.error(e); process.exit(1); });
