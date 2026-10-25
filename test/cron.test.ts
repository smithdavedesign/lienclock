import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appUrlFrom, handleCronRequest } from '@/lib/cron';
import { createMemoryDb, ensureSchema, type Db } from '@/lib/db';
import { createJob } from '@/lib/jobs';

// Fake values built at runtime so secret scanners never see credential-shaped literals.
const secret = ['cron', 'X9y8Z7w6'.repeat(3)].join('-');
const resendKey = ['re', 'test', 'Q1w2E3r4'.repeat(4)].join('_');
const now = () => new Date('2026-03-14T19:00:00Z');

// One embedded Postgres per file (booting PGlite takes seconds); every test starts from one fresh job.
let db: Db;
beforeAll(async () => {
  db = await createMemoryDb();
  await ensureSchema(db);
});
beforeEach(async () => {
  await db.exec('TRUNCATE alerts, jobs RESTART IDENTITY CASCADE');
  await createJob(db, {
    state: 'CA',
    role: 'sub',
    projectType: 'commercial',
    counterparty: 'Acme Builders',
    firstFurnishDate: '2026-03-01',
    lastFurnishDate: null,
    alertEmail: 'office@example.com',
  });
});

const request = (authorization?: string) =>
  new Request('https://lienclock.example/api/cron/alerts', {
    headers: authorization ? { authorization } : {},
  });

describe('handleCronRequest', () => {
  it('fails closed when CRON_SECRET is not configured', async () => {
    const res = await handleCronRequest(request('Bearer undefined'), { env: {}, getDb: async () => db, now });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('Bearer');
  });

  it.each([
    ['no header', undefined],
    ['wrong token', 'Bearer wrong-token'],
    ['token without Bearer', secret],
    ['token with extra suffix', `Bearer ${secret}x`],
  ])('rejects %s with 401', async (_label, authorization) => {
    const res = await handleCronRequest(request(authorization), { env: { CRON_SECRET: secret }, getDb: async () => db, now });
    expect(res.status).toBe(401);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM alerts');
    expect(rows[0]).toEqual({ n: 0 });
  });

  it('enqueues alerts and leaves them pending when no email provider is configured', async () => {
    const res = await handleCronRequest(request(`Bearer ${secret}`), { env: { CRON_SECRET: secret }, getDb: async () => db, now });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      jobs: 1,
      enqueued: 1,
      pruned: 0,
      emailConfigured: false,
      sent: 0,
      retrying: 0,
      failed: 0,
    });
    const { rows } = await db.query('SELECT status FROM alerts');
    expect(rows).toEqual([{ status: 'pending' }]);
  });

  it('sends through Resend when RESEND_API_KEY is configured', async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response('{"id":"email_1"}', { status: 200 });
    }) as unknown as typeof fetch;
    const res = await handleCronRequest(request(`Bearer ${secret}`), {
      env: { CRON_SECRET: secret, RESEND_API_KEY: resendKey, APP_URL: 'https://lienclock.example' },
      getDb: async () => db,
      now,
      fetch: fetchImpl,
    });
    expect(await res.json()).toMatchObject({ ok: true, enqueued: 1, emailConfigured: true, sent: 1 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ from: 'LienClock <onboarding@resend.dev>', to: ['office@example.com'] });
    expect(JSON.stringify(bodies[0])).toContain('https://lienclock.example/jobs/');
  });

  it('returns a 500 without details when the database fails', async () => {
    const res = await handleCronRequest(request(`Bearer ${secret}`), {
      env: { CRON_SECRET: secret },
      getDb: async () => Promise.reject(new Error('connection refused at 10.0.0.5')),
      now,
    });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('10.0.0.5');
  });
});

describe('appUrlFrom', () => {
  it('prefers APP_URL, then the Vercel production host, then localhost', () => {
    expect(appUrlFrom({ APP_URL: 'https://lienclock.example/' })).toBe('https://lienclock.example');
    expect(appUrlFrom({ VERCEL_PROJECT_PRODUCTION_URL: 'lienclock.vercel.app' })).toBe('https://lienclock.vercel.app');
    expect(appUrlFrom({})).toBe('http://localhost:3000');
  });
});
