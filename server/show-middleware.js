const config = require('./config');
const shows = require('./models/shows');
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
 * An admin call naming a show that does not exist is refused, never quietly
 * replaced with the default: writing one event's booking into another is the
 * worst outcome available here, and it would be silent. Only a PUBLIC request
 * falls back, because all it can do is read a plan, and a visitor with a stale
 * link should still see one.
 */
const PAGE_WITH_SHOW = /^\/(admin|floorplan|sales)\/([a-z0-9][a-z0-9-]*)\/?$/i;

// What an admin page is told when the event it was opened on no longer has
// that address — renamed, or removed from the registry. Agreed with the
// console, which reloads on it.
const GONE = 'This event is no longer at that address. Reload the page.';

// Everything under /api acts as somebody: the console, the sales dashboard,
// the Settings cards. Those are the calls that must never land on another event.
// Except "who am I", which belongs to no event: a page whose event has moved
// still has to be able to ask whether its session is alive, or it cannot tell
// "reload" from "sign in again".
const isApi = (req) => /^\/api(\/|$)/.test(req.path || '') && req.path !== '/api/me';

/**
 * The show a slug names, whether or not it is still on the air.
 *
 * A retired event keeps its data and is still managed from Settings — its plan,
 * its colours, its stand schedule — and every one of those calls names it in
 * X-Show. Treating "retired" as "unknown" sent each of them to the default
 * event instead: a colour chosen for last year's show repainted this year's,
 * and removing last year's plan removed this year's.
 */
const named = (slug) => (slug ? shows.bySlug(slug) : null);

function showMiddleware() {
  return function resolveShow(req, res, next) {
    const header = String(req.get ? (req.get('X-Show') || '') : '').trim().toLowerCase();
    if (header) {
      const s = named(header);
      // The request names this event explicitly, so it runs as this event —
      // active or retired. Only a slug that names nothing is in question.
      if (s) return showContext.runAs(s.showId, next);
      // An admin call is refused. 409 rather than 400 because the request
      // itself is fine; it is the page that is out of date, and reloading it
      // is the whole remedy.
      if (isApi(req)) return res.status(409).json({ error: GONE });
      // A public read falls back to the default rather than failing. It used to
      // 400, which meant one bad slug turned every request a visitor's page made
      // into an error and left a blank floorplan — the page denying service to
      // itself. A page URL naming an unknown show is still a 404, because that
      // IS someone asking for something that does not exist.
      console.warn(`Unknown show header "${header}" — falling back to ${config.defaultShow}`);
      return showContext.runAs(config.defaultShow, next);
    }

    const m = PAGE_WITH_SHOW.exec(req.path);
    if (m) {
      const s = named(m[2]);
      // A retired show keeps its data but its PAGES stop answering, so an event
      // that has finished can be taken off the air without deleting anything.
      if (!s || s.active === false) return res.status(404).type('html').send('<h1>404 — no such show</h1>');
      return showContext.runAs(s.showId, next);
    }

    return showContext.runAs(config.defaultShow, next);
  };
}

/**
 * Which show a socket joins, from the slug its page passed in the handshake.
 *
 * Two answers, because the two kinds of socket can do different things:
 *
 *   - an ADMIN socket books stands. Its page names the event it is showing, so
 *     it joins that event — retired ones included — and a slug that names
 *     nothing is `gone`: the caller tells the page and disconnects it, because
 *     joining the default event's rooms is how a console labelled with one
 *     event came to book another's stands after a reconnect.
 *   - a visitor's socket only reads. Anything it cannot place — an unknown or a
 *     retired slug — falls back to the default, since a visitor with a stale
 *     bookmark should still see a floorplan.
 *
 * Returns `{ showId }` or `{ gone: true }`.
 */
function showForSocket(slug, { admin = false } = {}) {
  const want = String(slug || '').trim().toLowerCase();
  const s = named(want);
  if (admin) {
    if (s) return { showId: s.showId };
    // No slug at all is a page that predates per-event pages, and the default
    // is what it always meant. A slug naming nothing is a page that is stale.
    return want ? { gone: true } : { showId: config.defaultShow };
  }
  return { showId: s && s.active !== false ? s.showId : config.defaultShow };
}

/** The show a page URL names, for serving that page with its show injected. */
function showForRequest(req) {
  const m = PAGE_WITH_SHOW.exec(req.path);
  const page = m ? shows.bySlug(m[2]) : null;
  if (page && page.active !== false) {
    return { slug: page.slug, id: page.showId, name: page.name };
  }
  // Whatever happens, this returns a USABLE slug. Returning one without it is
  // what took the site down: the page injected `slug: undefined`, sent
  // `X-Show: undefined` on every request, and each one was rejected.
  const def = shows.byId(config.defaultShow) || shows.list()[0];
  const slug = (def && def.slug) || String(config.defaultShow).toLowerCase();
  const id = (def && def.showId) || config.defaultShow;
  return { slug, id, name: (def && def.name) || id };
}

module.exports = { showMiddleware, showForRequest, showForSocket, PAGE_WITH_SHOW, GONE };
