# lienclock — build notes

## Plan

Milestone: **M2 — Accounts, calendar feed and intake** (2 of 3 in this MVP run; M1 is done and
its plan is kept below under "M1 plan"). Planned with gstack plan-eng-review ("Step 0: Scope
Challenge", "1. Architecture review", "3. Test review"). This was a non-interactive run, so I
answered every question myself and recorded each answer here.

Exit criteria (ROADMAP M2): **the ICS feed validates and contains one VEVENT per deadline; a
forwarded sample PO email yields state and date fields flagged "unconfirmed".**

### Step 0 — Scope challenge

1. **What existing code already solves part of it?**
   - `computeDeadlines(job)` already returns every dated deadline, so the ICS feed is a pure
     serializer over it: one VEVENT per `Deadline`, no new date logic.
   - `parseJobForm` already validates job fields. The intake confirm step reuses it, so a
     proposed job passes the same checks as a typed one.
   - `resendSender` (M1) sends the sign-in emails too: same idempotency and error handling.
   - **[EUREKA]** M1's "Save & email me alerts" form already asks for an email address.
     Saving now *is* signing up: the job is held in the sign-in link and saved when the
     link is clicked. One click verifies the address, creates the account and saves the job.
     That closes M1's open P1 (alerts could be pointed at an unverified third-party address)
     without adding a separate sign-up step.
2. **Minimum change set:**
   - **Auth:** passwordless email sign-in ("magic link"). There are three tables: `accounts`
     (unique email), `login_tokens` (hashed, single use, 30 min) and `sessions` (hashed,
     30 days, HttpOnly cookie). No passwords, so there is no reset flow and no hashing
     parameters to get wrong. **[Layer 1]**: `node:crypto` random tokens + SHA-256, Postgres
     `ON CONFLICT` for find-or-create, an atomic `UPDATE … WHERE used_at IS NULL` for single use.
   - **Multiple jobs per account:** `jobs.account_id`, a `/jobs` dashboard sorted by each
     job's most urgent deadline, and every job read or write scoped by account in SQL.
   - **ICS feed:** `/calendar/<feed-token>.ics`, one secret URL per account (calendar apps
     can't send cookies; this is the same model as Google Calendar's "secret address"), with a
     reset button.
   - **Email-forward intake:** a deterministic parser (`proposeJobFromEmail`) that proposes
     state, GC and first-furnish date. Each value is flagged `unconfirmed` and carries the line
     it came from. The pipeline is Resend Inbound → a Svix-signed webhook → fetch the body →
     a stored proposal → a review page where the user confirms or edits, and that creates the
     job. A "paste the email" box feeds the same parser, so intake works locally and before
     Resend Inbound is set up.
   - **Deliberately NOT in M2:** passwords, OAuth and 2FA; teams and shared accounts;
     changing the account email; an account-deletion page (M3, with the legal pages);
     LLM extraction (deterministic parsing is free, testable and has no prompt-injection
     surface); PDF/attachment parsing; a project-name field; VALARM reminders inside the
     ICS; editing the GC or first-furnish date of a saved job; per-IP rate limiting.
     Stripe, the 10 new states and the rules changelog are M3.
3. **Complexity check:** 24 files are touched (20 under `src/`, plus config). That's 4 new
   framework-free modules (`auth`, `ics`, `intake`, `inbound`), 6 new thin Next.js files
   (session helper, sign-in page, dashboard, intake review page, feed route, webhook route) and
   edits to existing ones. There
   are no classes and no new services: Resend Inbound is a feature of the Resend account M1
   already requested. **The smell triggers.** I proceeded anyway, because each roadmap
   deliverable (auth, multi-job, ICS, intake) maps to one lib module plus one thin route or
   page, and none can be dropped without failing an exit criterion or leaving a feature with
   no UI. Cuts I made: sign-in and "finish sign-in" share one page, all server actions stay
   in the one `actions.ts`, there's no `SESSION_SECRET` (random tokens stored hashed need no
   signing key), and no new npm dependencies.
4. **Search check** (WebSearch; page fetches are blocked in this sandbox):
   - Inbound email with no domain on a free tier: **Resend Inbound** gives a catch-all
     `<anything>@<id>.resend.app` address on the free plan (received mail counts toward the
     100/day quota). Its `email.received` webhook carries **metadata only**, so the body must be
     fetched with `GET /emails/receiving/:id`, which needs a full-access API key. Webhooks are
     Svix-signed (HMAC-SHA256 over `id.timestamp.body`, `whsec_` base64 key, several `v1,`
     signatures possible, 5-minute window). I verify them with `node:crypto` against the raw
     body. Postmark's free plan was the alternative; sources disagree on whether it includes
     inbound, and it would be a second service.
   - Auth.js has an email provider **[Layer 2]**. I didn't use it: npm installs aren't
     available here, it needs an adapter and its own tables anyway, and the built-in version is
     about 150 lines.
   - Known footguns, from in-distribution knowledge: (a) email link scanners (Outlook Safe
     Links etc.) pre-fetch GET links and would burn single-use tokens, so the link opens a
     page with a "Sign in" button and only the POST (a server action) consumes the token;
     (b) a "reset link" URL built from the request's Host header can be poisoned, so links
     use the configured `APP_URL` / Vercel production URL; (c) `next` redirect parameters are
     open redirects unless restricted to same-site paths; (d) catching Next's `redirect()`
     inside try/catch swallows it.
   - ICS: RFC 5545 needs CRLF line endings, folding at 75 octets (UTF-8-safe), TEXT escaping
     of `\ ; , newline`, and `UID` + `DTSTAMP` + `DTSTART` on every VEVENT. All-day deadlines
     use `VALUE=DATE` with an exclusive `DTEND`, so time zones never shift a date.
5. **TODOS cross-reference:** there is no TODOS.md. From M1's "What's left", the open P1
   (alerts to unverified emails, no rate limit on saving) is fixed here. Saving needs a
   verified account, and sign-in emails are rate-limited.
6. **Completeness:** full edge handling where it's cheap: expired and replayed links,
   double clicks, stale sessions, cross-account access (IDOR) on every route and action,
   webhook replays (deduplicated by Resend email id), oversized bodies, unknown recipient
   addresses, unsupported states in an email, HTML-only emails, multi-byte ICS folding.
7. **Distribution:** no new artifact. It's the same Vercel app.

### 1 — Architecture

```
 sign-in / "Save & email me alerts" (server action)
    └─▶ startSignIn: rate limit (3 per address per 30 min, 60 per hour overall)
          → login_tokens(sha256(token), email, next, pending_job) → Resend email with /signin?token=…
 /signin?token=… (GET: peekSignIn → "Sign in as <address>" + button) ──POST──▶ finishSignIn
    → UPDATE login_tokens SET used_at … WHERE used_at IS NULL AND expires_at > now   (single use)
    → accounts INSERT … ON CONFLICT (email) → save pending job (account-owned)
    → sessions(sha256(token), 30 days) → cookie lc_session (HttpOnly, SameSite=Lax, Secure)

 /jobs, /jobs/<id>, /intake/<id>, every action ─▶ requireAccount() ─▶ SQL "… AND account_id = $n"

 calendar app ──GET /calendar/<feed token>.ics──▶ accounts.feed_token → account's jobs
    → computeDeadlines (today in each job's state) → buildCalendar → text/calendar (1 VEVENT/deadline)

 user forwards a PO ─▶ po-<intake token>@<id>.resend.app ─▶ Resend Inbound
    ──POST /api/intake/email (Svix-signed metadata)──▶ verify signature + 5 min window
    → account by recipient token (unknown → 200, ignored) → skip if this email id is stored
    → GET api.resend.com/emails/receiving/<id> → proposeJobFromEmail → intake_proposals (pending)
 /jobs "paste an email" ───────────────────────────▶ proposeJobFromEmail → intake_proposals
 /intake/<id>: each field "Unconfirmed" + its source line → user edits/confirms
    → parseJobForm → claim (pending → accepted, atomic) → createJob → /jobs/<job id>
```

- **Boundaries:** as in M1, `src/lib` is framework-free and tested directly. `src/app` holds
  thin pages and actions. `src/app/session.ts` is the only place that touches cookies.
- **Data:** new tables `accounts(id, email UNIQUE, feed_token UNIQUE, intake_token UNIQUE)`,
  `login_tokens`, `sessions` and `intake_proposals(account_id, source, external_id,
  fields jsonb, status pending|accepted|discarded, job_id, UNIQUE(account_id, external_id))`.
  `jobs` gains a nullable `account_id`: it is NULL only for M1-era rows, the app no longer
  creates account-less jobs, and nothing was deployed in M1. The cron is unchanged.
  An account job's `alert_email` is the verified account email.
- **Security:** tokens are 256-bit random values and only their SHA-256 hashes are stored.
  Sessions use an HttpOnly + SameSite=Lax cookie, Secure in production. Server actions keep
  Next's built-in Origin check (CSRF). `next` is restricted to same-site paths. Ownership
  lives in each query's `WHERE` clause, never in a separate check. The feed and intake
  tokens are per-account capabilities that can be rotated (feed) and are separate, so a leaked
  calendar link can't be used to spam intake. The webhook fails closed without
  `RESEND_WEBHOOK_SECRET`. Values parsed from email are only proposals; they pass
  `parseJobForm` when confirmed and are escaped by React.
- **Failure scenarios accounted for:**
  - A link scanner opens the sign-in link → only a page renders, and the token survives.
  - The user clicks an old or used link → "expired" message and a form to get a new one.
  - Someone floods sign-ins for a victim → at most 3 emails per 30 min, and the global hourly
    cap protects the 100/day Resend quota that alerts depend on.
  - Resend retries a webhook delivery → deduplicated on (account, email id), so one proposal.
  - Resend's body fetch fails → 500, so Resend retries later and nothing half-stored remains.
  - Mail arrives at an unknown or rotated address → 200 and dropped, so there's no retry
    storm and nothing leaks.
  - A double click on "Confirm" → the atomic claim lets exactly one job through.
  - Creating the job fails after the claim → the claim is reverted to pending.
  - One bad job row → skipped in the feed, the same as in the alert cron.
  - Email isn't configured on Vercel → sign-in fails loudly. Locally, the sign-in link is
    printed to the dev server console instead.
- **Scaling:** the feed computes deadlines for one account per request (tens of jobs),
  cached privately for 5 minutes.

### 3 — Test plan (vitest, `npm test`)

| Exit criterion | Test |
|---|---|
| ICS feed validates | `test/m2-exit-criteria.test.ts` M2-EC1: the feed response passes an independent RFC 5545 checker (`test/helpers/icsValidator.ts`: CRLF, 75-octet folding, nesting, required and single-valued properties, DATE values, TEXT escaping, unique UIDs). The checker is itself tested against broken calendars. |
| …one VEVENT per deadline | M2-EC1: an account with CA, TX (month-by-month) and WA jobs. VEVENT count = Σ `computeDeadlines`, UIDs map 1:1 to (job, deadline key), and each DTSTART equals its deadline date. Another account's job is absent. |
| Forwarded sample PO → state and date flagged "unconfirmed" | M2-EC2: `test/fixtures/forwarded-po.txt` (Gmail-style forward, vendor address in NV, job site in AZ). `state` = AZ and `firstFurnishDate` = 2026-03-02, both `status: 'unconfirmed'` with their source lines. End to end: a signed webhook plus a stubbed Resend fetch stores a pending proposal with those flags and creates no job until it is confirmed. |

Plus every other codepath:
- **auth:** email normalization, `next` sanitizing, hashed storage, single use, expiry,
  rate limits, find-or-create, pending-job save, session expiry and sign-out, feed rotation,
  sign-in email delivery (Resend shape, dev console fallback, fails on Vercel without a key).
- **jobs:** account scoping of get/list/delete/update/mark-done (another account → null or
  refused), and the dashboard summary sort.
- **ics:** escaping, UTF-8 folding, the DTEND year rollover, status labels, an empty calendar,
  the feed handler's 404s and headers, and old tokens failing after rotation.
- **intake parser:** Gmail, Outlook and Apple forward headers; ISO, US numeric, month-name and
  day-month dates; ship-to over bill-to/vendor; side-by-side columns; HTML-only bodies;
  unsupported states; nothing found; no confusing "Subcontractor:" with the GC; control
  characters.
- **webhook:** not configured (500), bad, stale or missing signature (401), other event types,
  unknown address, duplicate delivery, fetch failure, oversized body, pending-proposal cap.
- **proposals:** confirm (job created, linked, double confirm refused), invalid fields,
  discard, cross-account access.
- **pages and actions** (rendered and called like Next does, with `next/headers` cookies
  backed by an in-memory jar in `test/setup.ts`): signed-in vs signed-out calculator,
  sign-in states, dashboard redirect and contents, job page 404 for another account,
  intake review "Unconfirmed" badges, saving signed-out (sign-in email with the pending job)
  vs signed-in (job saved), finishing sign-in sets the cookie, sign-out, and ownership checks
  on mark-done, update and delete.

## What the product does now (end of M2)

- **Calculator** (`/`, unchanged from M1): pick a state (CA, TX, FL, WA, AZ, NV), enter the
  GC/owner, the first furnishing date and optionally the last. You get every
  preliminary-notice and lien deadline, most urgent first, each with its status, days left,
  what to do, the statute citation and its last-verified date. It works without an account
  or a database.
- **Accounts (passwordless):** "Save & email me alerts" with an email address sends a
  confirmation link. Opening the link shows a page saying which address it signs in as and
  which job it will save; one click on it creates the account, saves the job and signs you in
  for 30 days. Links work once and expire after 30 minutes, at most 3 are sent per address
  per 30 minutes and 60 per hour overall. Signed-in users save straight to their account,
  and alerts always go to the verified account address. `/signin` also works on its own.
- **Your jobs** (`/jobs`): every job in the account, sorted by its most urgent deadline
  (next deadline, days left, status, count of open deadlines). It also shows emails waiting
  for review, the calendar feed, and intake. Job pages (`/jobs/<id>`) are visible only to
  their owner; anyone else gets a 404. They work as in M1: mark a notice served or a lien
  recorded, update the last-furnishing date, delete the job.
- **Calendar feed:** `/calendar/<secret>.ics`, with a `webcal://` subscribe link on the
  dashboard. It holds one all-day event per deadline of every job, titled
  `[At risk] CA Preliminary 20-day notice — Acme Builders`. The description carries the
  note, the statute link, the last-verified date and the disclaimer. "Reset calendar
  address" invalidates the old URL.
- **Email intake:** forward a PO or contract email to your personal address
  `po-<token>@<receiving domain>` (Resend Inbound, once provisioned), or paste its text on
  the dashboard. LienClock proposes the **state** (from the job-site/ship-to address, never
  billing, vendor or sender addresses), the **GC** and the **first-furnish date** (a
  start, mobilization or delivery date, never the PO or sent date). Every proposed value is
  flagged **Unconfirmed** next to the line it came from. Nothing is saved until you check
  and confirm it on `/intake/<id>`, which creates the job. You can also discard it.
- **Alerts and rules:** unchanged from M1. The daily cron emails 14/7/2/0 days before each
  open deadline, and `rules/rules.json` holds 11 rules for 6 states.

## Run locally

```bash
npm install            # works with npm_config_ignore_scripts; no new dependencies in M2
npm test               # 367 vitest tests in 18 files, ~20–60 s (embedded Postgres boots per DB test file)
npm run typecheck
npm run dev            # http://localhost:3000, no env vars needed
npm run build && npm start
```

- Without `DATABASE_URL`, data lives in an embedded PGlite database in `.data/pglite`
  (gitignored).
- **Signing in locally:** without `RESEND_API_KEY`, the sign-in link is printed to the dev
  server console (`[dev] … sign-in link for you@…: http://localhost:3000/signin?token=…`).
  Open it to sign in. On Vercel, sign-in refuses to run without the key and never logs
  links.
- **Intake locally:** use the "paste an email" box on `/jobs`. `test/fixtures/forwarded-po.txt`
  is a sample forwarded PO. To try the webhook, configure `RESEND_WEBHOOK_SECRET`,
  `RESEND_API_KEY` and `INTAKE_EMAIL_DOMAIN` (see `.env.example`) and point a Resend webhook
  at a tunnel.
- Use `npm run dev` for clicking around: `npm start` runs in production mode, so the session
  cookie is `Secure`, and Safari won't keep it on `http://localhost`.
- The alert cron works as in M1: `GET /api/cron/alerts` with `Authorization: Bearer $CRON_SECRET`.

### Screenshots (`npm run screenshots`)

```bash
CHROMIUM_PATH=/path/to/chromium npm run screenshots   # ~40 s, writes docs/screenshots/*.png
```

`scripts/screenshots.mjs` runs `next build`, starts `next start` on a free 127.0.0.1 port and
waits for it to answer. It then drives Chromium through `playwright-core`, which never
downloads a browser. Each view is captured at 1280×800 and on an iPhone 13 (viewport only):

- `home-*`: a sample Texas job typed into the calculator.
- `deadlines-*`: the deadlines it triggers.
- `jobs-*`: the dashboard. To get there, the script saves the Texas job with an email, which
  is the real sign-up path. It reads the sign-in link from the server output, signs in, saves
  five more jobs (AZ, CA, WA, FL, NV) and records the NV notice as served.

It is not part of `npm test`.

- **Isolated from real infrastructure:** the app gets only PATH/HOME/locale variables. Every
  service variable (`DATABASE_URL`, `RESEND_API_KEY`, …) is set to an empty string, which also
  overrides any `.env` file. Data goes to a throwaway PGlite directory under `.data/`, which
  is deleted afterwards, and no email can be sent.
- **No secrets in output:** the server log is kept in memory, and the script shows it, with
  `token=` values blanked, only when something fails. The calendar feed address, which carries
  a token, is masked in the dashboard shots.
- **Sample data only:** made-up GC names and `office@example.com`. Dates are relative to the
  day of the run, so the statuses (at risk, missed, protected) stay realistic.
- In the sandbox's Chromium the text renders in a monospace fallback because no sans-serif
  font is installed. The stylesheet asks for `system-ui, sans-serif`, so real browsers show a
  sans-serif face.

## Deploy on a free tier

1. The pipeline runs `.provision` through the credential broker: the Neon Postgres
   (`DATABASE_URL`), the Vercel project `lienclock`, `CRON_SECRET`, a **full-access**
   `RESEND_API_KEY`, and the Resend Inbound webhook (`RESEND_WEBHOOK_SECRET`,
   `INTAKE_EMAIL_DOMAIN`).
2. Deploy to Vercel Hobby (git integration or `vercel deploy --prod`). The schema, including
   M2's new tables and the `jobs.account_id` column, is created or extended automatically on
   first request, under an advisory lock.
3. In Resend (free plan), enable Receiving and add a webhook for `email.received` to
   `https://<production host>/api/intake/email`. Its signing secret is
   `RESEND_WEBHOOK_SECRET`, and the `<id>.resend.app` receiving domain is
   `INTAKE_EMAIL_DOMAIN`. Until this is set up, the dashboard offers only the paste box, and
   the webhook answers 500 (fails closed).
4. **Before real users:** Resend's shared sender only delivers to the Resend account
   owner's address. Sign-in links and alerts reach other people only once a sending domain is
   verified and `ALERT_FROM_EMAIL` is set (see "What's left").

All services are free tiers: Vercel Hobby, Neon free, Resend free (100 emails/day, 3,000 a
month, with received mail counting toward the quota).

## Exit criteria

| # | Exit criterion (ROADMAP M2) | Status |
|---|---|---|
| 1 | ICS feed validates and contains one VEVENT per deadline | ✅ pass: `test/m2-exit-criteria.test.ts` M2-EC1 (independent RFC 5545 checker, itself tested in `test/icsValidator.test.ts`; 6 deadlines over CA/TX/WA jobs → 6 VEVENTs with matching UIDs and dates; another account's job absent) |
| 2 | A forwarded sample PO email yields state and date fields flagged "unconfirmed" | ✅ pass: M2-EC2 (`state` AZ and `firstFurnishDate` 2026-03-02, `status: 'unconfirmed'`, with source lines), plus end to end through a signed webhook: proposal stored, no job until confirmed |

M2 deliverables: auth ✅, multiple jobs per account ✅, ICS feed ✅, email-forward intake ✅.
Intake runs end to end in tests. In production it needs the Resend Inbound line in
`.provision`; until then, the paste box works.

| # | Exit criterion (ROADMAP M1, still passing) | Status |
|---|---|---|
| 1 | CA job, first furnish 2026-03-01 → preliminary notice deadline 2026-03-21 | ✅ pass (EC1) |
| 2 | CA notice served 2026-04-10 (day 40) → protection only from 2026-03-21 onward | ✅ pass (EC2) |
| 3 | TX job, last furnish 2026-02-10 → lien filing deadline 2026-06-15 | ✅ pass (EC3) |
| 4 | WA job, last furnish 2026-01-10 → lien recording deadline 2026-04-10 | ✅ pass (EC4) |
| 5 | A job 7 days before a deadline enqueues exactly one 7-day alert, none duplicated on rerun | ✅ pass (EC5) |
| 6 | Every returned deadline includes a non-empty citation URL and last-verified date | ✅ pass (EC6) |

`npm test` passes: **367 tests in 18 files** (all 195 M1 tests unchanged and passing).
`npm run typecheck` and `npm run build` are clean.

## Infrastructure

Requested in `.provision`. No secret values appear anywhere in the repo; code reads them from env.

| Line | Gives | Used by |
|---|---|---|
| `neon db lienclock` | `DATABASE_URL` (Neon Postgres, free) | `src/lib/db.ts` |
| `vercel project lienclock` | Vercel Hobby project with the stored values as env | deploy + cron |
| `request "CRON_SECRET …"` (M1) | random bearer secret for the cron route | `src/lib/cron.ts` (fails closed) |
| `request "Resend API key …"` (M1) | `RESEND_API_KEY` (free tier) | alert emails |
| `request "Full-access Resend API key …"` (M2) | the same `RESEND_API_KEY`, with full access | sign-in emails (`src/lib/auth.ts`) and reading received mail (`src/lib/inbound.ts`) |
| `request "Resend Inbound webhook …"` (M2) | `RESEND_WEBHOOK_SECRET` (secret) and `INTAKE_EMAIL_DOMAIN` (not secret) | `/api/intake/email` (fails closed) and the dashboard's forwarding address |

No new service: Resend Inbound is part of the Resend account M1 already requested. There's
no session-signing secret either, because session and link tokens are random and stored
hashed. Optional, not secret: `ALERT_FROM_EMAIL`, `APP_URL`.

## Decisions made without asking (non-interactive run)

M2:
- **Auth = emailed one-time links, no passwords or OAuth.** It's the smallest secure option.
  There's nothing to reset or leak, and it reuses Resend. OAuth would need provider
  credentials, and passwords would need a reset flow that sends email anyway.
- **Saving is signing up** (double opt-in). The job waits inside the link and is saved when
  the address is confirmed. This replaces M1's "save with any email".
- **Lifetimes:** links last 30 minutes and are single use; sessions last 30 days (no
  sliding renewal). The rate limits are 3 links per address per 30 minutes and 60 per hour
  overall. The global cap is there to protect the 100/day Resend quota that deadline alerts
  depend on.
- **The link page only shows a button.** Mail scanners that open links can't sign anyone
  in or burn the token, and the page names the address, so a link someone else sends
  can't silently sign you in to their account.
- **Inbound provider: Resend Inbound** (free, no domain needed, same account). Each account
  gets its own address, `po-<32 hex>@<domain>`. It's hex because some mail systems lowercase
  recipients. It is separate from the feed token, so a leaked calendar link can't be used to
  spam intake. Unknown recipients are accepted and dropped.
- **No LLM for intake.** A deterministic parser is free, fast, testable and has no
  prompt-injection surface. It proposes only state, GC and first-furnish date. It never
  proposes a last-furnish date: a PO's completion date is a plan, not the day you last
  furnished. It is conservative: it only uses dates with a start, mobilization or delivery
  label (or "start on <date>"), and it never reads the state from billing, vendor or sender
  addresses. An uncovered state (e.g. OR) is shown with a warning rather than guessed.
- **"Unconfirmed" is literal:** every proposed field carries `status: 'unconfirmed'` and
  its source line. Confirmation runs the same `parseJobForm` as typing the job in.
- **ICS:** one secret URL per account, all-day `VALUE=DATE` events, one per deadline
  including done and missed ones (the status is in the title). It sends
  `REFRESH-INTERVAL`/`X-PUBLISHED-TTL` hints of 12 h and a 5-minute private cache.
- **M1-era jobs without an account** are still alerted by the cron (M1's EC5 relies on it)
  but can't be reached in the UI. Nothing was deployed in M1, so none exist in production.
- **No new npm dependencies** (installs aren't available here). The Svix signature check,
  ICS writer and HTML-to-text use built-ins.

Screenshot pass (after M2):
- **`playwright-core` is the only new devDependency**, used only by `npm run screenshots`.
- **Layout fixes, made only where a screenshot showed the page broken:**
  - Desktop deadline tables broke due dates at their hyphens (`2026-11-` / `15`) and split
    the "At risk" pill over two lines. Dates and pills no longer wrap.
  - On phones, tables turned into a stack of cells with a divider under each one and no
    column names, so a bare `2026-10-07` meant nothing. Each row is now one card, and the
    cells that need it carry a `data-label` ("Due", "Statute", "Done on", "First furnished",
    "Next deadline"), shown before the value under 640 px.
  - Also on phones, "Sign out" and "Your jobs" wrapped onto two lines. The tagline now moves
    under the brand, and the sign-out form no longer shrinks.

M1 (unchanged):
- **Statute research:** checked against official-domain statute text quoted in search results
  (leginfo.legislature.ca.gov, capitol.texas.gov, flsenate.gov, app.leg.wa.gov, azleg.gov,
  leg.state.nv.us). Page fetches were blocked in the sandbox, so `lastVerified: 2026-10-25`
  means "checked against quoted official text", and `rules.json` says so in `verification`.
  **A full read of each page and an attorney review are required before charging (M3).**
- **WA:** there is no preliminary-notice rule. RCW 60.04.031(2)(c) exempts subs who contract
  with the prime.
- **NV:** a 31-day look-back, modelled like CA/AZ: on time means full protection, later
  means partial.
- **TX:** the lien deadline counts from the claimant's last month of furnishing (§ 53.052).
  Retainage deadlines are not tracked.
- **Lien windows that the statute counts from completion** (CA, AZ, NV) are counted from the
  last furnishing date. That date is never later than completion; a recorded notice of
  completion can shorten the window, and each rule note warns about it.
- **Weekends/holidays:** never extended. The shown date is always the earlier, safe one.
- **Status vocabulary:** protected / partial / at risk / missed.
- **Alerts:** thresholds 14/7/2/0. After missed cron days, only the most urgent one is sent.

## What's left

- **M3** (next in this run): Stripe at $29/mo, legal pages (terms, privacy, the
  not-legal-advice disclaimer), account deletion and data export, 10 more states, and a rules
  changelog with emails to affected users.
- **Launch blockers outside the code:** a verified Resend sending domain. Until then,
  sign-in links and alerts only reach the Resend account owner. Provisioning Resend Inbound
  (requested). Attorney review of the rules.
- **Intake:** PDF attachments (many POs arrive as PDFs; only the email body is read today),
  an optional LLM fallback (e.g. a free Gemini tier via `gcp key`) behind the same
  "unconfirmed" flags, and a project-name field to tell jobs with the same GC apart.
- **Auth hardening:** per-IP rate limits, the `__Host-` cookie prefix, a session list with
  "sign out everywhere", and changing the account email.
- **Rules:** notice-of-completion dates (CA/AZ/NV); TX retainage and specially fabricated
  materials; FL contract-termination variant; supplier role; residential/public/bond
  rules; enforcement-suit deadlines.
- **Ops:** pagination of the cron's job scan past roughly 10k jobs; batching alert inserts.

## Review

Self-review of everything M2 added or changed. `git status` shows the whole project as
untracked, because M1 wasn't committed either, so `git diff` is empty; I read every M2 file
instead. I checked it against gstack's checklist (Pass 1 CRITICAL, Pass 2 INFORMATIONAL)
and applied the Fix-First heuristic. This was a non-interactive run, so I made the "ASK"
calls myself and recorded them.

**Fixed**
- [P1] (confidence: 8/10) `src/app/signin/page.tsx`, login CSRF. A sign-in link that someone
  else requested for their own address signed the victim in to *their* account with no hint,
  so the victim's jobs would land where the sender can see them. The page now looks the link
  up without using it (`peekSignIn`) and says "Sign in as <address> and save your <state>
  job for <GC>". A used or expired link shows "expired" before any click. Tests added in
  `test/auth.test.ts` and `test/app.test.tsx`.
- [P2] (confidence: 9/10) `src/lib/intake.ts`, quadratic-time paths on hostile email text.
  Anyone who can reach an intake address (or a strange email a user forwards) could stall a
  webhook. There were five paths:
  - each empty label scanned every cell;
  - each "start on" match copied the rest of the cell;
  - unbounded cells per line made column matching O(n²);
  - `<[^>]*>` backtracked on runs of `<`;
  - the email-stripping regex backtracked on long tokens.

  Fixes: an O(1) `below` link, an 80-character date window, a cap of 20 cells per line,
  `[^<>]`, and an input cap before name cleaning. Six hostile-input tests enforce a 2 s
  budget; all six run in under 200 ms.
- [P2] (confidence: 9/10) `src/lib/auth.ts` and `src/lib/inbound.ts`. Untyped parameters in
  `INSERT … SELECT $n` are typed as text by Postgres, which uuid and timestamptz columns
  reject. I added explicit casts; this was caught while writing, before the first run.
- [P3] A stale `next.config.ts` comment (job links are no longer the secret; sign-in and feed
  URLs are). The dashboard's one-entry flash map is inlined. The calculator's `deleted` flash
  is removed (deleting now returns to `/jobs`). Invisible NBSP/U+2028/U+2029 characters in a
  regex are replaced with escapes.
- From the M1 review: the open **[P1] "alerts to any unverified email, no rate limit on
  saving"** is fixed. Saving requires a verified account, alerts go only to that address, and
  sign-in emails are rate-limited.

**Checked, no issue**
- **SQL:** every value is a parameter. The only interpolations are constant column lists and
  numbered placeholders. Account scoping uses one static `($n::uuid IS NULL OR account_id =
  $n::uuid)` in the `WHERE` of each read and write, so ownership is never a separate check.
- **Races / TOCTOU:**
  - single-use links: an atomic `UPDATE … WHERE used_at IS NULL`, tested with two
    simultaneous clicks;
  - accounts: a UNIQUE email + `ON CONFLICT`, tested concurrently;
  - proposal confirm: an atomic pending→accepted claim, tested with two simultaneous
    confirms; it is reverted if job creation fails;
  - webhook retries: a fast-path SELECT, then UNIQUE `(account_id, external_id)` +
    `ON CONFLICT DO NOTHING` for the race.
- **XSS:** email-derived text (subject, sender, source lines, proposed values) reaches the
  page only through React. The sign-in token is reflected only when it matches the strict
  token format. ICS TEXT values are escaped (`\ ; , newline`) and folded.
- **Untrusted email input (the LLM-trust-boundary item, applied to email):** lengths are
  capped (source 160, subject 300, sender 254, name 120), values are stored only as
  proposals and validated by `parseJobForm` on confirm, and `cleanFields` re-validates the
  stored JSON shape. The Resend fetch goes to a fixed host with a validated id, so there's no
  SSRF.
- **Enum completeness:**
  - Proposal statuses are handled by every consumer. The review page shows the form when
    pending, redirects to the job when accepted, and 404s when discarded. The dashboard lists
    pending only, and a CHECK constraint enforces the values.
  - Proposal sources (email/paste) are handled on the review page and the dashboard.
  - Every sign-in and dashboard error code has a message.
  - All four deadline statuses appear in ICS titles and dashboard badges.
  - All three intake fields get a flag on the review page.
- **Secrets:** none in the repo. Test secrets are built at runtime. The API key never appears
  in responses or errors (tested). The webhook fails closed without its secret, Svix
  signatures are compared in constant time with a 5-minute window, and dev link logging is
  off on Vercel.
- **Time windows:** ICS and dashboard statuses use "today" in each job's state time zone.
  Rate-limit, link and session expiry use one injected clock, and their boundaries are tested.
- **Shell injection / async mixing:** not applicable (no subprocesses, no Python).

**Left open (recorded, not fixed in M2)**
- [P2] (confidence: 8/10) Delivery to real users. Resend's free shared sender delivers only to
  the account owner, so sign-in links for anyone else won't arrive until a domain is verified.
  This is a launch blocker, but outside the code; it's tracked under "What's left".
- [P2] (confidence: 6/10) Medium confidence, verify. There is no per-IP rate limit. Someone
  requesting links for many addresses can use up the 60-per-hour cap and block sign-ins for an
  hour, but they can't eat into the alert quota beyond that. Add per-IP limits
  (`x-forwarded-for` on Vercel) if it's abused.
- [P2] (confidence: 6/10) Medium confidence, verify. The rate-limit and 50-pending-proposal
  caps are a single `INSERT … SELECT … WHERE count < n` statement each, so concurrent requests
  can overshoot by the number in flight. The overshoot is bounded; an advisory lock would make
  it exact.
- [P3] Tokens in URLs: sign-in tokens (query string) and feed tokens (path) appear in Vercel
  request logs. Sign-in tokens are single-use and expire in 30 minutes; the feed token can be
  reset.
- [P3] The webhook reads a chunked body (one without Content-Length) in full before checking
  its size. Vercel's 4.5 MB function body limit bounds this.
- [P3] Calendar status labels are as of the fetch. Google Calendar refreshes subscriptions on
  its own schedule (hours), so "[At risk]" can lag "[Missed]" by up to a day. The dates
  themselves don't change.
- [P3] No browser click-through: the sandbox doesn't allow starting a server. `next build`
  passes, and every page and server action is rendered or called in `test/app.test.tsx` with
  real SQL and the session cookie.

## M1 plan (done)

Milestone: **M1 — Deadline calculator and job list** (1 of 3 in this MVP run).

### Step 0 — Scope challenge

1. **Existing code?** None. The repo held only the PRD/roadmap/research, so everything is new.
   Built-ins I use instead of custom code: Postgres `UNIQUE` + `ON CONFLICT DO NOTHING` for alert
   de-duplication, `FOR UPDATE SKIP LOCKED` for claiming alerts to send, Vercel Cron +
   `CRON_SECRET` for scheduling, Next.js server actions (built-in Origin/CSRF check) for forms,
   `Intl.DateTimeFormat` for the "today" in each state's time zone, and Resend's `Idempotency-Key`
   header for safe retries. **[Layer 1]** throughout. No date library: deadlines are whole
   calendar days, so UTC-midnight arithmetic on `YYYY-MM-DD` strings is enough.
2. **Minimum change set that meets the exit criteria:**
   - `rules/rules.json`: versioned rules for CA, TX, FL, WA, AZ, NV (private commercial
     project, first-tier subcontractor). Each rule has a citation, official URL and last-verified date.
   - `computeDeadlines(job)`: a pure function that returns dated deadlines with status
     (`protected` / `partial` / `at_risk` / `missed`), sorted by urgency.
   - A minimal web form. `/` is a GET calculator with no database: fill in the job and the
     deadlines appear below. The same form has a "Save & email me alerts" button that stores
     the job and redirects to `/jobs/<uuid>`. That page lists the deadlines, lets you mark a
     notice or lien as done on a date, update the last-furnishing date, or delete the job.
   - Alert scheduler: a daily cron finds deadlines 14/7/2/0 days out, enqueues one alert per
     (job, deadline, deadline date, threshold) and sends pending alerts through Resend if a key
     is configured.
   - **Deliberately NOT in M1:** accounts/auth, multiple jobs per account, the ICS feed and
     email-forward intake (all M2); Stripe, more states and the rule changelog (M3); the
     supplier role, residential/public/bond rules, notice-of-completion dates (CA/AZ/NV
     shorten the lien window when one is recorded; the UI warns instead), weekend/holiday
     roll-forward (we never extend a date: you act by the date shown, which is always
     conservative), enforcement-suit deadlines, sending or filing notices.
3. **Complexity check:** 16 files under `src/`: 8 framework-free modules in `src/lib`, and
   8 Next.js files (layout, two pages, actions, two components, the cron route, CSS). No
   classes. 2 external services (Postgres via Neon, Resend email). That trips the 8-file
   smell. I did not cut further: every lib module maps to one M1 deliverable, the app files
   are thin, and the only candidate cut (persisting jobs) would leave the alert scheduler with
   nothing to schedule.
   Without `DATABASE_URL`, local dev falls back to an embedded PGlite (WASM Postgres), so
   there is one SQL dialect and no mock store.
4. **Search check** (WebSearch used): Vercel Hobby cron runs at most once a day with ±59 min
   precision and sends `Authorization: Bearer $CRON_SECRET`, so the route fails closed when
   the secret is unset. Resend's free tier allows 100 emails/day, and without a verified domain
   it only delivers to the account owner. Fine for M1, flagged for launch. Known footgun:
   `pg` turns `date` columns into local-time JS `Date`s, so every query casts `::text`.
5. **TODOS cross-reference:** there is no TODOS.md. Follow-up work goes in "What's left" below.
6. **Completeness:** full edge handling where it's cheap: each-month notices (TX), late-notice
   look-back (CA/AZ), catch-up alerts when a cron day is missed, deadlines that change when
   dates are edited, retries with a cap, idempotent sends.
7. **Distribution:** a web app on Vercel Hobby. No new artifact type; deploy is
   `vercel deploy` / git integration.

### 1 — Architecture

```
 browser ──GET /?state=CA&first=…──▶ page.tsx ──▶ computeDeadlines(job, today) ──▶ HTML table
    │                                   (no DB)        ▲  rules/rules.json (versioned)
    └─POST server action (save) ──▶ jobs.ts ──▶ Postgres (jobs) ──▶ redirect /jobs/<uuid>

 Vercel Cron (daily, 15:00 UTC) ──GET /api/cron/alerts (Bearer CRON_SECRET)
    └─▶ enqueueAlerts: for each job → computeDeadlines(today in the job's state TZ)
          → planAlerts (threshold = smallest of 14/7/2/0 ≥ days left)
          → INSERT … ON CONFLICT (job, deadline key, deadline date, threshold) DO NOTHING
    └─▶ sendPendingAlerts: claim rows (FOR UPDATE SKIP LOCKED) → Resend (Idempotency-Key)
          → mark sent / back to pending (max 3 attempts → failed)
```

- **Boundaries:** `src/lib` is framework-free and fully tested (dates, rules, deadlines,
  input parsing, jobs repository, alerts, cron handler). `src/app` holds thin Next.js
  pages, actions and the route that call into it.
- **Data:** `jobs(id uuid, state, role, project_type, counterparty, first/last furnish dates,
  done jsonb, alert_email)` and `alerts(... UNIQUE(job_id, deadline_key, deadline_date,
  threshold_days), status pending|sending|sent|failed)`. The schema is created lazily under a
  Postgres advisory lock, so concurrent cold starts don't race.
- **Security:** no auth in M1 (M2 adds it). A saved job is reachable only through an
  unguessable UUID link (a capability URL). All SQL is parameterized. React escapes all
  user text. Counterparty names are stripped of control characters, so they can't inject
  email headers. The cron route compares the bearer token in constant time and fails closed.
- **Failure scenarios accounted for:**
  - Cron skips a day → catch-up: the next run sends the most urgent threshold not yet sent.
  - Send succeeds but marking it sent crashes → the row is reclaimed after 15 min and the
    Resend Idempotency-Key (24 h) suppresses the duplicate.
  - Resend is down → the row goes back to pending, `attempts` increments, and it is `failed`
    after 3 tries.
  - The user edits the last-furnishing date → the deadline date changes → new alert keys.
    Old pending alerts for the stale date are dropped, so nobody gets an alert for a date
    that no longer applies.
  - DST/time zone → "today" is computed in the job's state time zone, never the server's.
  - `DATABASE_URL` is missing on Vercel → a loud error, not a silent local DB.
- **Scaling:** M1 loads all jobs once a day (fine to roughly 10k jobs). Paginate in M3 if needed.

### 3 — Test plan (vitest, `npm test`)

| Exit criterion | Test |
|---|---|
| CA first furnish 2026-03-01 → notice 2026-03-21 | `test/exit-criteria.test.ts` EC1 |
| CA notice served 2026-04-10 → protected only from 2026-03-21 | EC2 (status `partial`, `protectedFrom`) |
| TX last furnish 2026-02-10 → lien 2026-06-15 | EC3 |
| WA last furnish 2026-01-10 → lien 2026-04-10 | EC4 |
| 7 days out → exactly one 7-day alert, none duplicated on rerun | EC5 (real SQL on in-memory PGlite, run twice) |
| every deadline has a citation URL + last-verified date | EC6 (every state × several jobs, plus the rendered table) |

Plus coverage of every other codepath: date math (month ends, leap years, year rollover),
≥5 statute-derived fixtures per state (PRD success metric), the rules-file schema, status
for each branch (on time / late with look-back / late without look-back / open / passed),
urgency sort, TX month-by-month notices, alert thresholds incl. catch-up and "none after the
deadline", form parsing and validation errors, the jobs repository CRUD, stale-alert pruning,
the sender's request shape, send retry/fail paths, and the cron route's auth (unset secret,
wrong token, right token).

## M1 review (done)

M1's self-review of its full diff (all files were new) against gstack's checklist, Pass 1
(CRITICAL) and Pass 2 (INFORMATIONAL), with the Fix-First heuristic. Its open P1 is fixed
in M2 (see "Review" above). M1's statute-fixture metric still holds: 36 fixtures in
`test/rules.test.ts`, 5–8 per state, all matching.

**Fixed**
- [P1] (confidence: 8/10) `src/lib/alerts.ts`, send failure path. The status reset did not
  check `status = 'sending'`, so a stale reclaim racing a slow failure could flip a sent row
  back to pending. It now updates only rows still in `sending`, matching the success path.
- [P2] (confidence: 9/10) `test/alerts.test.ts`. The daily-cron test enqueued without
  sending, which doesn't match what the cron does. It now enqueues and sends each day like
  the route, and a new test covers the email-unconfigured queue (keeps only the current
  alert, prunes after the deadline).
- [P3] `src/app/page.tsx`. `pendingRules` was computed twice; it is now computed once.
- [P3] Test infrastructure. One PGlite per test file plus `TRUNCATE` between tests, instead
  of one per test, which had made the suite take more than 5 minutes.

**Checked, no issue**
- SQL: every query is parameterized. The only interpolation is the constant column list.
  Dates are read back with `::text`, which avoids node-postgres's local-midnight `Date`
  footgun.
- Races: alert enqueue uses `UNIQUE` + `ON CONFLICT DO NOTHING`, and the claim is one atomic
  `UPDATE … WHERE id IN (… FOR UPDATE SKIP LOCKED)`. The `done` map uses atomic jsonb
  merge/removal (tested concurrently). The last-furnish check lives in the `UPDATE`'s
  `WHERE` clause. Schema creation runs under an advisory lock.
- XSS: React escaping only, no `dangerouslySetInnerHTML` (test renders `<script>` input).
  Errors come back as fixed codes, not reflected text. Counterparty names are stripped of
  control characters before they reach email subjects, and emails with whitespace or
  control characters are rejected.
- Enum completeness: all four `DeadlineStatus` values are handled in labels, urgency order,
  CSS badges, the table's protection text and alert filtering. All three triggers are
  handled in `occurrences`. Alert statuses are enforced by a `CHECK` constraint.
- Time windows: "today" is per state time zone everywhere (alerts, statuses, the job page's
  max done date), and the 05:30 UTC LA/Chicago split is tested.
- Secrets: none in the repo. Test keys are built at runtime, and the Resend error message
  never includes the key (tested). The cron fails closed and compares the token in constant
  time.
- LLM trust boundary / shell injection: not applicable in M1. No LLM, no subprocesses.

**Left open (needs a product/security decision; recorded here, not fixed in M1)**
- ~~[P1] (confidence: 8/10) `src/app/actions.ts` `saveJob`. Anyone can save a job with any
  email address, so alerts could be pointed at a third party (no double opt-in), and there is
  no rate limit on job creation.~~ **Fixed in M2:** saving needs a verified account, alerts go
  only to that address, and sign-in emails are rate-limited.
- [P2] (confidence: 7/10) `src/lib/alerts.ts` `enqueueAlerts` loads every job and issues one
  DELETE plus one INSERT per planned alert. That's fine at M1 scale. Batch it (multi-row
  insert, paginated scan) when jobs pass roughly 10k.
- [P2] (confidence: 6/10) Medium confidence. A send that fails on the 0-day threshold is
  retried by the next daily run, after the deadline. Consider an inline retry, or an external
  scheduler calling the route more than once a day.
- [P3] I couldn't start a dev server in this sandbox, so no click-through browser check was
  done. (Since M2, the job page and server actions are also exercised in `test/app.test.tsx`.)
