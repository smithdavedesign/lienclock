// What REVENUE.md needs before charging, in the part that belongs to accounts (M2): terms with the
// "reference tool, not legal advice" disclaimer, a privacy policy, links to both on every page,
// and robots.txt + sitemap that keep crawlers on the public pages and off the private ones.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RootLayout, { generateMetadata as layoutMetadata } from '@/app/layout';
import OpengraphImage, { alt as ogAlt, contentType as ogContentType, size as ogSize } from '@/app/opengraph-image';
import PrivacyPage from '@/app/privacy/page';
import robots from '@/app/robots';
import sitemap from '@/app/sitemap';
import TermsPage from '@/app/terms/page';
import { SESSION_COOKIE } from '@/lib/auth';
import { STATES, SUPPORTED_STATES } from '@/lib/rules';
import { LEGAL_UPDATED, PUBLIC_PAGES, contactEmailFrom } from '@/lib/site';

beforeEach(() => {
  vi.stubEnv('APP_URL', 'https://lienclock.example');
  vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', '');
  vi.stubEnv('CONTACT_EMAIL', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** The page as a reader sees it: tags dropped, entities decoded, whitespace collapsed. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

const render = (element: React.ReactElement) => renderToStaticMarkup(element);

describe('terms of use', () => {
  const html = () => render(TermsPage());
  const text = () => visibleText(html());

  it('says it is a reference tool and not legal advice, from a company that is not a law firm', () => {
    expect(text()).toMatch(/not legal advice/i);
    expect(text()).toMatch(/not a law firm/i);
    expect(text()).toMatch(/no attorney.client relationship/i);
    expect(text()).toMatch(/does not prepare, send, serve, file or record notices or liens/i);
  });

  it('states what is covered and how dates are counted', () => {
    for (const code of SUPPORTED_STATES) expect(text()).toContain(STATES[code].name);
    expect(text()).toMatch(/private commercial projects/i);
    expect(text()).toMatch(/subcontractors hired directly by the general contractor/i);
    expect(text()).toMatch(/calendar days/i);
    expect(text()).toMatch(/never extended for weekends or holidays/i);
    expect(text()).toMatch(/notice of completion/i);
  });

  it('puts the responsibility to check each date on the user, and warns that alerts can fail', () => {
    expect(text()).toMatch(/check every date against the linked statute or with a construction attorney before you rely on it/i);
    expect(text()).toMatch(/alerts can be delayed, land in spam or fail/i);
    expect(text()).toMatch(/as is/i);
    expect(text()).toMatch(/limitation of liability/i);
  });

  it('is dated and links to the privacy policy', () => {
    expect(LEGAL_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(text()).toContain(`Last updated ${LEGAL_UPDATED}`);
    expect(html()).toContain('href="/privacy"');
  });

  it('states the price and how billing works (M3)', () => {
    expect(text()).not.toMatch(/free during early access\. If we introduce paid plans/i);
    expect(text()).toMatch(/Free plan.*1 tracked job/i);
    expect(text()).toMatch(/LienClock Pro costs US\$29 per month/);
    expect(text()).toMatch(/Stripe/);
    expect(text()).toMatch(/never see or store your card number/i);
    expect(text()).toMatch(/renews monthly until you cancel/i);
    expect(text()).toMatch(/no refunds for partial months/i);
    expect(text()).toMatch(/jobs you already track keep their alerts/i);
    expect(text()).toMatch(/30 days’ notice/);
  });

  it('says how rule changes are announced (M3)', () => {
    expect(html()).toContain('href="/changelog"');
    expect(text()).toMatch(/email everyone who tracks a job in that state/i);
  });
});

describe('privacy policy', () => {
  const html = () => render(PrivacyPage());
  const text = () => visibleText(html());

  it('lists what LienClock stores, including what it keeps from forwarded emails', () => {
    expect(text()).toMatch(/your email address/i);
    expect(text()).toMatch(/the GC or owner/i);
    expect(text()).toMatch(/subject, the sender’s address and the short lines/i);
    expect(text()).toMatch(/not the full email or its attachments/i);
    expect(text()).toMatch(/record of each alert/i);
  });

  it('names the processors and the only cookie', () => {
    // Go-live: the app is hosted on Cloudflare Workers, not Vercel.
    for (const name of ['Cloudflare', 'Neon', 'Resend', 'Stripe']) expect(text()).toContain(name);
    expect(text()).not.toContain('Vercel');
    expect(text()).toContain(SESSION_COOKIE);
    expect(text()).toMatch(/no analytics/i);
  });

  it('says what billing stores, and that card numbers never reach LienClock (M3)', () => {
    expect(text()).toMatch(/Stripe customer and subscription IDs/i);
    expect(text()).toMatch(/never see or store your card number/i);
    expect(text()).toMatch(/record of each rule-change email/i);
    expect(text()).toMatch(/cancel your subscription before you delete your account/i);
  });

  it('promises no selling or advertising use', () => {
    expect(text()).toMatch(/we do not sell/i);
    expect(text()).toMatch(/advertising/i);
  });

  it('explains how to delete a job or the whole account', () => {
    expect(html()).toContain('href="/jobs#account"');
    expect(text()).toMatch(/Delete my account/);
    expect(text()).toMatch(/deleting a job also deletes its alerts/i);
    expect(text()).toContain(`Last updated ${LEGAL_UPDATED}`);
    expect(html()).toContain('href="/terms"');
  });

  it('shows a contact address only when CONTACT_EMAIL is a valid address', () => {
    expect(html()).not.toContain('mailto:');
    expect(render(TermsPage())).not.toContain('mailto:');

    vi.stubEnv('CONTACT_EMAIL', 'Privacy@LienClock.example');
    expect(html()).toContain('href="mailto:privacy@lienclock.example"');
    expect(render(TermsPage())).toContain('href="mailto:privacy@lienclock.example"');

    for (const bad of ['not an email', 'a@b.co\r\nBcc: x@y.co', '"><script>@x.co']) {
      vi.stubEnv('CONTACT_EMAIL', bad);
      expect(html()).not.toContain('mailto:');
    }
  });
});

describe('contactEmailFrom', () => {
  it('normalizes a valid address and rejects anything else', () => {
    expect(contactEmailFrom({ CONTACT_EMAIL: ' Help@LienClock.example ' })).toBe('help@lienclock.example');
    expect(contactEmailFrom({ CONTACT_EMAIL: '' })).toBeNull();
    expect(contactEmailFrom({})).toBeNull();
    expect(contactEmailFrom({ CONTACT_EMAIL: 'help@lienclock.example\nBcc: x@y.co' })).toBeNull();
  });
});

describe('every page', () => {
  it('links to the terms and the privacy policy from the footer, next to the disclaimer', () => {
    const html = render(RootLayout({ children: <p>page</p> }));
    const footer = /<footer>([\s\S]*)<\/footer>/.exec(html)?.[1] ?? '';
    expect(footer).toContain('href="/terms"');
    expect(footer).toContain('href="/privacy"');
    expect(visibleText(footer)).toMatch(/not legal advice/i);
  });

  it('links to the rule changes from the footer (M3)', () => {
    const footer = /<footer>([\s\S]*)<\/footer>/.exec(render(RootLayout({ children: <p>page</p> })))?.[1] ?? '';
    expect(footer).toContain('href="/changelog"');
  });

  it('describes the coverage in the page metadata and resolves og:image URLs against the app URL (M3)', () => {
    const metadata = layoutMetadata();
    expect(String(metadata.description)).toContain('16 states');
    expect(String(metadata.metadataBase)).toBe('https://lienclock.example/');
    // A malformed APP_URL (no scheme) must not throw on every page.
    vi.stubEnv('APP_URL', 'lienclock.example');
    expect(() => layoutMetadata()).not.toThrow();
    expect(layoutMetadata().metadataBase).toBeUndefined();
  });
});

describe('og:image (M3)', () => {
  it('is a 1200×630 PNG that names the product and the price', async () => {
    expect(ogSize).toEqual({ width: 1200, height: 630 });
    expect(ogContentType).toBe('image/png');
    expect(ogAlt).toContain('$29/month');
    const res = await OpengraphImage();
    expect(res.headers.get('content-type')).toBe('image/png');
    const png = Buffer.from(await res.arrayBuffer());
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // IHDR: width and height, big-endian, right after the 8-byte signature and the chunk header.
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
  });
});

describe('robots.txt', () => {
  const rule = () => {
    const { rules } = robots();
    const list = Array.isArray(rules) ? rules : [rules];
    expect(list).toHaveLength(1);
    return list[0];
  };
  /** Crawlers apply the longest matching rule. Every Disallow prefix is longer than `Allow: /`, so any match blocks. */
  const blocked = (path: string) => {
    const disallow = [rule().disallow ?? []].flat();
    return disallow.some((prefix) => path.startsWith(prefix));
  };

  it('lets every crawler see the public pages', () => {
    expect(rule()).toMatchObject({ userAgent: '*', allow: '/' });
    for (const path of ['/', '/?state=CA&counterparty=Acme&firstFurnishDate=2026-03-01', '/privacy', '/terms', '/sitemap.xml']) {
      expect(blocked(path), path).toBe(false);
    }
  });

  it('keeps crawlers off signed-in pages and every URL that carries a secret', () => {
    for (const path of [
      '/jobs',
      '/jobs/9f1c2d3e-4b5a-4c6d-8e7f-a1b2c3d4e5f6',
      `/signin?token=${'A'.repeat(43)}`,
      '/signin?next=%2Fjobs',
      '/intake/9f1c2d3e-4b5a-4c6d-8e7f-a1b2c3d4e5f6',
      `/calendar/${'B'.repeat(43)}.ics`,
      '/api/intake/email',
      '/api/cron/alerts',
    ]) {
      expect(blocked(path), path).toBe(true);
    }
  });

  it('points at the sitemap on the configured host, falling back to the Vercel production URL', () => {
    expect(robots().sitemap).toBe('https://lienclock.example/sitemap.xml');
    vi.stubEnv('APP_URL', '');
    vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', 'lienclock-eta.vercel.app');
    expect(robots().sitemap).toBe('https://lienclock-eta.vercel.app/sitemap.xml');
  });
});

describe('sitemap.xml', () => {
  it('lists exactly the public pages, as absolute URLs', () => {
    expect(sitemap().map((entry) => entry.url)).toEqual([
      'https://lienclock.example/',
      'https://lienclock.example/changelog',
      'https://lienclock.example/privacy',
      'https://lienclock.example/terms',
    ]);
    expect(PUBLIC_PAGES).toEqual(['/', '/changelog', '/privacy', '/terms']);
  });

  it('never lists a page robots.txt blocks', () => {
    const disallow = [robots().rules].flat().flatMap((r) => [r.disallow ?? []].flat());
    for (const { url } of sitemap()) {
      const path = new URL(url).pathname;
      expect(disallow.some((prefix) => path.startsWith(prefix)), path).toBe(false);
    }
  });
});
