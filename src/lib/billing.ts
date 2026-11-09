// Billing: LienClock Pro at $29/month through a Stripe Payment Link, with no Stripe SDK or secret key.
//
//   /jobs "Subscribe" ─▶ <STRIPE_PAYMENT_LINK>?client_reference_id=<account id>&prefilled_email=<email>
//   Stripe ──POST /api/stripe/webhook (Stripe-Signature: t=…,v1=…)──▶ handleStripeWebhook
//     verify HMAC-SHA256("t.<raw body>") with STRIPE_WEBHOOK_SECRET, 5-minute window
//     checkout.session.completed → account by client_reference_id, else by checkout email
//       (and …async_payment_succeeded) → customer + subscription ids, status
//     customer.subscription.*     → account by subscription id → status
//     each update applies only if the event is not older than the last one applied (Stripe
//     doesn't guarantee order), so replays and late deliveries are harmless.
//   Cancelling, card changes and invoices happen in Stripe's no-code portal (STRIPE_PORTAL_URL).
//
// Free plan: the calculator and FREE_JOB_LIMIT tracked jobs. Limits apply only once billing is
// configured (both the link and the webhook secret); until then everything is free (early access).
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Account } from './auth';
import type { Db } from './db';
import { parseEmail } from './jobInput';
import { isJobId } from './jobs';

export const PRO_MONTHLY_USD = 29;
export const PRO_PRICE_LABEL = `$${PRO_MONTHLY_USD}/month`;
export const FREE_JOB_LIMIT = 1;
/** Stripe statuses that keep Pro: past_due too, while Stripe retries the card. */
const PAID_STATUSES = new Set(['active', 'trialing', 'past_due']);
/**
 * Stripe statuses after which a subscription can never charge again. Any other status (unpaid, paused,
 * incomplete, or one Stripe adds later) is a subscription that still exists in Stripe.
 */
export const ENDED_SUBSCRIPTION_STATUSES: readonly string[] = ['canceled', 'incomplete_expired'];
const SIGNATURE_TOLERANCE_S = 5 * 60;
const MAX_WEBHOOK_BYTES = 256 * 1024;
const STATUS = /^[a-z_]{1,32}$/;
const STRIPE_ID = /^[A-Za-z0-9_]{1,255}$/;

export interface BillingEnv {
  [name: string]: string | undefined;
  STRIPE_PAYMENT_LINK?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PORTAL_URL?: string;
}

export interface Billing {
  paymentLink: string;
  /** Stripe's customer portal login link, where subscribers cancel or change their card. */
  portalUrl: string | null;
}

function httpsUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The Payment Link behind the "Get Pro" button, or null (no button) when STRIPE_PAYMENT_LINK is unset or
 * not https. Read per request: on the Worker it's a secret that can change without a rebuild.
 */
export function paymentLinkFrom(env: BillingEnv): string | null {
  return httpsUrl(env.STRIPE_PAYMENT_LINK);
}

/** Billing is on only when people can both pay (the link) and be recorded as paid (the webhook). */
export function billingFrom(env: BillingEnv): Billing | null {
  const paymentLink = paymentLinkFrom(env);
  if (!paymentLink || !env.STRIPE_WEBHOOK_SECRET) return null;
  return { paymentLink, portalUrl: httpsUrl(env.STRIPE_PORTAL_URL) };
}

export function isPaid(status: string | null | undefined): boolean {
  return typeof status === 'string' && PAID_STATUSES.has(status);
}

/** True while the account has a Stripe subscription that deleting the account wouldn't stop. */
export function hasOpenSubscription(status: string | null | undefined): boolean {
  return typeof status === 'string' && !ENDED_SUBSCRIPTION_STATUSES.includes(status);
}

/** How many jobs the account may track: null means no limit (Pro, or billing not configured yet). */
export function jobLimitFor(account: Pick<Account, 'subscriptionStatus'>, env: BillingEnv): number | null {
  if (!billingFrom(env) || isPaid(account.subscriptionStatus)) return null;
  return FREE_JOB_LIMIT;
}

/** The Payment Link, tagged with the account so the webhook knows whose payment it is. */
export function checkoutUrl(billing: Pick<Billing, 'paymentLink'>, account: Pick<Account, 'id' | 'email'>): string {
  const url = new URL(billing.paymentLink);
  url.searchParams.set('client_reference_id', account.id);
  url.searchParams.set('prefilled_email', account.email);
  return url.toString();
}

// ── Webhook ────────────────────────────────────────────────────────────────────────────────────

/** Stripe-Signature: `t=<unix seconds>,v1=<hex>[,v1=<hex>…]`, the HMAC of "t.<raw body>" with the secret. */
export function verifyStripeSignature(body: string, header: string | null, secret: string, now: Date): boolean {
  if (!header || !secret) return false;
  const pairs = header.split(',').map((part) => {
    const at = part.indexOf('=');
    return at < 0 ? ['', ''] : [part.slice(0, at).trim(), part.slice(at + 1).trim()];
  });
  const t = pairs.find(([key]) => key === 't')?.[1];
  if (!t || !/^\d{1,12}$/.test(t)) return false;
  if (Math.abs(now.getTime() / 1000 - Number(t)) > SIGNATURE_TOLERANCE_S) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest();
  return pairs.some(([key, value]) => {
    if (key !== 'v1' || !/^[0-9a-f]{64}$/.test(value)) return false;
    return timingSafeEqual(Buffer.from(value, 'hex'), expected);
  });
}

interface StripeEvent {
  type: string;
  created: number;
  object: Record<string, unknown>;
}

function eventFrom(raw: unknown): StripeEvent | null {
  const e = raw as Record<string, unknown> | null;
  const object = (e?.data as Record<string, unknown> | undefined)?.object;
  if (typeof e?.type !== 'string' || typeof e.created !== 'number' || !object || typeof object !== 'object') return null;
  return { type: e.type, created: e.created, object: object as Record<string, unknown> };
}

const stripeId = (value: unknown): string | null => (typeof value === 'string' && STRIPE_ID.test(value) ? value : null);

// Applies only if this event is not older than the last billing event applied to the account.
const NOT_OLDER = '(billing_updated_at IS NULL OR billing_updated_at <= to_timestamp($2))';

async function checkoutCompleted(db: Db, event: StripeEvent): Promise<boolean | 'ignored'> {
  const session = event.object;
  if (session.mode !== 'subscription') return 'ignored';
  const reference = typeof session.client_reference_id === 'string' && isJobId(session.client_reference_id) ? session.client_reference_id : null;
  const details = session.customer_details as Record<string, unknown> | undefined;
  const email = parseEmail(details?.email ?? session.customer_email);
  // Async payment methods complete checkout before the money arrives; the subscription events say when.
  const status = session.payment_status === 'unpaid' ? 'incomplete' : 'active';
  const { rows } = await db.query(
    `UPDATE accounts
        SET subscription_status = $3, stripe_customer_id = $4, stripe_subscription_id = $5,
            billing_updated_at = to_timestamp($2)
      WHERE id = (SELECT id FROM accounts
                   WHERE id = $1::uuid OR email = $6::text
                   ORDER BY (id IS NOT DISTINCT FROM $1::uuid) DESC  -- the referenced account first
                   LIMIT 1)
        AND ${NOT_OLDER}
      RETURNING id`,
    [reference, event.created, status, stripeId(session.customer), stripeId(session.subscription), email],
  );
  return rows.length > 0;
}

async function subscriptionChanged(db: Db, event: StripeEvent): Promise<boolean | 'ignored'> {
  const subscription = event.object;
  const id = stripeId(subscription.id);
  const status = event.type === 'customer.subscription.deleted' ? 'canceled' : subscription.status;
  if (!id || typeof status !== 'string' || !STATUS.test(status)) return 'ignored';
  const { rows } = await db.query(
    `UPDATE accounts SET subscription_status = $3, billing_updated_at = to_timestamp($2)
      WHERE stripe_subscription_id = $1 AND ${NOT_OLDER}
      RETURNING id`,
    [id, event.created, status],
  );
  return rows.length > 0;
}

const HANDLERS: Record<string, (db: Db, event: StripeEvent) => Promise<boolean | 'ignored'>> = {
  'checkout.session.completed': checkoutCompleted,
  // A bank debit clears days after checkout. Stripe may have created the subscription as active
  // already, so no subscription update follows: this event is what turns "incomplete" into Pro.
  'checkout.session.async_payment_succeeded': checkoutCompleted,
  'customer.subscription.created': subscriptionChanged,
  'customer.subscription.updated': subscriptionChanged,
  'customer.subscription.deleted': subscriptionChanged,
  'customer.subscription.paused': subscriptionChanged,
  'customer.subscription.resumed': subscriptionChanged,
};

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** POST /api/stripe/webhook. 2xx tells Stripe to stop retrying; 4xx/5xx make it retry for days. */
export async function handleStripeWebhook(
  req: Request,
  deps: { env: BillingEnv; getDb: () => Promise<Db>; now?: () => Date },
): Promise<Response> {
  const secret = deps.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    // Fail closed: without the secret anyone could post a fake payment.
    console.error('billing: STRIPE_WEBHOOK_SECRET is not configured; refusing to run');
    return json({ ok: false, error: 'Billing is not configured.' }, 500);
  }
  if (Number(req.headers.get('content-length') ?? 0) > MAX_WEBHOOK_BYTES) return json({ ok: false, error: 'Too large' }, 413);
  const body = await req.text(); // the signature covers the raw bytes, so read before parsing
  if (Buffer.byteLength(body, 'utf8') > MAX_WEBHOOK_BYTES) return json({ ok: false, error: 'Too large' }, 413);
  if (!verifyStripeSignature(body, req.headers.get('stripe-signature'), secret, deps.now?.() ?? new Date())) {
    return json({ ok: false, error: 'Invalid signature' }, 400);
  }

  let event: StripeEvent | null;
  try {
    event = eventFrom(JSON.parse(body));
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }
  if (!event) return json({ ok: false, error: 'Not a Stripe event' }, 400);
  const handler = HANDLERS[event.type];
  if (!handler) return json({ ok: true, ignored: true });

  try {
    const result = await handler(await deps.getDb(), event);
    if (result === 'ignored') return json({ ok: true, ignored: true });
    // Not matched (unknown account, older event): acknowledged, so Stripe doesn't retry forever.
    if (!result) console.info(`billing: ${event.type} matched no account (or was older than the last update)`);
    return json({ ok: true, updated: result });
  } catch (error) {
    console.error('billing: webhook failed:', error instanceof Error ? error.message : error);
    return json({ ok: false, error: 'Billing update failed.' }, 500);
  }
}
