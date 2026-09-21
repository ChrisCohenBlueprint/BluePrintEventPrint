/**
 * Shared plumbing for the browser-driven suites.
 *
 * Two things here, both of which existed as copy-paste in every suite and both
 * of which stopped the tests running anywhere but this laptop.
 *
 * `listen()` binds port 0 — whatever the OS has free — instead of the hard-coded
 * 3333/3334 the suites used to share. Two suites on the same port cannot run at
 * once, which matters more than it sounds: the failure is an EADDRINUSE crash
 * that looks nothing like a test failure, so a real regression and a scheduling
 * collision are indistinguishable at a glance. It cost an hour of chasing a
 * non-bug once already.
 *
 * `launch()` takes the browser channel from PW_CHANNEL. Locally it stays
 * Chrome, which is installed. `playwright-core` ships no browser of its own, so
 * on a CI runner `channel: 'chrome'` fails before a single assertion runs;
 * there, PW_CHANNEL='' selects the Chromium that `playwright install` fetched.
 */
const { chromium } = require('playwright-core');

/** Launch a browser: installed Chrome by default, PW_CHANNEL to override. */
async function launch(opts = {}) {
  // Set but empty means "the bundled Chromium", which is what CI wants; unset
  // means Chrome, which is what this project has always used locally.
  const channel = process.env.PW_CHANNEL === undefined ? 'chrome' : process.env.PW_CHANNEL;
  return chromium.launch({ headless: true, ...(channel ? { channel } : {}), ...opts });
}

/**
 * Start an express app on a free port.
 * @returns {Promise<{ server: import('http').Server, port: number, base: string }>}
 */
function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0);
    server.once('error', reject);
    server.once('listening', () => {
      const { port } = server.address();
      resolve({ server, port, base: `http://127.0.0.1:${port}` });
    });
  });
}

module.exports = { launch, listen };
