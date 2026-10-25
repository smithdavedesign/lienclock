import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ALERT_THRESHOLDS,
  alertThreshold,
  enqueueAlerts,
  planAlerts,
  resendSender,
  sendPendingAlerts,
  type AlertMessage,
  type AlertSender,
} from '@/lib/alerts';
import { createMemoryDb, ensureSchema, type Db } from '@/lib/db';
import { computeDeadlines } from '@/lib/deadlines';
import { createJob, markDeadlineDone, setLastFurnish, type JobDraft, type StoredJob } from '@/lib/jobs';

const APP_URL = 'https://lienclock.example';
const caDraft: JobDraft = {
  state: 'CA',
  role: 'sub',
  projectType: 'commercial',
  counterparty: 'Acme Builders',
  firstFurnishDate: '2026-03-01',
  lastFurnishDate: null,
  alertEmail: 'office@example.com',
};
/** 19:00 UTC (noon in Los Angeles): the same calendar day in every US time zone. */
const noonUtc = (iso: string) => new Date(`${iso}T19:00:00Z`);

function fakeSender() {
  const sent: AlertMessage[] = [];
  const sender: AlertSender = { send: async (m) => void sent.push(m) };
  return { sent, sender };
}

async function alertRows(db: Db, jobId: string) {
  const { rows } = await db.query<{ threshold_days: number; deadline_key: string; deadline_date: string; status: string }>(
    `SELECT threshold_days, deadline_key, deadline_date::text AS deadline_date, status
       FROM alerts WHERE job_id = $1 ORDER BY id`,
    [jobId],
  );
  return rows;
}

// One embedded Postgres per file (booting PGlite takes seconds); every test starts from empty tables.
let db: Db;
beforeAll(async () => {
  db = await createMemoryDb();
  await ensureSchema(db);
});
beforeEach(async () => {
  await db.exec('TRUNCATE alerts, jobs RESTART IDENTITY CASCADE');
});

describe('alertThreshold', () => {
  it('uses the 14/7/2/0-day thresholds', () => {
    expect(ALERT_THRESHOLDS).toEqual([14, 7, 2, 0]);
  });

  it.each([
    [30, null],
    [15, null],
    [14, 14],
    [13, 14],
    [8, 14],
    [7, 7],
    [3, 7],
    [2, 2],
    [1, 2],
    [0, 0],
    [-1, null],
  ])('%i days left → %s', (daysLeft, expected) => {
    expect(alertThreshold(daysLeft)).toBe(expected);
  });
});

describe('planAlerts', () => {
  const job: StoredJob = { ...caDraft, id: '00000000-0000-4000-8000-000000000001', lastFurnishDate: null, done: {} };

  it('plans one alert for an at-risk deadline inside the window, with a useful email', () => {
    const [alert, ...rest] = planAlerts(job, { today: '2026-03-14', appUrl: APP_URL });
    expect(rest).toEqual([]);
    expect(alert).toMatchObject({
      jobId: job.id,
      deadlineDate: '2026-03-21',
      thresholdDays: 7,
      daysLeft: 7,
      toEmail: 'office@example.com',
    });
    expect(alert.subject).toBe('CA Preliminary 20-day notice due in 7 days (2026-03-21) — Acme Builders');
    expect(alert.body).toContain(`${APP_URL}/jobs/${job.id}`);
    expect(alert.body).toContain('https://leginfo.legislature.ca.gov/');
    expect(alert.body).toMatch(/not legal advice/i);
  });

  it('says "today" when the deadline is today', () => {
    const [alert] = planAlerts(job, { today: '2026-03-21', appUrl: APP_URL });
    expect(alert.thresholdDays).toBe(0);
    expect(alert.subject).toMatch(/due today/);
  });

  it('plans nothing outside the window, after the deadline or once the notice is served', () => {
    expect(planAlerts(job, { today: '2026-03-02', appUrl: APP_URL })).toEqual([]);
    expect(planAlerts(job, { today: '2026-03-22', appUrl: APP_URL })).toEqual([]);
    const key = computeDeadlines(job, { today: '2026-03-14' })[0].key;
    expect(planAlerts({ ...job, done: { [key]: '2026-03-10' } }, { today: '2026-03-14', appUrl: APP_URL })).toEqual([]);
  });
});

describe('enqueueAlerts', () => {
  it('sends the 14, 7, 2 and 0-day alerts once each across a run of daily crons', async () => {
    const job = await createJob(db, caDraft);
    const { sent, sender } = fakeSender();
    const enqueuedPerDay: number[] = [];
    for (let day = 1; day <= 25; day++) {
      const now = noonUtc(`2026-03-${String(day).padStart(2, '0')}`);
      // Same order as the cron route: enqueue, then send.
      enqueuedPerDay.push((await enqueueAlerts(db, { now, appUrl: APP_URL })).enqueued);
      await sendPendingAlerts(db, sender, { now });
    }
    const rows = await alertRows(db, job.id);
    expect(rows.map((r) => [r.threshold_days, r.status])).toEqual([
      [14, 'sent'],
      [7, 'sent'],
      [2, 'sent'],
      [0, 'sent'],
    ]);
    expect(sent.map((m) => m.subject.match(/due (in \d+ days|today)/)?.[0])).toEqual([
      'due in 14 days',
      'due in 7 days',
      'due in 2 days',
      'due today',
    ]);
    // 2026-03-07 is 14 days out, 03-14 is 7, 03-19 is 2, 03-21 is the deadline.
    expect(enqueuedPerDay.flatMap((n, i) => (n ? [i + 1] : []))).toEqual([7, 14, 19, 21]);
  });

  it('keeps only the current alert queued while email is not configured, and none after the deadline', async () => {
    const job = await createJob(db, caDraft);
    await enqueueAlerts(db, { now: noonUtc('2026-03-07'), appUrl: APP_URL }); // 14-day
    await enqueueAlerts(db, { now: noonUtc('2026-03-14'), appUrl: APP_URL }); // 7-day replaces it
    expect((await alertRows(db, job.id)).map((r) => r.threshold_days)).toEqual([7]);
    await enqueueAlerts(db, { now: noonUtc('2026-03-22'), appUrl: APP_URL }); // deadline passed
    expect(await alertRows(db, job.id)).toEqual([]);
  });

  it('catches up with the most urgent threshold after missed cron days, never a burst', async () => {
    const job = await createJob(db, caDraft);
    // First run ever happens 1 day before the deadline: only the 2-day alert, not 14 + 7 + 2.
    const result = await enqueueAlerts(db, { now: noonUtc('2026-03-20'), appUrl: APP_URL });
    expect(result.enqueued).toBe(1);
    expect((await alertRows(db, job.id)).map((r) => r.threshold_days)).toEqual([2]);
  });

  it("computes days left in the job's state time zone", async () => {
    const job = await createJob(db, caDraft);
    // 05:30 UTC on 03-14 is still 03-13 in Los Angeles → 8 days left → the 14-day alert, not the 7-day one.
    await enqueueAlerts(db, { now: new Date('2026-03-14T05:30:00Z'), appUrl: APP_URL });
    expect((await alertRows(db, job.id)).map((r) => r.threshold_days)).toEqual([14]);
  });

  it('drops pending alerts once the deadline is marked done', async () => {
    const job = await createJob(db, caDraft);
    await enqueueAlerts(db, { now: noonUtc('2026-03-14'), appUrl: APP_URL });
    const key = computeDeadlines(job, { today: '2026-03-14' })[0].key;
    await markDeadlineDone(db, job.id, key, '2026-03-14', { today: '2026-03-14' });
    const result = await enqueueAlerts(db, { now: noonUtc('2026-03-15'), appUrl: APP_URL });
    expect(result).toMatchObject({ enqueued: 0, pruned: 1 });
    expect(await alertRows(db, job.id)).toEqual([]);
  });

  it('re-alerts for the new date when the last-furnishing date moves the deadline', async () => {
    const job = await createJob(db, { ...caDraft, state: 'WA', firstFurnishDate: '2025-11-03', lastFurnishDate: '2026-01-10' });
    await enqueueAlerts(db, { now: noonUtc('2026-04-03'), appUrl: APP_URL }); // 7 days before 04-10
    await setLastFurnish(db, job.id, '2026-01-20'); // deadline moves to 04-20 → 17 days out
    const moved = await enqueueAlerts(db, { now: noonUtc('2026-04-03'), appUrl: APP_URL });
    expect(moved).toMatchObject({ enqueued: 0, pruned: 1 });
    await enqueueAlerts(db, { now: noonUtc('2026-04-13'), appUrl: APP_URL }); // 7 days before 04-20
    expect((await alertRows(db, job.id)).map((r) => [r.deadline_date, r.threshold_days])).toEqual([['2026-04-20', 7]]);
  });

  it('never prunes alerts that were already sent', async () => {
    const job = await createJob(db, caDraft);
    await enqueueAlerts(db, { now: noonUtc('2026-03-14'), appUrl: APP_URL });
    await sendPendingAlerts(db, fakeSender().sender, { now: noonUtc('2026-03-14') });
    const key = computeDeadlines(job, { today: '2026-03-14' })[0].key;
    await markDeadlineDone(db, job.id, key, '2026-03-14', { today: '2026-03-14' });
    expect(await enqueueAlerts(db, { now: noonUtc('2026-03-15'), appUrl: APP_URL })).toMatchObject({ pruned: 0 });
    expect((await alertRows(db, job.id)).map((r) => r.status)).toEqual(['sent']);
  });

  it('handles several jobs and reports counts', async () => {
    await createJob(db, caDraft);
    await createJob(db, { ...caDraft, state: 'TX', firstFurnishDate: '2026-01-05', lastFurnishDate: '2026-01-30' });
    // TX: January notice due 04-15 and lien due 05-15. On 04-08 only the notice is within 14 days.
    const result = await enqueueAlerts(db, { now: noonUtc('2026-04-08'), appUrl: APP_URL });
    expect(result).toEqual({ jobs: 2, enqueued: 1, pruned: 0 });
  });
});

describe('sendPendingAlerts', () => {
  async function oneQueuedAlert() {
    const job = await createJob(db, caDraft);
    await enqueueAlerts(db, { now: noonUtc('2026-03-14'), appUrl: APP_URL });
    return job;
  }

  it('sends each pending alert once and marks it sent', async () => {
    const job = await oneQueuedAlert();
    const { sent, sender } = fakeSender();
    expect(await sendPendingAlerts(db, sender, { now: noonUtc('2026-03-14') })).toEqual({ sent: 1, retrying: 0, failed: 0 });
    expect(await sendPendingAlerts(db, sender, { now: noonUtc('2026-03-14') })).toEqual({ sent: 0, retrying: 0, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'office@example.com', subject: expect.stringContaining('in 7 days') });
    expect(sent[0].idempotencyKey).toMatch(/^lienclock-alert-\d+$/);
    expect((await alertRows(db, job.id))[0].status).toBe('sent');
  });

  it('puts a failed send back in the queue and gives up after 3 attempts', async () => {
    const job = await oneQueuedAlert();
    const failing: AlertSender = { send: async () => Promise.reject(new Error('provider down')) };
    const now = noonUtc('2026-03-14');
    expect(await sendPendingAlerts(db, failing, { now })).toEqual({ sent: 0, retrying: 1, failed: 0 });
    expect(await sendPendingAlerts(db, failing, { now })).toEqual({ sent: 0, retrying: 1, failed: 0 });
    expect(await sendPendingAlerts(db, failing, { now })).toEqual({ sent: 0, retrying: 0, failed: 1 });
    expect(await sendPendingAlerts(db, failing, { now })).toEqual({ sent: 0, retrying: 0, failed: 0 });
    const { rows } = await db.query<{ status: string; attempts: number; last_error: string }>(
      'SELECT status, attempts, last_error FROM alerts WHERE job_id = $1',
      [job.id],
    );
    expect(rows).toEqual([{ status: 'failed', attempts: 3, last_error: 'provider down' }]);
  });

  it('reclaims an alert stuck in "sending" after 15 minutes, reusing its idempotency key', async () => {
    const job = await oneQueuedAlert();
    await db.query(`UPDATE alerts SET status = 'sending', claimed_at = $2, attempts = 1 WHERE job_id = $1`, [
      job.id,
      new Date('2026-03-14T18:50:00Z'),
    ]);
    const { sent, sender } = fakeSender();
    expect((await sendPendingAlerts(db, sender, { now: new Date('2026-03-14T19:00:00Z') })).sent).toBe(0);
    expect((await sendPendingAlerts(db, sender, { now: new Date('2026-03-14T19:06:00Z') })).sent).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('sends nothing for a deleted job (alerts cascade away)', async () => {
    const job = await oneQueuedAlert();
    await db.query('DELETE FROM jobs WHERE id = $1', [job.id]);
    const { sent, sender } = fakeSender();
    await sendPendingAlerts(db, sender, { now: noonUtc('2026-03-14') });
    expect(sent).toEqual([]);
  });
});

describe('resendSender', () => {
  // Fake key built at runtime so secret scanners never see a key-shaped literal.
  const fakeKey = ['re', 'test', 'A1b2C3d4'.repeat(4)].join('_');
  const message: AlertMessage = {
    to: 'office@example.com',
    subject: 'CA notice due in 7 days',
    text: 'body',
    idempotencyKey: 'lienclock-alert-42',
  };

  it('posts the email to the Resend API with the key and an idempotency key', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'email_1' }), { status: 200 });
    }) as unknown as typeof fetch;
    await resendSender({ apiKey: fakeKey, from: 'LienClock <alerts@example.com>', fetch: fetchImpl }).send(message);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect(calls[0].init.method).toBe('POST');
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${fakeKey}`);
    expect(headers.get('idempotency-key')).toBe('lienclock-alert-42');
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      from: 'LienClock <alerts@example.com>',
      to: ['office@example.com'],
      subject: 'CA notice due in 7 days',
      text: 'body',
    });
  });

  it('throws on a non-2xx response without leaking the key', async () => {
    const fetchImpl = (async () => new Response('{"message":"invalid"}', { status: 403 })) as unknown as typeof fetch;
    const error = await resendSender({ apiKey: fakeKey, from: 'a@example.com', fetch: fetchImpl })
      .send(message)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/403/);
    expect((error as Error).message).not.toContain(fakeKey);
  });
});
