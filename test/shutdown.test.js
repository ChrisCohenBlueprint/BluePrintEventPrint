/**
 * A deploy does not cut a socket handler in half.
 *
 * Render sends SIGTERM on every deploy. Shutdown closed the sockets and then
 * the database straight away, so a handler already running — an enquiry
 * half-way through being stored, a multi-step booking — had the connection
 * closed underneath it. Shutdown now waits for the handlers in flight (within
 * its 10-second deadline) before it flushes the activity log and closes the
 * database.
 *
 * Against the real `node server.js`, with an enquiry whose insert is held
 * open when the signal arrives.
 */
const { start } = require('./server-process');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  let srv;
  try {
    srv = await start({ STUB_SLOW_INSERT_MS: '1200' });
    const visitor = await srv.client();

    console.log('\nSIGTERM while an enquiry is being stored');
    visitor.emit('inquiry:submit', { firstName: 'Ada', email: 'ada@example.com', boothNumbers: ['101'] }, () => {});
    await wait(250);
    const startedAt = Date.now();
    const { code } = await srv.kill('SIGTERM');
    const log = srv.output();
    const stored = log.indexOf('STUB enquiry stored');
    const closed = log.indexOf('STUB db closed');
    check('the enquiry finishes being stored', stored > -1, log.split('\n').filter(l => /STUB|SIGTERM|Closed|still/.test(l)).join(' | '));
    check('before the database is closed', stored > -1 && closed > stored);
    check('and the process still exits cleanly, well inside the deadline',
          code === 0 && /Closed cleanly/.test(log) && Date.now() - startedAt < 9000, `exit ${code}, ${Date.now() - startedAt} ms`);
  } catch (e) {
    check('suite ran without throwing', false, `${e.stack}\n${srv ? srv.output().slice(-2000) : ''}`);
  } finally {
    if (srv && srv.exited) await Promise.race([srv.exited, wait(100)]);
  }

  const failed = out.filter(x => !x).length;
  console.log(failed ? `\n${failed} FAILED (${out.length} checks)` : `\nALL PASSED (${out.length} checks)`);
  process.exit(failed ? 1 : 0);
})();
