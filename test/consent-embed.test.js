/**
 * Consent comes from the visitor, through the page the plan is embedded in —
 * and from nowhere else.
 *
 * On the marketing site this page is an iframe with our consent bar hidden,
 * and the host's cookie banner tells us what the visitor chose by
 * postMessage. Four ways that went wrong:
 *
 *   a. The message was accepted from ANY window. Another iframe on the host
 *      page — an ad, a chat widget — could run
 *        parent.frames[0].postMessage({ type: 'bp-consent', value: 'granted' }, '*')
 *      and tracking was switched on, stored, and the session adopted.
 *   b. An answer stored on an earlier visit was used at once: the handshake
 *      carried the stored session id and connecting adopted it, before the
 *      host had said anything about THIS visit — including a visitor who has
 *      since withdrawn on the host's banner.
 *   c. Withdrawing cleared local storage and told the server nothing, so the
 *      open socket went on being tracked under the visitor's id.
 *   d. Accepting while the socket was down buffered a session:adopt, and the
 *      reconnect sent a second one.
 */
const { start, openPage, reporter, wait } = require('./floorplan-stub');

const { check, finish } = reporter();

const HOST = `<!doctype html><title>host</title>
  <iframe id="plan" src="/floorplan?embed=1" width="900" height="600"></iframe>
  <iframe id="other" src="/third-party" width="200" height="100"></iframe>
  <script>
    window.answer = function (v) {
      document.getElementById('plan').contentWindow.postMessage({ type: 'bp-consent', value: v }, '*');
    };
  </script>`;
const THIRD_PARTY = `<!doctype html><title>widget</title>
  <script>
    window.attack = function () { parent.frames[0].postMessage({ type: 'bp-consent', value: 'granted' }, '*'); };
  </script>`;

(async () => {
  const srv = await start({
    routes(app) {
      app.get('/host', (_q, res) => res.type('html').send(HOST));
      app.get('/third-party', (_q, res) => res.type('html').send(THIRD_PARTY));
    },
  });
  const { page, errors } = await openPage(srv.browser, `${srv.base}/host`);
  await wait(1500);
  const plan = () => page.frames().find(f => /\/floorplan/.test(f.url()));
  const widget = () => page.frames().find(f => /\/third-party/.test(f.url()));
  const emits = (e) => plan().evaluate(e => window.__emits.filter(x => x.e === e), e);
  const stored = () => plan().evaluate(() => ({ consent: localStorage.getItem('bp_consent'),
                                                session: localStorage.getItem('bp_session') }));

  console.log('\na. Another frame on the host page');
  await widget().evaluate(() => window.attack());
  await wait(300);
  check('cannot grant consent', (await stored()).consent !== 'granted', JSON.stringify(await stored()));
  check('or adopt a session', (await emits('session:adopt')).length === 0);
  await page.evaluate(() => window.answer('granted'));
  await wait(300);
  check('the host page itself can', (await stored()).consent === 'granted');
  let adopts = await emits('session:adopt');
  check('and the session is adopted once', adopts.length === 1 && /^[0-9a-f]{32}$/.test(adopts[0].p.sessionId),
        JSON.stringify(adopts));
  const sessionId = adopts[0] && adopts[0].p.sessionId;
  await page.evaluate(() => window.answer('granted'));       // the host re-posts on every banner change
  await wait(200);
  check('a repeated answer does not adopt it again', (await emits('session:adopt')).length === 1);

  console.log('\nb. The next visit, with "granted" stored from this one');
  await page.reload({ waitUntil: 'networkidle' });
  await wait(1500);
  check('the answer is still stored', (await stored()).consent === 'granted');
  const hs = await plan().evaluate(() => window.__handshake());
  check('the handshake does not carry the stored session before the host answers', hs && hs.sessionId === null,
        JSON.stringify(hs));
  check('and connecting does not adopt it', (await emits('session:adopt')).length === 0);
  await plan().evaluate(() => { window.__emits.length = 0; });
  await page.evaluate(() => window.answer('granted'));
  await wait(300);
  adopts = await emits('session:adopt');
  check('once the host says granted, the same session is adopted', adopts.length === 1 && adopts[0].p.sessionId === sessionId,
        JSON.stringify(adopts));

  console.log('\nc. Withdrawing');
  await page.evaluate(() => window.answer('declined'));
  await wait(300);
  const w = await emits('consent:withdrawn');
  check('tells the server', w.length === 1 && w[0].connected, JSON.stringify(w));
  check('and forgets the session', (await stored()).session === null && (await stored()).consent === 'denied');
  check('and the handshake carries no session from then on',
        (await plan().evaluate(() => window.__handshake())).sessionId === null);
  await page.evaluate(() => window.answer('declined'));
  await wait(200);
  check('saying it twice tells it once', (await emits('consent:withdrawn')).length === 1);

  console.log('\nd. Accepting while the connection is down');
  await plan().evaluate(() => { window.__emits.length = 0; window.__drop(); });
  await page.evaluate(() => window.answer('granted'));
  await wait(200);
  check('sends nothing into the dead socket', (await emits('session:adopt')).length === 0);
  await plan().evaluate(() => window.__rejoin());
  await wait(200);
  adopts = await emits('session:adopt');
  check('and adopts exactly once when it is back', adopts.length === 1 && adopts[0].connected, JSON.stringify(adopts));
  await plan().evaluate(() => { window.__drop(); window.__rejoin(); });
  await wait(200);
  check('once per connection', (await emits('session:adopt')).length === 2);

  console.log('\nThe plan opened directly, with its own consent bar');
  const top = await openPage(srv.browser, `${srv.base}/floorplan`);
  await wait(800);
  await top.page.click('#consent-accept');
  await wait(200);
  const topAdopts = await top.page.evaluate(() => window.__emits.filter(x => x.e === 'session:adopt'));
  check('accepting adopts the session once', topAdopts.length === 1, JSON.stringify(topAdopts));
  await top.page.reload({ waitUntil: 'networkidle' });
  await wait(800);
  const again = await top.page.evaluate(() => ({ hs: window.__handshake(),
    adopts: window.__emits.filter(x => x.e === 'session:adopt').length }));
  check('and a stored answer is used straight away there — the visitor gave it on this page',
        /^[0-9a-f]{32}$/.test(again.hs.sessionId || '') && again.adopts === 1, JSON.stringify(again));

  check('the pages raised no errors', errors.length === 0 && top.errors.length === 0,
        errors.concat(top.errors).slice(0, 2).join(' | '));
  await srv.close();
  finish();
})().catch((e) => { console.error(e); process.exit(1); });
