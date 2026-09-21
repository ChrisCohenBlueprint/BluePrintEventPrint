# BluePrint Floorprint — interactive exhibition floorplan

A real-time floorplan for exhibition sales. Visitors browse the hall plan and
**send an enquiry**; the sales office books, holds and prices stands from an
admin console; reps build per-client proposals from what is still available.
Everything is backed by MongoDB and pushed over Socket.IO, so a stand booked in
the admin changes colour on every open plan immediately.

One deployment serves **several events** (Europe, North America, Middle East),
each with its own artwork, stands, settings and proposals.

---

## What is actually in here

**Public plan — `/floorplan`, `/floorplan/:show`**
* Zoomable, pannable SVG hall plan, drawn from the designer's own artwork.
* Live status per stand (available / on hold / sold) and a live viewer count.
* Search across exhibitor, country and business activity in one field; matches
  light up and the rest of the hall fades. Country comes from a built-in list
  (`server/data/countries.js`); business activity from the admin-curated
  catalogue under **Tools → Business Activities**.
* Sponsorship recommendations sized to the stand being looked at, with **no
  prices** — sales cover cost in the follow-up.
* **Enquiry form.** There is no public self-service booking and has not been for
  a long time: a visitor shortlists stands and sends an enquiry, and a person
  books it. The booking events are admin-only on the socket layer.
* Behavioural tracking is **consent-gated** — nothing is sent until the visitor
  accepts — and retention is enforced by a TTL index, not by policy.
* Designed to be embedded in the marketing site in an iframe (`?embed=1`).

**Admin console — `/admin`, `/admin/:show`** (role `admin` or `owner`)
* Book, hold (24h, really enforced), release and re-price stands; record the
  negotiated price and internal notes against each one.
* Merge, split, move and renumber stands when the hall layout changes.
* Upload an event's floorplan SVG and import its stands straight out of the
  artwork — number, size and status are read from the drawing. The upload is
  scored against `docs/floorplan-artwork-spec.html` as a report, never a gate.
* Leads: the enquiry pipeline (new → contacted → won/lost), assignment to a rep,
  and — the valuable part — the visitor's whole browsing history from *before*
  they identified themselves, joined retroactively to the enquiry.
* Sponsorship catalogue and partner logo strip, with CSV import/export.
* Analytics (demand per stand, funnel) and an audit trail of every change.
* Team management (owner only): create admin and sales accounts, reset a
  colleague's password or 2FA, change tiers.

**Sales dashboard — `/sales`** (role `sales`, plus admins and the owner)
* Remaining sponsorship and available stands only — no company names, no
  negotiated prices, no deal notes.
* Build, duplicate and print bespoke client proposals (prices off by default).
  Contents resolve against live inventory at print time, so a proposal never
  quotes a stand that sold this morning. See
  [docs/sales-dashboard.md](docs/sales-dashboard.md).

**Accounts.** Real per-person accounts in three tiers — `owner`, `admin`,
`sales`. Sign-in is password + TOTP (any authenticator app), with one-time
recovery codes issued at enrolment and a one-time invite code for a new
account's first login. The session is a signed HttpOnly cookie, 12 hours;
signing out revokes that session immediately, and changing a password, resetting
2FA or changing a tier revokes every session that account holds.

**Recovery key.** Optional (`RECOVERY_KEY`). When set, the data-destroying
actions require a key that only the owner knows, so a stolen admin session still
cannot erase bookings.

---

## ⚠ Run this as a SINGLE instance. Do not enable autoscaling.

On Render: **one instance, no autoscaling, no second region.** The process keeps
real state in memory and there is no shared adapter or store behind it:

| Per-process state | Where | What a second instance breaks |
|---|---|---|
| Socket.IO rooms (no Redis adapter) | `server/sockets/index.js` | A booking made on instance A never reaches the plans connected to B — stale plans, stale stats, no live updates |
| Per-show booth / tag / area caches | `server/sockets/index.js` | B serves yesterday's stands until something happens to write on B |
| Viewer presence map | `server/sockets/index.js` | Viewer counts only ever reflect one instance |
| Spent 2FA pending-token set | `server/auth.js` | A captured pending token spent on A is replayable on B for five minutes |
| Login rate limits and the per-account delay | `server/routes/auth-routes.js` | N instances = N× the password guesses |
| Recovery-key attempt throttle | `server/auth.js` | Same multiplication of the 5-attempt limit |
| Show registry cache | `server/models/shows.js` | A new or renamed event is invisible to the other instance until restart |
| Buffered analytics | `server/services/tracking.js` | Each instance holds its own unflushed batch |

Making this horizontally scalable means adding `@socket.io/redis-adapter` and
moving those four caches and three limiters into shared storage. Until then, one
instance is not a limitation to work around — it is a correctness requirement.
A single Render instance comfortably serves an exhibition's traffic.

---

## Running locally

Node **22 or newer** and a MongoDB you can reach.

There is no Docker in this project — deliberately. Point `MONGO_URI` at a
MongoDB you already have (a free Atlas cluster is the easy path; a local
`mongod` works too).

```bash
npm install
cp .env.example .env         # then fill it in — see the comments in that file
npm run dev                  # nodemon, restarts on save
npm start                    # or plain node
```

Then open <http://localhost:3000> — `/` redirects to the public plan. The first
boot seeds one owner account from `ADMIN_USER` / `ADMIN_PASS`; log in at
`/login` and enrol an authenticator app. `GET /healthz` returns 200 with the
database up and 503 without it.

### Getting stands into a new event

1. Upload the event's SVG in **Admin → Settings → Floorplans**.
2. **Preview stands** reads the artwork and shows what it found — it writes
   nothing.
3. **Import** replaces that event's inventory from the artwork. It refuses
   outright on an event that has sold or held stands.

`npm run migrate` still exists and seeds stands from `server/data/booth_data.json`;
it predates artwork import and is only for the original Europe data. That file
lives under `server/` deliberately — it carries a list price for every stand,
and while it sat in `public/` express served it to anyone who asked.

### Useful scripts

| Command | Does |
|---|---|
| `npm test` | The full suite below. No database needed. |
| `npm run check` | `check:security` + `check:browser` against a **running local** server. Both refuse to run against an Atlas URI. |
| `npm run validate:artwork <file.svg>` | Scores a floorplan against the artwork spec and names the failed clauses. |
| `node scripts/admin-account.js` | Break-glass account tool: `list`, `create`, `role`, `reset-2fa`, `delete`, `seed-sales`. Needs the database, not a login. |
| `node scripts/preview-stands.js` | Prints what the extractor reads from an SVG. Writes nothing. |

**Migrations are scripts, not boot steps.** Anything that rewrites or deletes
inventory — `scripts/reset-blank-layout.js`, `scripts/seed-north-america.js`,
`scripts/repair-halved-stands.js` — is run by hand and is a dry run until you
pass `--apply`. The server used to run these on boot behind a database flag,
which meant restoring a backup or cloning to staging could wipe live bookings on
the next deploy. It never does anything destructive on its own now.

### Tests

`npm test` runs ten suites and needs **no database**. Several drive your
installed Chrome through the real pages (`playwright-core`, `channel: 'chrome'`)
because SVG layout and `getBBox` are only true in a browser:

* `pages.test.js` — every page renders with its styles applied and scripts running.
* `plans-grid.test.js` — Settings shows every event side by side, each control aimed at its own event.
* `artwork-per-event.test.js` — each event's plan is reachable by its own URL, with no cross-event cache bleed.
* `booth-binding.test.js` / `booth-palette.test.js` — stands bind to the right artwork shapes, in that plan's own palette.
* `artwork-spec.test.js` / `artwork-preserved.test.js` — the spec reports but never gates; name-stripping never damages the stored original.
* `extract-stands.test.js` / `import-stands.test.js` / `seed-artwork.test.js` — extraction is derived from the file, and an import refuses an event that has started selling.

---

## Deploying to Render

* **Build command:** `npm install` · **Start command:** `node server.js`
* **Instances:** 1. No autoscaling (see above).
* **Environment:** everything in `.env.example`. `ADMIN_USER`, `ADMIN_PASS` and
  `SESSION_SECRET` are required — the server refuses to start without them
  whenever it can tell it is handling real data, rather than falling back to
  `admin`/`password`.
* **Health check path:** `/healthz`.
* Render sends `SIGTERM` on every deploy; the server stops reporting healthy,
  closes the sockets, lets in-flight requests finish, flushes analytics and
  closes the database, with a 10-second hard deadline.

### Embedding the plan in the marketing site

```html
<iframe src="https://<your-app>.onrender.com/floorplan?embed=1"></iframe>
```

Set `EMBED_ORIGINS` to the marketing site's origin(s). Only `/floorplan` is
frameable; `/admin`, `/sales` and `/login` are `frame-ancestors 'none'` so the
2FA form and the Release button cannot be clickjacked.
