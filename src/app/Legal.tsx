import { GITHUB_ISSUES_URL, contactEmailFrom } from '@/lib/site';

/**
 * Shown next to each button that leads to an account. The account itself is created by "Sign in to
 * LienClock" on the link page, which carries this notice too.
 */
export function Agreement({ by }: { by: string }) {
  return (
    <p className="hint">
      {`By ${by}, you agree to the `}
      <a href="/terms">Terms of Use</a> and <a href="/privacy">Privacy Policy</a>.
    </p>
  );
}

/** How to reach us: the GitHub repo's issues, plus the support address when CONTACT_EMAIL is a valid one. */
export function ContactLine({ lead }: { lead: string }) {
  const email = contactEmailFrom(process.env);
  return (
    <>
      <h2>Contact</h2>
      <p>
        {`${lead} open an issue at `}
        <a href={GITHUB_ISSUES_URL}>{GITHUB_ISSUES_URL.replace('https://', '')}</a>
        {'. Issues are public, so don’t put your email address or job details in one. To delete your data, use “Delete my account” at the bottom of '}
        <a href="/jobs#account">Your jobs</a>.
        {email && (
          <>
            {' For anything private, email '}
            <a href={`mailto:${email}`}>{email}</a>.
          </>
        )}
      </p>
    </>
  );
}
