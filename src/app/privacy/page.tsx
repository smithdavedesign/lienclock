import type { Metadata } from 'next';
import { SESSION_COOKIE, SESSION_DAYS, SIGN_IN_LINK_MINUTES } from '@/lib/auth';
import { NO_TRACK_KEY, SENT_FLAGS, SIGNAL_URL } from '@/lib/signal';
import { LEGAL_UPDATED } from '@/lib/site';
import { ContactLine } from '../Legal';
import { publicPageMetadata } from '../seo';

export const metadata: Metadata = publicPageMetadata({
  path: '/privacy',
  title: 'Privacy Policy — LienClock',
  description: 'What LienClock stores to track your lien deadlines, the visit counts it sends, who processes it, and how to delete it.',
});

const signalHost = new URL(SIGNAL_URL).host;

// Keep this in step with the schema in src/lib/db.ts and with deleteAccount in src/lib/auth.ts.
export default function PrivacyPage() {
  return (
    <article className="legal">
      <h1>Privacy Policy</h1>
      <p className="lede">
        Last updated <time dateTime={LEGAL_UPDATED}>{LEGAL_UPDATED}</time>
      </p>
      <p>
        LienClock keeps the least it needs to compute your deadlines and remind you of them. This page says what that is, who
        processes it and how to delete it.
      </p>

      <h2>What we store</h2>
      <ul>
        <li>
          <strong>Your email address</strong>, which is your account. We use it to send you sign-in links and deadline alerts.
        </li>
        <li>
          <strong>Job details</strong> you enter or confirm: the state, the GC or owner you work for, your first and last
          furnishing dates, and the dates you mark notices served or liens recorded.
        </li>
        <li>
          <strong>A record of each alert</strong> we email you (address, subject and text), kept with its job so the same alert
          isn’t sent twice.
        </li>
        <li>
          <strong>A record of each rule-change email</strong> we send you when a rule changes in a state where you track a job
          (address, subject and text).
        </li>
        <li>
          <strong>Billing details</strong>, if you subscribe to Pro: your Stripe customer and subscription IDs and the
          subscription’s status. Stripe handles the payment itself; we never see or store your card number.
        </li>
        <li>
          <strong>Emails you forward or paste</strong> to add a job. We read the text once to propose job fields, and keep the
          subject, the sender’s address and the short lines our proposals came from (each under 160 characters), not the full
          email or its attachments.
        </li>
        <li>
          {`Sign-in links and sessions, stored only as one-way hashes. Links stop working after ${SIGN_IN_LINK_MINUTES} minutes and sessions after ${SESSION_DAYS} days. A job you save before confirming your email waits inside its link until you click it.`}
        </li>
        <li>Your calendar feed and forwarding addresses, which are random secrets tied to your account.</li>
      </ul>

      <h2>Cookies</h2>
      <p>
        One cookie, <code>{SESSION_COOKIE}</code>, keeps you signed in. It is strictly necessary, so there is no cookie banner.
        There are no analytics, advertising or third-party cookies.
      </p>

      <h2>Visit counts</h2>
      <p>
        {`To count how many people use LienClock, your browser sends a small message to ${signalHost} (RepoHQ, which runs LienClock) for three events:`}
      </p>
      <ul>
        <li>
          <strong>visit</strong>: you opened a public page (the calculator, rule changes, the terms or this policy), sent
          once per browser session;
        </li>
        <li>
          <strong>activate</strong>: the calculator showed you the deadlines for a job, sent once per browser;
        </li>
        <li>
          <strong>checkout</strong>: you clicked a button that opens Stripe to subscribe to Pro.
        </li>
      </ul>
      <p>
        {`Each message holds only the product name (“lienclock”), the event, and the address of the other website that sent you here, if one did. It never holds a LienClock page address, so the job details in a calculator link stay in your browser. It carries no cookies and nothing you typed, and it isn’t linked to your account. Like any web request, it reaches the counter with your IP address and browser type. To remember what was already counted, your browser keeps two small flags (${SENT_FLAGS.visit?.key} in session storage and ${SENT_FLAGS.activate?.key} in local storage). Automated browsers send nothing, and neither does a browser where local storage holds ${NO_TRACK_KEY}. A content blocker that blocks the counter’s address stops it too, and LienClock keeps working.`}
      </p>

      <h2>Who processes it</h2>
      <ul>
        <li>
          <strong>Cloudflare</strong> hosts the app (Cloudflare Workers) and keeps short-lived request logs (page addresses and
          IP addresses).
        </li>
        <li>
          <strong>Neon</strong> hosts the database.
        </li>
        <li>
          <strong>Resend</strong> sends our emails and receives the emails you forward for intake, under its own retention
          policy.
        </li>
        <li>
          <strong>Stripe</strong> processes Pro subscriptions and keeps the payment records (card, invoices, billing address)
          under its own privacy policy.
        </li>
      </ul>
      <p>These providers may process data in the United States.</p>

      <h2>What we don’t do</h2>
      <p>
        We do not sell your data, share it for advertising, or use it to train AI models. We never contact your GC, the owner
        or anyone else about your jobs.
      </p>

      <h2>How long we keep it</h2>
      <p>
        Job details and alert records stay until you delete the job or your account. What we kept from intake emails, the
        records of rule-change emails and your billing details stay until you delete your account. Expired sign-in links and sessions stop working at once; their records are cleared
        out over time, and all of them when you delete your account. Copies in our providers’ backups expire on their own
        schedule.
      </p>

      <h2>Deleting your data</h2>
      <ul>
        <li>Deleting a job also deletes its alerts: use “Delete this job and stop alerts” on the job’s page.</li>
        <li>
          “Delete my account” at the bottom of <a href="/jobs#account">Your jobs</a> deletes your account, all your jobs and
          their alerts, rule-change emails, emails waiting for review, your sessions and your sign-in links, straight away. It
          also stops alerts to your address from any job saved before LienClock had accounts.
        </li>
        <li>
          If you subscribe to Pro, cancel your subscription before you delete your account: deleting the account can’t stop
          Stripe’s charges, so LienClock asks you to cancel first. Stripe keeps its payment records as the law requires.
        </li>
      </ul>

      <h2>Children</h2>
      <p>LienClock is a business tool and isn’t meant for anyone under 16.</p>

      <h2>Changes</h2>
      <p>
        When our practices change we update this page and its date, and we email account holders about significant changes.
        See also the <a href="/terms">Terms of Use</a>.
      </p>
      <ContactLine lead="Privacy questions or requests:" />
    </article>
  );
}
