import { handleStripeWebhook } from '@/lib/billing';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Stripe's webhook (checkout.session.completed, customer.subscription.*), signed with STRIPE_WEBHOOK_SECRET.
export function POST(request: Request): Promise<Response> {
  return handleStripeWebhook(request, { env: process.env, getDb: () => getDb() });
}
