#!/usr/bin/env node
// `npm run screenshots`: builds the app, starts it on localhost against a throwaway embedded
// database, drives it with Playwright (desktop 1280×800 and iPhone 13) and saves viewport PNGs to
// docs/screenshots/. Chromium is never downloaded: set CHROMIUM_PATH to an installed binary.
//
// The app runs with every real service credential blanked, so it can't touch a real database, send
// email or reach Stripe. The sign-in link it would email is printed to its console, where this
// script picks it up. The cron and Stripe webhook secrets are random values made up for this run,
// so the script can call the cron (which records the rules changelog) and play Stripe's part after
// a checkout (a signed checkout.session.completed event). The payment links are sample URLs that
// are never opened. All job data below is made up, and dates are relative to today.
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'screenshots');
const NEXT_BIN = join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
const DATA_DIR = join(ROOT, '.data', `screenshots-${process.pid}`);
const SAMPLE_EMAIL = 'office@example.com';
// Made up for this run only: they exist in this process and the app it starts, nowhere else.
const CRON_SECRET = randomBytes(24).toString('hex');
const WEBHOOK_SECRET = randomBytes(24).toString('hex');

const DESKTOP = { viewport: { width: 1280, height: 800 } };
const { defaultBrowserType: _ignored, ...PHONE } = devices['iPhone 13'];

/** YYYY-MM-DD, `offset` days from today (UTC). */
function day(offset) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

// The job typed into the calculator: Pennsylvania (added in M3), with a Notice of Furnishing
// already past, a notice of intent and the lien claim still ahead.
const CALCULATOR_JOB = {
  state: 'PA',
  counterparty: 'Keystone Builders Group',
  firstFurnishDate: day(-150),
  lastFurnishDate: day(-20),
};

// Saved after subscribing to Pro: more jobs in M3 states, at risk, missed and fine.
const MORE_JOBS = [
  { state: 'OH', counterparty: 'Buckeye Commercial Builders', firstFurnishDate: day(-15) },
  { state: 'CO', counterparty: 'Front Range Construction', firstFurnishDate: day(-140), lastFurnishDate: day(-100) },
  { state: 'GA', counterparty: 'Peachtree General Contractors', firstFurnishDate: day(-130), lastFurnishDate: day(-95) },
];

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
    'RESEND_API_KEY',
    'RESEND_WEBHOOK_SECRET',
    'INTAKE_EMAIL_DOMAIN',
    'ALERT_FROM_EMAIL',
    'CONTACT_EMAIL',
    'VERCEL',
    'VERCEL_PROJECT_PRODUCTION_URL',
  ]) {
    env[key] = '';
  }
  return {
    ...env,
    APP_URL: baseUrl,
    PGLITE_DIR: DATA_DIR,
    NEXT_TELEMETRY_DISABLED: '1',
    CRON_SECRET,
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    // Sample URLs (never opened): they switch billing on so the Free/Pro plans show as in production.
    STRIPE_PAYMENT_LINK: 'https://buy.stripe.com/sample-lienclock-pro',
    STRIPE_PORTAL_URL: 'https://billing.stripe.com/p/login/sample-lienclock',
  };
}

/** Runs `next <args>`, keeping its output in memory (sign-in links included: never echoed as is). */
function runNext(args, env) {
  const child = spawn(process.execPath, [NEXT_BIN, ...args], { cwd: ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve(code ?? signal)));
  return {
    child,
    exited,
    output: () => output,
    /** The output with sign-in tokens blanked, safe to show when something fails. */
    redacted: () => output.replace(/token=[\w-]+/g, 'token=…'),
  };
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
    if (server.child.exitCode !== null) throw new Error(`The app exited early:\n${server.redacted()}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The app did not answer on ${url} within ${timeoutMs / 1000} s:\n${server.redacted()}`);
}

async function waitForSignInLink(server, after, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = server.output().slice(after).match(/https?:\/\/\S+\/signin\?token=[\w-]+/);
    if (match) return match[0];
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`No sign-in link appeared in the app's output:\n${server.redacted()}`);
}

/** Runs the daily cron once, as Vercel Cron would: it records the rules changelog. */
async function runCron(baseUrl) {
  const res = await fetch(`${baseUrl}/api/cron/alerts`, { headers: { authorization: `Bearer ${CRON_SECRET}` } });
  const body = await res.json();
  if (!res.ok || !body.ruleChanges?.ok) throw new Error(`The cron run failed: ${res.status} ${JSON.stringify(body)}`);
  console.log(`cron: ${body.ruleChanges.created} rule changes recorded, ${body.enqueued} alerts queued`);
}

/** What Stripe sends after someone pays through the Payment Link: a signed checkout.session.completed. */
async function completeCheckout(baseUrl, accountId) {
  const created = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    id: 'evt_sample_checkout',
    object: 'event',
    type: 'checkout.session.completed',
    created,
    data: {
      object: {
        id: 'cs_sample',
        object: 'checkout.session',
        mode: 'subscription',
        payment_status: 'paid',
        client_reference_id: accountId,
        customer: 'cus_sample',
        subscription: 'sub_sample',
        customer_details: { email: SAMPLE_EMAIL },
      },
    },
  });
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(`${created}.${body}`).digest('hex');
  const res = await fetch(`${baseUrl}/api/stripe/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${created},v1=${signature}` },
    body,
  });
  const result = await res.json();
  if (!res.ok || !result.updated) throw new Error(`The webhook did not activate Pro: ${res.status} ${JSON.stringify(result)}`);
}

async function fillJob(page, job) {
  await page.selectOption('select[name="state"]', job.state);
  await page.fill('input[name="counterparty"]', job.counterparty);
  await page.fill('input[name="firstFurnishDate"]', job.firstFurnishDate);
  await page.fill('input[name="lastFurnishDate"]', job.lastFurnishDate ?? '');
}

async function shot(page, name, options = {}) {
  await page.evaluate(() => {
    document.activeElement?.blur(); // no focus ring or selected date segment in the picture
    return document.fonts.ready;
  });
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, ...options });
  console.log(`saved docs/screenshots/${name}.png`);
}

async function scrollTo(page, selector) {
  await page.locator(selector).evaluate((el) => {
    el.scrollIntoView({ block: 'start' });
    window.scrollBy(0, -12);
  });
}

/** The calculator with the Pennsylvania job typed in, scrolled to the deadlines it triggers. */
async function calculator(context, baseUrl, size) {
  const page = await context.newPage();
  await page.goto(baseUrl);
  await fillJob(page, CALCULATOR_JOB);
  await Promise.all([page.waitForURL(/\?state=PA/), page.getByRole('button', { name: 'Show deadlines' }).click()]);
  await scrollTo(page, '#deadlines-heading');
  await shot(page, `deadlines-${size}`);
  return page;
}

/** The dashboard: Pro plan and the jobs, most urgent first. The feed address holds a secret: masked. */
async function dashboard(page, baseUrl, size) {
  await page.goto(`${baseUrl}/jobs`);
  await page.getByRole('heading', { name: 'Your jobs' }).waitFor();
  await page.getByText('LienClock Pro, $29/month').waitFor();
  await shot(page, `jobs-${size}`, { mask: [page.locator('input.copy')], maskColor: '#d9dee7' });
}

async function changelog(page, baseUrl, size) {
  await page.goto(`${baseUrl}/changelog`);
  await page.getByRole('heading', { name: 'Changes', exact: true }).waitFor();
  await scrollTo(page, '#changes-heading');
  await shot(page, `changelog-${size}`);
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
  if ((await build.exited) !== 0) throw new Error(`next build failed:\n${build.redacted()}`);

  console.log(`starting the app on ${baseUrl}…`);
  const server = runNext(['start', '-p', String(port), '-H', '127.0.0.1'], env);
  let browser;
  try {
    await waitUntilAnswering(baseUrl, server);
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });

    // 0. The first daily cron run on this database records the changes since the baseline rules.
    await runCron(baseUrl);

    // 1. A visitor on a desktop: enters the Pennsylvania job, sees its deadlines, saves it with an email.
    const desktop = await browser.newContext(DESKTOP);
    const page = await calculator(desktop, baseUrl, 'desktop');
    await page.fill('input[name="alertEmail"]', SAMPLE_EMAIL);
    const before = server.output().length;
    await Promise.all([page.waitForURL(/\/signin\?sent=job/), page.getByRole('button', { name: 'Save & email me alerts' }).click()]);

    // 2. Opens the (locally printed) sign-in link: the account is created and the job saved (Free: 1 job).
    await page.goto(await waitForSignInLink(server, before));
    await Promise.all([page.waitForURL(/\/jobs(\/[0-9a-f-]{36})?$/), page.getByRole('button', { name: 'Sign in to LienClock' }).click()]);

    // 3. A second job hits the Free plan's limit and comes back with a subscribe link.
    await page.goto(baseUrl);
    await fillJob(page, MORE_JOBS[0]);
    await Promise.all([page.waitForURL(/limit=1/), page.getByRole('button', { name: 'Save & email me alerts' }).click()]);
    const subscribe = await page.getByRole('link', { name: /Subscribe to Pro/ }).getAttribute('href');
    const accountId = new URL(subscribe).searchParams.get('client_reference_id');

    // 4. Pays through the Payment Link; Stripe's webhook makes the account Pro. Then saves the rest.
    await completeCheckout(baseUrl, accountId);
    for (const job of MORE_JOBS) {
      await page.goto(baseUrl);
      await fillJob(page, job);
      await Promise.all([page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/), page.getByRole('button', { name: 'Save & email me alerts' }).click()]);
    }

    await dashboard(page, baseUrl, 'desktop');
    await changelog(page, baseUrl, 'desktop');

    // 5. The same on a phone, signed in to the same account.
    const phone = await browser.newContext(PHONE);
    await calculator(phone, baseUrl, 'mobile');
    await phone.addCookies(await desktop.cookies());
    const phonePage = await phone.newPage();
    await dashboard(phonePage, baseUrl, 'mobile');
    await changelog(phonePage, baseUrl, 'mobile');
  } finally {
    await browser?.close();
    await stop(server);
    await rm(DATA_DIR, { recursive: true, force: true });
  }
}

main().catch((error) => {
  // Playwright's own logs quote the URLs it visited, sign-in link included.
  console.error(String(error instanceof Error ? error.message : error).replace(/token=[\w-]+/g, 'token=…'));
  process.exit(1);
});
