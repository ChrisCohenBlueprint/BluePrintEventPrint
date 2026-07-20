# Handover — MongoDB migration and security hardening

Branch: `rebuild/mongo-and-hardening`

What changed, what still needs a decision from you, and how to run it.

---

## 1. What was fixed

### Bookings no longer disappear
State lived in memory, mirrored to a gitignored `booth_state.json` on Render's
ephemeral filesystem — wiped on every deploy and every idle spin-down.
Everything now persists to MongoDB. Verified by killing the process mid-session
and confirming bookings, negotiated prices, notes and the audit trail all
survived (`scripts/persistence-check.js`).

### The socket layer is authenticated
The Basic Auth added in `ac9c073` only guarded `/admin*` HTTP routes. Every
mutation travels over Socket.IO, which had no auth at all — `demo:reset` from
any browser console wiped all 272 booths.

Admins now get a signed HttpOnly cookie on Basic Auth success; the socket
handshake verifies it. All privileged handlers are wrapped in `requireAdmin`,
and denied attempts are recorded as `security.denied` events. `demo:reset` is
gone entirely.

### `/api/*` is no longer public
`/api/stats` and `/api/booths` sat outside the auth middleware and served
company names, negotiated prices and internal notes to anyone. Both are behind
auth now, and the public socket payload is a projection that omits commercial
fields — a held stand reads as "reserved" with no holder and no price.

### Enquiry contact details are captured
The public form collected Contact Name and Email and then discarded them —
`booth:book` only ever transmitted `company`. There is now an `inquiries`
collection with server-side validation, honeypot and rate limiting.

### Stored XSS in the admin dashboard is closed
`renderBookingsTable()` interpolated `company` and `notes` — both attacker-controlled
via the public form — into an HTML string. The table is now built with DOM nodes
and event delegation, so there is no interpolation to escape. Verified in a real
browser: an injected `<script>` does not execute and an `<img onerror>` is not
parsed as markup.

### "Hold (24h)" is real
There was no expiry logic anywhere; a hold was permanent. Holds are now
documents with a TTL index, plus a reconciliation sweep that returns the stand
to available.

> **Deviation from the plan:** the plan proposed a change stream to detect TTL
> deletions. A sweep is used instead — change streams need a replica set and
> drop events while the process is down, which would strand a stand on hold
> permanently. The sweep re-derives truth every 60s and self-heals.

### Two bugs found while working
- **Socket handler race.** The connection handler was `async` and awaited before
  binding `socket.on(...)`. A client acting immediately on first state had its
  action silently dropped. Handlers are now bound synchronously.
- **Initial paint race.** `state:full` arrives while the 2.1 MB SVG is still
  downloading, so status classes were never applied and every stand rendered as
  taken. State is re-applied once the plan is in the DOM.

---

## 2. Running it

```bash
npm install
npm run mongo:up        # local MongoDB 7 in Docker, persistent volume
npm run migrate         # seed 272 booths from public/booth_data.json
npm run dev
```

`.env` is gitignored; `.env.example` documents every variable. In production the
server **refuses to boot** without `ADMIN_USER`, `ADMIN_PASS` and
`SESSION_SECRET`, rather than falling back to `admin`/`password`.

### Verification

```bash
npm run check           # security + browser, 28 assertions
```

- `check:security` — proves anonymous sockets cannot mutate state, that the
  public payload carries no commercial fields, and that admin actions still work.
- `check:browser` — drives your installed Chrome through the real pages: consent
  gate, stand selection, multi-select shortlist, enquiry validation and
  submission, and the XSS assertions. Seeds its own data, so order-independent.

`scripts/persistence-check.js write|verify <stand>` tests survival across a restart.

---

## 3. Data model

| Collection | Holds |
|---|---|
| `shows` | One doc per event. Everything is keyed by `showId`, so a second show needs no schema change. |
| `booths` | Geometry, sqm, list price, status, and `assignment` (company, negotiated price, notes). |
| `holds` | Active holds. TTL index on `expiresAt`. |
| `inquiries` | Name, email, phone, company, stands of interest, message. |
| `activity` | Append-only behavioural + audit stream. TTL index drives retention. |
| `accessCodes` | Indexed and ready; the redemption flow is not built yet. |

### Tracking

One `activity` collection discriminated by `type`, covering all four goals you
named. Timestamp, actor and IP are stamped server-side — a client-supplied actor
is not an audit trail. Writes are buffered and flushed in batches.

**The retroactive identity join is the valuable part.** Visitors are tracked
against an anonymous `sessionId`. When someone submits an enquiry,
`attributeSession()` writes their `contactId` onto every event they generated
*before* identifying themselves. Sales opens a lead and sees the whole browsing
history that preceded it.

Endpoints: `/api/analytics/demand`, `/api/analytics/funnel`, `/api/audit`,
`/api/inquiries/:id` (lead plus full history), `/api/booths/:n/activity`.

### Consent

Behavioural events are **not sent** until the visitor accepts. Retention is
enforced by a TTL index rather than policy — `ACTIVITY_RETENTION_DAYS`, default
730. This number must match whatever your privacy policy says.

---

## 4. What I did not do

- **Did not push or deploy.** Work is committed on a branch. Deploying could
  destroy live data — see below.
- **Did not provision Atlas.** Needs your account. Set `MONGO_URI` and the
  migration runs unchanged.
- **Did not build booth-number extraction (plan §07).** Blocked on the source
  file question. `boothNumber` is currently the positional id, but it is already
  the business key, so extraction becomes a data migration rather than a
  refactor.
- **Did not build the access-code flow (plan §06).** Collection and indexes
  exist; redemption does not.

---

## 5. Needed from you

1. **Is there live data on Render to rescue?** No deployed URL is recorded in
   the repo, so I could not check. If an instance is running, pull
   `/api/booths` **before the next deploy** — that endpoint is currently
   unauthenticated on the deployed version, which is the vulnerability, but for
   now also the rescue hatch. `scripts/migrate.js --state <file>` imports a
   legacy `booth_state.json`, including click history.

2. **Atlas connection string**, then `MONGO_URI=… npm run migrate`.

3. **Set the production env vars** — the server will not boot without them.
   `SESSION_SECRET` should be a long random string; changing it invalidates
   open admin sessions.

4. **Set `PUBLIC_ORIGIN`** to your Render URL. CORS was `origin: '*'`, which is
   unsafe now that the socket carries an auth cookie.

5. **Confirm the retention period** and get the consent wording past whoever
   handles your GDPR compliance. I am not a lawyer and this is not legal advice.

6. **Ask the venue for the floorplan with live text** before any work starts on
   §07. I verified the current SVG has zero `<text>` elements and 5,955 distinct
   glyph shapes across 5,970 paths — every contour is unique, so exact vector
   extraction is genuinely unavailable from this asset. The source file would
   remove most of that phase.

---

## 6. Known gaps

- Admin auth is still shared-credential Basic Auth. The `users` collection is in
  the plan but not built, so the audit trail records "admin" rather than a
  person. Worth doing before more than one person uses it.
- Booth numbering is still positional, so the id mismatch from the plan persists
  until §07 lands.
- `booth:consolidate` is still registered but was not reworked for the new
  schema — it needs revisiting before use.
- The funnel endpoint counts distinct sessions per step; steps are not strictly
  nested, so a session can enquire without a recorded click if consent was
  declined mid-session.
