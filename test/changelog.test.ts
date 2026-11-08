// The rules changelog: detection (diffing shipped rules against a stored snapshot), the entries it
// writes and the emails it queues, on a real embedded Postgres.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import rawRules from '../rules/rules.json';
import baselineFile from '../rules/baseline-2026-10-25.json';
import { deleteAccount, findOrCreateAccount } from '@/lib/auth';
import {
  RULES_BASELINE,
  describeDeadline,
  describeLateNotice,
  diffRules,
  listRuleChanges,
  rulesFingerprint,
  syncRuleChanges,
} from '@/lib/changelog';
import { createMemoryDb, ensureSchema, type Db } from '@/lib/db';
import { createJob } from '@/lib/jobs';
import { RULES, validateRuleSet, type Rule, type RuleSet } from '@/lib/rules';

const APP_URL = 'https://lienclock.example';
const now = new Date('2026-11-09T15:00:00Z');
const later = new Date('2026-11-20T15:00:00Z');
const base = { role: 'sub', projectType: 'commercial', lastFurnishDate: null } as const;
type RawRule = (typeof rawRules.rules)[number];

/** The shipped rules file, with `edit` applied to its rule list. */
function rulesWith(edit: (rules: RawRule[]) => unknown[], version = '2026-12-01'): RuleSet {
  return validateRuleSet({ ...rawRules, version, rules: edit(rawRules.rules) });
}
const patch = (id: string, change: Partial<Record<keyof RawRule, unknown>>) => (rules: RawRule[]) =>
  rules.map((r) => (r.id === id ? { ...r, ...change } : r));

const sync = (rules: RuleSet, baseline: Rule[] = RULES.rules, at = now) =>
  syncRuleChanges(db, { rules, baseline, now: at, appUrl: APP_URL });

async function count(table: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0].n;
}

let db: Db;
beforeAll(async () => {
  db = await createMemoryDb();
  await ensureSchema(db);
});
beforeEach(async () => {
  await db.exec(
    'TRUNCATE rule_change_emails, rule_changes, rule_snapshots, alerts, jobs, accounts RESTART IDENTITY CASCADE',
  );
});

describe('the baseline', () => {
  it('is the rules file LienClock shipped before change tracking (M1–M2, version 2026-10-25)', () => {
    expect(baselineFile.version).toBe('2026-10-25');
    expect(RULES_BASELINE.map((r) => r.id)).toEqual(baselineFile.rules.map((r) => r.id));
    expect(new Set(RULES_BASELINE.map((r) => r.state))).toEqual(new Set(['CA', 'TX', 'FL', 'WA', 'AZ', 'NV']));
  });

  it('first sync on an empty database: only what changed since the baseline is reported, and nobody is emailed', async () => {
    const account = await findOrCreateAccount(db, 'office@example.com');
    await createJob(db, { ...base, state: 'CA', counterparty: 'Acme', firstFurnishDate: '2026-11-01', alertEmail: account.email, accountId: account.id });

    const result = await sync(RULES, RULES_BASELINE);
    expect(result.seeded).toBe(true);
    // M3 added 10 states and changed none of the M1 rules.
    expect(result.changes.map((c) => c.state).sort()).toEqual(['CO', 'GA', 'IL', 'MN', 'NJ', 'NY', 'OH', 'PA', 'UT', 'VA']);
    for (const change of result.changes) {
      expect(change.items.length).toBeGreaterThan(0);
      expect(change.items.every((i) => i.change === 'added')).toBe(true);
    }
    expect(result.emailsQueued).toBe(0);
    expect(await count('rule_change_emails')).toBe(0);
    expect(await count('rule_snapshots')).toBe(16);

    const again = await sync(RULES, RULES_BASELINE);
    expect(again).toMatchObject({ seeded: false, changes: [], emailsQueued: 0 });
  });

  it('a database seeded from the current rules reports nothing', async () => {
    const result = await sync(RULES, RULES.rules);
    expect(result).toMatchObject({ seeded: true, changes: [], emailsQueued: 0 });
  });
});

describe('detecting changes', () => {
  beforeEach(async () => {
    await sync(RULES);
  });

  it('ignores re-verification: a new lastVerified date alone is no change, but the stored copy is refreshed', async () => {
    const reverified = rulesWith(patch('ca-preliminary-notice', { lastVerified: '2026-11-30' }));
    expect(rulesFingerprint(reverified.rules.filter((r) => r.state === 'CA'))).toBe(
      rulesFingerprint(RULES.rules.filter((r) => r.state === 'CA')),
    );
    const result = await sync(reverified);
    expect(result.changes).toEqual([]);
    const { rows } = await db.query<{ rules: Rule[] }>("SELECT rules FROM rule_snapshots WHERE state = 'CA'");
    expect(rows[0].rules.find((r) => r.id === 'ca-preliminary-notice')?.lastVerified).toBe('2026-11-30');

    // A later real change still diffs against the refreshed copy (only the note changed).
    const noted = rulesWith(patch('ca-preliminary-notice', { lastVerified: '2026-11-30', note: 'Serve the notice. New wording.' }));
    const [change] = (await sync(noted)).changes;
    expect(change.items[0].fields.map((f) => f.label)).toEqual(['What to do']);
  });

  it('reports each changed field with its before and after', async () => {
    const edited = rulesWith(
      patch('nv-notice-of-right-to-lien', {
        offset: { unit: 'days', days: 30 },
        lateLookbackDays: 30,
        citation: 'NRS 108.245(1)',
        title: 'Notice of right to lien (31 → 30 days)',
      }),
    );
    const [change] = (await sync(edited)).changes;
    expect(change.state).toBe('NV');
    expect(change.items).toHaveLength(1);
    const fields = Object.fromEntries(change.items[0].fields.map((f) => [f.label, [f.before, f.after]]));
    expect(fields.Deadline).toEqual(['31 days after you first furnish', '30 days after you first furnish']);
    expect(fields['Late notice']).toEqual([
      'A late notice still protects work from 31 days before it is given',
      'A late notice still protects work from 30 days before it is given',
    ]);
    expect(fields.Statute).toEqual(['NRS 108.245', 'NRS 108.245(1)']);
    expect(fields.Name).toEqual(['Notice of right to lien', 'Notice of right to lien (31 → 30 days)']);
    expect(change.items[0].title).toBe('Notice of right to lien (31 → 30 days)');
  });

  it('reports added and removed rules, and groups one state’s changes into one entry', async () => {
    const edited = rulesWith((rules) => [
      ...rules.filter((r) => r.id !== 'fl-claim-of-lien'),
      {
        ...rules.find((r) => r.id === 'fl-claim-of-lien')!,
        id: 'fl-claim-of-lien-2027',
        offset: { unit: 'days', days: 60 },
        title: 'Record claim of lien (2027 law)',
      },
    ]);
    const result = await sync(edited);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].state).toBe('FL');
    expect(result.changes[0].items.map((i) => [i.change, i.ruleId])).toEqual([
      ['removed', 'fl-claim-of-lien'],
      ['added', 'fl-claim-of-lien-2027'],
    ]);
    const added = result.changes[0].items[1];
    expect(added.fields).toEqual([
      { label: 'Deadline', before: '', after: '60 days after you last furnish' },
      { label: 'Statute', before: '', after: 'Fla. Stat. § 713.08(5)' },
    ]);
  });

  it('a new state with no jobs gets an entry and no email, even when other states have jobs', async () => {
    const account = await findOrCreateAccount(db, 'office@example.com');
    await createJob(db, { ...base, state: 'TX', counterparty: 'Lone Star', firstFurnishDate: '2026-10-01', alertEmail: account.email, accountId: account.id });
    const withoutGa = { ...RULES, rules: RULES.rules.filter((r) => r.state !== 'GA') };
    await db.exec('TRUNCATE rule_change_emails, rule_changes, rule_snapshots RESTART IDENTITY CASCADE');
    await sync(withoutGa, withoutGa.rules);

    const result = await sync(RULES, withoutGa.rules);
    expect(result.changes.map((c) => c.state)).toEqual(['GA']);
    expect(result.emailsQueued).toBe(0);
  });

  it('a revert is a change too: every edit gets the next revision', async () => {
    const edited = rulesWith(patch('wa-claim-of-lien', { offset: { unit: 'days', days: 60 } }));
    expect((await sync(edited)).changes[0].revision).toBe(1);
    const reverted = await sync(RULES, RULES.rules, later);
    expect(reverted.changes).toHaveLength(1);
    expect(reverted.changes[0]).toMatchObject({ state: 'WA', revision: 2 });
    expect(reverted.changes[0].items[0].fields[0]).toEqual({
      label: 'Deadline',
      before: '60 days after you last furnish',
      after: '90 days after you last furnish',
    });
    expect((await sync(edited, RULES.rules, later)).changes[0].revision).toBe(3);
    expect((await listRuleChanges(db)).map((c) => c.revision)).toEqual([3, 2, 1]);
  });

  it('two overlapping runs record one entry and queue each email once', async () => {
    const account = await findOrCreateAccount(db, 'office@example.com');
    await createJob(db, { ...base, state: 'AZ', counterparty: 'Mesa', firstFurnishDate: '2026-11-01', alertEmail: account.email, accountId: account.id });
    const edited = rulesWith(patch('az-mechanics-lien', { offset: { unit: 'days', days: 100 } }));
    const results = await Promise.all([sync(edited), sync(edited), sync(edited)]);
    expect(results.flatMap((r) => r.changes)).toHaveLength(1);
    expect(await count('rule_changes')).toBe(1);
    expect(await count('rule_change_emails')).toBe(1);
  });

  it('queues the emails on the next run if a run stopped after recording the change', async () => {
    const account = await findOrCreateAccount(db, 'office@example.com');
    await createJob(db, { ...base, state: 'AZ', counterparty: 'Mesa', firstFurnishDate: '2026-11-01', alertEmail: account.email, accountId: account.id });
    await sync(rulesWith(patch('az-mechanics-lien', { offset: { unit: 'days', days: 100 } })));
    // Simulate the crash: the entry exists, its emails don't.
    await db.exec('DELETE FROM rule_change_emails; UPDATE rule_changes SET emails_queued_at = NULL');
    const next = await sync(rulesWith(patch('az-mechanics-lien', { offset: { unit: 'days', days: 100 } })));
    expect(next.changes).toEqual([]);
    expect(next.emailsQueued).toBe(1);
    expect(await count('rule_change_emails')).toBe(1);
  });

  it('lists only the jobs in the changed state, grouped per address, and links each one', async () => {
    const account = await findOrCreateAccount(db, 'office@example.com');
    const own = { alertEmail: account.email, accountId: account.id };
    const a = await createJob(db, { ...base, ...own, state: 'WA', counterparty: 'Cascade GC', firstFurnishDate: '2026-09-01' });
    const b = await createJob(db, { ...base, ...own, state: 'WA', counterparty: 'Rainier Builders', firstFurnishDate: '2026-10-01' });
    await createJob(db, { ...base, ...own, state: 'CA', counterparty: 'Harbor Point', firstFurnishDate: '2026-10-01' });
    await sync(rulesWith(patch('wa-claim-of-lien', { offset: { unit: 'days', days: 60 } })));
    const { rows } = await db.query<{ to_email: string; subject: string; body: string }>('SELECT to_email, subject, body FROM rule_change_emails');
    expect(rows).toHaveLength(1);
    expect(rows[0].to_email).toBe('office@example.com');
    expect(rows[0].subject).toBe('Washington lien rules changed: check your 2 Washington jobs');
    expect(rows[0].body).toContain(`Cascade GC (first furnished 2026-09-01): ${APP_URL}/jobs/${a.id}`);
    expect(rows[0].body).toContain(`Rainier Builders (first furnished 2026-10-01): ${APP_URL}/jobs/${b.id}`);
    expect(rows[0].body).not.toContain('Harbor Point');
  });
});

describe('account deletion', () => {
  it('also deletes the rule-change emails queued or sent to that address', async () => {
    await sync(RULES);
    const gone = await findOrCreateAccount(db, 'gone@example.com');
    const stays = await findOrCreateAccount(db, 'stays@example.com');
    for (const a of [gone, stays]) {
      await createJob(db, { ...base, state: 'WA', counterparty: 'Cascade GC', firstFurnishDate: '2026-09-01', alertEmail: a.email, accountId: a.id });
    }
    await sync(rulesWith(patch('wa-claim-of-lien', { offset: { unit: 'days', days: 60 } })));
    expect(await count('rule_change_emails')).toBe(2);
    expect(await deleteAccount(db, gone.id)).toBe(true);
    const { rows } = await db.query<{ to_email: string }>('SELECT to_email FROM rule_change_emails');
    expect(rows).toEqual([{ to_email: 'stays@example.com' }]);
  });
});

describe('diffRules', () => {
  const ca = RULES.rules.filter((r) => r.state === 'CA');
  it('is empty for identical rule sets, in any order', () => {
    expect(diffRules(ca, [...ca].reverse())).toEqual([]);
  });
  it('sorts items by rule id', () => {
    expect(diffRules([], ca).map((i) => i.ruleId)).toEqual(['ca-mechanics-lien', 'ca-preliminary-notice']);
    expect(diffRules(ca, []).map((i) => i.change)).toEqual(['removed', 'removed']);
  });
});

describe('describeDeadline and describeLateNotice', () => {
  const rule = (id: string) => RULES.rules.find((r) => r.id === id)!;
  it.each([
    ['ca-preliminary-notice', '20 days after you first furnish'],
    ['wa-claim-of-lien', '90 days after you last furnish'],
    ['tx-notice-of-claim', 'the 15th of the 3rd month after each month you furnish'],
    ['tx-lien-affidavit', 'the 15th of the 4th month after the month you last furnish'],
    ['ny-notice-of-lien', '8 months after you last furnish'],
    ['co-notice-of-intent', '4 months after you last furnish, less 10 days'],
    ['pa-mechanics-lien', '6 months after you last furnish'],
  ])('%s → %s', (id, text) => {
    expect(describeDeadline(rule(id))).toBe(text);
  });

  it('describes the late-notice effect, including Utah’s forward-only protection', () => {
    expect(describeLateNotice(rule('ca-preliminary-notice'))).toBe('A late notice still protects work from 20 days before it is given');
    expect(describeLateNotice(rule('ut-preliminary-notice'))).toBe('A late notice protects only work from 5 days after it is given');
    expect(describeLateNotice(rule('fl-notice-to-owner'))).toBe('A late notice protects nothing');
    expect(describeLateNotice(rule('fl-claim-of-lien'))).toBe('');
  });
});
