// Signs a webhook body the way Stripe does, so tests can post real signed events.
import { createHmac } from 'node:crypto';

/** A throwaway signing secret built at runtime, so no credential-shaped literal lives in the repo. */
export function fakeStripeSecret(seed = 'K7m2P9q4'): string {
  return ['whsec', seed.repeat(4)].join('_');
}

/** The Stripe-Signature header: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`. */
export function stripeSignature(body: string, secret: string, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

let counter = 0;

/** A Stripe event envelope. `created` defaults to `at`. */
export function stripeEvent(type: string, object: Record<string, unknown>, at: Date, created?: Date): string {
  counter += 1;
  return JSON.stringify({
    id: `evt_test_${counter}`,
    object: 'event',
    type,
    created: Math.floor((created ?? at).getTime() / 1000),
    data: { object },
  });
}
