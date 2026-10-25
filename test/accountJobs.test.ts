// Multiple jobs per account, and no way to read or change another account's job.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findOrCreateAccount, type Account } from '@/lib/auth';
import { createMemoryDb, ensureSchema, type Db } from '@/lib/db';
import {
  createJob,
  deleteJob,
  getJob,
  listJobs,
  listJobsForAccount,
  markDeadlineDone,
  setLastFurnish,
  summarizeJobs,
  type JobDraft,
} from '@/lib/jobs';

let db: Db;
let owner: Account;
let other: Account;
beforeAll(async () => {
  db = await createMemoryDb();
  await ensureSchema(db);
});
beforeEach(async () => {
  await db.exec('TRUNCATE alerts, jobs, accounts RESTART IDENTITY CASCADE');
  owner = await findOrCreateAccount(db, 'owner@example.com');
  other = await findOrCreateAccount(db, 'other@example.com');
});

const draft = (account: Account, overrides: Partial<JobDraft> = {}): JobDraft => ({
  state: 'CA',
  role: 'sub',
  projectType: 'commercial',
  counterparty: 'Acme Builders',
  firstFurnishDate: '2026-03-01',
  lastFurnishDate: null,
  alertEmail: account.email,
  accountId: account.id,
  ...overrides,
});

describe('account-owned jobs', () => {
  it('stores the owning account', async () => {
    const job = await createJob(db, draft(owner));
    expect(job.accountId).toBe(owner.id);
    expect(await getJob(db, job.id)).toEqual(job);
  });

  it('lists only the account’s own jobs, oldest first', async () => {
    const a = await createJob(db, draft(owner, { counterparty: 'First GC' }));
    await createJob(db, draft(other));
    const b = await createJob(db, draft(owner, { state: 'TX', counterparty: 'Second GC' }));
    expect((await listJobsForAccount(db, owner.id)).map((j) => j.id)).toEqual([a.id, b.id]);
    expect(await listJobsForAccount(db, 'not-a-uuid')).toEqual([]);
    expect(await listJobs(db)).toHaveLength(3); // the cron still sees every job
  });

  it('hides a job from other accounts', async () => {
    const job = await createJob(db, draft(owner));
    expect(await getJob(db, job.id, { accountId: owner.id })).toEqual(job);
    expect(await getJob(db, job.id, { accountId: other.id })).toBeNull();
    expect(await getJob(db, job.id, { accountId: 'not-a-uuid' })).toBeNull();
  });

  it('refuses to delete another account’s job', async () => {
    const job = await createJob(db, draft(owner));
    expect(await deleteJob(db, job.id, { accountId: other.id })).toBe(false);
    expect(await getJob(db, job.id)).not.toBeNull();
    expect(await deleteJob(db, job.id, { accountId: owner.id })).toBe(true);
    expect(await getJob(db, job.id)).toBeNull();
  });

  it('refuses to change another account’s last-furnishing date', async () => {
    const job = await createJob(db, draft(owner));
    expect(await setLastFurnish(db, job.id, '2026-05-01', { accountId: other.id })).toBeNull();
    expect((await getJob(db, job.id))!.lastFurnishDate).toBeNull();
    // An out-of-range date for someone else's job reads as "not found", not as a validation hint.
    expect(await setLastFurnish(db, job.id, '2026-01-01', { accountId: other.id })).toBeNull();
    expect((await setLastFurnish(db, job.id, '2026-05-01', { accountId: owner.id }))!.lastFurnishDate).toBe('2026-05-01');
  });

  it('refuses to mark another account’s deadline done', async () => {
    const job = await createJob(db, draft(owner));
    const denied = await markDeadlineDone(db, job.id, 'ca-preliminary-notice', '2026-03-10', {
      today: '2026-03-11',
      accountId: other.id,
    });
    expect(denied).toEqual({ ok: false, error: expect.stringMatching(/not found/i) });
    expect((await getJob(db, job.id))!.done).toEqual({});
    const allowed = await markDeadlineDone(db, job.id, 'ca-preliminary-notice', '2026-03-10', {
      today: '2026-03-11',
      accountId: owner.id,
    });
    expect(allowed.ok).toBe(true);
  });
});

describe('summarizeJobs', () => {
  it('orders jobs by their most urgent deadline and puts jobs without dates last', async () => {
    const now = new Date('2026-03-14T16:00:00Z');
    const later = await createJob(db, draft(owner, { firstFurnishDate: '2026-03-10', counterparty: 'Later GC' })); // due 03-30
    const waOnly = await createJob(db, draft(owner, { state: 'WA', counterparty: 'No dates yet' })); // WA: lien needs a last date
    const soon = await createJob(db, draft(owner, { firstFurnishDate: '2026-03-01', counterparty: 'Soon GC' })); // due 03-21
    const missed = await createJob(db, draft(owner, { firstFurnishDate: '2026-01-02', counterparty: 'Missed GC' })); // due 01-22
    const summaries = summarizeJobs([later, waOnly, soon, missed], now);
    expect(summaries.map((s) => s.job.counterparty)).toEqual(['Soon GC', 'Later GC', 'Missed GC', 'No dates yet']);
    expect(summaries[0]).toMatchObject({ openCount: 1, next: { date: '2026-03-21', status: 'at_risk', daysLeft: 7 } });
    expect(summaries[2]).toMatchObject({ openCount: 0, next: { status: 'missed' } });
    expect(summaries[3]).toMatchObject({ openCount: 0, next: null });
  });
});
