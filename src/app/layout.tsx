import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { RULES } from '@/lib/rules';
import './styles.css';

export const metadata: Metadata = {
  title: 'LienClock: preliminary notice and lien deadlines for subcontractors',
  description:
    'See every preliminary-notice and lien deadline a job triggers in CA, TX, FL, WA, AZ and NV, with the statute behind each date, and get alerts before they lapse.',
};

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
        </footer>
      </body>
    </html>
  );
}
