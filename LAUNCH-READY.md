# lienclock: launch readiness

The go-live pass changes nothing about what LienClock does. It adds search and sharing tags, the
legal pages' new lines, a "Get LienClock Pro" button, the RepoHQ visit beacon, and hosting on
Cloudflare Workers (the Vercel account answers 402 to every deployment). `npm test` passes: **581
tests in 25 files** (547 before; none deleted or loosened, one changed, see below).

## What I did

1. **Search and sharing.** Each public page (`/`, `/changelog`, `/privacy`, `/terms`) has its own
   `<title>` and meta description. It also has a canonical URL, Open Graph tags and a
   `summary_large_image` Twitter card with the 1200×630 share image. The helper is
   `src/app/seo.ts`, used by each page's `metadata`.
   - The share image is `src/app/opengraph-image.tsx`, drawn with code by `next/og` and
     prerendered at build time. Each page names it explicitly. Without that, a page that sets its
     own `openGraph` drops the image Next.js adds from the file, which the first build showed.
   - Every page carries JSON-LD: a `SoftwareApplication` with an `Offer` of US$29, priced per
     month (`UnitPriceSpecification`, `unitCode: MON`). It's built from constants, with `<`
     escaped.
   - `robots.ts` (allow `/`, keep crawlers off private paths, point at the sitemap) and
     `sitemap.ts` (the 4 public pages) were already there from M2.
   - Every URL resolves against `APP_URL`.
2. **Privacy and terms.**
   - `/privacy` has a new "Visit counts" section. It names the three events (visit, activate,
     checkout), what each message holds and what it never holds, the two storage flags, and the
     opt-outs.
   - Cloudflare is now named as the host, in place of Vercel.
   - Both pages end with **Contact**: the GitHub repo's issues
     (https://github.com/smithdavedesign/lienclock/issues), with a warning that issues are public.
     `CONTACT_EMAIL`, if set at build time, is added for private requests.
   - The terms already had "No warranty" (§8) and the price and refund line (§6: US$29/month,
     renews monthly, cancel anytime, no refunds for partial months).
   - The footer links to Pricing, Rule changes, Terms of Use, Privacy Policy and Contact.
   - `LEGAL_UPDATED` is now 2026-11-09.
3. **Payment.** The home page's pricing section shows **"Get LienClock Pro: $29/month"**, linking
   to `STRIPE_PAYMENT_LINK`.
   - The page is dynamic and reads the variable per request (`paymentLinkFrom`), so a Worker
     secret set with no rebuild shows up at once. Nothing is `NEXT_PUBLIC_`.
   - The button is hidden when the variable is unset or not https.
   - For a signed-in account, the link carries `client_reference_id` and `prefilled_email`, so the
     existing webhook knows who paid. It's hidden while Stripe holds a subscription for that
     account, so nobody is billed twice.
   - With the link but no `STRIPE_WEBHOOK_SECRET`, the page says the Free plan's 1-job limit
     isn't enforced yet, and `/jobs` offers the same button.
4. **Visit beacon** (`src/lib/signal.ts`, browser side in `src/app/Beacon.tsx`). It sends a
   fire-and-forget POST of `{"slug":"lienclock","kind":…,"referrer":…}` to
   `https://idea-factory.1426davejobs.workers.dev/api/ideas/signal`. It uses `keepalive`,
   `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`.
   - **visit**: on the 4 public pages, once per browser session (sessionStorage).
   - **activate**: the **core action**, which is the calculator showing the deadlines for a job
     (submit "Show deadlines" and the result renders). Once per browser (localStorage).
   - **checkout**: every click on a button that opens the Payment Link: Get Pro on the home
     page, Subscribe on `/jobs`, and the Free-limit message.
   - `referrer` is `document.referrer` only when its origin differs from `location.origin`,
     else `null`.
   - Nothing is sent when `navigator.webdriver` is true, when the build isn't production, or when
     localStorage holds `repohq:notrack`.
     - Production means `NEXT_PUBLIC_DEPLOY_ENV`, else `NEXT_PUBLIC_VERCEL_ENV`, is
       `"production"`. Both are inlined at build time, and `cf:build` sets the first.
5. **Cloudflare Workers (free plan)**, through the OpenNext adapter. `@opennextjs/cloudflare` and
   `wrangler` are dev dependencies; neither needs install scripts.
   - `open-next.config.ts` uses the static-assets incremental cache. `npm run cf:build` =
     `NEXT_PUBLIC_DEPLOY_ENV=production APP_URL=… opennextjs-cloudflare build && opennextjs-cloudflare populateCache local`.
     The last step copies the prerendered pages and the share image into the Worker's static
     assets, so they aren't rendered per request.
   - `wrangler.jsonc`:
     - `"name": "lienclock"`, `"workers_dev": true`;
     - `nodejs_compat` (Next.js, `node:crypto`, `pg`'s sockets);
     - static assets from `.open-next/assets`;
     - a daily Cron Trigger at the same time as `vercel.json`'s (15:00 UTC);
     - one var, `APP_URL`;
     - no `build` section.
   - `worker.ts` (the entry) wraps OpenNext's handler with `src/lib/worker.ts`. It adds two
     things:
     - **One database connection per request.** The Node.js pool shared by every request can't
       work on Workers, because a socket belongs to the request that opened it. On Workers,
       `getDb()` opens a `pg` client on first use within the request
       (`src/lib/requestScope.ts`). The Worker closes it once the response body has been sent,
       streamed pages included. The schema check runs once per isolate. On Node.js (Vercel,
       `next start`, tests) nothing changes.
     - **The daily cron.** The Cron Trigger's `scheduled` handler calls `GET /api/cron/alerts`
       in-process with `Bearer CRON_SECRET`, as Vercel Cron does. The route checks the secret as
       before. A failed run throws, so it shows as failed in the dashboard.
   - **Size:** about **1.83 MiB gzipped**, against a limit of 3 MiB. That's my estimate from
     gzipping the build output: server bundle 1.2 MiB, `next/og`'s wasm and font 0.6 MiB,
     middleware 0.03 MiB. `provision cloudflare deploy lienclock <dir> --dry-run` prints the
     official number.
   - No filesystem at runtime: without `DATABASE_URL` the Worker refuses, rather than falling back
     to the embedded PGlite.
   - The Vercel build (`npm run build`) is unchanged and still passes.
6. **Tests**:
   - `test/launch.test.tsx` (25): tags on every public page (unique titles and descriptions,
     canonical, Open Graph, Twitter, share image); JSON-LD and its escaping; robots and sitemap;
     the Get Pro button hidden without the env var and for non-https links, shown with it, and
     read per render; the pages render; footer links; the privacy and terms lines; the beacon's
     rules; the Worker config and `.provision`.
   - `test/worker.test.ts` (6): one connection per request, closed after the response; refusal
     outside a request or without `DATABASE_URL`; the cron trigger.
   - `test/m3-app.test.tsx` (+2): Get Pro for signed-in accounts, and link-only early access on
     `/jobs`.
   - `test/auth.test.ts` (+1): see the review below.
   - Two mutations were caught, then reverted: taking out the `navigator.webdriver` guard, and
     always showing the button.
7. **Screenshots** (`npm run screenshots`, production build, placeholder
   `STRIPE_PAYMENT_LINK=https://example.com/pay`). There are 6 PNGs: the start page with a sample
   job, its deadlines, and the plans with the Get Pro button and footer links, each on desktop and
   iPhone 13. I opened each one to check it. The run fails if the beacon sends anything (it
   doesn't: automated browser, not a production build). The README's Screenshots section shows
   them.

## How to check it

```bash
npm ci
npm test               # 581 tests, ~35 s
npm run typecheck
npm run build          # the Vercel build, unchanged
npm run cf:build       # the Worker: .open-next/ (worker.js, assets with the prerendered pages)
```

**The Worker locally, with a real Postgres wire protocol** (no Postgres install;
`scripts/pglite-wire.mjs` serves an in-memory PGlite on 127.0.0.1:54329):

```bash
node scripts/pglite-wire.mjs &
npx wrangler dev --test-scheduled --var DATABASE_URL:postgres://postgres@127.0.0.1:54329/postgres \
  --var CRON_SECRET:any-local-value --var STRIPE_PAYMENT_LINK:https://example.com/pay
# then: /, /changelog (reads the database), /terms, /robots.txt, /sitemap.xml, /opengraph-image,
# and /__scheduled?cron=0+15+*+*+* (runs the daily cron through the scheduled handler)
```

I ran exactly this. Every page answered 200, with `APP_URL`-based canonical and og:image URLs,
the JSON-LD and the button. The first cron run recorded the 10 states added since the M1 rules,
and the second recorded nothing new. A wrong bearer secret got 401.

**After the deploy** (https://lienclock.1426davejobs.workers.dev):
- `/changelog` answers 200. It reads the database, so this proves the Worker reaches Neon over
  TLS, which I couldn't test here (the local check above uses plain TCP). If it answers 500,
  Workers Logs show the database error.
- `/robots.txt` and `/sitemap.xml` list the workers.dev URLs.
- View source on `/`: the title, description, canonical, `og:*`, `twitter:*` and the
  `application/ld+json` script. Paste the URL into a share-card previewer and into Google's Rich
  Results Test.
- In the browser's Network tab, the first page view sends one POST to `…/api/ideas/signal` with
  `"kind":"visit"`; reloads don't. Showing a job's deadlines sends `"activate"` once, and the Get
  Pro button sends `"checkout"`.
- **In David's own browser, run `localStorage.setItem('repohq:notrack', '1')` on the site once**,
  so his visits aren't counted.
- Workers Logs (observability is on): each day at 15:00 UTC, a `cron: {"ok":true,…}` line.

## Settings the Worker reads

Secrets are set by the credential broker (`provision cloudflare secret lienclock <KEY>`), never in
the repo.

| Name | Kind | Read by | Without it |
|---|---|---|---|
| `DATABASE_URL` | **secret** | `src/lib/db.ts`: one `pg` connection per request to Neon | pages that need the database answer 500 |
| `CRON_SECRET` | **secret** | the Cron Trigger sends it to `/api/cron/alerts` (`src/lib/worker.ts`, `src/lib/cron.ts`) | the daily run refuses (fails closed) |
| `RESEND_API_KEY` | **secret** | sign-in, alert and rule-change emails; reading forwarded mail (`src/lib/auth.ts`, `alerts.ts`, `inbound.ts`) | sign-in refuses on the Worker; alerts are queued, not sent |
| `RESEND_WEBHOOK_SECRET` | **secret** | `/api/intake/email` (`src/lib/inbound.ts`) | email intake refuses; the paste box still works |
| `STRIPE_PAYMENT_LINK` | **secret** (set by `provision stripe lienclock … --host cloudflare`) | the Get Pro and Subscribe buttons, read per request (`src/lib/billing.ts`) | no Get Pro button |
| `STRIPE_WEBHOOK_SECRET` | **secret** | `/api/stripe/webhook`; with the link, it turns on the Free plan's 1-job limit | early access: everyone unlimited, webhook refuses |
| `APP_URL` | var (`wrangler.jsonc`), `https://lienclock.1426davejobs.workers.dev` | sign-in links, emails, calendar feed, canonical URLs, sitemap, JSON-LD | links would point to localhost |
| `ALERT_FROM_EMAIL` | not secret, but its value is with the broker: set it as a secret like the rest (or as a var, never both) | the email sender | Resend's test sender, which only reaches the Resend account owner |
| `INTAKE_EMAIL_DOMAIN` | not secret, as above | the per-account forwarding address on `/jobs` | only the paste box is offered |
| `STRIPE_PORTAL_URL` | not secret, as above | "Manage billing or cancel" on `/jobs` | the link is hidden |

Build-time only, set by `npm run cf:build` and not on the Worker:
- `NEXT_PUBLIC_DEPLOY_ENV=production` turns on the beacon.
- `APP_URL` puts the host into the prerendered pages: terms, privacy, robots, sitemap.
- `CONTACT_EMAIL` is optional, and only read at build time because `/terms` and `/privacy` are
  prerendered. The GitHub issues link is the contact without it.

Not used on the Worker: `VERCEL`, `VERCEL_PROJECT_PRODUCTION_URL`, `NEXT_PUBLIC_VERCEL_ENV` (Vercel
only), and `PGLITE_DIR` (local dev). This app doesn't read `GOOGLE_API_KEY`.

## What's left for David

1. **The Stripe payment link.** `.provision` requests it. `provision stripe lienclock … --host
   cloudflare` puts it on the Worker as `STRIPE_PAYMENT_LINK`, and the Get Pro button appears
   without a rebuild. In Stripe, set the link's "After payment" redirect to
   `https://lienclock.1426davejobs.workers.dev/jobs?billing=success`.
2. **The Stripe webhook on the Worker's URL** (BUILD.md, Deploy step 6). The endpoint is
   `https://lienclock.1426davejobs.workers.dev/api/stripe/webhook`, and its signing secret becomes
   `STRIPE_WEBHOOK_SECRET`. Until then:
   - the Free limit isn't enforced (the site says so);
   - payments are only recorded in Stripe. Turn on Pro for early buyers by hand (BUILD.md, Deploy
     step 7).

   Any webhook created for the Vercel host is dead (402). The Resend Inbound webhook moves the
   same way, to `/api/intake/email` on the Worker.
3. **Confirm the Worker's URL.** I assumed the account's workers.dev subdomain is `1426davejobs`,
   the same account as `idea-factory`. If `provision cloudflare deploy` prints another URL, change
   `APP_URL` in `wrangler.jsonc` and in `package.json`'s `cf:build` (a test keeps them equal),
   then rebuild and redeploy. Sign-in links depend on it.
4. **A custom domain**, if he wants one: add it to the Worker in Cloudflare (free on a domain he
   already owns), then change `APP_URL` as in step 3.
5. **Owner's browser:** set `repohq:notrack`, as described in "How to check it".
6. Still open from BUILD.md: a verified sending domain for Resend (otherwise sign-in links reach
   only the Resend account owner), and an attorney review of the rules, terms and privacy policy.
7. **Watch the free plan's CPU limit** (10 ms per request). Static pages come from assets, but
   `/`, `/changelog` and the signed-in pages render per request. If Workers Logs show "Exceeded
   CPU" on them, the choices are trimming those pages or the Workers Paid plan. I couldn't measure
   CPU time locally: `wrangler dev` doesn't enforce the limit.

## Decisions made without asking

- **Worker URL:** `https://lienclock.1426davejobs.workers.dev`. Workers URLs are
  `<name>.<account subdomain>.workers.dev`, and the beacon's endpoint shows RepoHQ's subdomain.
  See "What's left", step 3.
- **Per-request `pg` client, not Neon's HTTP driver.**
  - It needs no new dependency (`pg` and `pg-cloudflare` were already installed).
  - One socket per request is one subrequest. Over HTTP every query is a subrequest, and the
    daily cron's dozens of queries would pass the free plan's 50 per invocation.
  - The connection is opened lazily (pages without a database don't open one), and closed after
    the response body has been sent.
- **Cron on Cloudflare = Cron Trigger → in-process call to the existing route,** so the secret
  check and the logic stay in one place.
- **Get Pro shows with the Payment Link alone,** as the task says. The early-access line changes
  to say the limit isn't enforced yet, instead of "paid plans aren't open". That keeps the page
  honest when the webhook secret isn't on the Worker yet.
- **"checkout" counts every click toward Stripe** (Get Pro, Subscribe, the Free-limit link), not
  only the home page button.
- **"activate" fires when the result renders.** That includes someone opening a shared calculator
  link with a job in it, which is still seeing the core result.
- **Contact is the GitHub issues.** The pages warn that issues are public and point to self-serve
  deletion. `CONTACT_EMAIL` stays optional.
- **Terms: price and refund line kept as they were.** REVENUE.md gives the price ($29/month) but
  no refund line, so §6's "no refunds for partial months, cancel anytime" stays. The $290/year
  plan isn't mentioned, because no link for it exists.
- **Screenshots:** start page, result, and plans with the footer, replacing M3's Pro dashboard and
  changelog shots (both still covered by tests). That's the order the task asks for, within 6
  images.
- **`next/og` stays,** even though its wasm (0.6 MiB gzipped) sits in the Worker bundle unused per
  request. The image is prerendered and served from assets, and the total is well under 3 MiB.
  Swapping it for a committed PNG would add a binary to keep in sync with the copy.
- **PGlite's JS is still bundled** (≈0.1 MiB gzipped) but never runs on the Worker. It's only a
  local and test fallback.

## Self-review (gstack pre-landing checklist)

I checked `git status` and `git diff` against "Review Categories" and the "Fix-First Heuristic".

CRITICAL:
- **[P1] (confidence 9/10) `src/lib/auth.ts`: fixed.** Without `RESEND_API_KEY`, sign-in links
  (bearer tokens) were printed to the console everywhere except Vercel. On the Worker that means
  the Workers Logs. It now fails closed on Workers too, with a test (`test/auth.test.ts`).
- **SQL & data safety:** no new SQL. On Workers the existing schema runs under its advisory lock
  once per isolate; concurrent first requests both run the idempotent DDL, serialized by the lock.
- **Race conditions:** the only state shared across requests is a boolean (`workerSchemaReady`)
  and the AsyncLocalStorage. Connections are per request.
- **Unsafe HTML:** one `dangerouslySetInnerHTML`, the JSON-LD. Its data is constants plus
  `APP_URL`, with `<` escaped, and a test feeds it `</script>`.
- **LLM trust boundary, shell injection:** none in this diff.
- **Enum completeness:** the new `SignalKind` (`visit`, `activate`, `checkout`) is a typed
  `Record` in `SENT_FLAGS`, and the privacy page names all three (tested).

INFORMATIONAL, fixed:
- **og:image and twitter:image were missing** on pages with their own `openGraph`. Now set
  explicitly, and tested.
- **A false "db: connection error: This socket has been closed"** was logged on every Worker
  request when the Worker closed the connection on purpose. It's silenced once closing starts.
- **`/jobs` said "Pro will cost $29/month once paid plans open"** while the home page sold Pro.
  It now offers the same button.

INFORMATIONAL, left:
- The bundle size items above (next/og wasm, PGlite JS).
- The free plan's CPU limit ("What's left", step 7).

**Existing tests changed** (none loosened):
- `test/legal.test.tsx`'s processor list now expects Cloudflare instead of Vercel, and checks
  Vercel is gone.
- `test/m3-app.test.tsx` gained two tests. Its existing ones are unchanged.
