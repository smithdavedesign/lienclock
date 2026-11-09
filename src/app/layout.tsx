import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { appUrlFrom } from '@/lib/cron';
import { RULES } from '@/lib/rules';
import { GITHUB_ISSUES_URL, PUBLIC_PAGES, SITE_NAME } from '@/lib/site';
import { VisitBeacon } from './Beacon';
import { SITE_DESCRIPTION, jsonLdHtml, softwareApplicationJsonLd } from './seo';
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
// Public pages set their own title, description, canonical URL and cards (seo.ts); these are defaults.
export function generateMetadata(): Metadata {
  return {
    // og:image and other metadata URLs resolve against the configured host, never the request's.
    metadataBase: metadataBase(),
    applicationName: SITE_NAME,
    title: 'LienClock: preliminary notice and lien deadlines for subcontractors',
    description: SITE_DESCRIPTION,
  };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <script
          type="application/ld+json"
          // Built from constants only (name, price, APP_URL), with `<` escaped.
          dangerouslySetInnerHTML={{ __html: jsonLdHtml(softwareApplicationJsonLd(appUrlFrom(process.env))) }}
        />
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
            <a href="/#pricing">Pricing</a>
            <a href="/changelog">Rule changes</a>
            <a href="/terms">Terms of Use</a>
            <a href="/privacy">Privacy Policy</a>
            <a href={GITHUB_ISSUES_URL}>Contact</a>
          </nav>
        </footer>
        <VisitBeacon publicPaths={PUBLIC_PAGES} />
      </body>
    </html>
  );
}
