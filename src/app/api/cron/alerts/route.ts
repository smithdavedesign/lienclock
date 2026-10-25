import { handleCronRequest } from '@/lib/cron';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Vercel Cron calls this daily (vercel.json) with `Authorization: Bearer $CRON_SECRET`.
export function GET(request: Request): Promise<Response> {
  return handleCronRequest(request, { env: process.env, getDb: () => getDb() });
}
