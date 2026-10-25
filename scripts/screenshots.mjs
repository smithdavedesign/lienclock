#!/usr/bin/env node
// `npm run screenshots`: builds the app, starts it on localhost against a throwaway embedded
// database, drives it with Playwright (desktop 1280×800 and iPhone 13) and saves viewport PNGs to
// docs/screenshots/. Chromium is never downloaded: set CHROMIUM_PATH to an installed binary.
//
// The app runs with every service credential blanked, so it can't touch a real database or send
// email: the sign-in link it would email is printed to its console, where this script picks it up.
// All job data below is made up, and dates are relative to today so statuses stay realistic.
import { spawn } from 'node:child_process';
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

const DESKTOP = { viewport: { width: 1280, height: 800 } };
const { defaultBrowserType: _ignored, ...PHONE } = devices['iPhone 13'];

/** YYYY-MM-DD, `offset` days from today (UTC). */
function day(offset) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

// The job typed into the calculator: a Texas job with month-by-month notices, one already late.
const CALCULATOR_JOB = {
  state: 'TX',
  counterparty: 'Lone Star Commercial Builders',
  firstFurnishDate: day(-110),
  lastFurnishDate: day(-10),
};

// More jobs saved to the same account, so the dashboard shows at-risk, missed and protected jobs.
const MORE_JOBS = [
  { state: 'AZ', counterparty: 'Mesa Ridge Construction', firstFurnishDate: day(-18) },
  { state: 'CA', counterparty: 'Harbor Point Builders', firstFurnishDate: day(-14) },
  { state: 'WA', counterparty: 'Cascade General Contractors', firstFurnishDate: day(-120), lastFurnishDate: day(-30) },
  { state: 'FL', counterparty: 'Gulf Coast Constructors', firstFurnishDate: day(-52) },
  {
    state: 'NV',
    counterparty: 'Silver State Contractors',
    firstFurnishDate: day(-25),
    served: { label: 'Date served: Notice of right to lien', date: day(-20) },
  },
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
    'CRON_SECRET',
    'ALERT_FROM_EMAIL',
    'VERCEL',
    'VERCEL_PROJECT_PRODUCTION_URL',
  ]) {
    env[key] = '';
  }
  return { ...env, APP_URL: baseUrl, PGLITE_DIR: DATA_DIR, NEXT_TELEMETRY_DISABLED: '1' };
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

/** Start page with a job typed in, then the deadlines it triggers. */
async function calculator(context, baseUrl, size) {
  const page = await context.newPage();
  await page.goto(baseUrl);
  await fillJob(page, CALCULATOR_JOB);
  await page.evaluate(() => window.scrollTo(0, 0)); // filling the last field scrolled it into view
  await shot(page, `home-${size}`);
  await Promise.all([page.waitForURL(/\?state=TX/), page.getByRole('button', { name: 'Show deadlines' }).click()]);
  await page.locator('#deadlines-heading').evaluate((el) => {
    el.scrollIntoView({ block: 'start' });
    window.scrollBy(0, -12);
  });
  await shot(page, `deadlines-${size}`);
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
  if ((await build.exited) !== 0) throw new Error(`next build failed:\n${build.redacted()}`);

  console.log(`starting the app on ${baseUrl}…`);
  const server = runNext(['start', '-p', String(port), '-H', '127.0.0.1'], env);
  let browser;
  try {
    await waitUntilAnswering(baseUrl, server);
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });

    // 1. A visitor on a desktop: enters the Texas job, sees its deadlines, saves it with an email.
    const desktop = await browser.newContext(DESKTOP);
    const page = await calculator(desktop, baseUrl, 'desktop');
    await page.fill('input[name="alertEmail"]', SAMPLE_EMAIL);
    const before = server.output().length;
    await Promise.all([page.waitForURL(/\/signin\?sent=job/), page.getByRole('button', { name: 'Save & email me alerts' }).click()]);

    // 2. Opens the (locally printed) sign-in link: the account is created and the job saved.
    await page.goto(await waitForSignInLink(server, before));
    await Promise.all([page.waitForURL(/\/jobs(\/[0-9a-f-]{36})?$/), page.getByRole('button', { name: 'Sign in to LienClock' }).click()]);

    // 3. Saves more jobs while signed in, and records one served notice.
    for (const job of MORE_JOBS) {
      await page.goto(baseUrl);
      await fillJob(page, job);
      await Promise.all([page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/), page.getByRole('button', { name: 'Save & email me alerts' }).click()]);
      if (job.served) {
        const row = page.locator('form.inline', { has: page.getByLabel(job.served.label) });
        await row.getByLabel(job.served.label).fill(job.served.date);
        await row.getByRole('button', { name: 'Save' }).click();
        await page.locator('.badge-protected').first().waitFor();
      }
    }

    // 4. The dashboard. The calendar feed address holds a secret token: always masked.
    const dashboard = async (p, size) => {
      await p.goto(`${baseUrl}/jobs`);
      await p.getByRole('heading', { name: 'Your jobs' }).waitFor();
      await shot(p, `jobs-${size}`, { mask: [p.locator('input.copy')], maskColor: '#d9dee7' });
    };
    await dashboard(page, 'desktop');

    // 5. The same on a phone, signed in to the same account.
    const phone = await browser.newContext(PHONE);
    await calculator(phone, baseUrl, 'mobile');
    await phone.addCookies(await desktop.cookies());
    await dashboard(await phone.newPage(), 'mobile');
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
