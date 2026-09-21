# Handover — what this is, how it runs, and what is still open

BluePrint Floorprint: a real-time exhibition floorplan (Node + Express +
Socket.IO + MongoDB) deployed as a single Render web service. `README.md` covers
what the product does and how to run it. This document is the operator's view —
how the parts fit, what the rules are, and where the sharp edges are.

---

## 1. How it is put together

```
server.js                 boot, security headers, compression, health, shutdown
server/config.js          environment → config (and the fail-fast checks)
server/db.js              the Mongo connection and every index
server/auth.js            sessions, roles, the Express and Socket.IO guards
server/routes/            auth-routes (login), public, api (admin), sales
server/sockets/index.js   every real-time event, public and admin
server/models/            one file per collection
server/services/          totp, holds, tracking, notify, seed-artwork
server/lib/               send-page, csv, extract-stands, artwork-spec
public/                   the three front ends: floorplan, admin, sales
scripts/                  operator tools and one-shot migrations
test/                     ten suites, no database needed
```

Requests carry their **event** (show) in async context: `showMiddleware` resolves
it once — `X-Show` header, then a `/floorplan/:show`-style path segment, then the
default — and `config.showId` is a *getter* that reads it. That is how ~120 model
reads are scoped to the right event without being passed a show id. Destructuring
`config.showId` anywhere breaks that, silently, for everything downstream.
Background work (the hold sweep, cache refreshes) must name its show explicitly
with `showContext.runAs`.

## 2. Accounts and access

Three tiers, in `users`:

| Tier | Reaches | Notes |
|---|---|---|
| `owner` | everything, plus team management | The recovery anchor. Cannot be created, deleted or re-roled through the API. `ADMIN_USER` is force-promoted to owner on every boot. |
| `admin` | `/admin`, `/api/*`, all admin socket events | Books, holds, releases, prices, imports artwork. |
| `sales` | `/sales`, `/api/sales/*` only | Remaining inventory and proposals. No company names, no negotiated prices, no deal notes, no socket mutations. |

Sign-in is two steps: password (scrypt, **async** — see §5), then TOTP. A new
account also needs its one-time invite code the first time, so an intercepted
temporary password alone cannot claim it. Eight one-time recovery codes are
issued at enrolment, stored hashed.

The session is a signed HttpOnly cookie (`bp_admin`), 12 hours, carrying the
username, role, the account's `tokenVersion` and a per-session `jti`. Both are
checked on every request:

* **`tokenVersion`** — bumped by a password change, a 2FA reset, a role change or
  deletion. Signs that account out **everywhere**, at once.
* **`jti`** — written to `revokedTokens` by `POST /logout`. Signs out **that one
  browser**, immediately. The rows carry the token's own expiry and a TTL index
  drops them, so the list never outgrows the sessions still theoretically alive.

`scripts/admin-account.js` is the break-glass path: it talks to the database, not
to a login, so a lost 2FA device is recoverable without a session.

## 3. Rate limiting and the failsafe key

* **Login.** A per-IP budget counts **failures only** (a busy office behind one
  NAT address is not rationed), and each account carries a delay that doubles
  with each wrong attempt, capped at five minutes. The credential is **always**
  checked first and a correct one clears the record — a stranger can slow an
  account down but can never lock its owner out, which the old hard lock allowed
  with ten guesses every five minutes.
* **`RECOVERY_KEY`.** Optional, and off unless set. When set, releasing a booked
  stand, forcing one back to Available and changing the €/unit rate require it.
  Five wrong attempts pause that account for fifteen minutes, and every failure
  is written to `activity` as `security.secret_failed`
  (`auth.checkSecretThrottle` / `auth.registerSecretFailure`).
* All of these limiters are **in-process** — see the single-instance rule in the
  README.

## 4. Data model

| Collection | Holds |
|---|---|
| `shows` | The event registry: slug, immutable `showId`, name, active. Everything else is keyed by `showId`. |
| `booths` | Stands: geometry, sqm, list price, status, and `assignment` (company, negotiated price, notes, tags, country). Unique on `(showId, boothNumber)`. |
| `booths_snapshots` | A copy of the stand set taken before anything destructive. |
| `holds` | Live 24h holds. TTL on `expiresAt`, plus a 60s reconciliation sweep that returns the stand to available — a TTL deletion is not an event we can subscribe to reliably. |
| `floorplans` | Per event: the uploaded SVG, the display copy with printed names stripped, version, uploader, spec score. |
| `inquiries` | Public enquiries, the pipeline status, assignment and archive flag. |
| `activity` | Append-only behavioural + audit stream, discriminated by `type`. TTL from `ACTIVITY_RETENTION_DAYS`. |
| `users` | Accounts (see §2). |
| `sponsors`, `partners`, `planAreas`, `tags` | The sponsorship catalogue, the partner strip, the plan's named areas, the business-activity catalogue. |
| `menus`, `counters` | Sales proposals and their per-event reference numbers. |
| `settings` | Per-event runtime settings: rate, unit, currency, palette, plan sponsor. |
| `revokedTokens` | Session ids retired by signing out. TTL. |
| `meta` | Flags left by the one-shot migrations. |
| `accessCodes` | Indexed, unused. The redemption flow was never built. |

**Tracking.** Timestamp, actor and IP are stamped server-side; a client-supplied
actor is not an audit trail. IPs are truncated before storage. Writes are
buffered and flushed in batches. The valuable part is the retroactive identity
join: a visitor browses against an anonymous `sessionId`, and when they send an
enquiry `attributeSession()` stamps their contact id onto everything they did
*before* identifying themselves — so a lead opens with the browsing history that
led to it. Behavioural events are **not sent at all** until the visitor consents.

## 5. Things that will bite you

* **`users.hashPassword` / `verifyPassword` / `absorbPassword` are async.**
  scrypt is ~26ms of CPU and `scryptSync` ran it on the event loop, so forty
  wrong passwords a second stalled every socket. They are promisified now. A
  missing `await` on `verifyPassword` is an **authentication bypass**, not a
  visible failure — a pending promise is truthy.
* **Migrations are scripts, never boot steps.** `scripts/reset-blank-layout.js`,
  `scripts/seed-north-america.js` and `scripts/repair-halved-stands.js` are dry
  runs until `--apply`. They used to run on boot behind a flag in the `meta`
  collection — which is in the same database as the data, so restoring a backup,
  pointing at a fresh cluster or cloning to staging re-armed them and the next
  deploy deleted every booth and hold on the default event.
* **Importing stands deletes that event's inventory** and rebuilds it from the
  artwork. It refuses outright on an event with sold or held stands; `?force=1`
  is a decision, not a retry.
* **The artwork is user-uploaded SVG sanitised by regex.** It is served under its
  own locked-down CSP (`default-src 'none'`) for that reason.
* **One instance only.** Rooms, caches, limiters and the spent-2FA set are all
  per-process with no shared adapter. The README table lists exactly what breaks.
* **Render redeploys send SIGTERM.** Shutdown is graceful now (stop reporting
  healthy → close sockets → drain HTTP → flush analytics → close Mongo, 10s hard
  deadline). Do not add work after `process.exit`.

## 6. Verification

```bash
npm test          # 10 suites, no database; several drive your installed Chrome
npm run check     # security + browser assertions against a RUNNING local server
npm run validate:artwork <file.svg>
```

`check:security` proves anonymous sockets cannot mutate state and that the public
payload carries no commercial fields. `check:browser` drives real Chrome through
the consent gate, stand selection, the shortlist and enquiry submission,
including the XSS assertions. Both **refuse to run against an Atlas URI** — they
seed and mutate data.

`scripts/persistence-check.js` still sends HTTP Basic auth and therefore no
longer works against the current login; fix or delete it before relying on it.

## 7. Still open

* **Access codes.** The collection and its indexes exist; there is no redemption
  flow.
* **Horizontal scaling.** Needs `@socket.io/redis-adapter` and a shared store for
  the caches and limiters (§3, and the README table).
* **`scripts/persistence-check.js`** — stale auth, as above.
* **Stand numbering** is the business key now, but some events were imported
  before artwork extraction existed; check `boothNumber` before trusting a
  cross-event comparison.
* **Confirm the retention period.** `ACTIVITY_RETENTION_DAYS` drives a TTL index
  and must match whatever the privacy policy says. Changing it is safe — the
  server updates the existing index in place rather than refusing to boot, which
  it used to do.
