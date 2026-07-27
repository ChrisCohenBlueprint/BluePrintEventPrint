/**
 * URL sanitisers shared by anything that stores a link or image the browser
 * will later load. Keeping them in one place stops the partner and sponsor
 * paths drifting apart (they previously validated differently).
 */

const clean = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';

/**
 * A link the browser may navigate to: absolute http(s), or a site-relative
 * path. Everything else (javascript:, data:, mailto:, …) is rejected.
 *
 * The site-relative test deliberately rejects "//host" and "/\host": both
 * start with a slash but browsers treat them as protocol-relative URLs to
 * another origin, so a naive `startsWith('/')` would let an off-site link
 * through under our own branding.
 */
function safeLink(v) {
  const s = clean(v, 500);
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\/(?![/\\])/.test(s)) return s;   // "/path" yes; "//host" and "/\host" no
  return '';
}

/**
 * An image source. Same rules as a link, plus an inline `data:image/…` URI so a
 * small logo can be pasted or uploaded directly. Only image MIME types — never
 * data:text/html.
 */
function safeImage(v) {
  const s = clean(v, 2_000_000);          // data URIs are long
  if (!s) return '';
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(s)) return s;
  return safeLink(s);
}

module.exports = { clean, safeLink, safeImage };
