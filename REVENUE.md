# lienclock: road to first revenue

**Verdict: weak evidence that anyone will pay $29/mo for deadlines alone. Cheap to test, so test it, but with a hard kill date.** Confidence: Low.

## Where it stands (from state.json, 2026-10-26)
- M1 merged (rules for CA/TX/FL/WA/AZ/NV, `computeDeadlines`, alert scheduler). Live at https://lienclock-eta.vercel.app.
- M2 (accounts, ICS, email intake) timed out; M3 (Stripe) not started. The last build failed on a Docker sandbox error, which is infrastructure, not product.
- Missing: privacy and terms pages, og:image, robots.txt, sitemap. Zero users, zero MRR.

## Forcing questions, applied to money
**Who pays.** The owner or office manager of a 2–25 person specialty sub (drywall, electrical, concrete, roofing) doing commercial work in 2+ states, with no billing suite. I can't name a person. The research has no first-hand buyer quote; the demand evidence is vendor marketing (Siteline) and one reply-less forum post. Finding a real named person is the first task.

**What they pay today.** Mostly $0: spreadsheet, calendar, or a lien attorney when something goes wrong. Paid alternatives from third-party listings (my searches only reconfirmed the $149 figures, via GetApp and Software Advice; the others come from the earlier research and may be stale):
- LienDeadline: $149/mo flat starting price (GetApp), with a free tier of unknown limits. It already covers 50 states, with email reminders.
- Levelset/Zlien: listed from $149 per user per month (Software Advice); about $19 per notice send (TrustRadius snippet, unverified). One GetApp reviewer disputes the value of about $3,000 spent.
- LienDone: $49/mo, waivers.

Implication: **LienDeadline's free tier and 50-state coverage are the real threat.** A $29 tracker with 6 states has to beat free, not just $149.

**Narrowest version worth paying for.** Not the whole PRD. One job entry, deadlines with citations, and email alerts at 14/7/2 days. ICS and email-forward intake are nice-to-have and should not block charging. Charge for "I enter a job in 60 seconds and get warned before my rights lapse."

**Observation.** Nobody has used it. Assignment #1 is to watch three subs enter a real job.

## Price
$29/month flat (or $290/year), through a Stripe Checkout payment link. It sits below LienDone's $49, far below $149, and about the cost of two Levelset notice sends. Roughly one saved lien claim pays for years, but the buyer must believe they're at risk. If the first 10 conversations push back, drop to $19/month rather than add features.

## Shortest path
1. **Agent:** privacy policy and terms with a clear "reference tool, not legal advice" disclaimer, a rules "last verified" date on every result, og:image, robots.txt, sitemap. Finish M2 accounts only as far as magic-link login plus saved jobs (ICS and intake can wait).
2. **David:** create a Stripe payment link at $29/mo (RepoHQ → repo → Stripe product). No backend needed: after payment, enable the account by hand for the first 10 users.
3. **David:** post in the channels below, and also run 5 direct conversations. Ask: "when did you last miss or nearly miss a notice?" and "would you pay $29 today?" Send the payment link to anyone who says yes.
4. Use a free per-state "when is my deadline" calculator page as the lead magnet. Siteline and Levelset win this search traffic with content, so don't expect SEO to work in 60 days.

## Risks
- Wrong deadline means a lost lien right and possible liability. Disclaimers help but do not remove it. Verify each rule against statute before charging, and start with CA, TX and WA, where the roadmap has fixtures.
- Free or cheap competitors with 50-state coverage already exist.
- Small subs may call an attorney instead of adopting SaaS.
- Rule maintenance is ongoing, and six states changed their laws since 2023 (Siteline claim).
- No known personal network in the trade, so reach is cold.

## Kill criteria
Stop if, by 2026-12-31 (about 60 days from now): fewer than 3 of 10 interviewed subs report a missed or near-missed notice, or no one pays $29 (or $19) after 100 landing visitors and 10 direct pitches. Also stop if you find that the paying job is notice sending, which is non-goal and a $0-budget legal-liability problem.
