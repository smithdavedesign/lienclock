import { describe, expect, it } from 'vitest';
import { computeDeadlines, pendingRules, statusLabel, type JobInput } from '@/lib/deadlines';

const base = { role: 'sub', projectType: 'commercial', counterparty: 'Acme Builders' } as const;
const ca: JobInput = { ...base, state: 'CA', firstFurnishDate: '2026-03-01', lastFurnishDate: '2026-05-15' };

function keyOf(job: JobInput, kind: 'notice' | 'lien', today = '2026-03-02') {
  return computeDeadlines(job, { today }).find((d) => d.kind === kind)!.key;
}

describe('computeDeadlines — status', () => {
  it('open and not yet due → at risk, with days left', () => {
    const notice = computeDeadlines(ca, { today: '2026-03-14' }).find((d) => d.kind === 'notice')!;
    expect(notice).toMatchObject({ status: 'at_risk', daysLeft: 7, date: '2026-03-21' });
    expect(notice.doneDate).toBeUndefined();
  });

  it('due today is still at risk (0 days left)', () => {
    const notice = computeDeadlines(ca, { today: '2026-03-21' }).find((d) => d.kind === 'notice')!;
    expect(notice).toMatchObject({ status: 'at_risk', daysLeft: 0 });
  });

  it('open and past due → missed, negative days left', () => {
    const notice = computeDeadlines(ca, { today: '2026-03-22' }).find((d) => d.kind === 'notice')!;
    expect(notice).toMatchObject({ status: 'missed', daysLeft: -1 });
  });

  it('notice served before work started counts as on time', () => {
    const key = keyOf(ca, 'notice');
    const notice = computeDeadlines({ ...ca, done: { [key]: '2026-02-20' } }, { today: '2026-03-02' }).find((d) => d.key === key)!;
    expect(notice).toMatchObject({ status: 'protected', protectedFrom: '2026-03-01' });
  });

  it('late notice in a state with no look-back (FL) → missed', () => {
    const fl: JobInput = { ...base, state: 'FL', firstFurnishDate: '2026-03-01' };
    const key = keyOf(fl, 'notice');
    const notice = computeDeadlines({ ...fl, done: { [key]: '2026-04-16' } }, { today: '2026-04-20' }).find((d) => d.key === key)!;
    expect(notice.status).toBe('missed');
    expect(notice.doneDate).toBe('2026-04-16');
    expect(notice.protectedFrom).toBeUndefined();
  });

  it('late notice in NV keeps the 31-day look-back', () => {
    const nv: JobInput = { ...base, state: 'NV', firstFurnishDate: '2026-03-01' };
    const key = keyOf(nv, 'notice');
    const notice = computeDeadlines({ ...nv, done: { [key]: '2026-05-10' } }, { today: '2026-05-11' }).find((d) => d.key === key)!;
    expect(notice).toMatchObject({ status: 'partial', protectedFrom: '2026-04-09' });
  });

  it('late notice in AZ keeps the 20-day look-back', () => {
    const az: JobInput = { ...base, state: 'AZ', firstFurnishDate: '2026-03-01' };
    const key = keyOf(az, 'notice');
    const notice = computeDeadlines({ ...az, done: { [key]: '2026-04-30' } }, { today: '2026-05-01' }).find((d) => d.key === key)!;
    expect(notice).toMatchObject({ status: 'partial', protectedFrom: '2026-04-10' });
  });

  it('lien recorded on or before the deadline → protected; after → missed', () => {
    const key = keyOf(ca, 'lien');
    const onTime = computeDeadlines({ ...ca, done: { [key]: '2026-08-13' } }, { today: '2026-09-01' }).find((d) => d.key === key)!;
    expect(onTime).toMatchObject({ status: 'protected', date: '2026-08-13' });
    const late = computeDeadlines({ ...ca, done: { [key]: '2026-08-14' } }, { today: '2026-09-01' }).find((d) => d.key === key)!;
    expect(late.status).toBe('missed');
  });

  it('ignores done entries for keys that are not this job’s deadlines', () => {
    const deadlines = computeDeadlines({ ...ca, done: { 'tx-lien-affidavit': '2026-03-05' } }, { today: '2026-03-02' });
    expect(deadlines.every((d) => d.doneDate === undefined)).toBe(true);
  });

  it('carries the rule metadata on each deadline', () => {
    const notice = computeDeadlines(ca, { today: '2026-03-02' }).find((d) => d.kind === 'notice')!;
    expect(notice.ruleId).toBe('ca-preliminary-notice');
    expect(notice.citation).toContain('8204');
    expect(notice.title).toBeTruthy();
    expect(notice.note).toBeTruthy();
  });
});

describe('computeDeadlines — sorting by urgency', () => {
  it('lists open deadlines soonest first, then missed, then partially protected, then protected', () => {
    const tx: JobInput = { ...base, state: 'TX', firstFurnishDate: '2026-01-10', lastFurnishDate: '2026-04-20' };
    const all = computeDeadlines(tx, { today: '2026-04-21' });
    const jan = all.find((d) => d.periodMonth === '2026-01')!;
    const feb = all.find((d) => d.periodMonth === '2026-02')!;
    const deadlines = computeDeadlines({ ...tx, done: { [feb.key]: '2026-04-20' } }, { today: '2026-04-21' });
    expect(deadlines.map((d) => [d.periodMonth ?? d.kind, d.status])).toEqual([
      ['2026-03', 'at_risk'], // 2026-06-15
      ['2026-04', 'at_risk'], // 2026-07-15
      ['lien', 'at_risk'], // 2026-08-15
      ['2026-01', 'missed'], // 2026-04-15 passed
      ['2026-02', 'protected'],
    ]);
    expect(jan.status).toBe('missed');
  });

  it('breaks ties between same-date deadlines deterministically by key', () => {
    const tx: JobInput = { ...base, state: 'TX', firstFurnishDate: '2026-01-10', lastFurnishDate: '2026-01-20' };
    const a = computeDeadlines(tx, { today: '2026-01-21' }).map((d) => d.key);
    const b = computeDeadlines(tx, { today: '2026-01-21' }).map((d) => d.key);
    expect(a).toEqual(b);
  });
});

describe('computeDeadlines — Texas month-by-month notices', () => {
  const tx: JobInput = { ...base, state: 'TX', firstFurnishDate: '2026-01-20', lastFurnishDate: '2026-03-05' };

  it('creates one notice per month furnished, due the 15th of the third month after', () => {
    const notices = computeDeadlines(tx, { today: '2026-01-21' }).filter((d) => d.kind === 'notice');
    expect(notices.map((d) => [d.periodMonth, d.date])).toEqual([
      ['2026-01', '2026-04-15'],
      ['2026-02', '2026-05-15'],
      ['2026-03', '2026-06-15'],
    ]);
    expect(new Set(notices.map((d) => d.key)).size).toBe(3);
    expect(notices[0].title).toMatch(/January 2026/);
  });

  it('without a last-furnishing date, runs through the current month only', () => {
    const open = { ...tx, lastFurnishDate: null };
    const months = computeDeadlines(open, { today: '2026-02-10' }).filter((d) => d.kind === 'notice').map((d) => d.periodMonth);
    expect(months).toEqual(['2026-01', '2026-02']);
  });

  it('for a job that has not started yet, shows the first month only', () => {
    const future = { ...tx, lastFurnishDate: null };
    const months = computeDeadlines(future, { today: '2025-12-01' }).filter((d) => d.kind === 'notice').map((d) => d.periodMonth);
    expect(months).toEqual(['2026-01']);
  });
});

describe('computeDeadlines — missing last-furnishing date', () => {
  const open: JobInput = { ...base, state: 'CA', firstFurnishDate: '2026-03-01' };

  it('omits lien deadlines until a last-furnishing date is given', () => {
    const kinds = computeDeadlines(open, { today: '2026-03-02' }).map((d) => d.kind);
    expect(kinds).toEqual(['notice']);
  });

  it('pendingRules names the rules waiting for that date', () => {
    expect(pendingRules(open).map((r) => r.id)).toEqual(['ca-mechanics-lien']);
    expect(pendingRules({ ...open, lastFurnishDate: '2026-05-01' })).toEqual([]);
  });

  it('recomputes the lien window when the last-furnishing date changes', () => {
    const first = computeDeadlines({ ...open, lastFurnishDate: '2026-05-01' }, { today: '2026-05-02' }).find((d) => d.kind === 'lien')!;
    const moved = computeDeadlines({ ...open, lastFurnishDate: '2026-06-01' }, { today: '2026-05-02' }).find((d) => d.kind === 'lien')!;
    expect(first.date).toBe('2026-07-30');
    expect(moved.date).toBe('2026-08-30');
    expect(moved.key).toBe(first.key);
  });
});

describe('computeDeadlines — input guards', () => {
  it('rejects an unsupported state', () => {
    expect(() => computeDeadlines({ ...ca, state: 'OR' as never }, { today: '2026-03-02' })).toThrow(/state/i);
  });

  it('rejects roles and project types outside M1', () => {
    expect(() => computeDeadlines({ ...ca, role: 'supplier' as never }, { today: '2026-03-02' })).toThrow(/role/i);
    expect(() => computeDeadlines({ ...ca, projectType: 'residential' as never }, { today: '2026-03-02' })).toThrow(/project type/i);
  });

  it('rejects invalid or inverted dates', () => {
    expect(() => computeDeadlines({ ...ca, firstFurnishDate: '2026-02-30' }, { today: '2026-03-02' })).toThrow(/first/i);
    expect(() => computeDeadlines({ ...ca, lastFurnishDate: '2026-02-01' }, { today: '2026-03-02' })).toThrow(/last/i);
    expect(() => computeDeadlines(ca, { today: 'tomorrow' })).toThrow(/today/i);
  });

  it('defaults "today" to the current date in the job’s state', () => {
    const deadlines = computeDeadlines({ ...base, state: 'CA', firstFurnishDate: '2026-03-01' });
    expect(Number.isInteger(deadlines[0].daysLeft)).toBe(true);
  });
});

describe('statusLabel', () => {
  it('has a human label for every status', () => {
    expect(statusLabel('protected')).toBe('Protected');
    expect(statusLabel('partial')).toBe('Partially protected');
    expect(statusLabel('at_risk')).toBe('At risk');
    expect(statusLabel('missed')).toBe('Missed');
  });
});
