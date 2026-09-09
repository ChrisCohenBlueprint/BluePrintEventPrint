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

/**
 * `show` names the event this page is for. It is injected as a small script in
 * <head> — before the page's own scripts run — which does two things: records
 * the show for the socket handshake, and adds an `X-Show` header to every
 * same-origin fetch the page makes. That header is how ~40 existing `fetch()`
 * calls reach the right event without one of them being edited.
 */
function sendPage(res, file, show = null) {
  if (!cache[file]) {
    const html = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    // Local .js/.css only — not external URLs, and not ones already carrying a
    // query. Rewritten to ABSOLUTE paths: a relative "floorplan.css" resolves
    // against the current URL, so it only works at exactly /floorplan. At
    // /floorplan/ or /floorplan/lex the browser asks for
    // /floorplan/floorplan.css, gets the HTML page back, and renders with no
    // styles and no scripts. Absolute paths work at every URL shape.
    cache[file] = html.replace(/(src|href)="([^"?:]+\.(?:js|css))"/g,
      (_m, attr, p) => `${attr}="${p.startsWith('/') ? p : '/' + p}?v=${BUILD_ID}"`);
  }

  let html = cache[file];
  if (show) {
    const boot = `<script>
window.__SHOW = ${JSON.stringify(show)};
(function () {
  var native = window.fetch;
  window.fetch = function (input, init) {
    // Same-origin only: a relative path, or this origin spelled out. Never add
    // the header to a third-party request.
    var url = (typeof input === 'string') ? input : (input && input.url) || '';
    var sameOrigin = url.charAt(0) === '/' || url.indexOf(location.origin) === 0;
    if (!sameOrigin) return native.apply(this, arguments);
    init = init || {};
    var h = new Headers(init.headers || (typeof input === 'object' && input.headers) || {});
    // Only when we actually have one. Sending the string "undefined" is how a
    // missing slug became a site-wide outage.
    if (window.__SHOW && window.__SHOW.slug) h.set('X-Show', window.__SHOW.slug);
    return native.call(this, input, Object.assign({}, init, { headers: h }));
  };
})();
</script>`;
    html = html.replace('</head>', boot + '</head>');
  }

  res.set('Cache-Control', 'no-cache');
  res.type('html').send(html);
}

module.exports = { sendPage, BUILD_ID, PUBLIC };
