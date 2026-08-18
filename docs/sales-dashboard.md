# Sales dashboard (`/sales`)

A sub-admin tier for the sales team. Reps sign in with the same password + 2FA
flow as an administrator, but their account only unlocks `/sales`: what is still
on the table, and the bespoke client proposals they build from it.

## What a rep can and cannot do

| | Rep (`sales`) | Administrator | Owner |
|---|---|---|---|
| `/sales` dashboard | ✅ | ✅ (preview) | ✅ (preview) |
| See remaining sponsorship **with internal prices** | ✅ | ✅ | ✅ |
| See available stands | ✅ | ✅ | ✅ |
| Build / print client proposals | ✅ (their own) | ✅ (all reps') | ✅ (all reps') |
| Admin console, floorplan, bookings, leads | ❌ | ✅ | ✅ |
| Manage team accounts | ❌ | ❌ | ✅ |

A rep never receives exhibitor company names, negotiated prices or internal deal
notes — the catalogue endpoint projects those away, and `socketAuth` still gates
on the admin roles, so a rep's socket cannot emit `admin:*` events either.

## Creating rep logins

**In the console** — Team → *Add a team member* → choose **Sales**. Picking a
name from the roster dropdown (sourced from `server/data/sales-team.js`)
prefills the username, display name and email. The display name and email sign
that rep's proposals.

**From the CLI** — one login per roster name, in one go:

```bash
node scripts/admin-account.js seed-sales
```

It prints a username, temporary password and one-time invite code per rep. It is
idempotent: existing accounts are skipped, not reset. Other commands:

```bash
node scripts/admin-account.js create <user> <pass> sales   # single rep
node scripts/admin-account.js role <user> admin|sales      # move between tiers
node scripts/admin-account.js list
```

The temporary password and the invite code must be shared **out of band and
separately** — the invite code is what stops an intercepted password alone from
claiming the account. Both are entered on the rep's first sign-in only, before
they set up their authenticator app. Changing an account's role or password
revokes any live session for it immediately (`tokenVersion` is bumped).

## Bespoke menus

A menu is a saved *selection* — sponsorship keys, stand numbers and any free-text
line items — not a snapshot. Contents are resolved against live inventory every
time the proposal is opened, so a package that sold between drafting and printing
is shown struck through and marked "Now sold", excluded from the total, and
flagged to the rep before they send. Proposals carry a per-show reference
(`LEX26-P001`) allocated by an atomic counter.

### Producing the PDF

The rep opens **Save as PDF** on a proposal, which loads the print view and calls
the browser's print dialog; they choose *Save as PDF* as the destination and
email the file. The print page sits behind the same login as the rest of
`/sales` — the client receives the file, never a link, and nothing is published
to a public URL.

**Prices are off by default.** The client-facing document is price-free, matching
the public floorplan, so sales can walk the buyer through cost in conversation.
A rep can tick *Show prices* per proposal when they want the numbers in writing;
the total then covers only items still available.

## Files

| Path | Role |
|---|---|
| `server/routes/sales.js` | Pages + `/api/sales/*`; mounted **before** `adminAuth` so `/api/sales/*` isn't caught by the blanket `/api/*` rule |
| `server/models/menus.js` | Proposal CRUD; ownership is enforced in the query, not after the read |
| `public/sales.{html,js,css}` | The dashboard |
| `public/menu-print.{html,js,css}` | The printable proposal (light theme + `@media print`) |
| `server/auth.js` | `salesAuth`, the role lists, and `SHARED_ASSETS` |

`admin.css` is listed in `SHARED_ASSETS`: the sales page is built on the same
design tokens, and while that stylesheet sat in `ADMIN_PATHS` it was 403'd for
the very reps the page is for, rendering the dashboard unstyled. It carries no
data, so it is gated on being signed in rather than on holding an admin role.
