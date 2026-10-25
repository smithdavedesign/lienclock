import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Both load native-ish assets (PGlite's WASM, pg's optional bindings): keep them out of the bundle.
  serverExternalPackages: ['@electric-sql/pglite', 'pg'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // Sign-in links and calendar feed URLs carry secrets: never leak a URL to statute sites via Referer.
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
