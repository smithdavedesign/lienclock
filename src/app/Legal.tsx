import { contactEmailFrom } from '@/lib/site';

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

/** The support address, when CONTACT_EMAIL is set to a valid one. */
export function ContactLine({ lead }: { lead: string }) {
  const email = contactEmailFrom(process.env);
  return email ? (
    <p>
      {`${lead} `}
      <a href={`mailto:${email}`}>{email}</a>.
    </p>
  ) : null;
}
