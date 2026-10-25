// One test (or more) per M1 exit criterion in ROADMAP.md.
import { beforeAll, describe, expect, it } from 'vitest';
import { enqueueAlerts } from '@/lib/alerts';
import { isIsoDate } from '@/lib/dates';
import { createMemoryDb, ensureSchema, type Db } from '@/lib/db';
import { computeDeadlines, type JobInput } from '@/lib/deadlines';
import { createJob } from '@/lib/jobs';
import { SUPPORTED_STATES } from '@/lib/rules';

const base = { role: 'sub', projectType: 'commercial', counterparty: 'Acme Builders' } as const;
const APP_URL = 'https://lienclock.example';

function job(overrides: Partial<JobInput> & Pick<JobInput, 'state' | 'firstFurnishDate'>): JobInput {
  return { ...base, ...overrides };
}

describe('M1 exit criteria', () => {
  it('EC1: CA job, first furnish 2026-03-01 → preliminary notice deadline 2026-03-21', () => {
    const deadlines = computeDeadlines(job({ state: 'CA', firstFurnishDate: '2026-03-01' }), { today: '2026-03-02' });
    const notice = deadlines.find((d) => d.kind === 'notice');
    expect(notice?.date).toBe('2026-03-21');
    expect(notice?.status).toBe('at_risk');
    expect(notice?.daysLeft).toBe(19);
  });

  it('EC2: CA notice served 2026-04-10 (day 40) → protection only from 2026-03-21 onward', () => {
    const ca = job({ state: 'CA', firstFurnishDate: '2026-03-01' });
    const key = computeDeadlines(ca, { today: '2026-03-02' }).find((d) => d.kind === 'notice')!.key;

    const late = computeDeadlines({ ...ca, done: { [key]: '2026-04-10' } }, { today: '2026-04-11' });
    const notice = late.find((d) => d.key === key)!;
    expect(notice.status).toBe('partial');
    expect(notice.protectedFrom).toBe('2026-03-21');
    expect(notice.doneDate).toBe('2026-04-10');

    // Contrast: served on day 20 protects everything from first furnishing.
    const onTime = computeDeadlines({ ...ca, done: { [key]: '2026-03-21' } }, { today: '2026-04-11' });
    const onTimeNotice = onTime.find((d) => d.key === key)!;
    expect(onTimeNotice.status).toBe('protected');
    expect(onTimeNotice.protectedFrom).toBe('2026-03-01');
  });

  it('EC3: TX job, last furnish 2026-02-10 → lien filing deadline 2026-06-15 (15th of fourth month after)', () => {
    const deadlines = computeDeadlines(
      job({ state: 'TX', firstFurnishDate: '2026-01-05', lastFurnishDate: '2026-02-10' }),
      { today: '2026-02-11' },
    );
    const lien = deadlines.find((d) => d.kind === 'lien');
    expect(lien?.date).toBe('2026-06-15');
  });

  it('EC4: WA job, last furnish 2026-01-10 → lien recording deadline 2026-04-10', () => {
    const deadlines = computeDeadlines(
      job({ state: 'WA', firstFurnishDate: '2025-11-03', lastFurnishDate: '2026-01-10' }),
      { today: '2026-01-11' },
    );
    const lien = deadlines.find((d) => d.kind === 'lien');
    expect(lien?.date).toBe('2026-04-10');
  });

  describe('alert scheduler', () => {
    let db: Db;
    beforeAll(async () => {
      db = await createMemoryDb(); // fresh embedded Postgres, real SQL
      await ensureSchema(db);
    });

    it('EC5: a job 7 days before a deadline enqueues exactly one 7-day alert and none duplicated on rerun', async () => {
      // 16:00 UTC on 2026-03-14 is 09:00 in Los Angeles: the CA notice (due 2026-03-21) is 7 days out.
      const now = new Date('2026-03-14T16:00:00Z');
      const saved = await createJob(db, {
        ...job({ state: 'CA', firstFurnishDate: '2026-03-01' }),
        alertEmail: 'office@example.com',
      });

      const first = await enqueueAlerts(db, { now, appUrl: APP_URL });
      const rerun = await enqueueAlerts(db, { now, appUrl: APP_URL });
      const laterSameDay = await enqueueAlerts(db, { now: new Date('2026-03-14T23:00:00Z'), appUrl: APP_URL });

      expect(first.enqueued).toBe(1);
      expect(rerun.enqueued).toBe(0);
      expect(laterSameDay.enqueued).toBe(0);
      const { rows } = await db.query(
        'SELECT threshold_days, deadline_date::text AS deadline_date FROM alerts WHERE job_id = $1',
        [saved.id],
      );
      expect(rows).toEqual([{ threshold_days: 7, deadline_date: '2026-03-21' }]);
    });
  });

  it('EC6: every returned deadline includes a non-empty citation URL and last-verified date', () => {
    const shapes = [
      { firstFurnishDate: '2026-01-05' },
      { firstFurnishDate: '2026-01-05', lastFurnishDate: '2026-04-20' },
      { firstFurnishDate: '2025-11-30', lastFurnishDate: '2026-02-28' },
    ];
    let checked = 0;
    for (const state of SUPPORTED_STATES) {
      for (const shape of shapes) {
        const deadlines = computeDeadlines({ ...base, state, ...shape }, { today: '2026-03-01' });
        // WA: a first-tier sub on a commercial job owes no preliminary notice, so without a
        // last-furnishing date there is nothing to return yet.
        if (state !== 'WA' || 'lastFurnishDate' in shape) expect(deadlines.length).toBeGreaterThan(0);
        for (const d of deadlines) {
          expect(d.citationUrl).toMatch(/^https:\/\/\S+$/);
          expect(() => new URL(d.citationUrl)).not.toThrow();
          expect(d.citation.trim()).not.toBe('');
          expect(isIsoDate(d.lastVerified)).toBe(true);
          expect(d.lastVerified <= '2026-10-25').toBe(true);
          checked += 1;
        }
      }
      // With a last-furnishing date every state yields a lien deadline too.
      const withLast = computeDeadlines(
        { ...base, state, firstFurnishDate: '2026-01-05', lastFurnishDate: '2026-04-20' },
        { today: '2026-03-01' },
      );
      expect(withLast.some((d) => d.kind === 'lien')).toBe(true);
    }
    expect(checked).toBeGreaterThan(SUPPORTED_STATES.length * 3);
  });
});
