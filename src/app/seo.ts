// Search and sharing tags for the public pages: a unique title and description, the canonical URL,
// Open Graph and Twitter cards with the 1200×630 share image that opengraph-image.tsx draws at build
// time. Every URL resolves against APP_URL (metadataBase in layout.tsx).
import type { Metadata } from 'next';
import { PRO_MONTHLY_USD, PRO_PRICE_LABEL } from '@/lib/billing';
import { SUPPORTED_STATES } from '@/lib/rules';
import { SITE_NAME, type PUBLIC_PAGES } from '@/lib/site';

export const SITE_DESCRIPTION = `See every preliminary-notice and lien deadline a job triggers in ${SUPPORTED_STATES.length} states (${SUPPORTED_STATES.join(', ')}), with the statute behind each date, and get alerts before they lapse. ${PRO_PRICE_LABEL}, no per-notice fees.`;

/**
 * The share image (opengraph-image.tsx, prerendered). Named explicitly on each public page: a page that
 * sets its own openGraph would otherwise drop the image Next.js adds from the file.
 */
export const SHARE_IMAGE = {
  url: '/opengraph-image',
  width: 1200,
  height: 630,
  type: 'image/png',
  alt: `LienClock: preliminary-notice and lien deadlines for subcontractors in ${SUPPORTED_STATES.length} states. ${PRO_PRICE_LABEL}, no per-notice fees.`,
};

export interface PublicPage {
  path: (typeof PUBLIC_PAGES)[number];
  title: string;
  description: string;
}

export function publicPageMetadata({ path, title, description }: PublicPage): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { type: 'website', siteName: SITE_NAME, locale: 'en_US', url: path, title, description, images: [SHARE_IMAGE] },
    twitter: { card: 'summary_large_image', title, description, images: [SHARE_IMAGE] },
  };
}

/** schema.org SoftwareApplication with the Pro plan's offer, for the JSON-LD on every page. */
export function softwareApplicationJsonLd(appUrl: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: SITE_NAME,
    url: `${appUrl}/`,
    description: SITE_DESCRIPTION,
    image: `${appUrl}${SHARE_IMAGE.url}`,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    offers: {
      '@type': 'Offer',
      name: `${SITE_NAME} Pro`,
      url: `${appUrl}/#pricing`,
      price: String(PRO_MONTHLY_USD),
      priceCurrency: 'USD',
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price: String(PRO_MONTHLY_USD),
        priceCurrency: 'USD',
        unitCode: 'MON',
        billingDuration: 'P1M',
      },
    },
  };
}

/** JSON for a <script type="application/ld+json">: `<` escaped so no value can close the tag. */
export function jsonLdHtml(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
