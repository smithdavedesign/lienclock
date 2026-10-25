import { getDb } from '@/lib/db';
import { handleCalendarFeed } from '@/lib/ics';

export const dynamic = 'force-dynamic';

// GET /calendar/<feed token>.ics — the account's deadlines as an ICS subscription (secret URL, no cookies).
export async function GET(_request: Request, { params }: { params: Promise<{ feed: string }> }): Promise<Response> {
  const { feed } = await params;
  return handleCalendarFeed(feed, { env: process.env, getDb: () => getDb() });
}
