// Go-live: search and sharing tags on every public page, JSON-LD with the $29/month offer, the "Get Pro"
// button (shown only when STRIPE_PAYMENT_LINK is set, read per request), the visit beacon's rules, the
// legal pages' new lines, and the Cloudflare Worker's configuration.
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChangelogPage, { metadata as changelogMetadata } from '@/app/changelog/page';
import RootLayout from '@/app/layout';
import CalculatorPage, { metadata as homeMetadata } from '@/app/page';
import PrivacyPage, { metadata as privacyMetadata } from '@/app/privacy/page';
import robots from '@/app/robots';
import { SHARE_IMAGE, jsonLdHtml, softwareApplicationJsonLd } from '@/app/seo';
import sitemap from '@/app/sitemap';
import TermsPage, { metadata as termsMetadata } from '@/app/terms/page';
import { paymentLinkFrom } from '@/lib/billing';
import {
  NO_TRACK_KEY,
  SENT_FLAGS,
  SIGNAL_SLUG,
  SIGNAL_URL,
  externalReferrer,
  isProductionBuild,
  sendSignal,
  type SignalBrowser,
} from '@/lib/signal';
import { GITHUB_ISSUES_URL, PUBLIC_PAGES } from '@/lib/site';

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  // /changelog reads the database: an empty embedded one is enough to render it.
  const ready = actual.createMemoryDb().then(async (db) => {
    await actual.ensureSchema(db);
    return db;
  });
  return { ...actual, getDb: () => ready };
});

const APP_URL = 'https://lienclock.example';
const SAMPLE_LINK = 'https://example.com/pay';

beforeEach(() => {
  vi.stubEnv('APP_URL', APP_URL);
  vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', '');
  vi.stubEnv('CONTACT_EMAIL', '');
  vi.stubEnv('STRIPE_PAYMENT_LINK', '');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const html = async (element: Promise<React.ReactElement> | React.ReactElement) => renderToStaticMarkup(await element);
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
const home = (params: Record<string, string> = {}) => html(CalculatorPage({ searchParams: Promise.resolve(params) }));

const PAGE_METADATA = {
  '/': homeMetadata,
  '/changelog': changelogMetadata,
  '/privacy': privacyMetadata,
  '/terms': termsMetadata,
} as const;

describe('search and sharing tags', () => {
  it('cover exactly the public pages that the sitemap lists', () => {
    expect(Object.keys(PAGE_METADATA).sort()).toEqual([...PUBLIC_PAGES].sort());
    expect(sitemap().map((entry) => new URL(entry.url).pathname).sort()).toEqual([...PUBLIC_PAGES].sort());
  });

  it('give every public page its own title and description', () => {
    const titles = Object.values(PAGE_METADATA).map((m) => String(m.title));
    const descriptions = Object.values(PAGE_METADATA).map((m) => String(m.description));
    expect(new Set(titles).size).toBe(PUBLIC_PAGES.length);
    expect(new Set(descriptions).size).toBe(PUBLIC_PAGES.length);
    for (const [path, m] of Object.entries(PAGE_METADATA)) {
      expect(String(m.title), path).toMatch(/LienClock/);
      expect(String(m.description).length, path).toBeGreaterThan(50);
      expect(String(m.description).length, path).toBeLessThanOrEqual(300);
    }
  });

  it('set the canonical URL, Open Graph and a large Twitter card with the 1200×630 share image', () => {
    for (const [path, m] of Object.entries(PAGE_METADATA)) {
      expect(m.alternates?.canonical, path).toBe(path);
      expect(m.openGraph, path).toMatchObject({ url: path, title: m.title, description: m.description, siteName: 'LienClock', type: 'website' });
      expect(m.openGraph?.images, path).toEqual([SHARE_IMAGE]);
      expect(m.twitter, path).toMatchObject({ card: 'summary_large_image', title: m.title, description: m.description, images: [SHARE_IMAGE] });
    }
    expect(SHARE_IMAGE).toMatchObject({ url: '/opengraph-image', width: 1200, height: 630, type: 'image/png' });
  });
});

describe('JSON-LD', () => {
  const ldFrom = (markup: string) => {
    const json = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(markup)?.[1];
    expect(json).toBeDefined();
    return JSON.parse(json!);
  };

  it('is on every page: a SoftwareApplication with an Offer of $29 a month', () => {
    const ld = ldFrom(renderToStaticMarkup(RootLayout({ children: <p>page</p> })));
    expect(ld).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'LienClock',
      url: `${APP_URL}/`,
      image: `${APP_URL}/opengraph-image`,
      offers: {
        '@type': 'Offer',
        price: '29',
        priceCurrency: 'USD',
        priceSpecification: { '@type': 'UnitPriceSpecification', price: '29', priceCurrency: 'USD', unitCode: 'MON' },
      },
    });
  });

  it('cannot close its script tag, whatever a value holds', () => {
    const out = jsonLdHtml({ name: '</script><script>alert(1)</script>' });
    expect(out).not.toContain('<');
    expect(JSON.parse(out).name).toBe('</script><script>alert(1)</script>');
    expect(jsonLdHtml(softwareApplicationJsonLd(APP_URL))).not.toContain('<');
  });
});

describe('robots.txt and sitemap.xml', () => {
  it('allow indexing and point at the sitemap, which lists every public page', () => {
    const { rules, sitemap: sitemapUrl } = robots();
    expect([rules].flat()[0]).toMatchObject({ userAgent: '*', allow: '/' });
    expect(sitemapUrl).toBe(`${APP_URL}/sitemap.xml`);
    expect(sitemap().map((entry) => entry.url)).toEqual(PUBLIC_PAGES.map((path) => `${APP_URL}${path}`));
  });
});

describe('the Get Pro button', () => {
  it('is hidden when STRIPE_PAYMENT_LINK is unset', async () => {
    const page = await home();
    expect(text(page)).not.toMatch(/Get LienClock Pro/);
    expect(page).not.toContain('example.com/pay');
    expect(text(page)).toMatch(/Paid plans aren’t open yet/);
  });

  it('links to STRIPE_PAYMENT_LINK, read when the page renders (no rebuild)', async () => {
    vi.stubEnv('STRIPE_PAYMENT_LINK', SAMPLE_LINK);
    const page = await home();
    expect(page).toMatch(/<a href="https:\/\/example\.com\/pay" class="button">Get LienClock Pro: \$29\/month<\/a>/);
    // Without the webhook secret the Free limit isn't enforced: say so instead of "not open yet".
    expect(text(page)).toMatch(/limit isn’t enforced yet/);
    expect(text(page)).not.toMatch(/Paid plans aren’t open yet/);

    vi.stubEnv('STRIPE_PAYMENT_LINK', '');
    expect(text(await home())).not.toMatch(/Get LienClock Pro/);
  });

  it('is hidden for a link that is not https', async () => {
    for (const bad of ['http://example.com/pay', 'javascript:alert(1)', 'not a url']) {
      vi.stubEnv('STRIPE_PAYMENT_LINK', bad);
      expect(paymentLinkFrom(process.env), bad).toBeNull();
      expect(text(await home()), bad).not.toMatch(/Get LienClock Pro/);
    }
  });

  it('stays below the calculator result, next to the plans', async () => {
    vi.stubEnv('STRIPE_PAYMENT_LINK', SAMPLE_LINK);
    const page = await home({ state: 'PA', counterparty: 'Keystone Builders Group', firstFurnishDate: '2026-06-01', lastFurnishDate: '2026-10-20' });
    expect(page.indexOf('id="deadlines-heading"')).toBeGreaterThan(0);
    expect(page.indexOf('Get LienClock Pro')).toBeGreaterThan(page.indexOf('id="pricing"'));
  });
});

describe('the pages render', () => {
  it('home, terms, privacy and changelog', async () => {
    expect(text(await home())).toMatch(/Which lien clocks just started\?/);
    expect(text(await html(TermsPage()))).toMatch(/Terms of Use/);
    expect(text(await html(PrivacyPage()))).toMatch(/Privacy Policy/);
    expect(text(await html(ChangelogPage()))).toMatch(/Rule changes/);
  });

  it('the footer links to pricing, the terms, the privacy policy and the GitHub issues', () => {
    const footer = /<footer>([\s\S]*)<\/footer>/.exec(renderToStaticMarkup(RootLayout({ children: <p>page</p> })))?.[1] ?? '';
    for (const href of ['/#pricing', '/terms', '/privacy', GITHUB_ISSUES_URL]) expect(footer).toContain(`href="${href}"`);
  });
});

describe('privacy policy and terms (go-live)', () => {
  const privacy = async () => text(await html(PrivacyPage()));
  const terms = async () => text(await html(TermsPage()));

  it('privacy names the three beacon events, what each message holds, and what it never holds', async () => {
    const page = await privacy();
    for (const kind of ['visit', 'activate', 'checkout']) expect(page).toMatch(new RegExp(`\\b${kind}\\b ?: `));
    expect(page).toContain(new URL(SIGNAL_URL).host);
    expect(page).toMatch(/once per browser session/);
    expect(page).toMatch(/no cookies/i);
    expect(page).toMatch(/never holds a LienClock page address/i);
    expect(page).toContain(NO_TRACK_KEY);
    expect(page).toContain('Cloudflare');
  });

  it('both point to the GitHub issues for contact, with a warning that issues are public', async () => {
    for (const markup of [await html(PrivacyPage()), await html(TermsPage())]) {
      expect(markup).toContain(`href="${GITHUB_ISSUES_URL}"`);
      expect(text(markup)).toMatch(/Issues are public/);
      expect(markup).not.toContain('mailto:');
    }
  });

  it('terms keep the price, the refund line and the no-warranty clause', async () => {
    const page = await terms();
    expect(page).toMatch(/LienClock Pro costs US\$29 per month/);
    expect(page).toMatch(/no refunds for partial months/);
    expect(page).toMatch(/No warranty/);
    expect(page).toMatch(/“as is”/);
  });
});

// ── The visit beacon ──────────────────────────────────────────────────────────────────────────────

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, String(value)),
    removeItem: (key) => void items.delete(key),
    key: (i) => [...items.keys()][i] ?? null,
  };
}

function fakeBrowser(overrides: Partial<SignalBrowser> = {}) {
  const fetch = vi.fn(async () => new Response(null, { status: 204 }));
  const browser: SignalBrowser = {
    navigator: { webdriver: false },
    location: { origin: 'https://lienclock.example' },
    document: { referrer: '' },
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    fetch: fetch as unknown as typeof globalThis.fetch,
    ...overrides,
  };
  return { browser, fetch };
}

const PRODUCTION = { NEXT_PUBLIC_DEPLOY_ENV: 'production' };
const sent = (fetch: ReturnType<typeof fakeBrowser>['fetch'], call = 0) => {
  const [url, init] = fetch.mock.calls[call] as unknown as [string, RequestInit];
  return { url, init, body: JSON.parse(String(init.body)) };
};

describe('the visit beacon', () => {
  it('POSTs {slug, kind, referrer} as JSON, fire-and-forget with keepalive and no cookies', () => {
    const { browser, fetch } = fakeBrowser({ document: { referrer: 'https://www.reddit.com/r/Construction/' } });
    expect(sendSignal('visit', browser, PRODUCTION)).toBe(true);
    const { url, init, body } = sent(fetch);
    expect(url).toBe('https://idea-factory.1426davejobs.workers.dev/api/ideas/signal');
    expect(init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'omit', referrerPolicy: 'no-referrer' });
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(body).toEqual({ slug: SIGNAL_SLUG, kind: 'visit', referrer: 'https://www.reddit.com/r/Construction/' });
    expect(SIGNAL_SLUG).toBe('lienclock');
  });

  it('sends visit once per session, activate once per browser, checkout on every click', () => {
    const { browser, fetch } = fakeBrowser();
    expect(sendSignal('visit', browser, PRODUCTION)).toBe(true);
    expect(sendSignal('visit', browser, PRODUCTION)).toBe(false);
    expect(browser.sessionStorage.getItem(SENT_FLAGS.visit!.key)).not.toBeNull();

    expect(sendSignal('activate', browser, PRODUCTION)).toBe(true);
    expect(sendSignal('activate', browser, PRODUCTION)).toBe(false);
    expect(browser.localStorage.getItem(SENT_FLAGS.activate!.key)).not.toBeNull();

    expect(sendSignal('checkout', browser, PRODUCTION)).toBe(true);
    expect(sendSignal('checkout', browser, PRODUCTION)).toBe(true);
    expect(fetch.mock.calls.map((_, i) => sent(fetch, i).body.kind)).toEqual(['visit', 'activate', 'checkout', 'checkout']);

    // A new session (fresh sessionStorage, same localStorage): visit again, activate not.
    const next = { ...browser, sessionStorage: memoryStorage() };
    expect(sendSignal('visit', next, PRODUCTION)).toBe(true);
    expect(sendSignal('activate', next, PRODUCTION)).toBe(false);
  });

  it('sends the referrer only when it is another site', () => {
    const origin = 'https://lienclock.example';
    expect(externalReferrer('', origin)).toBeNull();
    expect(externalReferrer('https://lienclock.example/?state=PA&counterparty=Keystone', origin)).toBeNull();
    expect(externalReferrer('not a url', origin)).toBeNull();
    expect(externalReferrer('https://news.ycombinator.com/item?id=1', origin)).toBe('https://news.ycombinator.com/item?id=1');
    // Same host on another scheme or port is another origin.
    expect(externalReferrer('http://lienclock.example/', origin)).toBe('http://lienclock.example/');

    const { browser, fetch } = fakeBrowser({ document: { referrer: 'https://lienclock.example/terms' } });
    sendSignal('checkout', browser, PRODUCTION);
    expect(sent(fetch).body.referrer).toBeNull();
  });

  it('sends nothing from automated browsers, from builds that are not production, or with repohq:notrack', () => {
    const bot = fakeBrowser({ navigator: { webdriver: true } });
    expect(sendSignal('visit', bot.browser, PRODUCTION)).toBe(false);
    expect(bot.fetch).not.toHaveBeenCalled();

    for (const env of [{}, { NEXT_PUBLIC_DEPLOY_ENV: 'preview' }, { NEXT_PUBLIC_VERCEL_ENV: 'preview' }, { NEXT_PUBLIC_VERCEL_ENV: 'development' }]) {
      const { browser, fetch } = fakeBrowser();
      expect(sendSignal('visit', browser, env), JSON.stringify(env)).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    }

    const owner = fakeBrowser();
    owner.browser.localStorage.setItem(NO_TRACK_KEY, '1');
    for (const kind of ['visit', 'activate', 'checkout'] as const) expect(sendSignal(kind, owner.browser, PRODUCTION)).toBe(false);
    expect(owner.fetch).not.toHaveBeenCalled();
    // Not counted as sent either: clearing the flag later still counts the visit.
    expect(owner.browser.sessionStorage.getItem(SENT_FLAGS.visit!.key)).toBeNull();
  });

  it('counts production on either host: NEXT_PUBLIC_DEPLOY_ENV (Cloudflare build), else NEXT_PUBLIC_VERCEL_ENV', () => {
    expect(isProductionBuild({ NEXT_PUBLIC_DEPLOY_ENV: 'production' })).toBe(true);
    expect(isProductionBuild({ NEXT_PUBLIC_VERCEL_ENV: 'production' })).toBe(true);
    expect(isProductionBuild({ NEXT_PUBLIC_DEPLOY_ENV: 'preview', NEXT_PUBLIC_VERCEL_ENV: 'production' })).toBe(false);
    expect(isProductionBuild({})).toBe(false);
    // This test run is not a production build, so the default sends nothing.
    const { browser, fetch } = fakeBrowser();
    expect(sendSignal('visit', browser)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never throws: blocked storage, a throwing fetch or a failed request', async () => {
    const blocked: Storage = { ...memoryStorage(), getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    const a = fakeBrowser({ localStorage: blocked, sessionStorage: blocked });
    expect(sendSignal('visit', a.browser, PRODUCTION)).toBe(true);

    const b = fakeBrowser({ fetch: (() => { throw new TypeError('no fetch'); }) as unknown as typeof fetch });
    expect(sendSignal('checkout', b.browser, PRODUCTION)).toBe(false);

    const rejected = vi.fn(() => Promise.reject(new TypeError('offline')));
    const c = fakeBrowser({ fetch: rejected as unknown as typeof fetch });
    expect(sendSignal('checkout', c.browser, PRODUCTION)).toBe(true);
    await Promise.resolve(); // the rejection is handled, not reported as unhandled
  });
});

// ── The Cloudflare Worker's configuration ─────────────────────────────────────────────────────────

/** wrangler.jsonc with its whole-line comments removed (it has no trailing ones). */
const wrangler = () => JSON.parse(readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''));
const pkg = () => JSON.parse(readFileSync('package.json', 'utf8'));

describe('Cloudflare Workers config', () => {
  it('wrangler.jsonc: the lienclock Worker on workers.dev, nodejs_compat, static assets, the daily cron, no build section', () => {
    const config = wrangler();
    expect(config).toMatchObject({ name: 'lienclock', workers_dev: true, main: 'worker.ts', assets: { directory: '.open-next/assets', binding: 'ASSETS' } });
    expect(config.compatibility_flags).toContain('nodejs_compat');
    expect(config).not.toHaveProperty('build');
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'));
    expect(config.triggers.crons).toEqual(vercel.crons.map((c: { schedule: string }) => c.schedule));
  });

  it('keeps secrets out of vars: only APP_URL, the same URL cf:build bakes into the prerendered pages', () => {
    const { vars } = wrangler();
    expect(Object.keys(vars)).toEqual(['APP_URL']);
    expect(vars.APP_URL).toMatch(/^https:\/\/lienclock\.[a-z0-9-]+\.workers\.dev$/);
    expect(pkg().scripts['cf:build']).toContain(`APP_URL=${vars.APP_URL} `);
  });

  it('cf:build builds for production and copies the prerendered pages into the static assets', () => {
    const script: string = pkg().scripts['cf:build'];
    expect(script).toMatch(/^NEXT_PUBLIC_DEPLOY_ENV=production /);
    expect(script).toContain('opennextjs-cloudflare build');
    expect(script).toMatch(/&& opennextjs-cloudflare populateCache local$/);
    expect(pkg().devDependencies).toHaveProperty('@opennextjs/cloudflare');
    expect(pkg().devDependencies).toHaveProperty('wrangler');
    expect(pkg().scripts.build).toBe('next build'); // the Vercel build is unchanged
  });

  it('.provision asks the broker for the Worker deploy and the Stripe payment link', () => {
    const lines = readFileSync('.provision', 'utf8').trim().split('\n');
    expect(lines).toEqual([
      'request "Cloudflare Workers deploy for lienclock: npm ci && npm run cf:build, then provision cloudflare deploy lienclock <checkout>, and provision cloudflare secret lienclock <KEY> for each value LAUNCH-READY.md lists"',
      'request "Stripe payment link for lienclock: $29/month, per REVENUE.md"',
    ]);
  });
});
