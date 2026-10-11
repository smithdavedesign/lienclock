# lienclock — PRD

## Problem
Specialty subs and suppliers must serve preliminary notices and file liens within state-specific windows that run from first and last furnishing dates. Miss one and the unpaid balance loses its strongest collection leverage (e.g. CA: a notice served on day 40 forfeits the first 20 days of work). Deadlines are tracked in spreadsheets separate from billing, and rules differ by state, role and project type and change over time.

## Target user
Owner or office manager of a 2–25 person specialty subcontractor (or small supplier) doing commercial work in 2+ states, without a billing suite like Siteline. Painful moment: starting a new job on a GC's PO and not knowing which clock just started, then discovering months later it ran out.

## Competitors & gap
Levelset/Zlien ($19/notice, software from ~$149), LienDeadline (~$149/mo), LienDone ($49/mo, waivers), Siteline (billing suite), Handle (sending), Prelien (CA free), free state directories. Gap: a deadline-only per-job tracker with alerts at a flat $29–49/month, no per-notice fees, no billing system required.

## MVP scope
- Add a job: state, role (sub/supplier), project type (commercial), GC/owner, first-furnish date.
- Rules engine for 5–6 states returning each deadline with statute citation and last-verified date.
- Per-job deadline list sorted by urgency, with "protected / at risk / missed" status.
- Email alerts at 14, 7 and 2 days before each deadline.
- ICS calendar feed for all deadlines.
- Update last-furnish date to recompute filing windows.
- Email-forward intake that proposes job fields for user confirmation.

## Non-goals
- Sending or filing notices and liens.
- Legal advice; residential, public-works and bond claims in M1.
- Billing, waivers, or accounting integrations.
- Coverage of all 50 states at launch.

## Success metrics
- 100% of the rule fixtures per state (at least 5 each) match statute-derived expected dates in tests.
- Demand test: 100 landing visitors from contractor communities yields ≥10 email signups and ≥3 who say they'd pay $29/mo.
- ≥3 of 10 interviewed subs report missing or nearly missing a notice in the last 12 months.
- Post-launch: 10 paying accounts within 60 days at $29–49/mo.

## Open questions
- Will small subs pay for alerts without notice sending?
- Liability and disclaimer wording for a deadline tool.
- Who maintains rules as statutes change, and at what cost?
- Which states have the most small-sub pain per signup (CA, TX, FL?)?
