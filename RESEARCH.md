# lienclock — research

## Summary
Small specialty subcontractors and suppliers lose lien rights when they miss state-specific preliminary-notice and filing deadlines that run from "first furnishing" and "last furnishing" dates, not from invoices.
Paid tools exist but are either billing suites for commercial subs, per-notice services, or $149+/month platforms; a deadline-only tracker at a flat low price is the thin gap.
Evidence of payment is real (per-notice and monthly prices below) but the market is crowded and the legal-accuracy burden is high, so confidence is Low.

## Evidence of the problem
- California gives subs 20 days from first furnishing to serve a preliminary notice; serving late preserves only the 20 days before the notice date (a notice on day 40 forfeits the first 20 days). Texas counts by calendar month (generally the 15th day of the fourth month after last furnishing for commercial subs). WA is 90 days, NC 120, SC 90 from last furnishing; Nevada requires in-person or certified-mail delivery. Source: https://www.siteline.com/blog/mechanics-lien-myths-that-could-cost-subcontractors-their-rights
- Siteline says six states (NM, FL, IL, TX, IA, CO) changed lien laws since 2023, so rules need periodic review. Source: https://www.siteline.com/blog/recent-mechanics-lien-law-changes-every-subcontractor-should-know (vendor content, claim not independently checked).
- A CFMA forum post describes the recurring pattern: a sub goes to file a lien after non-payment and "finds out they missed a preliminary notice deadline two months ago"; the poster is from Siteline (promotional) and the thread has no replies. Source: https://cafe.cfma.org/discussion/anyone-else-tripping-over-mechanics-lien-rulesprocess
- Siteline's blog says tracking deadlines in a spreadsheet separate from billing leaves gaps. Source: https://www.siteline.com/blog/the-best-mechanics-lien-rights-management-software-for-subcontractors
- Siteline cites "56% of subcontractors missed a critical lien deadline" from its own report; I could not find this in the cited article, so it is NOT relied on here.
- Weakness: demand evidence is vendor marketing and Q&A pages, not first-hand buyer complaints I could verify.

## Who pays
- Buyer: owner/office manager of a 2–25 person specialty sub (drywall, electrical, concrete, roofing) or a small materials supplier working in more than one state, who is not on a billing suite.
- Price point: $29–49/month flat, below the $149/month entry of LienDeadline.
- Evidence they pay for something like it: Levelset lists $19 per notice send (free first three), $49 warning send, $149 lien cancellation, $349 lien filing (TrustRadius listing; the page returned 403 on direct fetch so the figure comes from a search snippet): https://www.trustradius.com/products/levelset/pricing . A Software Advice listing gives Zlien (Levelset) a starting price of $149: https://www.softwareadvice.com/cms/zlien-profile/reviews/ . Capterra lists LienDeadline at $149/month with a $499 enterprise tier and LienDone at $49/month: https://www.capterra.com/p/10039699/LienDeadline/ and https://www.capterra.com/p/10045597/liendone/ . These are third-party listings and may be out of date.

## Competitors & alternatives
| Name | Price | Gap |
|---|---|---|
| Levelset / Zlien | $19/notice send; software from ~$149 | Legal/document-first; per-action fees add up for many small jobs |
| LienDeadline | ~$149/mo, free tier, $499 enterprise | Generates notices; heavier than a calendar |
| LienDone | $49/mo | Focused on waivers, not preliminary-notice clocks |
| Siteline | not stated | Billing suite for commercial subs; lien tracker is a module and assumes sub role only |
| Handle | not found | Notice sending; lighter-weight |
| Prelien | free | California only calculators |
| Siteline 50-state directory | free | Reference, no per-project tracking or alerts |
| Spreadsheet / calendar | free | The status quo; no state logic |

## Technical notes
- Core is a rules table per state/role/project type: trigger (first/last furnishing, month-based), offset, delivery method, and citation. Start with 5–6 states (CA, TX, FL, WA, AZ, NV), commercial sub role only.
- Intake: manual form, plus optional email-forward that extracts state, GC, and first-furnish date from a PO/contract with an LLM, always confirmed by the user.
- Output: a per-job deadline list, email alerts at 14/7/2 days, ICS calendar feed. It does not send notices in M1.
- Every rule must link to the statute text and show a "last verified" date; this is a reference tool, not legal advice.

## Risks & open questions
- Legal accuracy: a wrong deadline could cost a user their lien rights; liability and disclaimers need thought, and rules need continuous maintenance (six states changed since 2023 per Siteline).
- Crowded market with funded vendors who could add a cheap tier; Siteline, Levelset and Handle all have free content marketing.
- Unknown whether small subs (low software adoption) will adopt a SaaS rather than call a lien attorney.
- Reachability for a $0 demand test: contractor forums and Facebook groups; no personal network is known.
- Open: do subs value deadline alerts without notice sending, or does the paid job-to-be-done really sit in the sending?

## Sources
- https://www.siteline.com/blog/mechanics-lien-myths-that-could-cost-subcontractors-their-rights
- https://www.siteline.com/blog/the-best-mechanics-lien-rights-management-software-for-subcontractors
- https://www.siteline.com/blog/recent-mechanics-lien-law-changes-every-subcontractor-should-know
- https://cafe.cfma.org/discussion/anyone-else-tripping-over-mechanics-lien-rulesprocess
- https://www.trustradius.com/products/levelset/pricing
- https://www.capterra.com/p/10039699/LienDeadline/
- https://www.capterra.com/p/10045597/liendone/
- https://www.softwareadvice.com/cms/zlien-profile/reviews/
- https://www.prelien.co/tools
