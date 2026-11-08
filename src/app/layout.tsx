import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { PRO_PRICE_LABEL } from '@/lib/billing';
import { appUrlFrom } from '@/lib/cron';
import { RULES, SUPPORTED_STATES } from '@/lib/rules';
import './styles.css';

/** The configured app URL, or undefined if APP_URL is malformed: a typo must not take every page down. */
function metadataBase(): URL | undefined {
  try {
    return new URL(`${appUrlFrom(process.env)}/`);
  } catch {
    return undefined;
  }
}

// A function, not a constant, so the og:image base URL comes from the env at build/render time.
export function generateMetadata(): Metadata {
  return {
    // og:image and other metadata URLs resolve against the configured host, never the request's.
    metadataBase: metadataBase(),
    title: 'LienClock: preliminary notice and lien deadlines for subcontractors',
    description: `See every preliminary-notice and lien deadline a job triggers in ${SUPPORTED_STATES.length} states (${SUPPORTED_STATES.join(', ')}), with the statute behind each date, and get alerts before they lapse. ${PRO_PRICE_LABEL}, no per-notice fees.`,
  };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <a href="/" className="brand">
            LienClock
          </a>
          <span>Lien and notice deadlines for subcontractors</span>
          <nav>
            <a href="/jobs">Your jobs</a>
          </nav>
        </header>
        <main>{children}</main>
        <footer>
          <p>
            LienClock is a deadline reference, not legal advice. Dates are calendar days, never extended for weekends or
            holidays, and cover private commercial projects for subcontractors hired by the GC. Check the linked statute or a
            construction attorney before relying on a date.
          </p>
          <p>{`Rules version ${RULES.version}.`}</p>
          <nav aria-label="Legal" className="legal-links">
            <a href="/changelog">Rule changes</a>
            <a href="/terms">Terms of Use</a>
            <a href="/privacy">Privacy Policy</a>
          </nav>
        </footer>
      </body>
    </html>
  );
}
