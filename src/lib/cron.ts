// The daily alert run behind GET /api/cron/alerts. Framework-free so it can be tested directly.
import { timingSafeEqual } from 'node:crypto';
import { enqueueAlerts, resendSender, sendPendingAlerts } from './alerts';
import type { Db } from './db';

export interface CronEnv {
  [name: string]: string | undefined;
  CRON_SECRET?: string;
  RESEND_API_KEY?: string;
  ALERT_FROM_EMAIL?: string;
  APP_URL?: string;
  VERCEL_PROJECT_PRODUCTION_URL?: string;
}

/** Resend's shared test sender: only delivers to the Resend account's own address until a domain is verified. */
export const DEFAULT_FROM = 'LienClock <onboarding@resend.dev>';

export function appUrlFrom(env: CronEnv): string {
  if (env.APP_URL) return env.APP_URL.replace(/\/+$/, '');
  if (env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return 'http://localhost:3000';
}

function bearerMatches(header: string | null, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function handleCronRequest(
  req: Request,
  deps: { env: CronEnv; getDb: () => Promise<Db>; now?: () => Date; fetch?: typeof fetch },
): Promise<Response> {
  const secret = deps.env.CRON_SECRET;
  if (!secret) {
    // Fail closed: without a secret anyone could trigger sends.
    console.error('cron: CRON_SECRET is not configured; refusing to run');
    return Response.json({ ok: false, error: 'Cron is not configured.' }, { status: 500 });
  }
  if (!bearerMatches(req.headers.get('authorization'), secret)) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const db = await deps.getDb();
    const now = deps.now?.() ?? new Date();
    const queued = await enqueueAlerts(db, { now, appUrl: appUrlFrom(deps.env) });
    const sender = deps.env.RESEND_API_KEY
      ? resendSender({ apiKey: deps.env.RESEND_API_KEY, from: deps.env.ALERT_FROM_EMAIL || DEFAULT_FROM, fetch: deps.fetch })
      : null;
    const delivery = sender ? await sendPendingAlerts(db, sender, { now }) : { sent: 0, retrying: 0, failed: 0 };
    return Response.json({ ok: true, ...queued, emailConfigured: sender !== null, ...delivery });
  } catch (error) {
    console.error('cron: alert run failed:', error instanceof Error ? error.message : error);
    return Response.json({ ok: false, error: 'Alert run failed.' }, { status: 500 });
  }
}
