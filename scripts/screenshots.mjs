#!/usr/bin/env node
// `npm run screenshots`: builds the app, starts it on localhost, drives it with Playwright (desktop
// 1280×800 and iPhone 13) and saves viewport PNGs to docs/screenshots/. Chromium is never downloaded:
// set CHROMIUM_PATH to an installed binary.
//
// It shows the launch-ready site doing its main job: the start page with a sample job typed in, the
// deadlines that job triggers, and the plans with the "Get LienClock Pro" button and the footer links.
// The app runs with every real service credential blanked, so it can't touch a real database, send
// email or reach Stripe. STRIPE_PAYMENT_LINK is a placeholder URL that is never opened. All job data is
// made up, and dates are relative to today.
import { spawn } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'screenshots');
const NEXT_BIN = join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
const DATA_DIR = join(ROOT, '.data', `screenshots-${process.pid}`);
const PAYMENT_LINK = 'https://example.com/pay'; // placeholder: shows the button, never opened
const SIGNAL_HOST = 'idea-factory.1426davejobs.workers.dev';

const DESKTOP = { viewport: { width: 1280, height: 800 } };
const { defaultBrowserType: _ignored, ...PHONE } = devices['iPhone 13'];

/** YYYY-MM-DD, `offset` days from today (UTC). */
function day(offset) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

// The job typed into the calculator: Pennsylvania, with a Notice of Furnishing already past, a notice
// of intent and the lien claim still ahead.
const SAMPLE_JOB = {
  state: 'PA',
  counterparty: 'Keystone Builders Group',
  firstFurnishDate: day(-150),
  lastFurnishDate: day(-20),
};

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** A minimal environment for the app: no inherited secrets, and blanks that beat any .env file. */
function appEnv(baseUrl) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const key of [
    'DATABASE_URL',
    'CRON_SECRET',
    'RESEND_API_KEY',
    'RESEND_WEBHOOK_SECRET',
    'INTAKE_EMAIL_DOMAIN',
    'ALERT_FROM_EMAIL',
    'CONTACT_EMAIL',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_PORTAL_URL',
    'VERCEL',
    'VERCEL_PROJECT_PRODUCTION_URL',
    'NEXT_PUBLIC_DEPLOY_ENV',
    'NEXT_PUBLIC_VERCEL_ENV',
  ]) {
    env[key] = '';
  }
  return {
    ...env,
    APP_URL: baseUrl,
    PGLITE_DIR: DATA_DIR,
    NEXT_TELEMETRY_DISABLED: '1',
    // What `provision stripe lienclock … --host cloudflare` sets: the link only, no webhook secret yet.
    STRIPE_PAYMENT_LINK: PAYMENT_LINK,
  };
}

/** Runs `next <args>`, keeping its output in memory. */
function runNext(args, env) {
  const child = spawn(process.execPath, [NEXT_BIN, ...args], { cwd: ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve(code ?? signal)));
  return { child, exited, output: () => output };
}

function stop(proc) {
  if (proc.child.exitCode !== null || proc.child.signalCode !== null) return Promise.resolve();
  try {
    process.kill(-proc.child.pid, 'SIGTERM'); // the whole process group: next may fork workers
  } catch {
    proc.child.kill('SIGTERM');
  }
  return Promise.race([proc.exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
}

async function waitUntilAnswering(url, server, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`The app exited early:\n${server.output()}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The app did not answer on ${url} within ${timeoutMs / 1000} s:\n${server.output()}`);
}

/** Removes PNGs in docs/screenshots that this run didn't write, so older views don't pile up. */
async function pruneOld(written) {
  for (const file of await readdir(OUT)) {
    if (file.endsWith('.png') && !written.has(file)) {
      await rm(join(OUT, file));
      console.log(`removed docs/screenshots/${file} (no longer produced)`);
    }
  }
}

const WRITTEN = new Set();

async function shot(page, name) {
  await page.evaluate(() => {
    document.activeElement?.blur(); // no focus ring or selected date segment in the picture
    return document.fonts.ready;
  });
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  WRITTEN.add(`${name}.png`);
  console.log(`saved docs/screenshots/${name}.png`);
}

/**
 * One visitor: types the job in (start page), shows its deadlines (the core action and its result),
 * then scrolls to the plans, the Get Pro button and the footer.
 */
async function visit(context, baseUrl, size) {
  const page = await context.newPage();
  await page.goto(baseUrl);
  await page.selectOption('select[name="state"]', SAMPLE_JOB.state);
  await page.fill('input[name="counterparty"]', SAMPLE_JOB.counterparty);
  await page.fill('input[name="firstFurnishDate"]', SAMPLE_JOB.firstFurnishDate);
  await page.fill('input[name="lastFurnishDate"]', SAMPLE_JOB.lastFurnishDate);
  // Back to the top of the start page. Clicking the heading moves focus off the date field, which
  // blur() alone doesn't clear in the phone emulation.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('h1').click();
  await shot(page, `home-${size}`);

  await Promise.all([page.waitForURL(/\?state=PA/), page.getByRole('button', { name: 'Show deadlines' }).click()]);
  await page.locator('#deadlines-heading').evaluate((el) => {
    el.scrollIntoView({ block: 'start' });
    window.scrollBy(0, -12);
  });
  const rows = await page.locator('section[aria-labelledby="deadlines-heading"] tbody tr').count();
  if (rows < 2) throw new Error(`Expected the PA job's deadlines, found ${rows} rows`);
  await shot(page, `deadlines-${size}`);

  const buy = page.getByRole('link', { name: 'Get LienClock Pro: $29/month' });
  if ((await buy.getAttribute('href')) !== PAYMENT_LINK) throw new Error('The Get Pro button does not link to STRIPE_PAYMENT_LINK');
  for (const name of ['Terms of Use', 'Privacy Policy']) await page.locator('footer').getByRole('link', { name }).waitFor();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await shot(page, `pricing-${size}`);
  return page;
}

async function main() {
  if (!process.env.CHROMIUM_PATH) throw new Error('Set CHROMIUM_PATH to a Chromium or Chrome binary.');
  await mkdir(OUT, { recursive: true });
  await rm(DATA_DIR, { recursive: true, force: true });

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = appEnv(baseUrl);

  console.log('building the app (next build)…');
  const build = runNext(['build'], env);
  if ((await build.exited) !== 0) throw new Error(`next build failed:\n${build.output()}`);

  console.log(`starting the app on ${baseUrl}…`);
  const server = runNext(['start', '-p', String(port), '-H', '127.0.0.1'], env);
  let browser;
  try {
    await waitUntilAnswering(baseUrl, server);
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
    let beacons = 0;
    for (const [options, size] of [
      [DESKTOP, 'desktop'],
      [PHONE, 'mobile'],
    ]) {
      const context = await browser.newContext(options);
      context.on('request', (request) => {
        if (new URL(request.url()).host === SIGNAL_HOST) beacons += 1;
      });
      await visit(context, baseUrl, size);
      await context.close();
    }
    // An automated browser on a non-production build: the visit beacon must stay silent.
    if (beacons !== 0) throw new Error(`The visit beacon sent ${beacons} requests during the screenshot run`);
    console.log('beacon: no requests sent (automated browser, not a production build)');
    await pruneOld(WRITTEN);
  } finally {
    await browser?.close();
    await stop(server);
    await rm(DATA_DIR, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
