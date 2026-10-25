// One test (or more) per M2 exit criterion in ROADMAP.md:
//   "ICS feed validates and contains one VEVENT per deadline; a forwarded sample PO email yields
//    state and date fields flagged 'unconfirmed'."
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { findOrCreateAccount } from '@/lib/auth';
import { todayIn } from '@/lib/dates';
import { createMemoryDb, ensureSchema, type Db } from '@/lib/db';
import { computeDeadlines } from '@/lib/deadlines';
import { handleCalendarFeed } from '@/lib/ics';
import { confirmProposal, handleInboundEmail, intakeAddressFor, listPendingProposals } from '@/lib/inbound';
import { proposeJobFromEmail } from '@/lib/intake';
import { createJob, listJobsForAccount } from '@/lib/jobs';
import { STATES } from '@/lib/rules';
import { prop, unescapeText, validateIcs } from './helpers/icsValidator';
import { fakeWebhookSecret, svixHeaders } from './helpers/svix';

const APP_URL = 'https://lienclock.example';
const base = { role: 'sub', projectType: 'commercial', lastFurnishDate: null } as const;
const samplePo = () => readFileSync(new URL('./fixtures/forwarded-po.txt', import.meta.url), 'utf8');

let db: Db;
beforeAll(async () => {
  db = await createMemoryDb();
  await ensureSchema(db);
});

describe('M2 exit criteria', () => {
  it('M2-EC1: the ICS feed validates and contains one VEVENT per deadline', async () => {
    const account = await findOrCreateAccount(db, 'office@brightline.example');
    const other = await findOrCreateAccount(db, 'someone-else@example.com');
    const owned = { alertEmail: account.email, accountId: account.id };
    const jobs = [
      // Commas and semicolons must be escaped, and non-ASCII names must fold on character boundaries.
      await createJob(db, { ...base, ...owned, state: 'CA', counterparty: 'Acme Builders, Inc.', firstFurnishDate: '2026-03-01' }),
      await createJob(db, {
        ...base,
        ...owned,
        state: 'TX',
        counterparty: 'Lone Star GC; Dallas',
        firstFurnishDate: '2026-01-05',
        lastFurnishDate: '2026-03-10',
      }),
      await createJob(db, {
        ...base,
        ...owned,
        state: 'WA',
        counterparty: 'Évergreen Construction — Seattle',
        firstFurnishDate: '2025-11-03',
        lastFurnishDate: '2026-01-10',
      }),
    ];
    const strangers = await createJob(db, {
      ...base,
      state: 'NV',
      counterparty: 'Not Yours LLC',
      firstFurnishDate: '2026-02-01',
      alertEmail: other.email,
      accountId: other.id,
    });

    const now = new Date('2026-03-14T16:00:00Z');
    const res = await handleCalendarFeed(`${account.feedToken}.ics`, {
      env: { APP_URL },
      getDb: async () => db,
      now: () => now,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/calendar; charset=utf-8/);
    const body = await res.text();

    const check = validateIcs(body);
    expect(check.errors).toEqual([]);

    const expected = jobs.flatMap((job) =>
      computeDeadlines(job, { today: todayIn(STATES[job.state].timeZone, now) }).map((deadline) => ({ job, deadline })),
    );
    // CA notice; TX Jan/Feb/Mar notices + lien; WA lien.
    expect(expected).toHaveLength(6);
    expect(check.events).toHaveLength(expected.length);

    const byUid = new Map(check.events.map((event) => [unescapeText(prop(event, 'UID')!.value), event]));
    expect(byUid.size).toBe(expected.length);
    for (const { job, deadline } of expected) {
      const event = byUid.get(`${job.id}.${deadline.key}@lienclock`);
      expect(event, `${job.state} ${deadline.key}`).toBeDefined();
      expect(prop(event!, 'DTSTART')).toMatchObject({ params: { VALUE: 'DATE' }, value: deadline.date.replaceAll('-', '') });
      const summary = unescapeText(prop(event!, 'SUMMARY')!.value);
      expect(summary).toContain(deadline.title);
      expect(summary).toContain(job.counterparty);
      expect(unescapeText(prop(event!, 'DESCRIPTION')!.value)).toContain(deadline.citationUrl);
      expect(prop(event!, 'URL')!.value).toBe(`${APP_URL}/jobs/${job.id}`);
    }
    expect(body).not.toContain(strangers.id);
  });

  it('M2-EC2: a forwarded sample PO email yields state and date fields flagged "unconfirmed"', () => {
    const proposal = proposeJobFromEmail({ subject: 'Fwd: PO 2026-0412 - Mill Ave Medical Office', text: samplePo() });
    expect(proposal.forwarded).toBe(true);
    // The job site is in Tempe, AZ: not the vendor's own Las Vegas address or the GC's office.
    expect(proposal.fields.state).toEqual({
      value: 'AZ',
      status: 'unconfirmed',
      source: expect.stringContaining('Tempe, AZ 85281'),
    });
    expect(proposal.fields.firstFurnishDate).toEqual({
      value: '2026-03-02',
      status: 'unconfirmed',
      source: expect.stringContaining('Start Date: March 2, 2026'),
    });
  });

  it('M2-EC2 end to end: forwarding the PO stores an unconfirmed proposal, and no job exists until it is confirmed', async () => {
    const account = await findOrCreateAccount(db, 'dana@brightline.example');
    const env = {
      RESEND_API_KEY: ['re', 'test', 'Q1w2E3r4'.repeat(4)].join('_'),
      RESEND_WEBHOOK_SECRET: fakeWebhookSecret(),
      INTAKE_EMAIL_DOMAIN: 'in.lienclock.example',
    };
    const address = intakeAddressFor(account, env);
    expect(address).toMatch(/^po-[0-9a-f]{32}@in\.lienclock\.example$/);

    const emailId = randomUUID();
    const now = new Date('2026-02-23T18:00:00Z');
    const fetched: string[] = [];
    const fetchImpl = (async (url: string) => {
      fetched.push(url);
      return Response.json({
        object: 'email',
        id: emailId,
        from: 'Dana Office <dana@brightline.example>',
        to: [address],
        subject: 'Fwd: PO 2026-0412 - Mill Ave Medical Office',
        text: samplePo(),
        html: null,
      });
    }) as unknown as typeof fetch;
    const body = JSON.stringify({
      type: 'email.received',
      created_at: now.toISOString(),
      data: {
        email_id: emailId,
        created_at: now.toISOString(),
        from: 'Dana Office <dana@brightline.example>',
        to: [`LienClock intake <${address}>`],
        cc: [],
        bcc: [],
        subject: 'Fwd: PO 2026-0412 - Mill Ave Medical Office',
        attachments: [],
      },
    });
    const request = new Request(`${APP_URL}/api/intake/email`, {
      method: 'POST',
      body,
      headers: svixHeaders(body, env.RESEND_WEBHOOK_SECRET, { at: now }),
    });

    const res = await handleInboundEmail(request, { env, getDb: async () => db, now: () => now, fetch: fetchImpl });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, stored: true });
    expect(fetched).toEqual([`https://api.resend.com/emails/receiving/${emailId}`]);

    const [proposal, ...rest] = await listPendingProposals(db, account.id);
    expect(rest).toEqual([]);
    expect(proposal.source).toBe('email');
    expect(proposal.fields.state).toMatchObject({ value: 'AZ', status: 'unconfirmed' });
    expect(proposal.fields.firstFurnishDate).toMatchObject({ value: '2026-03-02', status: 'unconfirmed' });
    // Proposed, not saved: nothing is tracked or alerted until the user confirms.
    expect(await listJobsForAccount(db, account.id)).toEqual([]);

    const confirmed = await confirmProposal(db, account, proposal.id, {
      state: proposal.fields.state!.value,
      counterparty: proposal.fields.counterparty?.value ?? 'Desert Ridge Builders, LLC',
      firstFurnishDate: proposal.fields.firstFurnishDate!.value,
      lastFurnishDate: '',
    });
    expect(confirmed.ok).toBe(true);
    const saved = await listJobsForAccount(db, account.id);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      state: 'AZ',
      firstFurnishDate: '2026-03-02',
      accountId: account.id,
      alertEmail: account.email,
    });
    expect(await listPendingProposals(db, account.id)).toEqual([]);
  });
});
