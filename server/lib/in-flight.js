/**
 * Socket handlers still running.
 *
 * Several handlers write in more than one step — book a held stand drops the
 * hold and then sets the status — and a deploy's SIGTERM used to close the
 * database underneath whichever of them happened to be mid-way. Every socket
 * handler runs through `run()`, and shutdown waits on `drain()` before it
 * closes the connection, so a write that has started is allowed to finish.
 */
let running = 0;
let waiters = [];

function settle() {
  running--;
  if (running === 0 && waiters.length) {
    const w = waiters; waiters = [];
    w.forEach(r => r());
  }
}

/** Run `fn`, counted as in flight until the promise it returns settles. */
function run(fn) {
  running++;
  let p;
  try { p = Promise.resolve(fn()); }
  catch (e) { p = Promise.reject(e); }
  return p.finally(settle);
}

/** Resolves true once nothing is in flight, or false after `ms`. */
function drain(ms) {
  if (running === 0) return Promise.resolve(true);
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(false), ms);
    if (t.unref) t.unref();
    waiters.push(() => { clearTimeout(t); resolve(true); });
  });
}

module.exports = { run, drain, count: () => running };
