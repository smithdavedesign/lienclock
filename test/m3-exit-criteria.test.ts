// One test (or more) per M3 exit criterion in ROADMAP.md:
//   "a rules change creates a changelog entry and queues emails only for jobs in that state."
import { beforeEach, beforeAll, describe, expect, it } from 'vitest';
import rawRules from '../rules/rules.json';
import { findOrCreateAccount } from '@/lib/auth';
import { describeDeadline, listRuleChanges, syncRuleChanges } from '@/lib/changelog';
import { handleCronRequest } from '@/lib/cron';
import { createMemoryDb, ensureSchema, type Db } from '@/lib/db';
import { createJob, type StoredJob } from '@/lib/jobs';
import { RULES, validateRuleSet, type RuleSet } from '@/lib/rules';

const APP_URL = 'https://lienclock.example';
const base = { role: 'sub', projectType: 'commercial', lastFurnishDate: null } as const;
const t0 = new Date('2026-11-09T15:00:00Z');
const t1 = new Date('2026-12-01T15:00:00Z');

/** The shipped rules with one Texas rule changed: notices due a month earlier. */
function texasEdit(): RuleSet {
  return validateRuleSet({
    ...rawRules,
    version: '2026-12-01',
    rules: rawRules.rules.map((r) =>
      r.id === 'tx-notice-of-claim'
        ? { ...r, offset: { unit: 'monthDay', months: 2, day: 15 }, lastVerified: '2026-12-01' }
        : r,
    ),
  });
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

/** Accounts with jobs in TX only, CA only, both; and an M1-era TX job without an account. */
async function seedJobs() {
  const tx = await findOrCreateAccount(db, 'tx-only@example.com');
  const ca = await findOrCreateAccount(db, 'ca-only@example.com');
  const both = await findOrCreateAccount(db, 'both@example.com');
  const own = (a: { id: string; email: string }) => ({ accountId: a.id, alertEmail: a.email });
  const jobs: Record<string, StoredJob> = {
    lone: await createJob(db, { ...base, ...own(tx), state: 'TX', counterparty: 'Lone Star GC', firstFurnishDate: '2026-09-02' }),
    harbor: await createJob(db, { ...base, ...own(ca), state: 'CA', counterparty: 'Harbor Point Builders', firstFurnishDate: '2026-11-01' }),
    acme: await createJob(db, { ...base, ...own(both), state: 'CA', counterparty: 'Acme Builders', firstFurnishDate: '2026-10-20' }),
    bluebonnet: await createJob(db, {
      ...base,
      ...own(both),
      state: 'TX',
      counterparty: 'Bluebonnet Builders',
      firstFurnishDate: '2026-10-05',
    }),
    legacy: await createJob(db, {
      ...base,
      state: 'TX',
      counterparty: 'Old Mill Contractors',
      firstFurnishDate: '2026-08-11',
      alertEmail: 'Legacy@Example.com',
    }),
  };
  return { jobs };
}

async function queuedEmails() {
  const { rows } = await db.query<{ to_email: string; subject: string; body: string; status: string }>(
    'SELECT to_email, subject, body, status FROM rule_change_emails ORDER BY to_email',
  );
  return rows;
}

describe('M3 exit criterion', () => {
  it('M3-EC1: a rules change creates a changelog entry and queues emails only for jobs in that state', async () => {
    // The database has seen the shipped rules: nothing to report yet.
    const first = await syncRuleChanges(db, { rules: RULES, baseline: RULES.rules, now: t0, appUrl: APP_URL });
    expect(first.changes).toEqual([]);
    const { jobs } = await seedJobs();

    const edited = texasEdit();
    const result = await syncRuleChanges(db, { rules: edited, baseline: RULES.rules, now: t1, appUrl: APP_URL });

    // Exactly one changelog entry, for Texas, saying what changed (before → after).
    expect(result.changes).toHaveLength(1);
    const [change] = result.changes;
    expect(change).toMatchObject({ state: 'TX', stateName: 'Texas', rulesVersion: '2026-12-01' });
    const before = RULES.rules.find((r) => r.id === 'tx-notice-of-claim')!;
    const after = edited.rules.find((r) => r.id === 'tx-notice-of-claim')!;
    expect(change.items).toEqual([
      {
        ruleId: 'tx-notice-of-claim',
        title: 'Notice of claim for unpaid work',
        change: 'changed',
        fields: [{ label: 'Deadline', before: describeDeadline(before), after: describeDeadline(after) }],
      },
    ]);
    expect(describeDeadline(before)).not.toBe(describeDeadline(after));
    expect(await listRuleChanges(db)).toEqual([change]);

    // Emails only for addresses with a Texas job: not the CA-only account.
    const emails = await queuedEmails();
    expect(emails.map((e) => e.to_email)).toEqual(['both@example.com', 'legacy@example.com', 'tx-only@example.com']);
    expect(result.emailsQueued).toBe(3);
    for (const email of emails) {
      expect(email.status).toBe('pending');
      expect(email.subject).toContain('Texas');
      expect(email.body).toContain(describeDeadline(before));
      expect(email.body).toContain(describeDeadline(after));
      expect(email.body).toContain(`${APP_URL}/changelog`);
      expect(email.body).toMatch(/not legal advice/i);
    }
    const bodyOf = (to: string) => emails.find((e) => e.to_email === to)!.body;
    // Each email lists only that address's Texas jobs.
    expect(bodyOf('both@example.com')).toContain('Bluebonnet Builders');
    expect(bodyOf('both@example.com')).toContain(`${APP_URL}/jobs/${jobs.bluebonnet.id}`);
    expect(bodyOf('both@example.com')).not.toContain('Acme Builders');
    expect(bodyOf('tx-only@example.com')).toContain('Lone Star GC');
    expect(bodyOf('tx-only@example.com')).not.toContain('Bluebonnet');
    expect(bodyOf('legacy@example.com')).toContain('Old Mill Contractors');
    for (const email of emails) expect(email.body).not.toContain('Harbor Point');

    // Running again (the next day's cron) changes nothing and sends nothing twice.
    const rerun = await syncRuleChanges(db, { rules: edited, baseline: RULES.rules, now: t1, appUrl: APP_URL });
    expect(rerun).toMatchObject({ changes: [], emailsQueued: 0 });
    expect(await queuedEmails()).toHaveLength(3);
    expect(await listRuleChanges(db)).toHaveLength(1);
  });

  it('M3-EC1 end to end: the daily cron records the change and emails only the Texas addresses', async () => {
    const secret = ['cron', 'M3e2E3r4'.repeat(3)].join('-');
    const resendKey = ['re', 'test', 'Z9x8C7v6'.repeat(4)].join('_');
    const sent: { to: string[]; subject: string }[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response('{"id":"email_1"}', { status: 200 });
    }) as unknown as typeof fetch;
    const run = (rules: RuleSet, now: Date) =>
      handleCronRequest(
        new Request(`${APP_URL}/api/cron/alerts`, { headers: { authorization: `Bearer ${secret}` } }),
        {
          env: { CRON_SECRET: secret, RESEND_API_KEY: resendKey, APP_URL },
          getDb: async () => db,
          now: () => now,
          fetch: fetchImpl,
          rules: { rules, baseline: RULES.rules },
        },
      );

    const seeded = await run(RULES, t0);
    expect(await seeded.json()).toMatchObject({ ok: true, ruleChanges: { ok: true, created: 0, emailsQueued: 0 } });
    await seedJobs();
    sent.length = 0;

    const res = await run(texasEdit(), t1);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ruleChanges: { ok: true, created: 1, emailsQueued: 3, sent: 3 } });
    const ruleMail = sent.filter((m) => /rules changed/i.test(m.subject));
    expect(ruleMail.map((m) => m.to[0]).sort()).toEqual(['both@example.com', 'legacy@example.com', 'tx-only@example.com']);
    expect((await queuedEmails()).every((e) => e.status === 'sent')).toBe(true);
  });
});
