const config = require('./config');
const showContext = require('./show-context');

/**
 * Decide which show a request belongs to, and run the rest of it in that show.
 *
 * Two sources, in order:
 *   1. `X-Show` — attached by every page to its own fetches (see send-page.js),
 *      which is how existing `fetch('/api/…')` calls reach the right event
 *      without any of them being edited.
 *   2. A slug in a page URL: /admin/lna, /floorplan/lex.
 *
 * With neither, the default show — which is every URL a single-show deployment
 * has ever used, so nothing about it changes.
 *
 * An unrecognised show is refused, never quietly replaced with the default:
 * writing one event's booking into another is the worst outcome available here,
 * and it would be silent.
 */
const PAGE_WITH_SHOW = /^\/(admin|floorplan|sales)\/([a-z0-9][a-z0-9-]*)\/?$/i;

function showMiddleware() {
  const bySlug = new Map(config.shows.map(s => [s.slug, s.id]));

  return function resolveShow(req, res, next) {
    const header = String(req.get ? (req.get('X-Show') || '') : '').trim().toLowerCase();
    if (header) {
      const id = bySlug.get(header);
      if (!id) return res.status(400).json({ error: `Unknown show "${header}".` });
      return showContext.runAs(id, next);
    }

    const m = PAGE_WITH_SHOW.exec(req.path);
    if (m) {
      const id = bySlug.get(m[2].toLowerCase());
      if (!id) return res.status(404).type('html').send('<h1>404 — no such show</h1>');
      return showContext.runAs(id, next);
    }

    return showContext.runAs(config.defaultShow, next);
  };
}

/** The show a page URL names, for serving that page with its show injected. */
function showForRequest(req) {
  const bySlug = new Map(config.shows.map(s => [s.slug, s.id]));
  const m = PAGE_WITH_SHOW.exec(req.path);
  const slug = m ? m[2].toLowerCase() : null;
  if (slug && bySlug.has(slug)) return { slug, id: bySlug.get(slug) };
  const def = config.shows.find(x => x.id === config.defaultShow) || config.shows[0];
  return { slug: def ? def.slug : '', id: config.defaultShow };
}

module.exports = { showMiddleware, showForRequest, PAGE_WITH_SHOW };
