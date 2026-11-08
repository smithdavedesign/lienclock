import type { Metadata } from 'next';
import type { Account } from '@/lib/auth';
import { FREE_JOB_LIMIT, PRO_PRICE_LABEL, billingFrom, checkoutUrl, isPaid, type Billing } from '@/lib/billing';
import { appUrlFrom } from '@/lib/cron';
import { getDb } from '@/lib/db';
import { statusLabel } from '@/lib/deadlines';
import { feedUrls } from '@/lib/ics';
import { MAX_PENDING_PROPOSALS, intakeAddressFor, listPendingProposals } from '@/lib/inbound';
import { listJobsForAccount, summarizeJobs } from '@/lib/jobs';
import { STATES } from '@/lib/rules';
import { deleteAccountAction, pasteIntakeAction, rotateFeedAction, signOutAction } from '../actions';
import { requireAccount } from '../session';

export const metadata: Metadata = { title: 'Your jobs — LienClock', robots: { index: false, follow: false } };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const ERRORS: Record<string, string> = {
  'paste-empty': 'Paste the text of a PO or contract email first.',
  'intake-full': `You have ${MAX_PENDING_PROPOSALS} emails waiting for review. Confirm or discard some first.`,
};

/** Early access (billing not configured), Free, or Pro in one of Stripe's states. */
function Plan({ account, billing, jobCount }: { account: Account; billing: Billing | null; jobCount: number }) {
  const status = account.subscriptionStatus;
  const manage = billing?.portalUrl ? <a href={billing.portalUrl}>Manage billing or cancel</a> : null;
  if (isPaid(status)) {
    return (
      <>
        <p>
          <strong>{`LienClock Pro, ${PRO_PRICE_LABEL}`}</strong>
          {status === 'trialing' ? ' (trial)' : ''}: unlimited jobs and alerts.
        </p>
        {status === 'past_due' && (
          <p className="error" role="alert">
            Your last payment failed. Update your card to keep Pro: Stripe retries the charge for a few days.
          </p>
        )}
        {manage && <p>{manage}</p>}
      </>
    );
  }
  if (!billing) {
    return <p>{`Early access: track as many jobs as you like, free. Pro will cost ${PRO_PRICE_LABEL} once paid plans open.`}</p>;
  }
  return (
    <>
      {status === 'incomplete' && <p>Stripe is still confirming your first payment. Pro starts as soon as it does.</p>}
      {status && status !== 'incomplete' && (
        <p>Your Pro subscription has ended. Jobs you already track keep their alerts; subscribe again to add more.</p>
      )}
      <p>
        <strong>Free plan</strong>
        {`: ${FREE_JOB_LIMIT} tracked job (you track ${Math.min(jobCount, FREE_JOB_LIMIT)} of ${FREE_JOB_LIMIT}). Pro tracks unlimited jobs for ${PRO_PRICE_LABEL}, with no per-notice fees.`}
      </p>
      <p>
        <a className="button" href={checkoutUrl(billing, account)}>{`Subscribe to Pro: ${PRO_PRICE_LABEL}`}</a>
      </p>
      {manage && status && <p>{manage}</p>}
    </>
  );
}

function timing(daysLeft: number): string {
  if (daysLeft === 0) return 'due today';
  if (daysLeft === 1) return '1 day left';
  return daysLeft > 1 ? `${daysLeft} days left` : `passed ${-daysLeft} days ago`;
}

export default async function JobsPage({ searchParams }: { searchParams: SearchParams }) {
  const account = await requireAccount('/jobs');
  const db = await getDb();
  const [query, jobs, proposals] = await Promise.all([
    searchParams,
    listJobsForAccount(db, account.id),
    listPendingProposals(db, account.id),
  ]);
  const summaries = summarizeJobs(jobs, new Date());
  const feed = feedUrls(account, appUrlFrom(process.env));
  const intakeAddress = intakeAddressFor(account, process.env);
  const error = typeof query.error === 'string' ? ERRORS[query.error] : undefined;
  const billing = billingFrom(process.env);
  const paid = isPaid(account.subscriptionStatus);

  return (
    <>
      <div className="account">
        <span>
          Signed in as <strong>{account.email}</strong>
        </span>
        <form action={signOutAction}>
          <button type="submit">Sign out</button>
        </form>
      </div>
      <h1>Your jobs</h1>
      {query.deleted && <p className="flash">Job deleted. No more alerts will be sent for it.</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {proposals.length > 0 && (
        <section aria-labelledby="review-heading">
          <h2 id="review-heading">Emails to review</h2>
          <ul className="proposals">
            {proposals.map((p) => (
              <li key={p.id}>
                <a href={`/intake/${p.id}`}>{p.subject || (p.source === 'paste' ? 'Pasted email' : 'Forwarded email')}</a>
                {p.fromEmail && <small>{` from ${p.fromEmail}`}</small>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {summaries.length === 0 ? (
        <p className="empty">
          No jobs yet. <a href="/">Add your first job</a> or forward a PO email below.
        </p>
      ) : (
        <table className="deadlines">
          <thead>
            <tr>
              <th scope="col">Job</th>
              <th scope="col">First furnished</th>
              <th scope="col">Next deadline</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {summaries.map(({ job, next, openCount }) => (
              <tr key={job.id} className={next ? `row-${next.status}` : undefined}>
                <td>
                  <a href={`/jobs/${job.id}`}>
                    <strong>{job.counterparty}</strong>
                  </a>
                  <br />
                  <small>{STATES[job.state]?.name ?? job.state}</small>
                </td>
                <td data-label="First furnished">
                  <time dateTime={job.firstFurnishDate}>{job.firstFurnishDate}</time>
                </td>
                <td data-label="Next deadline">
                  {next ? (
                    <>
                      {next.title}
                      <br />
                      <time dateTime={next.date}>{next.date}</time> <span className="timing">{timing(next.daysLeft)}</span>
                    </>
                  ) : (
                    'None yet: add the last furnishing date'
                  )}
                </td>
                <td>
                  {next && <span className={`badge badge-${next.status}`}>{statusLabel(next.status)}</span>}
                  {openCount > 1 && <p className="protection">{`${openCount} open deadlines`}</p>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        <a href="/">Add a job</a>
      </p>

      <section id="plan" aria-labelledby="plan-heading">
        <h2 id="plan-heading">Your plan</h2>
        {query.billing === 'success' && (
          <p className="flash">
            {paid ? 'Welcome to LienClock Pro. Add as many jobs as you need.' : 'Thanks! Stripe is confirming your payment: refresh this page in a minute.'}
          </p>
        )}
        {query.error === 'job-limit' && (
          <p className="error" role="alert">
            {`The Free plan tracks ${FREE_JOB_LIMIT} job. Subscribe to Pro to add more, or delete a job you no longer need.`}
          </p>
        )}
        <Plan account={account} billing={billing} jobCount={jobs.length} />
      </section>

      <section id="calendar" aria-labelledby="calendar-heading">
        <h2 id="calendar-heading">Calendar feed</h2>
        <p>
          <a href={feed.webcal}>Subscribe in your calendar app</a>, or paste this address into Google Calendar (“From URL”)
          or Outlook (“Subscribe from web”). Every deadline of every job appears as an all-day event.
        </p>
        <input className="copy" readOnly value={feed.https} aria-label="Calendar feed address" />
        <p className="hint">Anyone with this address can see your deadlines. If it leaks, reset it and subscribe again.</p>
        <form action={rotateFeedAction}>
          <button type="submit">Reset calendar address</button>
        </form>
      </section>

      <section id="intake" aria-labelledby="intake-heading">
        <h2 id="intake-heading">Add a job from an email</h2>
        {intakeAddress ? (
          <p>
            Forward a PO or contract email to <code>{intakeAddress}</code>. LienClock proposes the state, GC and start date,
            and nothing is saved until you confirm them.
          </p>
        ) : (
          <p>Paste a PO or contract email. LienClock proposes the state, GC and start date for you to confirm.</p>
        )}
        <form action={pasteIntakeAction} className="job-form">
          <label>
            Email text
            <textarea name="emailText" rows={8} maxLength={100000} required />
          </label>
          <button type="submit">Propose job fields</button>
        </form>
      </section>

      <section id="account" aria-labelledby="account-heading">
        <h2 id="account-heading">Delete your account</h2>
        <p>
          {`This deletes your account, your ${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'} and their alerts, emails waiting for review and your calendar feed, and signs you out everywhere. It can’t be undone.`}
        </p>
        {query.error === 'delete-confirm' && (
          <p className="error" role="alert">
            Tick the box to confirm you want to delete your account.
          </p>
        )}
        {query.error === 'delete-subscribed' && (
          <p className="error" role="alert">
            {'Your Pro subscription is still active, and deleting the account wouldn’t stop the charges. Cancel it first '}
            {billing?.portalUrl ? <a href={billing.portalUrl}>in the billing portal</a> : 'from the link in your Stripe receipt'}
            {', then delete your account.'}
          </p>
        )}
        <form action={deleteAccountAction} className="danger">
          <label className="check">
            <input type="checkbox" name="confirm" value="yes" required />
            I understand: delete everything and stop all alerts.
          </label>
          <button type="submit">Delete my account</button>
        </form>
      </section>
    </>
  );
}
