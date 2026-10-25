import { getDb } from '@/lib/db';
import { handleInboundEmail } from '@/lib/inbound';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Resend Inbound's email.received webhook (Svix-signed with RESEND_WEBHOOK_SECRET).
export function POST(request: Request): Promise<Response> {
  return handleInboundEmail(request, { env: process.env, getDb: () => getDb() });
}
