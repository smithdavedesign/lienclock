# lienclock — build notes

## Plan

Milestone: **M3 — Billing and more states**, run 2 of 2 in this MVP session (M2, then M3).
Planned with gstack plan-eng-review ("Step 0: Scope Challenge", "1. Architecture review",
"3. Test review"). Nobody answers questions in this run, so I answered each one myself and
wrote the answer down here.

Exit criterion (ROADMAP M3): **a rules change creates a changelog entry and queues emails only
for jobs in that state.** Deliverables: a Stripe subscription at $29/mo, 10 more states, and a
rule-change changelog with email to affected users. From REVENUE.md, what's still missing
before charging: the payment link/checkout, the og:image and the price in the terms (§6
said "free during early access").

### Step 0 — Scope challenge

1. **What already solves part of it?**
   - **Rules are versioned JSON in the repo (M1).** So the app can *detect* a change instead of
     someone remembering to write one up. It diffs the shipped rules against a snapshot in the
     database. No admin UI and no hand-written changelog file.
   - **The alert queue (M1)** already claims rows atomically, retries, gives up after 3
     attempts and sends with a per-row Resend idempotency key. Rule-change emails reuse the
     same send loop on a second queue table, with no second sender.
   - **The daily cron (M1)** is already authenticated and scheduled. It runs the rule sync
     first, then alerts.
   - **Payments: Stripe Payment Links + Stripe's no-code customer portal [Layer 1].** There's no
     Stripe SDK, no Checkout Session API and no secret API key: the link accepts
     `client_reference_id` (the account id) and `prefilled_email`, and a signed webhook tells us
     who paid. That's REVENUE.md's "payment link, no backend needed", minus the by-hand step.
   - **The Svix verifier (M2)** shows the pattern for Stripe's signature: an HMAC-SHA256 over
     the raw body, a timing-safe compare and a 5-minute window. It uses `node:crypto` only.
   - **og:image:** Next's `opengraph-image.tsx` with `next/og` **[Layer 1]**, prerendered at
     build time. There's no image file to keep in sync.
2. **Minimum change set:**
   - **10 states: CO, GA, IL, MN, NJ, NY, OH, PA, UT, VA** (17 rules). Together with the 6
     M1 states, they're the 16 largest construction markets except NC and MI. The engine gains one
     offset unit, `months` (plus or minus days), for NY/IL/CO/PA "N months after" deadlines and
     CO/PA "notice of intent N days before filing". It also gains negative `lateLookbackDays`
     for Utah, where a late notice covers work from 5 days *after* it's filed.
   - **Changelog:** three tables (`rule_snapshots`, `rule_changes`, `rule_change_emails`),
     `syncRuleChanges()` in the cron, and a public `/changelog` page with the covered states
     and every change.
   - **Billing:** the Free plan is the calculator plus **1 tracked job**; **Pro is $29/month**
     with unlimited jobs. The limit is enforced on all three paths that create a job (save,
     the job held in a sign-in link, and intake confirm). There's a Plan section on the
     dashboard, pricing on the home page, `/api/stripe/webhook`, §6 of the terms and Stripe in
     the privacy policy.
   - **og:image** with the price.
   - **Deliberately NOT in M3:**
     - **No Stripe API calls** (no `STRIPE_SECRET_KEY`): cancelling, invoices and card updates
       happen in Stripe's portal. Deleting an account is blocked while a subscription is
       active, rather than cancelling it through the API.
     - No annual $290 link, coupons, tax, seats or dunning emails of our own.
     - **NC and MI.** A late notice there is still partly valid in ways the status model can't
       show: NC's Notice to Lien Agent stays valid unless a buyer or lender recorded first,
       and MI reduces the lien by what the owner paid before the notice. LienClock would mark
       them "missed", which misleads.
     - A "doesn't apply to this job" switch for conditional notices (OH, PA, MN), and
       hand-written explanations attached to changes.
     - Weekend and holiday extensions, as in M1.
     - An attorney review, which is outside the code.
3. **Complexity check:** about 30 files: 6 new source files (`billing.ts`, `changelog.ts`, the
   webhook route, `/changelog`, `opengraph-image.tsx`, the rules baseline), the rest edits and
   tests. That's 2 new modules and no new services: Stripe is an account, not a server.
   **The smell triggers.** I proceed: each deliverable maps to one lib module plus one thin
   route or page, and the edits are the places where a job gets created (which the limit must
   cover) or where the price must be stated. Cuts I made:
   - no Stripe SDK or secret key;
   - no separate email sender (the alert loop is reused);
   - no hand-written changelog format;
   - rule-change emails per (change, address), not per job;
   - no new date units beyond `months`. Virginia's "90 days after the end of the month" is
     shown as the earlier, safe 90 days after last furnishing, with a note, the same way M1
     shows CA/AZ/NV.
4. **Search check:** WebSearch for the statutes (four parallel research passes; page
   fetches are blocked in this sandbox, as in M1). Stripe and Next patterns come from
   in-distribution knowledge. Known footguns, all handled:
   - (a) the signature covers the raw body, so the route reads `req.text()` before parsing;
   - (b) Stripe doesn't guarantee event order, so each update carries the event's `created`
     time and an older event never overwrites a newer state;
   - (c) Stripe retries and duplicates deliveries, so every update is idempotent;
   - (d) a payment-link payment made without our `client_reference_id` falls back to the
     checkout email;
   - (e) deleting an account doesn't cancel a Stripe subscription, so deletion is refused
     while one is active;
   - (f) a half-configured billing setup must not lock anyone out, so the job limit applies
     only when both the payment link and the webhook secret are set. Until then it's early
     access and everything is free;
   - (g) a rule change found by two overlapping cron runs: a compare-and-swap on the
     snapshot's revision plus `UNIQUE(state, revision)` make exactly one entry;
   - (h) re-verifying a rule (new `lastVerified` only) must not email anyone.
5. **TODOS cross-reference:** there is no TODOS.md. M2's "What's left" assigned to M3: Stripe,
   10 states, the changelog, the og:image and terms §6. All are in. The verified sending domain
   stays a launch blocker outside the code.
6. **Completeness:** the full version where it's cheap:
   - the changelog handles added, changed and removed rules, new states, reverts and
     re-verification;
   - the webhook handles checkout, subscription updates, cancellation, unknown accounts,
     replays and out-of-order events;
   - the job limit covers every creation path.
7. **Distribution:** no new artifact. It's the same Vercel app.

### 1 — Architecture

```
 daily cron (Bearer CRON_SECRET)
   ├─▶ syncRuleChanges(RULES, baseline = rules/baseline-2026-10-25.json)
   │     no snapshots yet? seed them from the baseline (the rules M1–M2 shipped with)
   │     for each state: fingerprint(material fields of its rules; lastVerified excluded)
   │       same → refresh the stored copy silently (re-verification)
   │       different → diff (added / changed / removed, field by field)
   │                 → INSERT rule_changes (state, revision+1) ON CONFLICT DO NOTHING
   │                 → UPDATE rule_snapshots … WHERE revision = old   (compare-and-swap)
   │     for each change not yet emailed: jobs WHERE state = change.state, grouped by address
   │       → INSERT rule_change_emails (change, address) ON CONFLICT DO NOTHING → mark emailed
   ├─▶ enqueueAlerts (unchanged)          ├─▶ send alerts (unchanged)
   └─▶ send rule-change emails (same loop, second table, after alerts: deadlines come first)

 /changelog (public) ── covered states + rule_changes, newest first

 Pro: /jobs "Subscribe – $29/month" ─▶ buy.stripe.com/…?client_reference_id=<account>&prefilled_email=…
   Stripe ──POST /api/stripe/webhook (Stripe-Signature t=…,v1=…)──▶ verify (raw body, 5 min)
     checkout.session.completed      → account by client_reference_id, else by email
                                      → customer + subscription ids, status active
     customer.subscription.updated/deleted → account by subscription id → status
     every UPDATE … WHERE billing_updated_at IS NULL OR billing_updated_at <= event.created
 save / sign-in link with a job / intake confirm ─▶ createJob(…, jobLimit)
     INSERT … SELECT … WHERE limit IS NULL OR (SELECT count(*) …) < limit   (one statement)
     limit = 1 if billing is configured and the account isn't active/trialing/past_due, else none
```

- **Boundaries:** `src/lib/changelog.ts` and `src/lib/billing.ts` are framework-free and
  tested directly on PGlite. The webhook route and `/changelog` page are thin.
- **Data:**
  - `accounts` gains `subscription_status`, `stripe_customer_id`, `stripe_subscription_id`
    and `billing_updated_at`.
  - New tables: `rule_snapshots(state PK, revision, fingerprint, rules)`,
    `rule_changes(state, revision UNIQUE, rules_version, items, emails_queued_at)` and
    `rule_change_emails` (the alert queue's columns plus `UNIQUE(change_id, to_email)`).
  - Account deletion also removes that address's rule-change emails.
- **Security:**
  - The webhook fails closed without `STRIPE_WEBHOOK_SECRET`. Signatures are compared in
    constant time, with a 5-minute window and a body-size cap.
  - The webhook only ever changes billing columns. A forged `client_reference_id` can at most
    pay for someone else's account.
  - Payment-link and portal URLs must be https.
  - The rules sync takes no user input. `/changelog` renders stored text through React.
- **Failure scenarios:**
  - **The sync throws** (e.g. a bad snapshot row): it's logged and the cron goes on to the
    alerts. A changelog bug must never stop deadline alerts.
  - **Crash between the change entry and the emails:** `emails_queued_at` is still NULL, so the
    next run queues them; `UNIQUE(change_id, to_email)` stops duplicates.
  - **A rule change touches 300 addresses but Resend allows 100 a day:** rule-change emails go
    after alerts, at most 50 per run, and the rest wait for later days.
  - **The webhook arrives before the redirect back:** the dashboard says "confirming your
    payment" on `?billing=success` until the status flips.
  - **The webhook never arrives (misconfigured):** the account stays Free. Stripe shows the
    failed deliveries, and David can fix the account by hand (SQL under Deploy).
  - **A subscriber deletes their account:** refused, with a link to cancel in the portal first.
  - **A subscription ends:** jobs already tracked keep their alerts. Only adding more jobs is
    blocked (terms §6). LienClock never silently stops warning about a deadline someone relies
    on.
- **Scaling:** the sync reads 16 small rule sets and queues one email per affected address
  (an indexed `jobs.state` scan). The webhook does one indexed update.

### 3 — Test plan (vitest, `npm test`), written before the code

| Exit criterion / item | Test |
|---|---|
| **A rules change creates a changelog entry and queues emails only for jobs in that state** | `test/m3-exit-criteria.test.ts` M3-EC1: CA, TX and CA+TX accounts plus an M1-era TX job. A TX rule edit creates exactly one TX entry, with the field-level before/after. It queues one email per address that has a TX job, listing only that address's TX jobs, and none for the CA-only account. A rerun adds nothing. End to end through the cron route as well. |
| Rule sync edge cases | `test/changelog.test.ts`: first run seeds from the baseline (only the 10 new states appear, no email); `lastVerified`-only edit → no entry; added and removed rules; a new state with jobs elsewhere → no email; revert → a new revision; two concurrent syncs → one entry; crash before queueing → emails on the next run; deleting an account deletes its rule-change emails; deadline and late-notice descriptions. `test/m3-app.test.tsx`: `/changelog` renders the states and the changes |
| 10 more states | `test/rules.test.ts`: ≥5 hand-counted statute fixtures per new state (PRD metric), exactly 16 states, `months` offsets (month-end clamping, leap years, minus days), Utah's negative look-back, the validator's rejections; `test/dates.test.ts`: `addMonths` |
| Stripe subscription | `test/billing.test.ts`: billing config (both values needed, https only), checkout URL, signature (valid, wrong secret, stale, tampered, rotated secrets, malformed), webhook (not configured, bad signature, oversized, bad JSON, checkout by id and by email, subscription updated/deleted, out-of-order, replay, unknown account, other events), `createJob` limit (one statement, per account) |
| Plan on the pages | `test/m3-app.test.tsx`: the home page pricing; dashboard Plan section in early access, Free (subscribe link carries the account) and Pro (portal link); save, sign-in-link job and intake confirm at the limit → no job, a clear message; Pro → no limit; delete account refused while subscribed |
| Terms, privacy, og:image, sitemap | `test/legal.test.tsx`: §6 states $29/month, Stripe, cancel, no refunds for part months, tracked jobs keep alerts after cancelling; privacy names Stripe and no card numbers; `/changelog` in the sitemap and footer; og:image renders a 1200×630 PNG |

Existing tests changed because M3 changes the spec, never to loosen them (each one is listed
under "Exit criteria"):
- the exact covered-state list (`rules.test.ts`) and the calculator's "covers …" message
  (`CalculatorPage.test.tsx`);
- M1-EC6's list of states with no deadline before a last-furnishing date, and its
  last-verified bound, which stays `2026-10-25` for the M1 states and is `2026-11-08` for
  the new ones;
- the sitemap's exact page list;
- the cron response, which gains a `ruleChanges` field in the exact-match assertion.

## M2 plan (done)

Milestone: **M2 — Accounts, calendar feed and intake**, run 1 of 2 in this MVP session (M2,
then M3). Planned with gstack plan-eng-review ("Step 0: Scope Challenge", "1. Architecture
review", "3. Test review"). Nobody answers questions in this run, so I answered each one
myself and wrote the answer down here.

Exit criteria (ROADMAP M2): **the ICS feed validates and contains one VEVENT per deadline; a
forwarded sample PO email yields state and date fields flagged "unconfirmed".**

### Where M2 stood when this run started

- **The M2 code was already in the repo.** The previous M2 run timed out after writing it, and
  the pipeline committed it together with M1 in `7c1c70a` (REVENUE.md: "M2 … timed out").
  Auth, multiple jobs per account, the ICS feed and email intake are all present. `npm test`
  passed with 367 tests, including `test/m2-exit-criteria.test.ts`.
- **So the exit-criteria tests could not "fail now"**, because the code they test was already
  there. I checked that they aren't vacuous by breaking the code three ways and confirming
  each change made a test fail, then reverting (the tree was clean afterwards):
  1. dropping each job's first VEVENT made M2-EC1 fail ("expected length 6 but got 3");
  2. removing `DTSTAMP` made M2-EC1's RFC 5545 check fail ("VEVENT #1 needs exactly one
     DTSTAMP" ×6);
  3. proposing fields as `confirmed` made M2-EC2 fail.
- **`.provision` was missing** from the repo, although the old BUILD.md lists its lines.
- **REVENUE.md is new.** Before charging it wants privacy and terms pages with a clear
  "reference tool, not legal advice" disclaimer, a last-verified date on every result (done in
  M1), an og:image, robots.txt and a sitemap. None of these existed.

### Step 0 — Scope challenge (this run)

1. **What already solves it?** All of ROADMAP M2 is built and tested (see "M2 core design"
   below). This run doesn't rebuild or re-architect it. The new work reuses what's there:
   `requireAccount` and server actions for deletion, `appUrlFrom` for absolute URLs in
   robots and the sitemap, `parseEmail` for the contact address, and FK `ON DELETE CASCADE`
   (already on `jobs`, `sessions` and `intake_proposals`) to delete an account's data in one
   statement. Next's built-in `robots.ts`/`sitemap.ts` metadata routes **[Layer 1]** replace
   hand-written files.
2. **Minimum change set.** These are the REVENUE.md items that belong to *accounts*. M2 is
   where people start giving LienClock their email address and forwarding it their POs:
   - **`/terms`**: not legal advice, not a law firm, coverage limits, "check before you rely",
     alerts can fail, as-is, liability cap. **`/privacy`**: what's stored, where, for how long,
     who processes it, and how to delete it. Both are linked from every page's footer.
   - **Agreement at sign-up:** "By …, you agree to the Terms and Privacy Policy" next to all
     three buttons that lead to an account. The one that actually creates it is "Sign in to
     LienClock" on the link page.
   - **Delete account** on `/jobs`. The privacy policy needs a way to delete your data, and
     without a contact address yet, self-serve is the only honest one. One statement removes
     the account, its jobs and alerts, pending emails, sessions and sign-in links.
   - **`robots.txt` + `/sitemap.xml`.** M2 added private and secret-bearing URLs (`/jobs`,
     `/signin?token=`, `/intake/`, `/calendar/<token>.ics`, `/api/`), so robots.txt keeps
     crawlers off them. The sitemap lists the 3 public pages.
   - **`.provision`**, recreated with every line the app needs.
   - **Deliberately NOT in M2:** the **og:image** goes to M3 with the pricing copy it should
     show. **Stripe and checkout**, **10 more states** and the **rules changelog** are M3.
     Also out: a data-export button (the dashboard and the ICS feed already show everything
     stored); recording which terms version each account accepted (the terms carry a date,
     and `accounts.created_at` records when someone agreed); a governing-law clause (the
     operator's entity and state are unknown); a cookie banner (the only cookie is the
     strictly necessary session cookie); and any change to the existing M2 features.
3. **Complexity check:** 13 source files: 6 new (`privacy/page.tsx`, `terms/page.tsx`,
   `robots.ts`, `sitemap.ts`, `Legal.tsx` with the agreement and contact lines, and
   `src/lib/site.ts` for shared constants).
   It edits `layout.tsx`, `page.tsx`, `signin/page.tsx`, `jobs/page.tsx`, `actions.ts`,
   `auth.ts` and the CSS. No new classes, services or dependencies. **The >8-file smell
   triggers.** I proceed anyway: 4 of the files are static pages or Next metadata routes
   with no logic, and the only logic (account deletion) is one SQL statement plus one action.
   Cuts I made: one tiny `Agreement` component instead of three copies of the text, no
   acceptance-tracking column, and the og:image moved to M3.
4. **Search check:** in-distribution knowledge only for this run's additions (Next's
   `app/robots.ts`, `app/sitemap.ts` and `MetadataRoute` are long-stable built-ins). Known
   footguns:
   (a) robots.txt `Disallow` stops a crawler from seeing a page's `noindex`. The private pages
   keep their `noindex` meta and the feed its `X-Robots-Tag`, so a URL leaked elsewhere still
   doesn't get indexed with content.
   (b) Sitemap URLs must be absolute and on the production host. They come from `appUrlFrom`
   (`APP_URL`, else Vercel's production URL), never the request Host.
   (c) A `DELETE` that cascades over several paths in one statement: the account's jobs
   cascade from `accounts`, and `intake_proposals.job_id` is `ON DELETE SET NULL` on rows
   that are themselves being deleted. A test runs it on real Postgres (PGlite).
5. **TODOS cross-reference:** there is no TODOS.md. M2's earlier "What's left" put the legal
   pages and account deletion in M3. They move here because they belong to accounts, and
   REVENUE.md lists them as the agent's first step. The rest stays where it was.
6. **Completeness:** deletion covers every table that holds the user's data, including M1-era
   jobs without an account that still alert the same (now verified) address, so after
   deletion LienClock never emails that address again unless they sign up again. Missing
   confirmation, signed-out calls and a second click are all handled. The contact address is
   shown only when `CONTACT_EMAIL` is a valid address.
7. **Distribution:** no new artifact. It's the same Vercel app.

### 1 — Architecture (this run's additions)

```
 every page ── footer: Terms · Privacy (+ the not-legal-advice line, as in M1)
 /terms, /privacy ── static pages; contact line only if CONTACT_EMAIL parses as an email
 /robots.txt ── allow /, disallow /jobs /signin /intake/ /calendar/ /api/, sitemap: <app url>/sitemap.xml
 /sitemap.xml ── <app url>/, /privacy, /terms (src/lib/site.ts PUBLIC_PAGES)

 /jobs "Delete your account" [x] I understand ──POST deleteAccountAction
    → requireAccount → confirm ticked? (no → /jobs?error=delete-confirm#account)
    → deleteAccount(db, id): one statement
        WITH gone AS (DELETE FROM accounts WHERE id = $1 RETURNING email)   ← cascades: sessions,
             , DELETE login_tokens WHERE email ∈ gone                            jobs → alerts,
             , DELETE jobs WHERE account_id IS NULL AND lower(alert_email) ∈ gone   intake_proposals
        SELECT email FROM gone
    → clear cookie → /?accountDeleted=1 ("Your account and all its data were deleted.")
```

- **Boundaries:** unchanged. The legal text lives in two server components, deletion lives in
  `src/lib/auth.ts` (framework-free, tested on PGlite), and the action is thin.
- **Security:** deletion needs a session (and Next's Origin check on server actions) plus an
  explicit checkbox; a GET can't do it. It's scoped by the session's account id, never a
  form field. It also clears pending sign-in links for the address, so an emailed link can't
  bring the account back a minute later without a new opt-in. Deleting the account ends every
  session, on every device, through the FK cascade.
- **Failure scenarios:**
  - Double click on "Delete": the second request carries a session that no longer exists, so
    it's sent to sign in and deletes nothing (tested). `deleteAccount` itself returns false
    for an account that's already gone.
  - The alert cron is sending for a job that gets deleted: its status update matches no row
    (the same as deleting one job in M1). An email already in flight may still arrive once.
  - `CONTACT_EMAIL` is unset or malformed: the pages omit the contact line and point to the
    self-serve controls.
  - `APP_URL` is unset on Vercel: `VERCEL_PROJECT_PRODUCTION_URL` is used (the existing
    `appUrlFrom`).
- **Scaling:** n/a (static pages; one indexed delete).

### 3 — Test plan (vitest, `npm test`), written before the code

| Exit criterion / item | Test |
|---|---|
| ICS feed validates, one VEVENT per deadline | `test/m2-exit-criteria.test.ts` M2-EC1 (already passing, and its mutations caught, see above) |
| Forwarded PO → state and date flagged "unconfirmed" | M2-EC2 and the end-to-end variant (same) |
| Terms say "not legal advice" and set the limits | `test/legal.test.tsx`: not legal advice, not a law firm, no attorney–client relationship, the 6 covered states, private commercial, calendar days never extended, check against the statute or an attorney, alerts can fail, as is, a dated "Last updated", a link to the privacy policy |
| Privacy says what's stored and how to delete it | `test/legal.test.tsx`: email, job details, forwarded emails (subject, sender and short source lines, not the full email), the processors (Vercel, Neon, Resend), the one cookie, no selling or ads, Delete account; contact shown only for a valid `CONTACT_EMAIL` |
| Footer links on every page | `test/legal.test.tsx`: the root layout renders `/terms` and `/privacy` links |
| robots.txt and sitemap | `test/legal.test.tsx`: `robots()` disallows every private prefix and points at `<APP_URL>/sitemap.xml`; `sitemap()` lists exactly the 3 public URLs, absolute, and no private path |
| Agreement before an account exists | `test/app.test.tsx`: the calculator (signed out only), the sign-in form and the link's "Sign in" page each show the agreement and link both pages |
| Account deletion (lib) | `test/auth.test.ts`: removes the account, its jobs, alerts, proposals, sessions and sign-in links, plus M1-era account-less jobs alerting the same address (any case); another account is untouched; the feed token and session stop working; unknown or invalid id → false; a proposal linked to a job doesn't break the cascade |
| Account deletion (action + UI) | `test/app.test.tsx`: signed out → sign in; no checkbox → error, nothing deleted; confirmed → data gone, cookie cleared, `/?accountDeleted=1`; the dashboard shows the section with the job count; the calculator shows the flash |

All 367 existing tests keep passing unchanged.

### M2 core design (first M2 run, unchanged and still accurate)

This is the design and test plan of the run that built auth, the ICS feed and intake.

#### Step 0 — Scope challenge

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

#### 1 — Architecture

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

#### 3 — Test plan (vitest, `npm test`)

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

## What the product does now (end of M3: the MVP)

New in M3:

- **16 states.** CA, TX, FL, WA, AZ, NV (M1), plus **CO, GA, IL, MN, NJ, NY, OH, PA, UT,
  VA** (17 new rules, 28 in all; the state picker is alphabetical).
  - Each new rule has a statute citation, a link and `lastVerified: 2026-11-08`, and a note
    that says what to do and when the rule applies.
  - New kinds of deadline:
    - "N months after" with month-end clamping (NY 8, IL and CO 4, PA 6);
    - "notice of intent N days before the lien is due" (CO 10, PA 30);
    - Utah's late preliminary notice, which covers only work from 5 days after it's filed;
    - conditional notices (OH Notice of Furnishing, PA projects of $1.5M or more, MN
      prelien), shown with their conditions.
- **Rules changelog** (`/changelog`, public, linked in every footer). It lists every covered
  state with its deadlines, statutes and last-verified date, then every recorded change,
  newest first: a new rule, a removed rule, or each changed field as before → after.
  - Changes are found automatically. The daily cron compares the shipped rules with the copy
    it stored last time. Re-verifying a rule (a new `lastVerified` only) isn't a change.
  - **Every address with a job in that state gets one email per change**: what changed,
    their jobs in that state with links, and the changelog link. Nobody else gets one.
  - Rule-change emails go out after the deadline alerts, at most 50 per day.
- **Billing: Free and Pro.**
  - **Free** is the calculator and **1 tracked job**, with alerts, calendar feed and intake.
  - **LienClock Pro, $29/month**, tracks unlimited jobs.
  - Pricing shows on the home page, and the dashboard has a "Your plan" section.
  - On the Free plan, "Subscribe to Pro" opens the Stripe Payment Link, tagged with the
    account and prefilled with its email. Stripe's signed webhook then switches the account
    to Pro within seconds; the redirect back shows "confirming your payment" until it does.
  - Pro shows "Manage billing or cancel" (Stripe's customer portal). Past-due cards get a
    warning. When a subscription ends, jobs already tracked keep their alerts; only adding
    more is blocked.
  - **Saving a 2nd job on Free** (from the calculator, from a sign-in link holding a job, or by
    confirming an intake email) is refused with a subscribe link. The typed job and the
    email waiting for review are kept.
  - Until `STRIPE_PAYMENT_LINK` and `STRIPE_WEBHOOK_SECRET` are both set, there's no limit and
    the site says "free during early access".
  - **Deleting an account is refused while a subscription is active**, with a link to cancel
    first, because deleting can't stop Stripe's charges.
- **Terms §6 "Plans and price"** covers Free/Pro, US$29/month, Stripe, card numbers never
  stored, monthly renewal, cancel anytime, no refunds for partial months, alerts kept after
  cancelling, and 30 days' notice of price changes. §3 adds conditional notices and the rule
  changelog. The **privacy policy** adds Stripe as a processor, the billing ids and status we
  store, and the records of rule-change emails, and says to cancel before deleting.
- **og:image** (1200×630, prerendered): the product, 16 states and the $29/month price.
  Metadata URLs resolve against `APP_URL`.

From M1–M2, with M3 changes noted:

- **Calculator** (`/`): pick a state (16), enter the
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
- **Alerts:** unchanged from M1. The daily cron emails 14/7/2/0 days before each open
  deadline. Since M3 it records rule changes first.
- **Terms and privacy** (`/terms`, `/privacy`, linked in every page's footer). The terms say
  LienClock is a reference tool and not legal advice, that it's not a law firm and creates
  no attorney–client relationship, and what it covers: 16 states, private commercial
  projects, first-tier subs, calendar days never extended, and no notice-of-completion
  tracking. They tell users to check each date against the statute or an attorney, warn that
  alerts can fail, and include as-is, a liability cap and (since M3) the plans and price. The
  privacy policy lists exactly what's stored, including what's kept from forwarded emails
  (subject, sender and short source lines, never the full email), the processors (Vercel,
  Neon, Resend), the one cookie, and how to delete data. A contact line appears when
  `CONTACT_EMAIL` is set. "By saving / continuing / signing in, you agree to the Terms of Use
  and Privacy Policy" sits next to every button that leads to an account.
- **Delete account** (bottom of `/jobs`): tick "I understand", then "Delete my account". At
  once this removes the account, its jobs and their alerts, emails waiting for review,
  sessions on every device, and unused sign-in links. It also removes M1-era jobs that alert
  the same address, so LienClock never emails it again. You land on the calculator with a
  confirmation.
- **robots.txt and sitemap.xml:** crawlers may read `/`, `/changelog`, `/privacy` and
  `/terms`. They're kept off `/jobs`, `/signin`, `/intake/`, `/calendar/` and `/api/`
  (signed-in pages, token-bearing URLs and the webhooks; the pages also send `noindex`
  themselves). The sitemap lists the four public pages on the production host.

## Run locally

```bash
npm install            # works with npm_config_ignore_scripts; no new dependencies in M2 or M3
npm test               # 540 vitest tests in 23 files, ~60–90 s (embedded Postgres boots per DB test file)
npm run typecheck
npm run dev            # http://localhost:3000, no env vars needed (/changelog, /terms, /privacy, /robots.txt, /sitemap.xml too)
npm run build && npm start
```

- **Rules changelog locally:** changes are recorded by the cron, so `/changelog` lists only
  the covered states until it runs. Set `CRON_SECRET` to any random string in `.env.local`, then
  run `curl -H "Authorization: Bearer <that string>" http://localhost:3000/api/cron/alerts`.
  The first run on a fresh database records the 10 states added since the M1 rules. Edit
  a rule in `rules/rules.json`, restart, and run it again to see a "changed" entry. Its
  emails are queued in `rule_change_emails` and sent only when `RESEND_API_KEY` is set.
- **Billing locally:** without the Stripe variables everything is free ("early access").
  To see the Free/Pro flow, set `STRIPE_PAYMENT_LINK` to any https URL and
  `STRIPE_WEBHOOK_SECRET` to any random string. Then sign a `checkout.session.completed` event
  with it, as `scripts/screenshots.mjs` (`completeCheckout`) does, or use the Stripe CLI
  (`stripe listen --forward-to localhost:3000/api/stripe/webhook`) with a test-mode Payment
  Link.

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
CHROMIUM_PATH=/path/to/chromium npm run screenshots   # ~60 s, writes docs/screenshots/*.png
```

`scripts/screenshots.mjs` runs `next build`, starts `next start` on a free 127.0.0.1 port and
waits for it to answer. It then drives Chromium through `playwright-core`, which never
downloads a browser. Each view is captured at 1280×800 and on an iPhone 13 (viewport only):

- `deadlines-*`: the calculator's result for a sample **Pennsylvania** job (an M3 state):
  the notice of intent, the lien claim and a missed Notice of Furnishing.
- `jobs-*`: the dashboard on **LienClock Pro**. To get there the script takes the real path:
  1. it saves the PA job with an email (signing up) and signs in with the link from the
     server output;
  2. it tries a second job and gets the Free limit and its subscribe link;
  3. it posts a **signed `checkout.session.completed`** to `/api/stripe/webhook` with the
     account id from that link, as Stripe would after payment;
  4. it saves jobs in OH, CO and GA.
- `changelog-*`: `/changelog` after the first cron run (the script calls
  `/api/cron/alerts`). It shows the rules added since the M1 rules, per state.

It is not part of `npm test`.

- **Isolated from real infrastructure:** the app gets only PATH/HOME/locale variables. Every
  service variable (`DATABASE_URL`, `RESEND_API_KEY`, …) is set to an empty string, which also
  overrides any `.env` file. Data goes to a throwaway PGlite directory under `.data/`, which
  is deleted afterwards, and no email can be sent.
  - `CRON_SECRET` and `STRIPE_WEBHOOK_SECRET` are random values the script makes up at
    start; they exist only in its process and the app it starts.
  - `STRIPE_PAYMENT_LINK` and `STRIPE_PORTAL_URL` are sample URLs that are never opened.
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
   `RESEND_API_KEY`, the Resend Inbound webhook (`RESEND_WEBHOOK_SECRET`,
   `INTAKE_EMAIL_DOMAIN`) and the support address `CONTACT_EMAIL`. REVENUE.md says M1 is
   already live at https://lienclock-eta.vercel.app, so a push redeploys the same project.
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
5. Set `CONTACT_EMAIL` (requested in `.provision`; not secret) and **redeploy**. `/terms`,
   `/privacy`, `/robots.txt`, `/sitemap.xml` and the og:image are prerendered at build time,
   so they pick up `CONTACT_EMAIL` and the production host (`APP_URL`, else Vercel's
   `VERCEL_PROJECT_PRODUCTION_URL`) from the build's env.
6. **Stripe (M3, requested in `.provision`; no monthly fee, Stripe takes a cut of each
   payment).** Do this in Stripe test mode first, then live:
   - create the product "LienClock Pro" at US$29/month (recurring);
   - create a **Payment Link** for it, with "After payment → redirect" set to
     `https://<production host>/jobs?billing=success`;
   - add a **webhook endpoint** `https://<production host>/api/stripe/webhook` for
     `checkout.session.completed`, `customer.subscription.updated` and
     `customer.subscription.deleted`;
   - turn on the **customer portal** with "cancel at end of billing period", the default and
     what terms §6 promises.

   Store the link as `STRIPE_PAYMENT_LINK`, the webhook signing secret as
   `STRIPE_WEBHOOK_SECRET` and the portal login link as `STRIPE_PORTAL_URL`, then **redeploy**.
   Until the link and the secret are both set, billing is off and everything is free; the
   webhook answers 500 without its secret (fails closed).
7. **Fixing an account by hand** (e.g. someone paid with a different email): in Neon's SQL
   editor, `UPDATE accounts SET subscription_status = 'active' WHERE email = '<their
   address>';`. The next Stripe event for their subscription won't reach this account, because
   its subscription id isn't stored, so also set `stripe_subscription_id` from the Stripe
   dashboard.
8. The first cron run after the M3 deploy records the 10 new states on `/changelog` (no emails:
   nobody can have a job there yet). From then on, deploying an edited `rules/rules.json` is
   enough: the next daily run records the change and emails the people affected.

All services are free tiers: Vercel Hobby, Neon free, Resend free (100 emails/day, 3,000 a
month, with received mail counting toward the quota). Stripe has no fixed cost.

## Exit criteria

| # | Exit criterion (ROADMAP M3) | Status |
|---|---|---|
| 1 | A rules change creates a changelog entry and queues emails only for jobs in that state | ✅ pass: `test/m3-exit-criteria.test.ts` M3-EC1. A Texas rule edit → exactly one TX entry with the before → after deadline. It queues 3 emails (TX-only account, CA+TX account, M1-era TX job), none for the CA-only account, and each lists only that address's TX jobs. A rerun adds nothing. The end-to-end variant goes through the cron route and sends exactly those 3 through a stubbed Resend. |

The exit-criterion tests failed before the code existed (`Cannot find package '@/lib/changelog'`).
To check they aren't vacuous I made two mutations and reverted both:
1. dropping the state filter from the recipient query made both M3-EC1 tests fail ("expected
   4 addresses, got 3");
2. putting `lastVerified` back into the fingerprint made the re-verification test fail.

M3 deliverables:

| Deliverable (ROADMAP M3 + REVENUE.md) | Status |
|---|---|
| Stripe subscription at $29/mo | ✅ Payment Link + signed webhook + Free/Pro limit on every job-creation path + portal link (`test/billing.test.ts`, `test/m3-app.test.tsx`). Live once Stripe is provisioned (`.provision`). |
| 10 more states | ✅ CO, GA, IL, MN, NJ, NY, OH, PA, UT, VA: 17 rules, ≥5 hand-counted statute fixtures per state (PRD metric), 53 new fixtures in all (`test/rules.test.ts`). |
| Rule-change changelog with email to affected users | ✅ automatic detection, `/changelog`, emails per address (`test/changelog.test.ts`, M3-EC1) |
| og:image (REVENUE.md) | ✅ `/opengraph-image`, 1200×630 PNG (`test/legal.test.tsx`) |
| Price in the terms (REVENUE.md, M2's open item) | ✅ terms §6, privacy (`test/legal.test.tsx`) |

**Existing tests changed in M3**, all because M3 changes what's expected, and none loosened:
- `test/rules.test.ts` "covers exactly CA, TX, FL, WA, AZ, NV" → the exact 16-state list. It
  also checks that WA, GA, NJ, NY and VA have no notice rule, and that NC and MI are absent.
- `test/CalculatorPage.test.tsx`: the "LienClock covers … for now." message lists 16 states.
- `test/exit-criteria.test.ts` M1-EC6:
  - the states with no deadline before a last-furnishing date were "WA only"; now it's an
    explicit list (WA, CO, GA, IL, NJ, NY, VA);
  - the "last verified ≤ 2026-10-25" bound still holds for the six M1 states, and the new
    states use 2026-11-08.
- `test/legal.test.tsx`: the sitemap's exact page list gains `/changelog`; the processors
  check gains Stripe.
- `test/cron.test.ts`: the exact-match response gains the `ruleChanges` field.

| # | Exit criterion (ROADMAP M2, still passing) | Status |
|---|---|---|
| 1 | ICS feed validates and contains one VEVENT per deadline | ✅ pass: `test/m2-exit-criteria.test.ts` M2-EC1 (independent RFC 5545 checker, itself tested in `test/icsValidator.test.ts`; 6 deadlines over CA/TX/WA jobs → 6 VEVENTs with matching UIDs and dates; another account's job absent) |
| 2 | A forwarded sample PO email yields state and date fields flagged "unconfirmed" | ✅ pass: M2-EC2 (`state` AZ and `firstFurnishDate` 2026-03-02, `status: 'unconfirmed'`, with source lines), plus end to end through a signed webhook: proposal stored, no job until confirmed |

M2 deliverables: auth ✅, multiple jobs per account ✅, ICS feed ✅, email-forward intake ✅.
Intake runs end to end in tests. In production it needs the Resend Inbound line in
`.provision`; until then, the paste box works.

Both M2 exit-criteria tests were already passing when M2 run 2 started (see "Where M2 stood"
in the M2 plan). That run's three mutations each made them fail, so they test what they claim.

REVENUE.md "before charging", all done now:

| Item | Status |
|---|---|
| Terms with a clear "reference tool, not legal advice" disclaimer | ✅ M2: `/terms`, agreement shown at every account entry point |
| Privacy policy | ✅ M2: `/privacy`, plus self-serve "Delete my account"; M3 adds Stripe |
| Rules "last verified" date on every result | ✅ since M1 (EC6), for all 16 states |
| robots.txt, sitemap | ✅ M2; M3 adds `/changelog` |
| og:image | ✅ M3 |
| Stripe payment link / checkout | ✅ M3 (live once `.provision`'s Stripe request is done) |

| # | Exit criterion (ROADMAP M1, still passing) | Status |
|---|---|---|
| 1 | CA job, first furnish 2026-03-01 → preliminary notice deadline 2026-03-21 | ✅ pass (EC1) |
| 2 | CA notice served 2026-04-10 (day 40) → protection only from 2026-03-21 onward | ✅ pass (EC2) |
| 3 | TX job, last furnish 2026-02-10 → lien filing deadline 2026-06-15 | ✅ pass (EC3) |
| 4 | WA job, last furnish 2026-01-10 → lien recording deadline 2026-04-10 | ✅ pass (EC4) |
| 5 | A job 7 days before a deadline enqueues exactly one 7-day alert, none duplicated on rerun | ✅ pass (EC5) |
| 6 | Every returned deadline includes a non-empty citation URL and last-verified date | ✅ pass (EC6) |

`npm test` passes: **540 tests in 23 files**. The 394 tests from before M3 still pass
(five changed as listed above), and 146 are new:
- `m3-exit-criteria` 2;
- `changelog` 22;
- `billing` 30;
- `m3-app` 14;
- 78 in `rules`, `dates` and `legal`: 53 statute fixtures, 7 validator rejections, 2 rules
  checks, 10 `addMonths` cases, 6 legal/og:image checks.

`npm run typecheck` and `npm run build` are clean. The build lists `/opengraph-image`,
`/privacy`, `/terms`, `/robots.txt` and `/sitemap.xml` as static, and `/changelog` and
`/api/stripe/webhook` as dynamic.

## Infrastructure

Requested in `.provision`. No secret values appear anywhere in the repo; code reads them from env.
`.provision` was missing from the repo at the start of M2 run 2, which recreated it with every
line below; M3 adds the Stripe line. Lines that were already provisioned for the live M1
deploy should be no-ops for the broker.

| Line | Gives | Used by |
|---|---|---|
| `neon db lienclock` | `DATABASE_URL` (Neon Postgres, free) | `src/lib/db.ts` |
| `vercel project lienclock` | Vercel Hobby project with the stored values as env | deploy + cron |
| `request "CRON_SECRET …"` (M1) | random bearer secret for the cron route | `src/lib/cron.ts` (fails closed) |
| `request "Resend API key …"` (M1) | `RESEND_API_KEY` (free tier) | alert emails |
| `request "Full-access Resend API key …"` (M2) | the same `RESEND_API_KEY`, with full access | sign-in emails (`src/lib/auth.ts`) and reading received mail (`src/lib/inbound.ts`) |
| `request "Resend Inbound webhook …"` (M2) | `RESEND_WEBHOOK_SECRET` (secret) and `INTAKE_EMAIL_DOMAIN` (not secret) | `/api/intake/email` (fails closed) and the dashboard's forwarding address |
| `request "Support address …"` (M2) | `CONTACT_EMAIL` (not secret): the address for privacy and support requests | the contact line on `/privacy` and `/terms` (`src/lib/site.ts`, shown only if it's a plain address) |
| `request "Sending domain …"` (**M3**) | `ALERT_FROM_EMAIL` (not secret) on a subdomain of a domain RepoHQ already owns, verified in the existing Resend account ($0; free plan allows one domain) | every email (sign-in links, alerts, rule-change emails) reaching people other than the Resend account owner |
| `request "Stripe billing …"` (**M3**) | A Stripe account (no monthly fee): the LienClock Pro product at US$29/month, its Payment Link (`STRIPE_PAYMENT_LINK`, not secret), a webhook endpoint for `checkout.session.completed` and `customer.subscription.updated`/`deleted` (`STRIPE_WEBHOOK_SECRET`, secret), and the customer portal (`STRIPE_PORTAL_URL`, not secret) | `src/lib/billing.ts`: the subscribe link, the job limit, `/api/stripe/webhook` (fails closed) and "Manage billing or cancel". Billing stays off until the link and the secret are both set. |

No Stripe API key is requested: payment goes through a Payment Link and the portal, and only
the webhook's signing secret reaches the app. M3 needs no other new service, because the
rules changelog uses the existing database, cron and Resend sender. There's no
session-signing secret either, because session and link tokens are random and stored hashed.
Optional, not secret: `ALERT_FROM_EMAIL`, `APP_URL`, `CONTACT_EMAIL`, `STRIPE_PORTAL_URL`.

## Decisions made without asking (non-interactive run)

M3 (this run):
- **Which 10 states.** I took the largest construction markets after the M1 six, keeping only
  states whose rules the status model can show truthfully. **In: CO, GA, IL, MN, NJ, NY, OH,
  PA, UT, VA. Out: NC and MI.**
  - In NC, a late Notice to Lien Agent is still good unless a buyer or lender recorded
    first.
  - In MI, a late Notice of Furnishing cuts the lien by what the owner paid before receiving
    it.
  - LienClock would show both as "missed", which is wrong. Adding them needs a third
    late-notice outcome (What's left).
- **Statute research the same way as M1.** I ran four parallel WebSearch passes over quoted
  statute text, because page fetches are blocked in the sandbox, so `lastVerified: 2026-11-08`
  means "checked against quoted text".
  - Citation links go to official legislature sites where a per-section page exists.
  - Elsewhere they go to public copies, and each note says so: GA (no official per-section
    site), CO (official code only as whole-title files) and NJ (no stable per-section link;
    the link is the 2010 law that set the wording).
  - `rules.json`'s `verification` field records all this. **A full read of each page and an
    attorney review are still required.**
- **The earlier, safe date, as in M1.** These counts run from something LienClock doesn't
  know, so they're counted from the sub's last furnishing:
  - **VA**: 90 days after the end of the month, capped at 90 days after completion;
  - **UT**: 180 days after final completion of the GC's contract;
  - **IL**: "4 months after completion", and recording later still binds the owner but not
    third parties.

  That date is never later than the real deadline, and each note says so.
  "N months after" uses the same day, or the month's last day when it's shorter (Colorado's
  § 2-4-108(3) says exactly this).
- **Notices of intent are their own deadlines** (CO "at least 10 days before filing" →
  4 months less 10 days; PA "at least 30 days before" → 6 months less 30 days). The last
  day to serve them is what a sub actually has to hit, so they get alerts.
- **Conditional notices are shown on every job in the state**, with the condition in the
  note: OH (once a notice of commencement is recorded), PA (projects of $1.5M or more with a
  Notice of Commencement) and MN (exempt above 5,000 sq ft nonresidential). Serving an
  unneeded notice costs little, and missing a needed one loses the lien. A "doesn't apply"
  switch is in What's left.
- **Changes are detected, not declared.** The cron diffs the shipped rules against a
  per-state snapshot in the database, so an edit can't ship without a changelog entry and
  emails.
  - `lastVerified` alone isn't a change, so re-checking a rule emails nobody. Any other field
    is a change, a note's wording included; over-notifying beats a silent change to legal
    guidance.
  - A fresh database starts from `rules/baseline-2026-10-25.json`, a byte-identical copy of
    the rules M1–M2 shipped (checked with `cmp`). So the first sync records exactly what M3
    added, and nobody is emailed about rules they already had.
- **One changelog entry per state per change, one email per address.** Grouping by address
  covers account jobs and M1-era jobs alike, and one person with five Texas jobs gets one
  email listing all five. Every job in the state counts, done or not, because a rule change
  can turn a served notice into a late one.
- **Pricing: Free = calculator + 1 tracked job; Pro = $29/month, unlimited** (ROADMAP's price,
  REVENUE.md's "$29/month flat"). REVENUE.md suggested enabling accounts by hand after a
  payment link. A one-job free plan lets a sub try alerts on a real job and still needs
  Pro for real use (several jobs at once). The webhook replaces the by-hand step at no extra
  cost. Annual $290 is left for a second Payment Link.
- **Billing is on only when both `STRIPE_PAYMENT_LINK` and `STRIPE_WEBHOOK_SECRET` are set.**
  Otherwise there's no way to pay, or no way to record payment, and a limit would lock people
  out. Until then the site says "free during early access".
- **When Pro ends, tracked jobs keep their alerts;** only new jobs beyond the Free limit are
  blocked. LienClock never silently stops warning about a deadline someone relies on. The
  cost: someone could subscribe for a month, add many jobs and cancel. That's acceptable at
  this scale, and it's in the review.
- **`past_due` keeps Pro** while Stripe retries the card (the dashboard warns). `incomplete`
  (a slow payment method) doesn't count yet, and the dashboard says it's confirming.
- **No Stripe API key.** Payment Link + customer portal + webhook covers subscribing,
  cancelling and card changes. The price of that: deleting an account can't cancel its
  subscription, so **deletion is refused while one is active**, with a link to the portal.
- **Unmatched payments** (the link used without our reference, with an email that has no
  account) are acknowledged and logged, not retried; David fixes them by hand (Deploy, step 7).
- **Rule-change emails have a daily cap of 50 and go after the alerts:** Resend's free 100 a
  day is shared with sign-in links and deadline alerts, and alerts matter more.
- **The og:image says the price.** It's generated by `next/og` and prerendered, so there's no
  binary to keep in sync with the copy.
- **Screenshots** show the Pennsylvania result, the Pro dashboard and the changelog. The
  start page (an empty form) adds the least and was cut to stay within 6 images. The
  script plays Stripe's part with a webhook signed by a secret it makes up at runtime, so
  the screenshots show a real Free → Pro transition without a Stripe account.

M2, run 2:
- **Don't rebuild what's there.** The timed-out run's M2 code is complete and tested, so this
  run verifies it (with mutations) instead of rewriting it, and keeps the ICS feed and intake
  even though REVENUE.md says they "can wait". Removing working, tested features would be
  churn.
- **Legal pages, deletion, robots and sitemap are M2.** They belong to accounts: M2 is when
  LienClock starts storing people's email addresses and forwarded POs, and when private and
  token-bearing URLs appear. **The og:image is M3,** where the pricing it should show
  exists. Stripe is M3 as planned.
- **The legal text is my plain-English draft, not a lawyer's.** It covers the risks
  REVENUE.md names (wrong deadline → lost lien right): not legal advice, not a law firm, check
  each date, alerts can fail, as is, and a liability cap of the greater of 12 months' fees
  and US$50. It has **no governing-law or arbitration clause**, because the operator's entity
  and state are unknown. "Last updated" is `LEGAL_UPDATED` in `src/lib/site.ts`.
- **Agreement is a notice next to the button** ("By signing in, you agree to …"), not a
  checkbox. It sits next to each button that leads to an account, including the one that
  creates it. Acceptance isn't tracked per version: the terms are dated, and
  `accounts.created_at` shows when someone agreed. Add a column if the terms ever need
  re-acceptance.
- **Self-serve deletion instead of "email us".** There's no contact address yet, and a
  deletion that runs at once keeps the privacy policy true without anyone working through
  requests. The confirmation is a required checkbox (checked on the server too), not a typed
  phrase or a re-sent email link: deleting every job one by one needs no more than a
  session either.
- **Deletion also removes M1-era jobs** without an account whose alert address matches
  (case-insensitive). The person has just proved they own that address, and "delete my
  account" should mean LienClock stops emailing it.
- **Terms say "free during early access."** That's true until M3 adds Stripe, which must
  update §6 (Price) and `LEGAL_UPDATED`.
- **`CONTACT_EMAIL` is optional and strict.** It's shown only if it looks like a plain
  address (`[a-z0-9._%+-]@…`), because it becomes a `mailto:` link. Without it, the pages
  point to the self-serve controls.
- **robots.txt disallows the private prefixes but doesn't replace `noindex`.** The private
  pages keep their `noindex` meta and the feed its `X-Robots-Tag`, for crawlers that ignore
  robots.txt or find a leaked URL elsewhere.

M2, run 1:
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

ROADMAP M1–M3 are built. Remaining, most important first:

- **Launch blockers outside the code:**
  - **A sending identity that reaches real users.** Resend's shared sender only delivers to
    the Resend account owner, so sign-in links (and so accounts), alerts and rule-change
    emails don't reach anyone else yet. M3's decision: no single-sender free provider fixes
    this, because sending "from" a free mailbox through a third party fails DMARC. The $0
    route is a **subdomain of a domain RepoHQ already owns**, verified in Resend (the free
    plan allows one domain), plus `ALERT_FROM_EMAIL`. It's requested in `.provision`;
    buying a new domain would break the $0 rule.
  - **Stripe** (requested): product, Payment Link, webhook, portal (Deploy, step 6). Until
    then everything is free.
  - Provisioning Resend Inbound and `CONTACT_EMAIL` (requested).
  - **Attorney review** of the 28 rules (the 17 M3 rules were checked only against quoted
    statute text) and of `/terms` (now including §6 billing) and `/privacy`: governing law,
    the liability cap, the operator's legal name, sales tax on SaaS.
  - **Delete `docs/screenshots/home-desktop.png` and `home-mobile.png`.** They're M2's
    screenshots, no longer produced or linked. This session's permission mode refused `rm`,
    so the caller should delete them before committing to stay at 6 PNGs.
- **Billing:**
  - an annual plan ($290/year, REVENUE.md) as a second Payment Link;
  - a `STRIPE_SECRET_KEY` integration if needed later: cancel on account deletion,
    proration, invoices in-app;
  - an email when a payment fails (Stripe can send its own).
  - The "subscribe, add many jobs, cancel" pattern is tolerated (tracked jobs keep alerts).
    Revisit if it's abused.
- **Rules:**
  - NC and MI, which need a third late-notice outcome: "valid unless a buyer/lender recorded
    first" (NC), "reduced by payments made before the notice" (MI);
  - a per-job "doesn't apply" switch for conditional notices (OH, PA, MN);
  - optional human-written "why it changed" notes on changelog entries;
  - VA's exact "end of month + 90" date;
  - notice-of-completion dates (CA/AZ/NV/UT); TX retainage and specially fabricated
    materials; the FL contract-termination variant; the supplier role;
    residential/public/bond rules; enforcement-suit deadlines;
  - NJ bill A889 (90 → 240 days) if it passes. The changelog will email NJ users when the
    rule is edited.
- **Intake:** PDF attachments (many POs arrive as PDFs; only the email body is read today),
  an optional LLM fallback (e.g. a free Gemini tier via `gcp key`) behind the same
  "unconfirmed" flags, and a project-name field to tell jobs with the same GC apart.
- **Auth hardening:** per-IP rate limits, the `__Host-` cookie prefix, a session list with
  "sign out everywhere", and changing the account email.
- **Ops:**
  - pagination of the cron's job scan past roughly 10k jobs;
  - batching alert inserts;
  - a paid email tier, or more spacing, if a rule change ever needs more than 50 emails a
    day.
- Data export stays optional: the dashboard and the ICS feed already show everything stored.

## Review

### M3 (this run)

I reviewed this run's diff (`git status` and `git diff`, plus the new untracked files; the tree
also still holds M2 run 2's uncommitted changes) against gstack's checklist, Pass 1 CRITICAL
and Pass 2 INFORMATIONAL, with the Fix-First heuristic. Nobody answers questions in this run,
so I made the "ASK" calls myself.

**CRITICAL: none found.**
- **SQL & data safety:** every value is a parameter.
  - The one interpolation is the queue table name in the shared send loop (`alerts.ts`). It
    comes from a two-entry constant map (`QUEUES`), never from input.
  - The changelog writes are a compare-and-swap on `rule_snapshots.revision` plus
    `UNIQUE(state, revision)` and `UNIQUE(change_id, to_email)`. Three simultaneous syncs
    are tested and produce one entry and one email.
- **Races:** the job limit is one `INSERT … SELECT … WHERE count < limit` statement. Webhook
  updates are single `UPDATE … WHERE billing_updated_at <= event time` statements, so replays
  and late deliveries are no-ops (tested).
- **Webhook trust boundary** (the checklist's untrusted-input item, applied to Stripe):
  - the signature is checked over the raw body, in constant time, within 5 minutes, with a
    256 KB cap, and it fails closed without the secret;
  - the event shape is checked, Stripe ids and statuses are matched against strict patterns,
    `client_reference_id` must be a uuid, and the email goes through `parseEmail`;
  - it writes only the four billing columns, so a forged reference can at most pay for
    someone else.
- **XSS:** no `dangerouslySetInnerHTML`. Changelog text and Stripe-derived state reach pages
  only through React. A status is never shown raw; it picks one of a few fixed messages. The
  checkout URL is built with `URL`/`searchParams`, and the payment and portal links must be
  https, so a `javascript:` value is ignored (tested).
- **Enum completeness**, with every consumer read:
  - **Stripe statuses:** `isPaid` (active, trialing, past_due) is used by the plan section,
    the limit and the deletion guard. Each status has its own message: trialing,
    past_due (warning), incomplete ("confirming", fixed below), and everything else
    ("ended").
  - **The `months` offset unit:** handled in `validateOffset`, `applyOffset` and
    `describeDeadline`. The last two are exhaustive switches that TypeScript checks.
  - **Negative `lateLookbackDays`:** handled in `statusFor`, the deadline table's "Served late"
    text, the ICS "Covers work from" line and `describeLateNotice`.
  - **New codes:** `?error=job-limit` (shown in `#plan`), `?error=delete-subscribed` (in
    `#account`), `?limit=1` (calculator) and `?billing=success` (plan section) are each
    rendered. `ConfirmResult` `limit` is handled by the action.
  - **Change kinds:** added, changed and removed are handled on the page and in the email.
- **Secrets:** none in the repo.
  - Tests build fake Stripe and cron secrets at runtime from parts.
  - The screenshot script makes up random secrets at start and never prints them.
  - `.env.example` has empty values, and `.provision` holds only requests.
  - No Stripe API key exists anywhere.

**Fixed (found in review)**
- [P2] (confidence: 9/10) `src/app/layout.tsx`: the new `metadataBase` was `new URL(APP_URL)`,
  which throws when `APP_URL` is set without a scheme (`lienclock.com`). Because
  `generateMetadata` runs on every page, that would have taken the whole site down. It now
  falls back to no base URL (test added).
- [P2] (confidence: 9/10) `src/app/jobs/page.tsx`: a checkout paid by a slow method (Stripe
  status `incomplete`) showed "Your Pro subscription has ended". It now says "Stripe is still
  confirming your first payment", with a test.
- [P3] (confidence: 9/10) `src/lib/dates.ts`: an `endOfMonth` helper, written before I settled
  on Virginia's safe 90-day reading, was dead code. Removed with its tests.
- [P3] Two mutation checks (see "Exit criteria") to prove the new exit-criterion and
  re-verification tests can fail. Both reverted.

**Left open (recorded, not fixed)**
- [P2] (confidence: 8/10) No sending identity yet, so emails reach only the Resend account
  owner. This is a launch blocker outside the code; a $0 subdomain is requested in `.provision`.
- [P3] (confidence: 7/10) `src/lib/jobs.ts` `createJob` with a limit: simultaneous saves by one
  Free account on Neon can overshoot by the number in flight, the same caveat as M2's rate
  limits. An advisory lock per account would make it exact.
- [P3] (confidence: 6/10) Medium confidence, verify. `deleteAccountAction` reads the
  subscription status with the session, then deletes. A checkout completing in that same
  instant (paying in another tab) would delete a just-paid account. The webhook then matches
  nothing and logs it, and David refunds by hand. A `WHERE subscription_status NOT IN (…)`
  guard in the DELETE would close it, but then the action has to tell "refused" from
  "already gone", which is a larger change for a sub-second window.
- [P3] (confidence: 5/10) Medium confidence, verify. Stripe event times have 1-second
  resolution. Two events for one subscription in the same second, delivered out of order, let
  the later delivery win. A later event corrects it.
- [P3] Rule-change emails: at most 50 a day, after alerts. A change affecting hundreds of
  addresses takes days at the free Resend tier.
- [P3] By design, any material edit (a note's wording included) emails everyone tracking a job
  in that state. Fix typos together with a real change, or accept the email.
- [P3] Changes reach `/changelog` and inboxes at the next daily cron, not at deploy.
- [P3] The intake review page doesn't warn about the Free limit before "Confirm"; the refusal
  comes after the click, and the email stays waiting for review.
- [P3] `docs/screenshots/home-*.png` are stale (see What's left): the sandbox refused `rm`.

### M2, run 2

Self-review of this run's diff (`git status`, `git diff`, plus the new untracked files) against
gstack's checklist, Pass 1 CRITICAL and Pass 2 INFORMATIONAL, with the Fix-First heuristic.
Nobody answers questions in this run, so I made the "ASK" calls myself.

**CRITICAL: none found.**
- **SQL & data safety:** `deleteAccount` is one parameterized statement with a uuid guard
  before it. No interpolation, no check-then-act. Its cascade over three paths (accounts →
  jobs → alerts, accounts → intake_proposals, and the proposals' `job_id SET NULL` inside the
  same statement) runs in a test on real Postgres (PGlite).
- **Races:** deletion is one statement, so there's no TOCTOU. A double submit is tested: the
  second request has no session and deletes nothing.
- **XSS / injection:** no `dangerouslySetInnerHTML`. `CONTACT_EMAIL` is validated against a
  plain-address pattern before it becomes a `mailto:` link (tested with header-injection and
  markup values). Everything else on the new pages is static text.
- **Auth:** `deleteAccountAction` takes the account from the session, never from the form.
  It needs the confirmation on the server, not just the `required` attribute, and keeps
  Next's Origin check. A signed-out call is sent to sign in.
- **Enum completeness:** the new codes are `?error=delete-confirm` (shown inside the
  `#account` section the redirect scrolls to, and deliberately not in the top-of-page
  `ERRORS` map, so it isn't shown twice) and `?accountDeleted=1` (the calculator's flash).
  Every private route of the build (`/jobs`, `/jobs/[id]`, `/signin`, `/intake/[id]`,
  `/calendar/[feed]`, `/api/*`) falls under a `PRIVATE_PATHS` prefix, and the public ones
  (`/`, `/privacy`, `/terms`, `/robots.txt`, `/sitemap.xml`) don't (tested).
- **Secrets:** none. `.provision` holds only provisioning requests, and the new tests need no
  credentials, real or fake.

**Fixed (INFORMATIONAL, auto-fixed)**
- [P2] (confidence: 9/10) `src/app/privacy/page.tsx`. The policy said expired sign-in links
  and sessions are "cleaned up automatically", but the code only deletes them on later
  sign-ins (links after a day; an account's sessions when that account next signs in). The
  wording now says what happens: they stop working at once, are cleared out over time, and
  all go with the account.
- [P3] (confidence: 9/10) `src/lib/site.ts`. `parseEmail` accepts `"><script>@x.co`.
  React would escape it, but it's no contact address. `contactEmailFrom` adds a
  plain-address check (caught by the test written first).

**Left open (recorded, not fixed)**
- [P3] (confidence: 7/10) `src/lib/auth.ts` `deleteAccount` vs `finishSignIn`. If someone
  clicks a sign-in link in the same instant the account is deleted, `finishSignIn` can find
  the old account and then fail to insert a session (FK). The user sees an error and signs in
  again, which creates a fresh account. Nothing leaks or survives.
- [P3] (confidence: 6/10) Medium confidence, verify. The legacy-job match
  `lower(alert_email)` has no index, so deletion scans `jobs`. That's fine at MVP scale, and
  M1-era rows stop being created. Drop the clause once no account-less jobs remain.
- [P3] Deleting an account also deletes its sign-in-link rows, which reset that address's
  per-address rate limit. It needs a completed sign-in per cycle, and the global hourly cap
  still applies, so it isn't a useful abuse path.
- [P3] The legal pages are prerendered, so changing `CONTACT_EMAIL` needs a redeploy (noted
  under Deploy).
- [P3] No browser click-through in this sandbox. `next build` passes, and the new pages,
  forms and actions are rendered or called in tests.

### First M2 run

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
