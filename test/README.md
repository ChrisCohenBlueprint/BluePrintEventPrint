# Tests

No database required. Everything here runs against stubs, because the project's
`MONGO_URI` points at the live Atlas cluster and `scripts/browser-check.js`
rightly refuses to touch it.

    npm test

## What each file is for

- **`serve-pages.js`** — serves the REAL page routes (`/admin`, `/admin/:show`,
  `/floorplan`, `/floorplan/:show`) with no database, plus stand-ins for
  socket.io and the artwork route. Started automatically by the suites below.

- **`pages.test.js`** — does the page a URL serves actually WORK: styles
  applied, scripts running, no asset 404s, and nothing served as the wrong
  content type. This exists because an earlier test only asserted that a URL
  *resolved to the right show*, which a page rendering as unstyled plain text
  passed cleanly — and that shipped.

- **`plans-grid.test.js`** — the Settings page: every event side by side, and
  uploading from a card targets THAT event rather than whichever one the page
  is scoped to.

## Why socket.io is stubbed rather than skipped

Without it `admin.js` throws on its first line and the page's own script never
runs, so every "scripts run" assertion passes on the injected bootstrap alone.
That made the suite look stronger than it was.
