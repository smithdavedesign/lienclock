import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'node',
    // Stands in for Next's request scope: `cookies()` reads an in-memory jar (signed out by default).
    setupFiles: ['test/setup.ts'],
    // Each database test file boots one embedded WASM Postgres (PGlite), which takes ~8 s alone
    // and much longer when several files boot in parallel on a small machine.
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
