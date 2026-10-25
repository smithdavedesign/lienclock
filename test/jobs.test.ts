import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMemoryDb, ensureSchema, type Db } from '@/lib/db';
import { computeDeadlines } from '@/lib/deadlines';
import { createJob, deleteJob, getJob, listJobs, markDeadlineDone, setLastFurnish, type JobDraft } from '@/lib/jobs';

const draft: JobDraft = {
  state: 'CA',
  role: 'sub',
  projectType: 'commercial',
  counterparty: 'Acme Builders',
  firstFurnishDate: '2026-03-01',
  lastFurnishDate: null,
  alertEmail: 'office@example.com',
};

let db: Db;
beforeAll(async () => {
  db = await createMemoryDb();
  await ensureSchema(db);
});

describe('ensureSchema', () => {
  it('is safe to run repeatedly', async () => {
    await expect(ensureSchema(db)).resolves.toBeUndefined();
    await expect(ensureSchema(db)).resolves.toBeUndefined();
  });
});

describe('jobs repository', () => {
  it('creates a job with an unguessable id and reads it back with ISO date strings', async () => {
    const job = await createJob(db, draft);
    expect(job.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const loaded = await getJob(db, job.id);
    expect(loaded).toEqual({ ...draft, id: job.id, done: {} });
    expect(typeof loaded!.firstFurnishDate).toBe('string');
  });

  it('returns null for unknown or malformed ids instead of throwing', async () => {
    await expect(getJob(db, randomUUID())).resolves.toBeNull();
    await expect(getJob(db, 'not-a-uuid')).resolves.toBeNull();
    await expect(getJob(db, "' OR 1=1 --")).resolves.toBeNull();
  });

  it('updates and clears the last-furnishing date', async () => {
    const job = await createJob(db, draft);
    const updated = await setLastFurnish(db, job.id, '2026-05-01');
    expect(updated?.lastFurnishDate).toBe('2026-05-01');
    const cleared = await setLastFurnish(db, job.id, null);
    expect(cleared?.lastFurnishDate).toBeNull();
    await expect(setLastFurnish(db, randomUUID(), '2026-05-01')).resolves.toBeNull();
  });

  it('refuses a last-furnishing date before first furnishing', async () => {
    const job = await createJob(db, draft);
    await expect(setLastFurnish(db, job.id, '2026-02-01')).rejects.toThrow(/on or after/i);
  });

  it('lists jobs', async () => {
    const job = await createJob(db, { ...draft, state: 'TX' });
    const all = await listJobs(db);
    expect(all.some((j) => j.id === job.id && j.state === 'TX')).toBe(true);
  });

  it('deletes a job', async () => {
    const job = await createJob(db, draft);
    await expect(deleteJob(db, job.id)).resolves.toBe(true);
    await expect(getJob(db, job.id)).resolves.toBeNull();
    await expect(deleteJob(db, job.id)).resolves.toBe(false);
    await expect(deleteJob(db, 'nope')).resolves.toBe(false);
  });
});

describe('markDeadlineDone', () => {
  it('records the date a notice was served and recomputes status', async () => {
    const job = await createJob(db, draft);
    const key = computeDeadlines(job, { today: '2026-03-02' })[0].key;
    const result = await markDeadlineDone(db, job.id, key, '2026-04-10', { today: '2026-04-11' });
    expect(result.ok).toBe(true);
    const loaded = await getJob(db, job.id);
    expect(loaded!.done).toEqual({ [key]: '2026-04-10' });
    const notice = computeDeadlines(loaded!, { today: '2026-04-11' }).find((d) => d.key === key)!;
    expect(notice).toMatchObject({ status: 'partial', protectedFrom: '2026-03-21' });
  });

  it('clears a done date', async () => {
    const job = await createJob(db, draft);
    const key = computeDeadlines(job, { today: '2026-03-02' })[0].key;
    await markDeadlineDone(db, job.id, key, '2026-03-10', { today: '2026-03-11' });
    const cleared = await markDeadlineDone(db, job.id, key, null, { today: '2026-03-11' });
    expect(cleared.ok).toBe(true);
    expect((await getJob(db, job.id))!.done).toEqual({});
  });

  it('keeps other done dates when one is set (atomic merge)', async () => {
    const job = await createJob(db, { ...draft, state: 'TX', firstFurnishDate: '2026-01-10', lastFurnishDate: '2026-02-20' });
    const [a, b] = computeDeadlines(job, { today: '2026-03-01' }).filter((d) => d.kind === 'notice');
    await Promise.all([
      markDeadlineDone(db, job.id, a.key, '2026-02-01', { today: '2026-03-01' }),
      markDeadlineDone(db, job.id, b.key, '2026-02-25', { today: '2026-03-01' }),
    ]);
    expect((await getJob(db, job.id))!.done).toEqual({ [a.key]: '2026-02-01', [b.key]: '2026-02-25' });
  });

  it('rejects keys that are not deadlines of this job', async () => {
    const job = await createJob(db, draft);
    const result = await markDeadlineDone(db, job.id, 'tx-lien-affidavit', '2026-03-10', { today: '2026-03-11' });
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/deadline/i) });
    expect((await getJob(db, job.id))!.done).toEqual({});
  });

  it('rejects future dates and unknown jobs', async () => {
    const job = await createJob(db, draft);
    const key = computeDeadlines(job, { today: '2026-03-02' })[0].key;
    expect((await markDeadlineDone(db, job.id, key, '2026-03-12', { today: '2026-03-11' })).ok).toBe(false);
    expect(await markDeadlineDone(db, randomUUID(), key, '2026-03-10', { today: '2026-03-11' })).toEqual({
      ok: false,
      error: expect.stringMatching(/not found/i),
    });
  });
});
