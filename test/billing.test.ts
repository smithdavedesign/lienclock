// Stripe billing: the Payment Link, the signed webhook that records who paid, and the Free-plan job limit.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findOrCreateAccount, getSessionAccount, type Account } from '@/lib/auth';
import {
  FREE_JOB_LIMIT,
  PRO_PRICE_LABEL,
  billingFrom,
  checkoutUrl,
  handleStripeWebhook,
  isPaid,
  jobLimitFor,
  verifyStripeSignature,
} from '@/lib/billing';
import { createMemoryDb, ensureSchema, type Db } from '@/lib/db';
import { JobLimitReached, createJob, listJobsForAccount } from '@/lib/jobs';
import { fakeStripeSecret, stripeEvent, stripeSignature } from './helpers/stripe';

const secret = fakeStripeSecret();
const PAYMENT_LINK = 'https://buy.stripe.com/test_lienclock_pro';
const PORTAL = 'https://billing.stripe.com/p/login/test_lienclock';
const env = { STRIPE_WEBHOOK_SECRET: secret, STRIPE_PAYMENT_LINK: PAYMENT_LINK, STRIPE_PORTAL_URL: PORTAL };
const now = new Date('2026-11-09T15:00:00Z');
const minutesLater = (n: number) => new Date(now.getTime() + n * 60_000);

let db: Db;
beforeAll(async () => {
  db = await createMemoryDb();
  await ensureSchema(db);
});
beforeEach(async () => {
  await db.exec('TRUNCATE alerts, jobs, accounts, sessions RESTART IDENTITY CASCADE');
});

function post(body: string, opts: { signature?: string | null; at?: Date; secretOverride?: string } = {}) {
  const at = opts.at ?? now;
  const signature = opts.signature === undefined ? stripeSignature(body, opts.secretOverride ?? secret, at) : opts.signature;
  return new Request('https://lienclock.example/api/stripe/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(signature ? { 'stripe-signature': signature } : {}) },
    body,
  });
}

const deliver = (body: string, opts: Parameters<typeof post>[1] & { webhookEnv?: Record<string, string> } = {}) =>
  handleStripeWebhook(post(body, opts), { env: opts.webhookEnv ?? env, getDb: async () => db, now: () => opts.at ?? now });

async function billingRow(id: string) {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT subscription_status, stripe_customer_id, stripe_subscription_id FROM accounts WHERE id = $1`,
    [id],
  );
  return rows[0];
}

const checkoutCompleted = (account: Pick<Account, 'id'> | null, extra: Record<string, unknown> = {}, at = now) =>
  stripeEvent(
    'checkout.session.completed',
    {
      id: 'cs_test_1',
      object: 'checkout.session',
      mode: 'subscription',
      payment_status: 'paid',
      status: 'complete',
      client_reference_id: account?.id ?? null,
      customer: 'cus_test_1',
      subscription: 'sub_test_1',
      customer_details: { email: 'office@example.com' },
      ...extra,
    },
    at,
  );

const subscriptionEvent = (type: string, status: string, created: Date, id = 'sub_test_1') =>
  stripeEvent(type, { id, object: 'subscription', status, customer: 'cus_test_1' }, now, created);

describe('billing configuration', () => {
  it('is on only when both the payment link and the webhook secret are set, and links must be https', () => {
    expect(billingFrom(env)).toEqual({ paymentLink: PAYMENT_LINK, portalUrl: PORTAL });
    expect(billingFrom({ ...env, STRIPE_PORTAL_URL: '' })).toEqual({ paymentLink: PAYMENT_LINK, portalUrl: null });
    expect(billingFrom({ STRIPE_PAYMENT_LINK: PAYMENT_LINK })).toBeNull();
    expect(billingFrom({ STRIPE_WEBHOOK_SECRET: secret })).toBeNull();
    expect(billingFrom({})).toBeNull();
    expect(billingFrom({ ...env, STRIPE_PAYMENT_LINK: 'http://buy.stripe.com/x' })).toBeNull();
    expect(billingFrom({ ...env, STRIPE_PAYMENT_LINK: 'javascript:alert(1)' })).toBeNull();
    expect(billingFrom({ ...env, STRIPE_PORTAL_URL: 'not a url' })).toEqual({ paymentLink: PAYMENT_LINK, portalUrl: null });
  });

  it('prices Pro at $29/month and gives the Free plan one tracked job', () => {
    expect(PRO_PRICE_LABEL).toBe('$29/month');
    expect(FREE_JOB_LIMIT).toBe(1);
  });

  it('treats active, trialing and past-due subscriptions as paid', () => {
    for (const status of ['active', 'trialing', 'past_due']) expect(isPaid(status), status).toBe(true);
    for (const status of [null, undefined, 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused']) {
      expect(isPaid(status), String(status)).toBe(false);
    }
  });

  it('limits Free accounts only while billing is configured', () => {
    expect(jobLimitFor({ subscriptionStatus: null }, env)).toBe(1);
    expect(jobLimitFor({ subscriptionStatus: 'canceled' }, env)).toBe(1);
    expect(jobLimitFor({ subscriptionStatus: 'active' }, env)).toBeNull();
    expect(jobLimitFor({ subscriptionStatus: null }, {})).toBeNull(); // early access: no way to pay yet
  });

  it('builds a checkout link that carries the account id and email', () => {
    const url = new URL(checkoutUrl(billingFrom(env)!, { id: '9f1c2d3e-4b5a-4c6d-8e7f-a1b2c3d4e5f6', email: 'office+pay@example.com' }));
    expect(url.origin + url.pathname).toBe(PAYMENT_LINK);
    expect(url.searchParams.get('client_reference_id')).toBe('9f1c2d3e-4b5a-4c6d-8e7f-a1b2c3d4e5f6');
    expect(url.searchParams.get('prefilled_email')).toBe('office+pay@example.com');
  });
});

describe('verifyStripeSignature', () => {
  const body = '{"id":"evt_1"}';
  it('accepts a valid signature within 5 minutes', () => {
    expect(verifyStripeSignature(body, stripeSignature(body, secret, now), secret, now)).toBe(true);
    expect(verifyStripeSignature(body, stripeSignature(body, secret, now), secret, minutesLater(4))).toBe(true);
  });
  it('accepts any of several v1 signatures (secret rotation)', () => {
    const good = stripeSignature(body, secret, now);
    const other = stripeSignature(body, fakeStripeSecret('Old1Old2'), now).split(',')[1];
    expect(verifyStripeSignature(body, `${good.split(',')[0]},${other},${good.split(',')[1]}`, secret, now)).toBe(true);
  });
  it.each([
    ['a wrong secret', () => stripeSignature(body, fakeStripeSecret('Wr0ngKey'), now), now],
    ['a stale timestamp', () => stripeSignature(body, secret, now), minutesLater(6)],
    ['a future timestamp', () => stripeSignature(body, secret, minutesLater(6)), now],
    ['a tampered body', () => stripeSignature('{"id":"evt_2"}', secret, now), now],
    ['no header', () => null, now],
    ['no timestamp', () => stripeSignature(body, secret, now).split(',')[1], now],
    ['a v0 scheme only', () => stripeSignature(body, secret, now).replace('v1=', 'v0='), now],
    ['garbage', () => 't=abc,v1=xyz', now],
  ])('rejects %s', (_label, header, at) => {
    expect(verifyStripeSignature(body, header(), secret, at)).toBe(false);
  });
});

describe('handleStripeWebhook', () => {
  let account: Account;
  beforeEach(async () => {
    account = await findOrCreateAccount(db, 'office@example.com');
  });

  it('fails closed when STRIPE_WEBHOOK_SECRET is not configured', async () => {
    const res = await deliver(checkoutCompleted(account), { webhookEnv: { STRIPE_PAYMENT_LINK: PAYMENT_LINK } });
    expect(res.status).toBe(500);
    expect((await billingRow(account.id)).subscription_status).toBeNull();
  });

  it('rejects a bad signature without touching the account', async () => {
    const res = await deliver(checkoutCompleted(account), { secretOverride: fakeStripeSecret('Wr0ngKey') });
    expect(res.status).toBe(400);
    expect((await billingRow(account.id)).subscription_status).toBeNull();
    expect((await deliver(checkoutCompleted(account), { signature: null })).status).toBe(400);
  });

  it('rejects an oversized body and invalid JSON', async () => {
    expect((await deliver('x'.repeat(300_000))).status).toBe(413);
    expect((await deliver('{not json')).status).toBe(400);
  });

  it('checkout.session.completed activates the account named in client_reference_id', async () => {
    const res = await deliver(checkoutCompleted(account));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, updated: true });
    expect(await billingRow(account.id)).toEqual({
      subscription_status: 'active',
      stripe_customer_id: 'cus_test_1',
      stripe_subscription_id: 'sub_test_1',
    });
  });

  it('falls back to the checkout email when the link was used without our reference', async () => {
    const res = await deliver(checkoutCompleted(null, { customer_details: { email: 'Office@Example.com' } }));
    expect(await res.json()).toMatchObject({ ok: true, updated: true });
    expect((await billingRow(account.id)).subscription_status).toBe('active');
  });

  it('acknowledges and ignores a payment it can’t match to an account', async () => {
    const res = await deliver(checkoutCompleted(null, { customer_details: { email: 'stranger@example.com' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, updated: false });
    const bogusId = await deliver(checkoutCompleted({ id: 'not-a-uuid' }, { customer_details: { email: 'stranger@example.com' } }));
    expect(await bogusId.json()).toMatchObject({ ok: true, updated: false });
  });

  it('ignores one-off payments and unpaid checkouts are not activated', async () => {
    expect(await (await deliver(checkoutCompleted(account, { mode: 'payment' }))).json()).toMatchObject({ ignored: true });
    await deliver(checkoutCompleted(account, { payment_status: 'unpaid' }));
    expect((await billingRow(account.id)).subscription_status).toBe('incomplete');
  });

  it('follows the subscription through updates and cancellation', async () => {
    await deliver(checkoutCompleted(account));
    await deliver(subscriptionEvent('customer.subscription.updated', 'past_due', minutesLater(1)), { at: minutesLater(1) });
    expect((await billingRow(account.id)).subscription_status).toBe('past_due');
    await deliver(subscriptionEvent('customer.subscription.deleted', 'canceled', minutesLater(2)), { at: minutesLater(2) });
    expect((await billingRow(account.id)).subscription_status).toBe('canceled');
    const session = await getSessionAccountAfterSignIn(account);
    expect(session?.subscriptionStatus).toBe('canceled');
  });

  it('never lets an older event overwrite a newer state (Stripe does not guarantee order)', async () => {
    await deliver(checkoutCompleted(account));
    await deliver(subscriptionEvent('customer.subscription.deleted', 'canceled', minutesLater(3)), { at: minutesLater(3) });
    // A delayed "active" update from before the cancellation arrives last.
    await deliver(subscriptionEvent('customer.subscription.updated', 'active', minutesLater(1)), { at: minutesLater(4) });
    expect((await billingRow(account.id)).subscription_status).toBe('canceled');
  });

  it('is idempotent: a replayed event changes nothing', async () => {
    const body = checkoutCompleted(account);
    await deliver(body);
    const replay = await deliver(body);
    expect(replay.status).toBe(200);
    expect((await billingRow(account.id)).subscription_status).toBe('active');
  });

  it('ignores updates for subscriptions it doesn’t know, and other event types', async () => {
    const unknown = await deliver(subscriptionEvent('customer.subscription.updated', 'active', now, 'sub_unknown'));
    expect(await unknown.json()).toMatchObject({ ok: true, updated: false });
    const other = await deliver(stripeEvent('invoice.paid', { id: 'in_1' }, now));
    expect(await other.json()).toMatchObject({ ok: true, ignored: true });
    expect((await billingRow(account.id)).subscription_status).toBeNull();
  });

  it('stores only a well-formed status', async () => {
    await deliver(checkoutCompleted(account));
    await deliver(subscriptionEvent('customer.subscription.updated', 'Active; DROP TABLE accounts', minutesLater(1)), { at: minutesLater(1) });
    expect((await billingRow(account.id)).subscription_status).toBe('active');
  });
});

async function getSessionAccountAfterSignIn(account: Account) {
  const token = 'S'.repeat(43);
  const { createHash } = await import('node:crypto');
  await db.query('INSERT INTO sessions (token_hash, account_id, expires_at, created_at) VALUES ($1, $2, $3, $4)', [
    createHash('sha256').update(token).digest('hex'),
    account.id,
    minutesLater(60),
    now,
  ]);
  return getSessionAccount(db, token, { now });
}

describe('the Free-plan job limit in createJob', () => {
  const job = (a: Account, counterparty: string) => ({
    state: 'CA' as const,
    role: 'sub' as const,
    projectType: 'commercial' as const,
    counterparty,
    firstFurnishDate: '2026-11-01',
    lastFurnishDate: null,
    alertEmail: a.email,
    accountId: a.id,
  });

  it('allows jobs up to the limit, then refuses with JobLimitReached', async () => {
    const a = await findOrCreateAccount(db, 'a@example.com');
    await createJob(db, job(a, 'First GC'), { jobLimit: 1 });
    await expect(createJob(db, job(a, 'Second GC'), { jobLimit: 1 })).rejects.toBeInstanceOf(JobLimitReached);
    expect((await listJobsForAccount(db, a.id)).map((j) => j.counterparty)).toEqual(['First GC']);
  });

  it('counts each account separately, and no limit means no limit', async () => {
    const a = await findOrCreateAccount(db, 'a@example.com');
    const b = await findOrCreateAccount(db, 'b@example.com');
    await createJob(db, job(a, 'A1'), { jobLimit: 1 });
    await createJob(db, job(b, 'B1'), { jobLimit: 1 });
    await createJob(db, job(a, 'A2'), { jobLimit: null });
    await createJob(db, job(a, 'A3'));
    expect(await listJobsForAccount(db, a.id)).toHaveLength(3);
    expect(await listJobsForAccount(db, b.id)).toHaveLength(1);
  });

  it('checks and inserts in one statement: three simultaneous saves on a Free account create one job', async () => {
    // PGlite runs statements one at a time, so this pins the single-statement design; on Neon,
    // concurrent requests can overshoot by the number in flight (see BUILD.md, Review).
    const a = await findOrCreateAccount(db, 'a@example.com');
    const results = await Promise.allSettled([1, 2, 3].map((n) => createJob(db, job(a, `GC ${n}`), { jobLimit: 1 })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((r) => r.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(JobLimitReached);
    }
    expect(await listJobsForAccount(db, a.id)).toHaveLength(1);
  });
});
