import type { MetadataRoute } from 'next';
import { appUrlFrom } from '@/lib/cron';
import { PUBLIC_PAGES } from '@/lib/site';

// /sitemap.xml: absolute URLs on the configured host, never the request's Host header.
export default function sitemap(): MetadataRoute.Sitemap {
  const base = appUrlFrom(process.env);
  return PUBLIC_PAGES.map((path) => ({
    url: `${base}${path}`,
    changeFrequency: 'monthly',
    priority: path === '/' ? 1 : 0.3,
  }));
}
