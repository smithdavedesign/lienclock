// Signs a webhook body the way Svix (Resend's webhook sender) does, so tests can post real signed requests.
import { createHmac } from 'node:crypto';

/** A throwaway signing secret built at runtime, so no credential-shaped literal lives in the repo. */
export function fakeWebhookSecret(seed = 'lienclock-webhook-test-key'): string {
  return ['whsec', Buffer.from(seed.padEnd(32, '0')).toString('base64')].join('_');
}

export function svixHeaders(body: string, secret: string, opts: { at: Date; id?: string }): Record<string, string> {
  const id = opts.id ?? 'msg_test_0001';
  const timestamp = String(Math.floor(opts.at.getTime() / 1000));
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return {
    'content-type': 'application/json',
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${signature}`,
  };
}
