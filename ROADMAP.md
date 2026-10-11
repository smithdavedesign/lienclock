# lienclock — roadmap

## M1 — Deadline calculator and job list (one weekend)
Deliverables:
- Rules table for CA, TX, FL, WA, AZ, NV (commercial, sub role) with citations and verified dates.
- `computeDeadlines(job)` function and a minimal web form that lists a job's deadlines.
- Email alert scheduler (14/7/2/0 days).

Exit criteria (testable):
- CA job, first furnish 2026-03-01 → preliminary notice deadline 2026-03-21.
- CA job notice served 2026-04-10 (day 40) → status reports protection only from 2026-03-21 onward.
- TX job, last furnish 2026-02-10 → lien filing deadline 2026-06-15 (15th of fourth month after).
- WA job, last furnish 2026-01-10 → lien recording deadline 2026-04-10.
- A job 7 days before a deadline enqueues exactly one 7-day alert and none duplicated on rerun.
- Every returned deadline includes a non-empty citation URL and last-verified date.

## M2 — Accounts, calendar feed and intake
- Auth, multiple jobs per account, ICS feed.
- Email-forward intake proposing fields.

Exit criteria: ICS feed validates and contains one VEVENT per deadline; a forwarded sample PO email yields state and date fields flagged "unconfirmed".

## M3 — Billing and more states
- Stripe subscription at $29/mo, 10 more states, rule-change changelog with email to affected users.

Exit criteria: a rules change creates a changelog entry and queues emails only for jobs in that state.

## Suggested stack
- TypeScript + Next.js on Vercel Hobby: one codebase for form, API and cron.
- SQLite/Turso or Neon free tier: small relational data.
- Resend free tier: alert emails.
- Rules as versioned JSON in the repo: reviewable diffs and tests.
- Vitest: table-driven date fixtures.
