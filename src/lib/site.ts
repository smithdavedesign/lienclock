// Public-site facts shared by the legal pages, robots.txt and the sitemap.
import { parseEmail } from './jobInput';

/** Date shown as "Last updated" on the terms and the privacy policy. Change it with their text. */
export const LEGAL_UPDATED = '2026-11-08';

/** The pages anyone (and any crawler) may read. Everything else is behind sign-in or a secret URL. */
export const PUBLIC_PAGES = ['/', '/changelog', '/privacy', '/terms'] as const;

/** Path prefixes crawlers must stay off: signed-in pages, and URLs that carry tokens. */
export const PRIVATE_PATHS = ['/jobs', '/signin', '/intake/', '/calendar/', '/api/'];

// Stricter than parseEmail (which accepts any non-space characters around the @): this one becomes a
// mailto: link, so it is limited to plain address characters.
const PLAIN_EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

/** The support address for the legal pages (CONTACT_EMAIL, not secret), or null if unset or not a plain address. */
export function contactEmailFrom(env: Record<string, string | undefined>): string | null {
  const email = parseEmail(env.CONTACT_EMAIL);
  return email && PLAIN_EMAIL.test(email) ? email : null;
}
