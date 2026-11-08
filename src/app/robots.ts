import type { MetadataRoute } from 'next';
import { appUrlFrom } from '@/lib/cron';
import { PRIVATE_PATHS } from '@/lib/site';

// /robots.txt: crawl the public pages, stay off signed-in pages and URLs that carry secrets. Those
// pages also send noindex themselves, for crawlers that ignore this file or find a leaked link.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: PRIVATE_PATHS },
    sitemap: `${appUrlFrom(process.env)}/sitemap.xml`,
  };
}
