/**
 * How big a socket message may be — for an admin, and for a visitor.
 *
 *   admin    — Socket.IO's default limit is 1 MB, and the logo setters accept
 *              up to 2,000,000 characters. A logo between the two never reached
 *              the server: the admin's socket was dropped with "transport
 *              error", no acknowledgement and no message, so the console just
 *              hung. The limit is now above the models' own, so it is their
 *              "too large" that answers.
 *   visitor  — nothing a visitor's page sends comes near that, so a visitor's
 *              socket is held to a ceiling of its own: an oversized event is
 *              answered and not processed, and the socket stays connected.
 *
 * Against the real `node server.js`, since its options are what is under test.
 */
const { start, ask } = require('./server-process');
const auth = require('../server/auth');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const image = (chars) => 'data:image/png;base64,' + 'A'.repeat(chars);

(async () => {
  let srv;
  try {
    srv = await start();
    const cookie = `${auth.COOKIE}=${auth.signToken({ user: 'chris', role: 'admin', v: 0, exp: Date.now() + 3600e3 })}`;

    console.log('\nAn admin\'s logo reaches the server, whatever its size');
    const admin = await srv.client({ cookie });
    let r = await ask(admin, 'booth:set-logo', { boothNumber: '101', logo: image(1_200_000) });
    check('a 1.2 MB stand logo is saved', r && r.ok === true, JSON.stringify(r).slice(0, 160));
    r = await ask(admin, 'area:set-logo', { key: 'vip-lounge', logo: image(2_500_000) });
    check('a 2.5 MB area logo is refused by the model, in words',
          r && r.ok === false && /too large/.test(r.error || ''), JSON.stringify(r).slice(0, 160));
    check('and the admin is still connected', admin.connected);

    console.log('\nA visitor\'s socket is held to what a page sends');
    const visitor = await srv.client();
    r = await ask(visitor, 'booth:view', { boothNumber: 'x'.repeat(200_000) });
    check('an oversized event is answered, not processed', r && r.ok === false && !r.timeout, JSON.stringify(r).slice(0, 160));
    check('and the visitor is still connected', visitor.connected);
    const enquiry = { firstName: 'Ada', email: 'ada@example.com', boothNumbers: ['101'] };
    r = await ask(visitor, 'inquiry:submit', { ...enquiry, message: 'M'.repeat(200_000) });
    check('an oversized enquiry is refused before it is stored',
          r && r.ok === false && !/STUB enquiry stored/.test(srv.output()), JSON.stringify(r).slice(0, 160));
    r = await ask(visitor, 'inquiry:submit', { ...enquiry, message: 'Hello' });
    check('an ordinary one goes through', r && r.ok === true, JSON.stringify(r).slice(0, 160));
    r = await ask(visitor, 'area:set-logo', { key: 'vip-lounge', logo: image(1_200_000) });
    check('and a visitor cannot borrow the admin\'s allowance', r && r.ok === false && visitor.connected,
          JSON.stringify(r).slice(0, 160));
  } catch (e) {
    check('suite ran without throwing', false, `${e.stack}\n${srv ? srv.output().slice(-2000) : ''}`);
  } finally {
    if (srv) await srv.kill('SIGKILL');
  }

  const failed = out.filter(x => !x).length;
  console.log(failed ? `\n${failed} FAILED (${out.length} checks)` : `\nALL PASSED (${out.length} checks)`);
  process.exit(failed ? 1 : 0);
})();
