const fs   = require('fs');
const path = require('path');

/**
 * Serve an HTML page with a build stamp on its local assets.
 *
 * Build id changes every process start (i.e. every deploy). Stamped as ?v= onto
 * the page's script/style tags so a reload — the HTML always revalidates — pulls
 * the JS/CSS matching this build instead of a copy a browser or proxy held onto.
 * Without it a stale script can keep running even though the deploy shipped new
 * code, which looks like "the front end isn't updating".
 *
 * Lives here rather than in server.js so every page route — admin, floorplan and
 * the sales surfaces — gets the same treatment from one implementation.
 */
const BUILD_ID = Date.now().toString(36);

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const cache = {};

function sendPage(res, file) {
  if (!cache[file]) {
    const html = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    // Local .js/.css only — not external URLs, and not ones already carrying a query.
    cache[file] = html.replace(/(src|href)="([^"?:]+\.(?:js|css))"/g, `$1="$2?v=${BUILD_ID}"`);
  }
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(cache[file]);
}

module.exports = { sendPage, BUILD_ID, PUBLIC };
