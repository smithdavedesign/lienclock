import type { Metadata } from 'next';
import { FREE_JOB_LIMIT, PRO_MONTHLY_USD } from '@/lib/billing';
import { STATES, SUPPORTED_STATES } from '@/lib/rules';
import { LEGAL_UPDATED } from '@/lib/site';
import { ContactLine } from '../Legal';

export const metadata: Metadata = {
  title: 'Terms of Use — LienClock',
  description: 'LienClock is a deadline reference and reminder tool for subcontractors, not legal advice.',
};

const names = SUPPORTED_STATES.map((code) => STATES[code].name);
const coveredStates = `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

export default function TermsPage() {
  return (
    <article className="legal">
      <h1>Terms of Use</h1>
      <p className="lede">
        Last updated <time dateTime={LEGAL_UPDATED}>{LEGAL_UPDATED}</time>
      </p>
      <p>
        These terms cover your use of LienClock: the website, and the emails and calendar feed it sends. By using LienClock or
        creating an account you agree to them. If you don’t agree, please don’t use it.
      </p>

      <h2>1. What LienClock is</h2>
      <p>
        LienClock is a deadline reference and reminder tool. It computes preliminary-notice and mechanics lien deadlines from
        the dates you enter, shows the statute behind each one, and can email you reminders and publish a calendar feed.
        LienClock does not prepare, send, serve, file or record notices or liens.
      </p>

      <h2>2. Not legal advice</h2>
      <p>
        LienClock is a reference tool, not legal advice. We are not a law firm, and using LienClock creates no attorney–client
        relationship. Lien rights depend on facts LienClock doesn’t know (your contract, who hired you, the property, notices
        others have recorded) and on statutes and court decisions that change. For advice about a specific job, talk to a
        construction attorney licensed in the project’s state.
      </p>

      <h2>3. What is covered, and how dates are counted</h2>
      <ul>
        <li>{`States: ${coveredStates}.`}</li>
        <li>
          Private commercial projects only, for subcontractors hired directly by the general contractor. Residential projects,
          public works, bond claims, suppliers and lower-tier subcontractors are not covered.
        </li>
        <li>
          Dates are calendar days and are never extended for weekends or holidays, so the date shown is the earlier, safer
          one.
        </li>
        <li>
          Lien deadlines are counted from your last furnishing date. A recorded notice of completion or cessation can shorten
          them, and LienClock doesn’t track those.
        </li>
        <li>
          Some notices are required only in some situations, for example Ohio’s Notice of Furnishing once a notice of
          commencement is recorded, or Pennsylvania’s on projects of $1.5 million or more. LienClock shows them on every job
          in that state, and each note says when it applies.
        </li>
        <li>Each deadline shows its statute citation and the date we last checked the rule.</li>
        <li>
          When a rule changes, we list the change on <a href="/changelog">Rule changes</a> and email everyone who tracks a
          job in that state. Deadlines on your jobs follow the current rules.
        </li>
      </ul>

      <h2>4. Your responsibilities</h2>
      <ul>
        <li>Check every date against the linked statute or with a construction attorney before you rely on it.</li>
        <li>Enter accurate dates and keep them current: a deadline is only as good as the dates it is computed from.</li>
        <li>
          Don’t rely on alerts alone. Email alerts can be delayed, land in spam or fail to send, and calendar apps refresh
          subscribed feeds on their own schedule.
        </li>
        <li>
          Keep sign-in links and your calendar feed address private. Anyone with the feed address can see your deadlines, so
          reset it from Your jobs if it leaks.
        </li>
        <li>Only forward or paste emails you are allowed to share with us.</li>
      </ul>

      <h2>5. Accounts and acceptable use</h2>
      <p>
        You sign in with links sent to your email address, so keep that inbox secure. Don’t use LienClock to email people who
        didn’t ask for it, to probe or overload the service, or to get at other people’s data. We may suspend accounts that do.
      </p>

      <h2>6. Plans and price</h2>
      <ul>
        <li>
          {`The Free plan includes the deadline calculator and ${FREE_JOB_LIMIT} tracked ${FREE_JOB_LIMIT === 1 ? 'job' : 'jobs'}, with email alerts, the calendar feed and email intake.`}
        </li>
        <li>
          {`LienClock Pro costs US$${PRO_MONTHLY_USD} per month, plus any sales tax Stripe must collect, and tracks unlimited jobs. There are no per-notice fees.`}
        </li>
        <li>Stripe processes the payments. We never see or store your card number.</li>
        <li>
          A subscription renews monthly until you cancel. You can cancel at any time in the billing portal linked from Your
          jobs; Pro then lasts until the end of the month you have paid for, and there are no refunds for partial months.
        </li>
        <li>
          If a subscription ends, because you cancel or a payment fails, jobs you already track keep their alerts, but you
          can’t add jobs beyond the Free plan until you subscribe again.
        </li>
        <li>We’ll give you at least 30 days’ notice by email before we change the price of your subscription.</li>
        <li>Until paid plans open, every account can track any number of jobs for free (early access).</li>
      </ul>

      <h2>7. Your data</h2>
      <p>
        The <a href="/privacy">Privacy Policy</a> explains what we store and how to delete it. You can delete any job, or your
        whole account, at any time. If you subscribe to Pro, cancel the subscription before you delete your account.
      </p>

      <h2>8. No warranty</h2>
      <p>
        LienClock is provided “as is” and “as available”. To the extent the law allows, we make no warranty that it is
        accurate, complete, current, uninterrupted or fit for a particular purpose, or that any alert will be delivered.
      </p>

      <h2>9. Limitation of liability</h2>
      <p>
        To the extent the law allows, LienClock and its operators are not liable for lost lien or payment rights, unpaid
        balances, lost profits, or any indirect, incidental or consequential damages arising from your use of LienClock. Our
        total liability for any claim is limited to the greater of what you paid us for LienClock in the 12 months before the
        claim and US$50.
      </p>

      <h2>10. Changes and ending</h2>
      <p>
        We may update these terms, and the date at the top shows when we last did. If a change is significant, we’ll email
        account holders before it takes effect. You can stop using LienClock and delete your account at any time.
      </p>
      <ContactLine lead="Questions about these terms:" />
    </article>
  );
}
