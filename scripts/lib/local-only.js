/**
 * Refuse to run a check unless BOTH ends of it are on this machine.
 *
 * check:security and check:browser mutate data: they book stands, and
 * browser-check submits a real enquiry from "Hostile Ltd", which fires the
 * lead webhook. Their guard looked only at the script's OWN MONGO_URI, and
 * only for "mongodb+srv", which missed every way this actually goes wrong:
 *
 *   - every side effect goes through the SERVER at BASE, not through the
 *     script's connection. A local server started with the Atlas URI, or BASE
 *     pointed at the live site, passed;
 *   - neither script read .env. With MONGO_URI unset in the shell the guard
 *     saw nothing at all, while the server started beside it — which does
 *     read .env — wrote to the cluster named there;
 *   - a non-SRV Atlas string (mongodb://cluster0-shard-00-00…) passed.
 *
 * So BASE must be this machine, and the database must be local as THIS
 * checkout's .env would configure a server started from it (a shell variable
 * still wins, exactly as it does for the server), judged by the same test
 * server/config.js uses to decide it is handling real data.
 *
 * A server started from another checkout with a different URI cannot be seen
 * from here, so the README's instruction stands: start the server and run the
 * check with the same, local, MONGO_URI.
 */
require('dotenv').config({ quiet: true });

/**
 * Is this connection string a database on this machine? The same rule as
 * isLocalMongo() in server/config.js: unset means the local default, SRV is
 * always a hosted cluster, and every host in a seed list must be loopback.
 */
function isLocalMongo(uri) {
  const raw = String(uri || '');
  if (!raw) return true;
  if (/^mongodb\+srv:/i.test(raw)) return false;
  const hosts = raw.replace(/^mongodb:\/\//i, '').split('/')[0].split('@').pop();
  return hosts.split(',').every(h =>
    /^(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:\d+)?$/i.test(h.trim()));
}

/** Is this URL a server on this machine? */
function isLoopback(base) {
  try {
    const { hostname } = new URL(base);
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname.toLowerCase());
  } catch { return false; }
}

/** Exit before anything is sent if either end is not local. */
function requireLocal(base, what) {
  const problems = [];
  if (!isLoopback(base)) {
    problems.push(`the server it would drive, ${base}, is not on this machine`);
  }
  if (!isLocalMongo(process.env.MONGO_URI)) {
    problems.push('MONGO_URI (from the shell or this checkout\'s .env) is not a database on this machine');
  }
  if (!problems.length) return;
  console.error(`Refusing to run ${what}: it changes data through the server it drives, so it only`);
  console.error('runs against a server on this machine using a database on this machine — and');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('Start a server on this machine against a local mongod, e.g.');
  console.error('  MONGO_URI=mongodb://127.0.0.1:27017 npm start');
  console.error('and run this with the same MONGO_URI in the shell.');
  process.exit(2);
}

module.exports = { requireLocal, isLocalMongo, isLoopback };
