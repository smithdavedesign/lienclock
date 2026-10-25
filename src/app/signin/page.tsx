import type { Metadata } from 'next';
import { SIGN_IN_LINK_MINUTES, peekSignIn, safeNextPath } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { STATES, isSupportedState } from '@/lib/rules';
import { finishSignInAction, requestSignInAction } from '../actions';

export const metadata: Metadata = { title: 'Sign in — LienClock', robots: { index: false, follow: false } };

const ERRORS: Record<string, string> = {
  expired: 'That sign-in link has expired or was already used. Enter your email to get a new one.',
  rate: 'Too many sign-in emails were requested. Wait half an hour and try again, or use the last link you received.',
  email: 'Enter a valid email address.',
  unavailable: 'Sign-in email is not available right now. Please try again later.',
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// One page for the whole flow: ask for an email → "check your email" → the link lands here with
// ?token=…, the page says which address (and job) it is for, and a button (a POST) finishes. A GET
// never uses the token up, so mail scanners that open links can't spend it.
export default async function SignInPage({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  const token = first(query.token);
  const link = token ? await peekSignIn(await getDb(), token, { now: new Date() }) : null;

  if (token && link) {
    const job = link.pendingJob;
    const state = job && isSupportedState(job.state) ? STATES[job.state].name : job?.state;
    return (
      <>
        <h1>Finish signing in</h1>
        <p className="lede">
          Sign in as <strong>{link.email}</strong>
          {job ? (
            <>
              {' '}
              and save your {state} job for <strong>{job.counterparty}</strong>
            </>
          ) : null}
          . If you didn’t ask for this link, close this page.
        </p>
        <form action={finishSignInAction} className="job-form">
          <input type="hidden" name="token" value={token} />
          <button type="submit">Sign in to LienClock</button>
        </form>
      </>
    );
  }

  const sent = first(query.sent);
  if (sent) {
    return (
      <>
        <h1>Check your email</h1>
        <p className="lede">
          {`We sent you a sign-in link. It works once and expires in ${SIGN_IN_LINK_MINUTES} minutes.`}
          {sent === 'job' ? ' Your job is saved when you click it, and deadline alerts start then.' : ''}
        </p>
      </>
    );
  }

  const error = token !== undefined ? ERRORS.expired : ERRORS[first(query.error) ?? ''];
  return (
    <>
      <h1>Sign in</h1>
      <p className="lede">No password: we email you a link. New here? The same link creates your account.</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <form action={requestSignInAction} className="job-form">
        <input type="hidden" name="next" value={safeNextPath(first(query.next))} />
        <label>
          Email
          <input type="email" name="email" autoComplete="email" maxLength={254} required />
        </label>
        <button type="submit">Email me a sign-in link</button>
      </form>
    </>
  );
}
