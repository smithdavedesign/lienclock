// M3 on the pages: pricing, the dashboard's Plan section, the Free-plan job limit on every path that
// creates a job, account deletion while subscribed, and the public /changelog page. Pages and
// server actions are called the way Next.js calls them, against one embedded Postgres for this file.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import rawRules from '../rules/rules.json';
import * as actions from '@/app/actions';
import ChangelogPage from '@/app/changelog/page';
import JobsPage from '@/app/jobs/page';
import CalculatorPage from '@/app/page';
import { SESSION_COOKIE, finishSignIn, startSignIn, type Account } from '@/lib/auth';
import { syncRuleChanges } from '@/lib/changelog';
import { getDb, type Db } from '@/lib/db';
import { createProposal, getProposal } from '@/lib/inbound';
import { createJob, listJobsForAccount } from '@/lib/jobs';
import { RULES, STATES, SUPPORTED_STATES, validateRuleSet } from '@/lib/rules';
import { cookieJar } from './helpers/cookies';
import { fakeStripeSecret } from './helpers/stripe';

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  const ready = actual.createMemoryDb().then(async (db) => {
    await actual.ensureSchema(db);
    return db;
  });
  return { ...actual, getDb: () => ready };
});

const PAYMENT_LINK = 'https://buy.stripe.com/test_lienclock_pro';
const PORTAL = 'https://billing.stripe.com/p/login/test_lienclock';

let db: Db;
beforeAll(async () => {
  db = await getDb();
});
beforeEach(async () => {
  await db.exec(
    'TRUNCATE rule_change_emails, rule_changes, rule_snapshots, alerts, jobs, accounts, login_tokens, sessions, intake_proposals RESTART IDENTITY CASCADE',
  );
  vi.stubEnv('RESEND_API_KEY', '');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('APP_URL', 'https://lienclock.example');
  vi.stubEnv('STRIPE_PAYMENT_LINK', '');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', '');
  vi.stubEnv('STRIPE_PORTAL_URL', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function billingOn() {
  vi.stubEnv('STRIPE_PAYMENT_LINK', PAYMENT_LINK);
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', fakeStripeSecret());
  vi.stubEnv('STRIPE_PORTAL_URL', PORTAL);
}

const params = <T,>(value: T) => Promise.resolve(value);
const html = async (element: Promise<React.ReactElement> | React.ReactElement) => renderToStaticMarkup(await element);
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

async function signInAs(email: string): Promise<Account> {
  const started = await startSignIn(db, { email, now: new Date() });
  if (!started.ok) throw new Error(started.error);
  const finished = await finishSignIn(db, started.token, { now: new Date() });
  if (!finished.ok) throw new Error('finish failed');
  cookieJar.set(SESSION_COOKIE, { value: finished.sessionToken, options: {} });
  return finished.account;
}

const setStatus = (account: Account, status: string | null) =>
  db.query('UPDATE accounts SET subscription_status = $2 WHERE id = $1', [account.id, status]);

function jobFor(account: Account, counterparty = 'Acme Builders') {
  return createJob(db, {
    state: 'CA',
    role: 'sub',
    projectType: 'commercial',
    counterparty,
    firstFurnishDate: '2026-11-01',
    lastFurnishDate: null,
    alertEmail: account.email,
    accountId: account.id,
  });
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
}

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest;
    if (typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT;')) return digest.split(';').slice(2, -2).join(';');
    throw error;
  }
  throw new Error('expected a redirect');
}

const newJob = { state: 'AZ', counterparty: 'Mesa Ridge Construction', firstFurnishDate: '2026-11-02', lastFurnishDate: '' };

describe('pricing on the calculator', () => {
  it('shows both plans and the $29/month price', async () => {
    const page = text(await html(CalculatorPage({ searchParams: params({}) })));
    expect(page).toContain('Pricing');
    expect(page).toMatch(/Free.*1 tracked job/);
    expect(page).toContain('Pro: $29/month');
    expect(page).toMatch(/no per-notice fees/i);
  });

  it('says everything is free while paid plans are not open (billing not configured)', async () => {
    expect(text(await html(CalculatorPage({ searchParams: params({}) })))).toMatch(/free during early access/i);
    billingOn();
    expect(text(await html(CalculatorPage({ searchParams: params({}) })))).not.toMatch(/early access/i);
  });

  it('Get Pro (go-live): tagged with the signed-in account, hidden while Stripe holds a subscription', async () => {
    billingOn();
    const account = await signInAs('office+buy@example.com');
    const free = await html(CalculatorPage({ searchParams: params({}) }));
    const href = /<a href="([^"]+)" class="button">Get LienClock Pro/.exec(free)?.[1].replace(/&amp;/g, '&');
    expect(href).toBeDefined();
    const url = new URL(href!);
    expect(url.origin + url.pathname).toBe(PAYMENT_LINK);
    expect(url.searchParams.get('client_reference_id')).toBe(account.id);
    expect(url.searchParams.get('prefilled_email')).toBe('office+buy@example.com');

    for (const status of ['active', 'trialing', 'past_due', 'incomplete', 'unpaid', 'paused']) {
      await setStatus(account, status);
      expect(text(await html(CalculatorPage({ searchParams: params({}) }))), status).not.toMatch(/Get LienClock Pro/);
    }
    await setStatus(account, 'canceled');
    expect(text(await html(CalculatorPage({ searchParams: params({}) })))).toMatch(/Get LienClock Pro/);
  });
});

describe('the dashboard Plan section', () => {
  it('early access: no subscribe button, unlimited jobs', async () => {
    await signInAs('office@example.com');
    const page = await html(JobsPage({ searchParams: params({}) }));
    expect(page).toContain('id="plan"');
    expect(text(page)).toMatch(/early access/i);
    expect(page).not.toContain('buy.stripe.com');
  });

  it('early access with a Payment Link but no webhook secret (go-live): Get Pro, still unlimited', async () => {
    vi.stubEnv('STRIPE_PAYMENT_LINK', PAYMENT_LINK);
    const account = await signInAs('office@example.com');
    const page = await html(JobsPage({ searchParams: params({}) }));
    expect(text(page)).toMatch(/Early access: track as many jobs as you like, free/);
    expect(text(page)).not.toMatch(/once paid plans open/);
    expect(page).toContain(`client_reference_id=${account.id}`);
    await setStatus(account, 'unpaid');
    expect(await html(JobsPage({ searchParams: params({}) }))).not.toContain('buy.stripe.com');
  });

  it('Free: shows the limit and a subscribe link that carries the account and its email', async () => {
    billingOn();
    const account = await signInAs('office+pay@example.com');
    await jobFor(account);
    const page = await html(JobsPage({ searchParams: params({}) }));
    expect(text(page)).toMatch(/Free plan/);
    expect(text(page)).toMatch(/1 of 1/);
    const href = /href="(https:\/\/buy\.stripe\.com[^"]+)"/.exec(page)?.[1].replace(/&amp;/g, '&');
    expect(href).toBeDefined();
    const url = new URL(href!);
    expect(url.searchParams.get('client_reference_id')).toBe(account.id);
    expect(url.searchParams.get('prefilled_email')).toBe('office+pay@example.com');
    expect(text(page)).toContain('$29/month');
  });

  it('Pro: no limit, and a link to manage or cancel in the Stripe portal', async () => {
    billingOn();
    const account = await signInAs('office@example.com');
    await setStatus(account, 'active');
    const page = await html(JobsPage({ searchParams: params({}) }));
    expect(text(page)).toMatch(/LienClock Pro/);
    expect(page).toContain(`href="${PORTAL}"`);
    expect(page).not.toContain('buy.stripe.com');
  });

  it('past due: asks for a new card; canceled: explains what still works', async () => {
    billingOn();
    const account = await signInAs('office@example.com');
    await setStatus(account, 'past_due');
    expect(text(await html(JobsPage({ searchParams: params({}) })))).toMatch(/payment failed/i);
    await setStatus(account, 'canceled');
    const page = text(await html(JobsPage({ searchParams: params({}) })));
    expect(page).toMatch(/subscription has ended/i);
    expect(page).toMatch(/keep their alerts/i);
    // A checkout paid by a slow method (bank debit) isn't "ended": it hasn't started yet.
    await setStatus(account, 'incomplete');
    const pending = text(await html(JobsPage({ searchParams: params({}) })));
    expect(pending).toMatch(/still confirming your first payment/i);
    expect(pending).not.toMatch(/has ended/i);
  });

  it('a subscription still open in Stripe but not paid: no second Subscribe link, and unpaid/paused point to the portal', async () => {
    // Subscribing again would start a second $29 subscription next to the one Stripe still holds.
    billingOn();
    const account = await signInAs('office@example.com');
    for (const status of ['incomplete', 'unpaid', 'paused']) {
      await setStatus(account, status);
      const page = await html(JobsPage({ searchParams: params({}) }));
      expect(page, status).not.toContain('buy.stripe.com');
      expect(text(page), status).not.toMatch(/has ended/i);
      expect(text(page), status).toMatch(/Free plan/);
    }
    for (const status of ['unpaid', 'paused']) {
      await setStatus(account, status);
      const page = await html(JobsPage({ searchParams: params({}) }));
      expect(text(page), status).toMatch(/on hold in Stripe/i);
      expect(page, status).toContain(`href="${PORTAL}"`);
    }
    // Over for good: subscribing again is the way back.
    for (const status of ['canceled', 'incomplete_expired']) {
      await setStatus(account, status);
      const page = await html(JobsPage({ searchParams: params({}) }));
      expect(text(page), status).toMatch(/has ended/i);
      expect(page, status).toContain(`client_reference_id=${account.id}`);
    }
  });

  it('after checkout: thanks the user while the webhook is on its way, then welcomes them', async () => {
    billingOn();
    const account = await signInAs('office@example.com');
    expect(text(await html(JobsPage({ searchParams: params({ billing: 'success' }) })))).toMatch(/confirming your payment/i);
    await setStatus(account, 'active');
    expect(text(await html(JobsPage({ searchParams: params({ billing: 'success' }) })))).toMatch(/welcome to LienClock Pro/i);
  });
});

describe('the Free-plan job limit on every path that creates a job', () => {
  it('save: refused at the limit, back to the calculator with the job kept and a subscribe link', async () => {
    billingOn();
    const account = await signInAs('office@example.com');
    await jobFor(account);
    const to = await redirectOf(() => actions.saveJob(form(newJob)));
    expect(to.startsWith('/?')).toBe(true);
    const query = new URLSearchParams(to.slice(2));
    expect(query.get('limit')).toBe('1');
    expect(query.get('counterparty')).toBe('Mesa Ridge Construction');
    expect(await listJobsForAccount(db, account.id)).toHaveLength(1);

    const page = await html(CalculatorPage({ searchParams: params(Object.fromEntries(query)) }));
    expect(text(page)).toMatch(/Free plan tracks 1 job/);
    expect(page).toContain(`client_reference_id=${account.id}`);

    // With a subscription Stripe still holds (here unpaid), the way out is the plan section, not a new checkout.
    await setStatus(account, 'unpaid');
    const held = await html(CalculatorPage({ searchParams: params(Object.fromEntries(query)) }));
    expect(text(held)).toMatch(/Free plan tracks 1 job/);
    expect(held).not.toContain('buy.stripe.com');
    expect(held).toContain('href="/jobs#plan"');
  });

  it('save: Pro and early access are unlimited', async () => {
    const account = await signInAs('office@example.com');
    await jobFor(account);
    expect(await redirectOf(() => actions.saveJob(form(newJob)))).toMatch(/^\/jobs\/[0-9a-f-]{36}$/);
    billingOn();
    await setStatus(account, 'active');
    expect(await redirectOf(() => actions.saveJob(form(newJob)))).toMatch(/^\/jobs\/[0-9a-f-]{36}$/);
    expect(await listJobsForAccount(db, account.id)).toHaveLength(3);
  });

  it('a job waiting in a sign-in link: the sign-in works, the job is not saved, and the dashboard says why', async () => {
    billingOn();
    const account = await signInAs('office@example.com');
    await jobFor(account);
    cookieJar.clear();
    const started = await startSignIn(db, {
      email: 'office@example.com',
      pendingJob: { state: 'AZ', role: 'sub', projectType: 'commercial', counterparty: 'Mesa', firstFurnishDate: '2026-11-02', lastFurnishDate: null },
      now: new Date(),
    });
    if (!started.ok) throw new Error(started.error);
    expect(await redirectOf(() => actions.finishSignInAction(form({ token: started.token })))).toBe('/jobs?error=job-limit#plan');
    expect(cookieJar.has(SESSION_COOKIE)).toBe(true);
    expect(await listJobsForAccount(db, account.id)).toHaveLength(1);
    const page = text(await html(JobsPage({ searchParams: params({ error: 'job-limit' }) })));
    expect(page).toMatch(/Free plan tracks 1 job/);
  });

  it('intake confirm: refused at the limit, and the email stays waiting for review', async () => {
    billingOn();
    const account = await signInAs('office@example.com');
    await jobFor(account);
    const proposal = await createProposal(db, { accountId: account.id, source: 'paste', subject: 'PO 7', fields: {} });
    const to = await redirectOf(() => actions.confirmProposalAction(form({ proposalId: proposal!.id, ...newJob })));
    expect(to).toBe('/jobs?error=job-limit#plan');
    expect((await getProposal(db, account.id, proposal!.id))?.status).toBe('pending');
    expect(await listJobsForAccount(db, account.id)).toHaveLength(1);
  });
});

describe('deleting an account while subscribed', () => {
  it('is refused until the subscription is cancelled, so nobody is charged for a deleted account', async () => {
    billingOn();
    const account = await signInAs('office@example.com');
    await setStatus(account, 'active');
    expect(await redirectOf(() => actions.deleteAccountAction(form({ confirm: 'yes' })))).toBe('/jobs?error=delete-subscribed#account');
    const { rows } = await db.query('SELECT 1 FROM accounts WHERE id = $1', [account.id]);
    expect(rows).toHaveLength(1);
    const page = await html(JobsPage({ searchParams: params({ error: 'delete-subscribed' }) }));
    expect(text(page)).toMatch(/cancel it first/i);
    expect(page).toContain(`href="${PORTAL}"`);

    await setStatus(account, 'canceled');
    expect(await redirectOf(() => actions.deleteAccountAction(form({ confirm: 'yes' })))).toBe('/?accountDeleted=1');
  });

  it('is refused for a subscription Stripe stopped charging but still holds open (unpaid), with the cancel link', async () => {
    // "unpaid" isn't Pro (no new jobs), but the subscription still exists: a new card would be charged.
    billingOn();
    const account = await signInAs('office@example.com');
    await setStatus(account, 'unpaid');
    expect(await redirectOf(() => actions.deleteAccountAction(form({ confirm: 'yes' })))).toBe('/jobs?error=delete-subscribed#account');
    const { rows } = await db.query('SELECT 1 FROM accounts WHERE id = $1', [account.id]);
    expect(rows).toHaveLength(1);
    const page = await html(JobsPage({ searchParams: params({ error: 'delete-subscribed' }) }));
    expect(text(page)).toMatch(/cancel it first/i);
    expect(text(page)).not.toMatch(/still active/i);
  });
});

describe('/changelog', () => {
  it('lists every covered state with its rules and last-verified date, and says when nothing has changed', async () => {
    const page = text(await html(ChangelogPage()));
    for (const code of SUPPORTED_STATES) expect(page).toContain(STATES[code].name);
    expect(page).toContain('Record lien statement');
    expect(page).toContain('2026-11-08');
    expect(page).toMatch(/no rule changes recorded yet/i);
  });

  it('shows each recorded change with its before and after, newest first', async () => {
    const now = new Date('2026-11-09T15:00:00Z');
    await syncRuleChanges(db, { rules: RULES, baseline: RULES.rules, now, appUrl: 'https://lienclock.example' });
    const edited = validateRuleSet({
      ...rawRules,
      version: '2026-12-01',
      rules: rawRules.rules.map((r) => (r.id === 'wa-claim-of-lien' ? { ...r, offset: { unit: 'days', days: 60 } } : r)),
    });
    await syncRuleChanges(db, { rules: edited, baseline: RULES.rules, now, appUrl: 'https://lienclock.example' });
    const page = text(await html(ChangelogPage()));
    expect(page).toContain('Washington');
    expect(page).toContain('Record claim of lien');
    expect(page).toContain('90 days after you last furnish');
    expect(page).toContain('60 days after you last furnish');
    expect(page).toContain('2026-12-01');
    expect(page).not.toMatch(/no rule changes recorded yet/i);
  });
});
