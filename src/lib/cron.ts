// The daily run behind GET /api/cron/alerts. Framework-free so it can be tested directly.
//   1. record rule changes and queue emails to the people affected (changelog.ts)
//   2. enqueue deadline alerts, 3. send them, 4. send rule-change emails (deadlines first)
import { timingSafeEqual } from 'node:crypto';
import { enqueueAlerts, resendSender, sendPendingAlerts, sendPendingRuleChangeEmails } from './alerts';
import { RULES_BASELINE, syncRuleChanges } from './changelog';
import type { Db } from './db';
import { RULES, type Rule, type RuleSet } from './rules';

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

const NOTHING_SENT = { sent: 0, retrying: 0, failed: 0 };

export async function handleCronRequest(
  req: Request,
  deps: {
    env: CronEnv;
    getDb: () => Promise<Db>;
    now?: () => Date;
    fetch?: typeof fetch;
    /** The shipped rules and the change-tracking baseline; tests pass an edited set. */
    rules?: { rules: RuleSet; baseline: Rule[] };
  },
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
    const appUrl = appUrlFrom(deps.env);
    const { rules, baseline } = deps.rules ?? { rules: RULES, baseline: RULES_BASELINE };
    // A changelog problem must never stop deadline alerts: log it and carry on.
    let changes = { ok: true, created: 0, emailsQueued: 0 };
    try {
      const synced = await syncRuleChanges(db, { rules, baseline, now, appUrl });
      changes = { ok: true, created: synced.changes.length, emailsQueued: synced.emailsQueued };
    } catch (error) {
      console.error('cron: rule change sync failed:', error instanceof Error ? error.message : error);
      changes = { ok: false, created: 0, emailsQueued: 0 };
    }
    const queued = await enqueueAlerts(db, { now, appUrl });
    const sender = deps.env.RESEND_API_KEY
      ? resendSender({ apiKey: deps.env.RESEND_API_KEY, from: deps.env.ALERT_FROM_EMAIL || DEFAULT_FROM, fetch: deps.fetch })
      : null;
    const delivery = sender ? await sendPendingAlerts(db, sender, { now }) : NOTHING_SENT;
    const ruleDelivery = sender ? await sendPendingRuleChangeEmails(db, sender, { now }) : NOTHING_SENT;
    return Response.json({
      ok: true,
      ...queued,
      emailConfigured: sender !== null,
      ...delivery,
      ruleChanges: { ...changes, ...ruleDelivery },
    });
  } catch (error) {
    console.error('cron: alert run failed:', error instanceof Error ? error.message : error);
    return Response.json({ ok: false, error: 'Alert run failed.' }, { status: 500 });
  }
}
