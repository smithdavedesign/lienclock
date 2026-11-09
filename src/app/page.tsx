import type { Metadata } from 'next';
import type { Account } from '@/lib/auth';
import { FREE_JOB_LIMIT, PRO_PRICE_LABEL, billingFrom, checkoutUrl, hasOpenSubscription, paymentLinkFrom } from '@/lib/billing';
import { computeDeadlines, pendingRules } from '@/lib/deadlines';
import { parseJobForm, type JobForm } from '@/lib/jobInput';
import { SUPPORTED_STATES } from '@/lib/rules';
import { saveJob } from './actions';
import { ActivateBeacon, BuyLink } from './Beacon';
import { DeadlineTable } from './DeadlineTable';
import { JobFields } from './JobFields';
import { Agreement } from './Legal';
import { SITE_DESCRIPTION, publicPageMetadata } from './seo';
import { currentAccount } from './session';

export const metadata: Metadata = publicPageMetadata({
  path: '/',
  title: 'LienClock: lien and preliminary-notice deadline calculator for subcontractors',
  description: SITE_DESCRIPTION,
});

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Where "Get Pro" points, or null to hide it: no Payment Link configured, or the account already has a
 * subscription Stripe hasn't ended (a second checkout would bill twice). Signed-in buyers carry their
 * account id and email, so the webhook knows whose payment it is.
 */
function buyHref(paymentLink: string | null, account: Account | null): string | null {
  if (!paymentLink) return null;
  if (!account) return paymentLink;
  return hasOpenSubscription(account.subscriptionStatus) ? null : checkoutUrl({ paymentLink }, account);
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// The calculator is a plain GET form: no database, no JavaScript needed, shareable URLs.
export default async function CalculatorPage({ searchParams }: { searchParams: SearchParams }) {
  const [params, account] = await Promise.all([searchParams, currentAccount()]);
  const form: JobForm = {
    state: first(params.state),
    counterparty: first(params.counterparty),
    firstFurnishDate: first(params.firstFurnishDate),
    lastFurnishDate: first(params.lastFurnishDate),
  };
  const submitted = Object.values(form).some(Boolean);
  const parsed = submitted ? parseJobForm(form, { requireEmail: false }) : null;
  const errors = parsed && !parsed.ok ? parsed.errors : {};
  const job = parsed?.ok ? parsed.value : null;
  const pending = job ? pendingRules(job) : [];
  // Both read per request (this page is dynamic): on the Worker they are secrets set without a rebuild.
  const billing = billingFrom(process.env);
  const paymentLink = paymentLinkFrom(process.env);
  const buy = buyHref(paymentLink, account);

  return (
    <>
      <h1>Which lien clocks just started?</h1>
      {first(params.accountDeleted) && (
        <p className="flash">Your account and all its data were deleted. No more alerts will be sent.</p>
      )}
      <p className="lede">
        Enter a job to see every preliminary-notice and lien deadline it triggers, with the statute behind each date. Save it
        to get email alerts 14, 7 and 2 days before each deadline, and on the day.
      </p>

      <form method="get" action="/" className="job-form">
        <JobFields values={form} errors={errors} />
        <button type="submit">Show deadlines</button>
        <fieldset className="save">
          <legend>Get alerts</legend>
          {account ? (
            <>
              <p>
                Alerts go to <strong>{account.email}</strong>. The job is saved to <a href="/jobs">your jobs</a>.
              </p>
              {first(params.limit) && (
                <p className="error" role="alert">
                  {`Your Free plan tracks ${FREE_JOB_LIMIT} job, and it’s in use. `}
                  {billing && hasOpenSubscription(account.subscriptionStatus) ? (
                    // Stripe still holds a subscription (payment pending or on hold): no second checkout.
                    <>
                      Your Pro subscription isn’t active yet: <a href="/jobs#plan">see your plan</a>. Or delete a job you no
                      longer need.
                    </>
                  ) : (
                    <>
                      {billing ? (
                        <BuyLink href={checkoutUrl(billing, account)}>{`Subscribe to Pro (${PRO_PRICE_LABEL})`}</BuyLink>
                      ) : (
                        'Subscribe to Pro'
                      )}
                      {' to save this one, or delete a job you no longer need.'}
                    </>
                  )}
                </p>
              )}
            </>
          ) : (
            <>
              <label>
                Email for alerts
                <input type="email" name="alertEmail" autoComplete="email" maxLength={254} aria-describedby="email-error" />
                {first(params.emailError) && (
                  <span className="error" id="email-error">
                    Enter a valid email address to save the job.
                  </span>
                )}
              </label>
              <p className="hint">
                We email you a link to confirm the address. Your job is saved, and your account created, when you click it.
              </p>
              <Agreement by="saving" />
            </>
          )}
          <button type="submit" formAction={saveJob}>
            Save &amp; email me alerts
          </button>
        </fieldset>
      </form>

      {job && (
        <section aria-labelledby="deadlines-heading">
          <h2 id="deadlines-heading">Deadlines for your job with {job.counterparty}</h2>
          <DeadlineTable deadlines={computeDeadlines(job)} />
          {pending.length > 0 && (
            <p className="pending">Add your last furnishing date to see: {pending.map((r) => r.title).join(', ')}.</p>
          )}
          <ActivateBeacon />
        </section>
      )}

      <section id="pricing" aria-labelledby="pricing-heading" className="pricing">
        <h2 id="pricing-heading">Pricing</h2>
        <div className="plans">
          <div className="plan">
            <h3>Free</h3>
            <p>{`The deadline calculator for ${SUPPORTED_STATES.length} states, and ${FREE_JOB_LIMIT} tracked job with email alerts and a calendar feed.`}</p>
          </div>
          <div className="plan">
            <h3>{`Pro: ${PRO_PRICE_LABEL}`}</h3>
            <p>
              Unlimited jobs, alerts before every deadline, the calendar feed and email intake. A flat price with no per-notice
              fees. Cancel anytime.
            </p>
          </div>
        </div>
        {buy && (
          <p className="buy">
            <BuyLink className="button" href={buy}>{`Get LienClock Pro: ${PRO_PRICE_LABEL}`}</BuyLink>
          </p>
        )}
        {!billing && (
          <p className="hint">
            {paymentLink
              ? `During early access the Free plan’s ${FREE_JOB_LIMIT}-job limit isn’t enforced yet, so every account tracks unlimited jobs.`
              : 'Paid plans aren’t open yet, so every account is unlimited and free during early access.'}
          </p>
        )}
        <p className="hint">
          <a href="/changelog">{`Which states and statutes LienClock covers, and every rule change`}</a>
        </p>
      </section>
    </>
  );
}
