import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findOrCreateAccount, type Account } from '@/lib/auth';
import { createMemoryDb, ensureSchema, type Db } from '@/lib/db';
import {
  MAX_PENDING_PROPOSALS,
  confirmProposal,
  createProposal,
  discardProposal,
  getProposal,
  handleInboundEmail,
  intakeAddressFor,
  intakeTokenFrom,
  listPendingProposals,
  verifySvixSignature,
} from '@/lib/inbound';
import { listJobsForAccount } from '@/lib/jobs';
import { fakeWebhookSecret, svixHeaders } from './helpers/svix';

const APP = 'https://lienclock.example';
const NOW = new Date('2026-02-23T18:00:00Z');
const DOMAIN = 'in.lienclock.example';
const env = {
  RESEND_API_KEY: ['re', 'test', 'Q1w2E3r4'.repeat(4)].join('_'),
  RESEND_WEBHOOK_SECRET: fakeWebhookSecret(),
  INTAKE_EMAIL_DOMAIN: DOMAIN,
};
const PO_TEXT = 'General Contractor: Desert Ridge Builders\nJob Site: 500 S Mill Ave, Tempe, AZ 85281\nStart Date: March 2, 2026';

let db: Db;
let account: Account;
let other: Account;
beforeAll(async () => {
  db = await createMemoryDb();
  await ensureSchema(db);
});
beforeEach(async () => {
  await db.exec('TRUNCATE alerts, jobs, accounts, intake_proposals RESTART IDENTITY CASCADE');
  account = await findOrCreateAccount(db, 'dana@brightline.example');
  other = await findOrCreateAccount(db, 'other@example.com');
});

function event(overrides: Record<string, unknown> = {}, type = 'email.received') {
  return JSON.stringify({
    type,
    created_at: NOW.toISOString(),
    data: {
      email_id: randomUUID(),
      from: 'Dana <dana@brightline.example>',
      to: [intakeAddressFor(account, env)],
      cc: [],
      bcc: [],
      subject: 'Fwd: PO 2026-0412',
      ...overrides,
    },
  });
}

function stubResend(email: Record<string, unknown> = { subject: 'Fwd: PO 2026-0412', text: PO_TEXT, html: null }, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return status === 200 ? Response.json({ object: 'email', ...email }) : new Response('upstream error', { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function post(body: string, opts: { headers?: Record<string, string>; secret?: string; at?: Date } = {}) {
  return new Request(`${APP}/api/intake/email`, {
    method: 'POST',
    body,
    headers: opts.headers ?? svixHeaders(body, opts.secret ?? env.RESEND_WEBHOOK_SECRET, { at: opts.at ?? NOW }),
  });
}

const deliver = (req: Request, fetchImpl: typeof fetch, e: Record<string, string | undefined> = env) =>
  handleInboundEmail(req, { env: e, getDb: async () => db, now: () => NOW, fetch: fetchImpl });

const proposalCount = async () => (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM intake_proposals')).rows[0].n;

describe('verifySvixSignature', () => {
  const body = '{"type":"email.received"}';
  const headersFor = (h: Record<string, string>) => new Headers(h);

  it('accepts a correctly signed body within five minutes', () => {
    expect(verifySvixSignature(body, headersFor(svixHeaders(body, env.RESEND_WEBHOOK_SECRET, { at: NOW })), env.RESEND_WEBHOOK_SECRET, NOW)).toBe(true);
    const fourMinutesAgo = svixHeaders(body, env.RESEND_WEBHOOK_SECRET, { at: new Date(NOW.getTime() - 4 * 60_000) });
    expect(verifySvixSignature(body, headersFor(fourMinutesAgo), env.RESEND_WEBHOOK_SECRET, NOW)).toBe(true);
  });

  it('rejects a wrong secret, a tampered body, and stale or future timestamps', () => {
    const signed = svixHeaders(body, env.RESEND_WEBHOOK_SECRET, { at: NOW });
    expect(verifySvixSignature(body, headersFor(signed), fakeWebhookSecret('another-secret'), NOW)).toBe(false);
    expect(verifySvixSignature(`${body} `, headersFor(signed), env.RESEND_WEBHOOK_SECRET, NOW)).toBe(false);
    for (const minutes of [-6, 6]) {
      const at = new Date(NOW.getTime() + minutes * 60_000);
      expect(verifySvixSignature(body, headersFor(svixHeaders(body, env.RESEND_WEBHOOK_SECRET, { at })), env.RESEND_WEBHOOK_SECRET, NOW)).toBe(false);
    }
  });

  it('accepts any one valid v1 signature (secret rotation) and ignores other versions', () => {
    const signed = svixHeaders(body, env.RESEND_WEBHOOK_SECRET, { at: NOW });
    const valid = signed['svix-signature'].slice(3);
    const rotated = { ...signed, 'svix-signature': `v1,${Buffer.from('nope').toString('base64')} v1,${valid}` };
    expect(verifySvixSignature(body, headersFor(rotated), env.RESEND_WEBHOOK_SECRET, NOW)).toBe(true);
    const wrongVersion = { ...signed, 'svix-signature': `v2,${valid}` };
    expect(verifySvixSignature(body, headersFor(wrongVersion), env.RESEND_WEBHOOK_SECRET, NOW)).toBe(false);
  });

  it('rejects missing headers', () => {
    const signed = svixHeaders(body, env.RESEND_WEBHOOK_SECRET, { at: NOW });
    for (const name of ['svix-id', 'svix-timestamp', 'svix-signature']) {
      const headers = { ...signed };
      delete headers[name as keyof typeof headers];
      expect(verifySvixSignature(body, headersFor(headers), env.RESEND_WEBHOOK_SECRET, NOW)).toBe(false);
    }
    expect(verifySvixSignature(body, headersFor({ ...signed, 'svix-timestamp': 'soon' }), env.RESEND_WEBHOOK_SECRET, NOW)).toBe(false);
  });
});

describe('intake addresses', () => {
  it('builds a per-account address on the configured receiving domain', () => {
    expect(intakeAddressFor(account, env)).toBe(`${account.intakeToken}@${DOMAIN}`);
    expect(intakeAddressFor(account, {})).toBeNull();
    expect(intakeAddressFor(account, { INTAKE_EMAIL_DOMAIN: 'not a domain' })).toBeNull();
  });

  it('finds the token among recipients, with or without display names', () => {
    const address = intakeAddressFor(account, env)!;
    expect(intakeTokenFrom(['someone@example.com', `LienClock <${address.toUpperCase()}>`], DOMAIN)).toBe(account.intakeToken);
    expect(intakeTokenFrom([address], undefined)).toBe(account.intakeToken);
    expect(intakeTokenFrom([`${account.intakeToken}@elsewhere.example`], DOMAIN)).toBeNull();
    expect(intakeTokenFrom(['po-short@in.lienclock.example', 42, null], DOMAIN)).toBeNull();
  });
});

describe('handleInboundEmail', () => {
  it('fails closed when the webhook secret or API key is missing', async () => {
    const { calls, fetchImpl } = stubResend();
    for (const missing of ['RESEND_WEBHOOK_SECRET', 'RESEND_API_KEY'] as const) {
      const body = event();
      const res = await deliver(post(body), fetchImpl, { ...env, [missing]: undefined });
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain(env.RESEND_API_KEY);
    }
    expect(calls).toEqual([]);
    expect(await proposalCount()).toBe(0);
  });

  it('rejects an unsigned or wrongly signed request with 401', async () => {
    const { calls, fetchImpl } = stubResend();
    const body = event();
    expect((await deliver(post(body, { headers: { 'content-type': 'application/json' } }), fetchImpl)).status).toBe(401);
    expect((await deliver(post(body, { secret: fakeWebhookSecret('attacker') }), fetchImpl)).status).toBe(401);
    expect((await deliver(post(body, { at: new Date(NOW.getTime() - 10 * 60_000) }), fetchImpl)).status).toBe(401);
    expect(calls).toEqual([]);
    expect(await proposalCount()).toBe(0);
  });

  it('rejects oversized bodies with 413 before checking anything else', async () => {
    const { fetchImpl } = stubResend();
    const body = event({ subject: 'x'.repeat(300_000) });
    expect((await deliver(post(body), fetchImpl)).status).toBe(413);
  });

  it('answers 400 for signed but malformed payloads', async () => {
    const { fetchImpl } = stubResend();
    expect((await deliver(post('not json'), fetchImpl)).status).toBe(400);
    expect((await deliver(post(event({ email_id: '../../emails' })), fetchImpl)).status).toBe(400);
    expect((await deliver(post(event({ email_id: undefined })), fetchImpl)).status).toBe(400);
  });

  it('acknowledges other event types without doing anything', async () => {
    const { calls, fetchImpl } = stubResend();
    const res = await deliver(post(event({}, 'email.sent')), fetchImpl);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(calls).toEqual([]);
  });

  it('accepts but drops mail for an unknown address, so Resend does not retry it', async () => {
    const { calls, fetchImpl } = stubResend();
    const res = await deliver(post(event({ to: [`po-${'0'.repeat(32)}@${DOMAIN}`] })), fetchImpl);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, stored: false });
    expect(calls).toEqual([]);
    expect(await proposalCount()).toBe(0);
  });

  it('fetches the body with the API key and stores one proposal for the right account', async () => {
    const { calls, fetchImpl } = stubResend();
    const body = event();
    const emailId = JSON.parse(body).data.email_id;
    expect((await deliver(post(body), fetchImpl)).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.resend.com/emails/receiving/${emailId}`);
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${env.RESEND_API_KEY}`);
    const [proposal] = await listPendingProposals(db, account.id);
    expect(proposal).toMatchObject({
      accountId: account.id,
      source: 'email',
      status: 'pending',
      subject: 'Fwd: PO 2026-0412',
      fromEmail: 'Dana <dana@brightline.example>',
      jobId: null,
      fields: {
        state: { value: 'AZ', status: 'unconfirmed' },
        firstFurnishDate: { value: '2026-03-02', status: 'unconfirmed' },
        counterparty: { value: 'Desert Ridge Builders', status: 'unconfirmed' },
      },
    });
    expect(await listPendingProposals(db, other.id)).toEqual([]);
  });

  it('stores a retried delivery once, without fetching it again', async () => {
    const { calls, fetchImpl } = stubResend();
    const body = event();
    await deliver(post(body), fetchImpl);
    const retry = await deliver(post(body, { at: new Date(NOW.getTime() + 1000) }), fetchImpl);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ok: true, stored: false, duplicate: true });
    expect(calls).toHaveLength(1);
    expect(await proposalCount()).toBe(1);
  });

  it('answers 500 when the body cannot be fetched, so Resend retries, and stores nothing', async () => {
    const failing = stubResend({}, 503);
    const body = event();
    const res = await deliver(post(body), failing.fetchImpl);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(env.RESEND_API_KEY);
    expect(await proposalCount()).toBe(0);
    const working = stubResend();
    expect((await deliver(post(body), working.fetchImpl)).status).toBe(200);
    expect(await proposalCount()).toBe(1);
  });

  it('reads HTML-only emails', async () => {
    const html = '<table><tr><td>Ship To:</td><td>2100 Riverside Dr, Austin, TX 78741</td></tr></table>';
    const { fetchImpl } = stubResend({ subject: 'PO', text: null, html });
    await deliver(post(event()), fetchImpl);
    const [proposal] = await listPendingProposals(db, account.id);
    expect(proposal.fields.state).toMatchObject({ value: 'TX', status: 'unconfirmed' });
  });

  it(`stops storing after ${MAX_PENDING_PROPOSALS} unreviewed proposals`, async () => {
    for (let i = 0; i < MAX_PENDING_PROPOSALS; i++) {
      await createProposal(db, { accountId: account.id, source: 'paste', subject: '', fields: {} });
    }
    const { fetchImpl } = stubResend();
    const res = await deliver(post(event()), fetchImpl);
    expect(await res.json()).toEqual({ ok: true, stored: false });
    expect(await proposalCount()).toBe(MAX_PENDING_PROPOSALS);
  });
});

describe('proposals', () => {
  const fields = {
    state: { value: 'AZ', status: 'unconfirmed', source: 'Tempe, AZ 85281' },
    firstFurnishDate: { value: '2026-03-02', status: 'unconfirmed', source: 'Start Date: March 2, 2026' },
  } as const;
  const form = { state: 'AZ', counterparty: 'Desert Ridge Builders', firstFurnishDate: '2026-03-02', lastFurnishDate: '' };

  it('is visible only to its account', async () => {
    const proposal = (await createProposal(db, { accountId: account.id, source: 'paste', subject: '', fields }))!;
    expect(await getProposal(db, account.id, proposal.id)).toEqual(proposal);
    expect(await getProposal(db, other.id, proposal.id)).toBeNull();
    expect(await getProposal(db, account.id, 'not-a-uuid')).toBeNull();
  });

  it('drops unknown or malformed field data when reading it back', async () => {
    const proposal = (await createProposal(db, {
      accountId: account.id,
      source: 'paste',
      subject: '',
      fields: { ...fields, bogus: { value: 'x' }, counterparty: { value: 42 } } as never,
    }))!;
    expect(Object.keys(proposal.fields).sort()).toEqual(['firstFurnishDate', 'state']);
  });

  it('confirms into an account-owned job, once', async () => {
    const proposal = (await createProposal(db, { accountId: account.id, source: 'paste', subject: '', fields }))!;
    const first = await confirmProposal(db, account, proposal.id, form);
    expect(first).toMatchObject({ ok: true, job: { state: 'AZ', accountId: account.id, alertEmail: account.email } });
    expect(await confirmProposal(db, account, proposal.id, form)).toEqual({ ok: false, reason: 'not_found' });
    expect(await listJobsForAccount(db, account.id)).toHaveLength(1);
    expect(await getProposal(db, account.id, proposal.id)).toMatchObject({ status: 'accepted', jobId: first.ok ? first.job.id : '' });
  });

  it('lets exactly one of two simultaneous confirms create a job', async () => {
    const proposal = (await createProposal(db, { accountId: account.id, source: 'paste', subject: '', fields }))!;
    const results = await Promise.all([
      confirmProposal(db, account, proposal.id, form),
      confirmProposal(db, account, proposal.id, form),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await listJobsForAccount(db, account.id)).toHaveLength(1);
  });

  it('returns field errors and stays pending when the confirmed values are invalid', async () => {
    const proposal = (await createProposal(db, { accountId: account.id, source: 'paste', subject: '', fields }))!;
    const result = await confirmProposal(db, account, proposal.id, { ...form, state: 'OR', counterparty: '' });
    expect(result).toEqual({
      ok: false,
      reason: 'invalid',
      errors: { state: expect.stringContaining('covers'), counterparty: expect.any(String) },
    });
    expect((await getProposal(db, account.id, proposal.id))!.status).toBe('pending');
    expect(await listJobsForAccount(db, account.id)).toEqual([]);
  });

  it('cannot be confirmed or discarded by another account', async () => {
    const proposal = (await createProposal(db, { accountId: account.id, source: 'paste', subject: '', fields }))!;
    expect(await confirmProposal(db, other, proposal.id, form)).toEqual({ ok: false, reason: 'not_found' });
    expect(await discardProposal(db, other.id, proposal.id)).toBe(false);
    expect(await listJobsForAccount(db, other.id)).toEqual([]);
    expect((await getProposal(db, account.id, proposal.id))!.status).toBe('pending');
  });

  it('can be discarded, after which it is neither listed nor confirmable', async () => {
    const proposal = (await createProposal(db, { accountId: account.id, source: 'paste', subject: '', fields }))!;
    expect(await discardProposal(db, account.id, proposal.id)).toBe(true);
    expect(await listPendingProposals(db, account.id)).toEqual([]);
    expect(await confirmProposal(db, account, proposal.id, form)).toEqual({ ok: false, reason: 'not_found' });
    expect(await discardProposal(db, account.id, proposal.id)).toBe(false);
  });
});
