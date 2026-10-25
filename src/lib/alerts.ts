// Email alert scheduler: plan → enqueue (idempotent) → send (claim, retry, give up).
//
//   daily cron ─▶ enqueueAlerts: for each job, deadlines "today" in the job's state
//                  ├─ prune pending alerts that no longer apply (done, or the date moved)
//                  └─ INSERT the most urgent threshold … ON CONFLICT DO NOTHING
//              ─▶ sendPendingAlerts: claim rows FOR UPDATE SKIP LOCKED → sender → sent | retry | failed
import { todayIn } from './dates';
import type { Db } from './db';
import { computeDeadlines, type Deadline } from './deadlines';
import { listJobs, type StoredJob } from './jobs';
import { STATES } from './rules';

export const ALERT_THRESHOLDS = [14, 7, 2, 0] as const;
export const MAX_SEND_ATTEMPTS = 3;
/** A row left in "sending" this long (crashed run) is picked up again. */
const STALE_CLAIM_MS = 15 * 60_000;
const SEND_BATCH = 100;

/**
 * The alert due for a deadline this many days away: the smallest threshold that is ≥ days left.
 * If a cron day is missed, the next run still sends the current threshold, never a burst of old ones.
 */
export function alertThreshold(daysLeft: number): number | null {
  if (daysLeft < 0) return null;
  const due = ALERT_THRESHOLDS.filter((t) => t >= daysLeft);
  return due.length > 0 ? Math.min(...due) : null;
}

export interface PlannedAlert {
  jobId: string;
  deadlineKey: string;
  deadlineDate: string;
  thresholdDays: number;
  daysLeft: number;
  toEmail: string;
  subject: string;
  body: string;
}

function dueIn(daysLeft: number): string {
  if (daysLeft === 0) return 'due today';
  if (daysLeft === 1) return 'due tomorrow';
  return `due in ${daysLeft} days`;
}

function emailFor(job: StoredJob, d: Deadline, appUrl: string): { subject: string; body: string } {
  const subject = `${job.state} ${d.title} ${dueIn(d.daysLeft)} (${d.date}) — ${job.counterparty}`;
  const body = [
    `${d.title} for your ${STATES[job.state].name} job with ${job.counterparty} is ${dueIn(d.daysLeft)}, on ${d.date}.`,
    '',
    d.note,
    '',
    `Statute: ${d.citation} — ${d.citationUrl} (last verified ${d.lastVerified})`,
    '',
    'Open the job to mark this done or update your furnishing dates:',
    `${appUrl}/jobs/${job.id}`,
    '',
    'LienClock is a deadline reference, not legal advice. Dates are calendar days and are never extended for weekends or holidays. Check the statute or a construction attorney before you rely on them.',
    'To stop these alerts, open the job link above and delete the job.',
  ].join('\n');
  return { subject, body };
}

export function planAlerts(job: StoredJob, opts: { today: string; appUrl: string }): PlannedAlert[] {
  return computeDeadlines(job, { today: opts.today })
    .filter((d) => d.status === 'at_risk')
    .flatMap((d) => {
      const thresholdDays = alertThreshold(d.daysLeft);
      if (thresholdDays === null) return [];
      return [
        {
          jobId: job.id,
          deadlineKey: d.key,
          deadlineDate: d.date,
          thresholdDays,
          daysLeft: d.daysLeft,
          toEmail: job.alertEmail,
          ...emailFor(job, d, opts.appUrl),
        },
      ];
    });
}

export async function enqueueAlerts(
  db: Db,
  opts: { now: Date; appUrl: string },
): Promise<{ jobs: number; enqueued: number; pruned: number }> {
  const jobs = await listJobs(db);
  let enqueued = 0;
  let pruned = 0;
  for (const job of jobs) {
    let planned: PlannedAlert[];
    try {
      planned = planAlerts(job, { today: todayIn(STATES[job.state].timeZone, opts.now), appUrl: opts.appUrl });
    } catch (error) {
      // One bad row must not stop alerts for everyone else.
      console.error(`alerts: skipped job ${job.id}:`, error instanceof Error ? error.message : error);
      continue;
    }
    // Pending alerts that are no longer exactly what we'd send today are stale: the deadline
    // was met, its date moved, or a more urgent threshold replaced it. Sent rows are history.
    const current = planned.map((a) => `${a.deadlineKey}|${a.deadlineDate}|${a.thresholdDays}`);
    const removed = await db.query(
      `DELETE FROM alerts
        WHERE job_id = $1 AND status = 'pending'
          AND NOT (deadline_key || '|' || deadline_date::text || '|' || threshold_days::text = ANY($2::text[]))
        RETURNING id`,
      [job.id, current],
    );
    pruned += removed.rows.length;
    for (const a of planned) {
      const inserted = await db.query(
        `INSERT INTO alerts (job_id, deadline_key, deadline_date, threshold_days, to_email, subject, body)
         VALUES ($1, $2, $3::date, $4, $5, $6, $7)
         ON CONFLICT (job_id, deadline_key, deadline_date, threshold_days) DO NOTHING
         RETURNING id`,
        [a.jobId, a.deadlineKey, a.deadlineDate, a.thresholdDays, a.toEmail, a.subject, a.body],
      );
      enqueued += inserted.rows.length;
    }
  }
  return { jobs: jobs.length, enqueued, pruned };
}

export interface AlertMessage {
  to: string;
  subject: string;
  text: string;
  /** Stable per alert row, so a retried send is delivered once. */
  idempotencyKey: string;
}

export interface AlertSender {
  send(message: AlertMessage): Promise<void>;
}

export function resendSender(opts: { apiKey: string; from: string; fetch?: typeof fetch }): AlertSender {
  const fetchImpl = opts.fetch ?? fetch;
  return {
    async send(message) {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': message.idempotencyKey,
        },
        body: JSON.stringify({ from: opts.from, to: [message.to], subject: message.subject, text: message.text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200);
        throw new Error(`Resend responded ${res.status}: ${detail}`);
      }
    },
  };
}

interface ClaimedAlert {
  id: number;
  to_email: string;
  subject: string;
  body: string;
  attempts: number;
}

export async function sendPendingAlerts(
  db: Db,
  sender: AlertSender,
  opts: { now: Date; limit?: number },
): Promise<{ sent: number; retrying: number; failed: number }> {
  const staleBefore = new Date(opts.now.getTime() - STALE_CLAIM_MS);
  // Claiming is one atomic UPDATE: two overlapping runs can never pick the same row.
  const { rows } = await db.query<ClaimedAlert>(
    `UPDATE alerts SET status = 'sending', claimed_at = $1, attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM alerts
         WHERE status = 'pending' OR (status = 'sending' AND claimed_at < $2)
         ORDER BY id
         LIMIT $3
         FOR UPDATE SKIP LOCKED)
      RETURNING id, to_email, subject, body, attempts`,
    [opts.now, staleBefore, opts.limit ?? SEND_BATCH],
  );
  const result = { sent: 0, retrying: 0, failed: 0 };
  for (const alert of rows.sort((a, b) => a.id - b.id)) {
    try {
      await sender.send({
        to: alert.to_email,
        subject: alert.subject,
        text: alert.body,
        idempotencyKey: `lienclock-alert-${alert.id}`,
      });
      await db.query(
        `UPDATE alerts SET status = 'sent', sent_at = $2, last_error = NULL WHERE id = $1 AND status = 'sending'`,
        [alert.id, opts.now],
      );
      result.sent += 1;
    } catch (error) {
      const giveUp = alert.attempts >= MAX_SEND_ATTEMPTS;
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      await db.query(`UPDATE alerts SET status = $2, last_error = $3 WHERE id = $1 AND status = 'sending'`, [
        alert.id,
        giveUp ? 'failed' : 'pending',
        message,
      ]);
      if (giveUp) result.failed += 1;
      else result.retrying += 1;
    }
  }
  return result;
}
