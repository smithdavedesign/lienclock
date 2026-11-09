import { createHash } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_SIGN_IN_EMAILS_PER_ADDRESS,
  MAX_SIGN_IN_EMAILS_PER_HOUR,
  SESSION_DAYS,
  SIGN_IN_LINK_MINUTES,
  accountByFeedToken,
  accountByIntakeToken,
  deleteAccount,
  deliverSignInLink,
  endSession,
  findOrCreateAccount,
  finishSignIn,
  getSessionAccount,
  hashToken,
  peekSignIn,
  rotateFeedToken,
  safeNextPath,
  signInLink,
  startSignIn,
} from '@/lib/auth';
import { createMemoryDb, ensureSchema, type Db } from '@/lib/db';
import { confirmProposal, createProposal, listPendingProposals } from '@/lib/inbound';
import { createJob, getJob, listJobsForAccount } from '@/lib/jobs';

const NOW = new Date('2026-03-14T16:00:00Z');
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const resendKey = ['re', 'test', 'Q1w2E3r4'.repeat(4)].join('_');
const pendingJob = {
  state: 'CA',
  role: 'sub',
  projectType: 'commercial',
  counterparty: 'Acme Builders',
  firstFurnishDate: '2026-03-01',
  lastFurnishDate: null,
} as const;

let db: Db;
beforeAll(async () => {
  db = await createMemoryDb();
  await ensureSchema(db);
});
beforeEach(async () => {
  await db.exec('TRUNCATE alerts, jobs, accounts, login_tokens, sessions RESTART IDENTITY CASCADE');
});

async function signedIn(email = 'office@example.com', now = NOW) {
  const started = await startSignIn(db, { email, now });
  if (!started.ok) throw new Error(started.error);
  const finished = await finishSignIn(db, started.token, { now });
  if (!finished.ok) throw new Error('finish failed');
  return finished;
}

describe('safeNextPath', () => {
  it('keeps same-site paths', () => {
    expect(safeNextPath('/jobs/123')).toBe('/jobs/123');
    expect(safeNextPath('/?state=CA&counterparty=Acme+Builders')).toBe('/?state=CA&counterparty=Acme+Builders');
  });

  it.each([
    ['protocol-relative', '//evil.example/jobs'],
    ['backslash trick', '/\\evil.example'],
    ['absolute URL', 'https://evil.example/'],
    ['javascript URL', 'javascript:alert(1)'],
    ['relative path', 'jobs'],
    ['header injection', '/jobs\r\nSet-Cookie: x=1'],
    ['too long', `/${'a'.repeat(2001)}`],
    ['not a string', undefined],
  ])('falls back to /jobs for %s', (_label, value) => {
    expect(safeNextPath(value)).toBe('/jobs');
  });
});

describe('accounts', () => {
  it('finds or creates one account per normalized email', async () => {
    const a = await findOrCreateAccount(db, ' Office@Example.COM ');
    const b = await findOrCreateAccount(db, 'office@example.com');
    expect(b).toEqual(a);
    expect(a.email).toBe('office@example.com');
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.feedToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.intakeToken).toMatch(/^po-[0-9a-f]{32}$/);
  });

  it('creates the account once even when two sign-ins finish at the same time', async () => {
    const [a, b] = await Promise.all([findOrCreateAccount(db, 'race@example.com'), findOrCreateAccount(db, 'race@example.com')]);
    expect(a.id).toBe(b.id);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM accounts');
    expect(rows[0]).toEqual({ n: 1 });
  });

  it('gives every account its own feed and intake tokens', async () => {
    const a = await findOrCreateAccount(db, 'a@example.com');
    const b = await findOrCreateAccount(db, 'b@example.com');
    expect(a.feedToken).not.toBe(b.feedToken);
    expect(a.intakeToken).not.toBe(b.intakeToken);
    expect(a.feedToken).not.toContain(a.intakeToken.slice(3));
  });

  it('refuses an invalid email', async () => {
    await expect(findOrCreateAccount(db, 'not an email')).rejects.toThrow(/email/i);
  });

  it('looks accounts up by feed and intake token, and rotates the feed token', async () => {
    const a = await findOrCreateAccount(db, 'a@example.com');
    expect(await accountByFeedToken(db, a.feedToken)).toEqual(a);
    expect(await accountByIntakeToken(db, a.intakeToken.toUpperCase())).toEqual(a);
    expect(await accountByFeedToken(db, 'nope')).toBeNull();
    expect(await accountByIntakeToken(db, 'po-nope')).toBeNull();
    const rotated = await rotateFeedToken(db, a.id);
    expect(rotated).toEqual({ ...a, feedToken: expect.not.stringMatching(a.feedToken) });
    expect(await accountByFeedToken(db, a.feedToken)).toBeNull();
    expect(await rotateFeedToken(db, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});

describe('sign-in links', () => {
  it('stores only a hash of the link token', async () => {
    const started = await startSignIn(db, { email: 'office@example.com', now: NOW });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const { rows } = await db.query<{ token_hash: string; email: string }>('SELECT token_hash, email FROM login_tokens');
    expect(rows).toEqual([{ token_hash: createHash('sha256').update(started.token).digest('hex'), email: 'office@example.com' }]);
    expect(hashToken(started.token)).toBe(rows[0].token_hash);
    expect(JSON.stringify(rows)).not.toContain(started.token);
  });

  it('rejects an invalid email', async () => {
    expect(await startSignIn(db, { email: 'office@', now: NOW })).toEqual({ ok: false, error: 'invalid_email' });
  });

  it(`sends at most ${MAX_SIGN_IN_EMAILS_PER_ADDRESS} links per address per ${SIGN_IN_LINK_MINUTES} minutes`, async () => {
    for (let i = 0; i < MAX_SIGN_IN_EMAILS_PER_ADDRESS; i++) {
      expect((await startSignIn(db, { email: 'office@example.com', now: later(i) })).ok).toBe(true);
    }
    expect(await startSignIn(db, { email: 'OFFICE@example.com', now: later(5) })).toEqual({ ok: false, error: 'rate_limited' });
    expect((await startSignIn(db, { email: 'other@example.com', now: later(5) })).ok).toBe(true);
    expect((await startSignIn(db, { email: 'office@example.com', now: later(SIGN_IN_LINK_MINUTES + 1) })).ok).toBe(true);
  });

  it(`caps sign-in emails at ${MAX_SIGN_IN_EMAILS_PER_HOUR} per hour overall to protect the alert email quota`, async () => {
    for (let i = 0; i < MAX_SIGN_IN_EMAILS_PER_HOUR; i++) {
      expect((await startSignIn(db, { email: `user${i}@example.com`, now: NOW })).ok).toBe(true);
    }
    expect(await startSignIn(db, { email: 'one-more@example.com', now: later(1) })).toEqual({ ok: false, error: 'rate_limited' });
    expect((await startSignIn(db, { email: 'one-more@example.com', now: later(61) })).ok).toBe(true);
  });

  it('signs in once per link: a second use, an expired link or a malformed token fails', async () => {
    const started = await startSignIn(db, { email: 'office@example.com', next: '/jobs/abc', now: NOW });
    if (!started.ok) throw new Error('start failed');
    const first = await finishSignIn(db, started.token, { now: later(1) });
    expect(first).toMatchObject({ ok: true, next: '/jobs/abc', job: null, account: { email: 'office@example.com' } });
    expect(await finishSignIn(db, started.token, { now: later(2) })).toEqual({ ok: false });

    const stale = await startSignIn(db, { email: 'office@example.com', now: NOW });
    if (!stale.ok) throw new Error('start failed');
    expect(await finishSignIn(db, stale.token, { now: later(SIGN_IN_LINK_MINUTES + 1) })).toEqual({ ok: false });

    expect(await finishSignIn(db, 'short', { now: NOW })).toEqual({ ok: false });
    expect(await finishSignIn(db, 'A'.repeat(43), { now: NOW })).toEqual({ ok: false });
  });

  it('lets exactly one of two simultaneous clicks through', async () => {
    const started = await startSignIn(db, { email: 'office@example.com', now: NOW });
    if (!started.ok) throw new Error('start failed');
    const results = await Promise.all([finishSignIn(db, started.token, { now: NOW }), finishSignIn(db, started.token, { now: NOW })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('peeks at a link without using it up: address and waiting job, for the confirmation page', async () => {
    const started = await startSignIn(db, { email: 'office@example.com', pendingJob, now: NOW });
    if (!started.ok) throw new Error('start failed');
    expect(await peekSignIn(db, started.token, { now: later(1) })).toEqual({ email: 'office@example.com', pendingJob });
    expect(await peekSignIn(db, started.token, { now: later(2) })).not.toBeNull();
    expect((await finishSignIn(db, started.token, { now: later(3) })).ok).toBe(true);
    expect(await peekSignIn(db, started.token, { now: later(4) })).toBeNull();

    const stale = await startSignIn(db, { email: 'office@example.com', now: NOW });
    if (!stale.ok) throw new Error('start failed');
    expect(await peekSignIn(db, stale.token, { now: later(SIGN_IN_LINK_MINUTES + 1) })).toBeNull();
    expect(await peekSignIn(db, 'garbage', { now: NOW })).toBeNull();
  });

  it('sanitizes the stored next path', async () => {
    const started = await startSignIn(db, { email: 'office@example.com', next: '//evil.example', now: NOW });
    if (!started.ok) throw new Error('start failed');
    expect(await finishSignIn(db, started.token, { now: NOW })).toMatchObject({ ok: true, next: '/jobs' });
  });

  it('saves the job that was waiting for the email to be confirmed, owned by the new account', async () => {
    const started = await startSignIn(db, { email: 'Office@Example.com', pendingJob, now: NOW });
    if (!started.ok) throw new Error('start failed');
    const finished = await finishSignIn(db, started.token, { now: NOW });
    if (!finished.ok) throw new Error('finish failed');
    expect(finished.job).toMatchObject({ ...pendingJob, accountId: finished.account.id, alertEmail: 'office@example.com' });
    expect(finished.next).toBe(`/jobs/${finished.job!.id}`);
    expect(await getJob(db, finished.job!.id, { accountId: finished.account.id })).not.toBeNull();
  });

  it('still signs in when the waiting job can no longer be saved', async () => {
    await db.query(
      `INSERT INTO login_tokens (token_hash, email, next_path, pending_job, expires_at, created_at)
       VALUES ($1, 'office@example.com', '/jobs', $2::jsonb, $3, $4)`,
      [hashToken('B'.repeat(43)), JSON.stringify({ ...pendingJob, state: 'OR' }), later(30), NOW],
    );
    const finished = await finishSignIn(db, 'B'.repeat(43), { now: NOW });
    expect(finished).toMatchObject({ ok: true, job: null, next: '/jobs' });
    if (finished.ok) expect(await listJobsForAccount(db, finished.account.id)).toEqual([]);
  });
});

describe('sessions', () => {
  it('resolves the session cookie to its account until it expires', async () => {
    const { sessionToken, account } = await signedIn();
    expect(sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await getSessionAccount(db, sessionToken, { now: later(60) })).toEqual(account);
    expect(await getSessionAccount(db, sessionToken, { now: later(SESSION_DAYS * 24 * 60 + 1) })).toBeNull();
  });

  it('stores only a hash of the session token', async () => {
    const { sessionToken } = await signedIn();
    const { rows } = await db.query<{ token_hash: string }>('SELECT token_hash FROM sessions');
    expect(rows).toEqual([{ token_hash: hashToken(sessionToken) }]);
  });

  it('ends a session on sign-out', async () => {
    const { sessionToken } = await signedIn();
    await endSession(db, sessionToken);
    expect(await getSessionAccount(db, sessionToken, { now: NOW })).toBeNull();
    await expect(endSession(db, 'garbage')).resolves.toBeUndefined();
  });

  it('ignores garbage cookies', async () => {
    expect(await getSessionAccount(db, '', { now: NOW })).toBeNull();
    expect(await getSessionAccount(db, "' OR 1=1 --", { now: NOW })).toBeNull();
    expect(await getSessionAccount(db, 'C'.repeat(43), { now: NOW })).toBeNull();
  });
});

describe('deleteAccount (the privacy policy promises self-serve deletion)', () => {
  const job = { ...pendingJob, counterparty: 'Acme Builders' };
  const count = async (sql: string, params: unknown[]) => (await db.query<{ n: number }>(sql, params)).rows[0].n;

  it('removes the account and everything it owns, and nothing of anyone else', async () => {
    const mine = await signedIn('office@example.com');
    const theirs = await signedIn('other@example.com');
    const owned = await createJob(db, { ...job, alertEmail: mine.account.email, accountId: mine.account.id });
    const othersJob = await createJob(db, { ...job, alertEmail: theirs.account.email, accountId: theirs.account.id });
    // M1-era jobs had no account; one still alerts this (now verified) address, in another case.
    const legacy = await createJob(db, { ...job, alertEmail: 'Office@Example.com' });
    const legacyOther = await createJob(db, { ...job, alertEmail: 'someone@example.com' });
    await db.query(
      `INSERT INTO alerts (job_id, deadline_key, deadline_date, threshold_days, to_email, subject, body)
       VALUES ($1, 'ca-preliminary-notice', '2026-03-21', 7, $2, 'Due soon', 'Serve the notice')`,
      [owned.id, mine.account.email],
    );
    // One proposal confirmed into a job (job_id is ON DELETE SET NULL inside the same cascade), one pending.
    const accepted = (await createProposal(db, { accountId: mine.account.id, source: 'paste', subject: '', fields: {} }))!;
    const confirmed = await confirmProposal(db, mine.account, accepted.id, {
      state: 'AZ',
      counterparty: 'Desert Ridge Builders',
      firstFurnishDate: '2026-03-02',
      lastFurnishDate: '',
    });
    expect(confirmed.ok).toBe(true);
    await createProposal(db, { accountId: mine.account.id, source: 'paste', subject: 'Fwd: PO 9', fields: {} });
    await createProposal(db, { accountId: theirs.account.id, source: 'paste', subject: 'Theirs', fields: {} });
    // An unused sign-in link for each address.
    await startSignIn(db, { email: 'office@example.com', now: NOW });
    await startSignIn(db, { email: 'other@example.com', now: NOW });

    expect(await deleteAccount(db, mine.account.id)).toBe(true);

    expect(await count('SELECT count(*)::int AS n FROM accounts WHERE id = $1', [mine.account.id])).toBe(0);
    expect(await listJobsForAccount(db, mine.account.id)).toEqual([]);
    expect(await getJob(db, owned.id)).toBeNull();
    expect(await getJob(db, legacy.id)).toBeNull();
    expect(await count('SELECT count(*)::int AS n FROM alerts WHERE to_email = $1', [mine.account.email])).toBe(0);
    expect(await count('SELECT count(*)::int AS n FROM intake_proposals WHERE account_id = $1', [mine.account.id])).toBe(0);
    expect(await count('SELECT count(*)::int AS n FROM sessions WHERE account_id = $1', [mine.account.id])).toBe(0);
    expect(await count('SELECT count(*)::int AS n FROM login_tokens WHERE email = $1', ['office@example.com'])).toBe(0);
    expect(await getSessionAccount(db, mine.sessionToken, { now: NOW })).toBeNull();
    expect(await accountByFeedToken(db, mine.account.feedToken)).toBeNull();
    expect(await accountByIntakeToken(db, mine.account.intakeToken)).toBeNull();

    expect(await getSessionAccount(db, theirs.sessionToken, { now: NOW })).toEqual(theirs.account);
    expect(await getJob(db, othersJob.id)).not.toBeNull();
    expect(await getJob(db, legacyOther.id)).not.toBeNull();
    expect(await listPendingProposals(db, theirs.account.id)).toHaveLength(1);
    expect(await count('SELECT count(*)::int AS n FROM login_tokens WHERE email = $1', ['other@example.com'])).toBeGreaterThan(0);
  });

  it('kills pending sign-in links, so an old email can’t bring the account back without a new opt-in', async () => {
    const { account } = await signedIn('office@example.com');
    const started = await startSignIn(db, { email: 'office@example.com', pendingJob, now: NOW });
    if (!started.ok) throw new Error(started.error);
    await deleteAccount(db, account.id);
    expect(await peekSignIn(db, started.token, { now: NOW })).toBeNull();
    expect(await finishSignIn(db, started.token, { now: NOW })).toEqual({ ok: false });
  });

  it('refuses while a Stripe subscription is still open: the guard is in the DELETE statement itself', async () => {
    // Deleting the account can't stop Stripe's charges. Checking the status in the same statement
    // that deletes means a checkout completing between the page's check and the delete still wins.
    const { account } = await signedIn('office@example.com');
    const job = await createJob(db, { ...pendingJob, alertEmail: account.email, accountId: account.id });
    const setStatus = (status: string | null) =>
      db.query('UPDATE accounts SET subscription_status = $2 WHERE id = $1', [account.id, status]);
    // Every Stripe status where the subscription still exists and can still charge (or resume charging).
    for (const status of ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused', 'some_future_status']) {
      await setStatus(status);
      expect(await deleteAccount(db, account.id), status).toBe('subscribed');
      expect(await getJob(db, job.id), status).not.toBeNull();
    }
    await setStatus('incomplete_expired');
    expect(await deleteAccount(db, account.id)).toBe(true);
    expect(await getJob(db, job.id)).toBeNull();
  });

  it('deletes an account whose subscription was canceled', async () => {
    const { account } = await signedIn('office@example.com');
    await db.query("UPDATE accounts SET subscription_status = 'canceled' WHERE id = $1", [account.id]);
    expect(await deleteAccount(db, account.id)).toBe(true);
    expect(await count('SELECT count(*)::int AS n FROM accounts WHERE id = $1', [account.id])).toBe(0);
  });

  it('returns false for an unknown or malformed id, and on a second call', async () => {
    const { account } = await signedIn('office@example.com');
    expect(await deleteAccount(db, '00000000-0000-4000-8000-000000000000')).toBe(false);
    expect(await deleteAccount(db, "' OR 1=1 --")).toBe(false);
    expect(await deleteAccount(db, account.id)).toBe(true);
    expect(await deleteAccount(db, account.id)).toBe(false);
  });
});

describe('deliverSignInLink', () => {
  const token = 'D'.repeat(43);

  it('builds links from the configured app URL, never from the request host', () => {
    expect(signInLink({ APP_URL: 'https://lienclock.example/' }, token)).toBe(`https://lienclock.example/signin?token=${token}`);
    expect(signInLink({ VERCEL_PROJECT_PRODUCTION_URL: 'lienclock.vercel.app' }, token)).toBe(
      `https://lienclock.vercel.app/signin?token=${token}`,
    );
  });

  it('sends through Resend when configured', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{"id":"email_1"}', { status: 200 });
    }) as unknown as typeof fetch;
    const result = await deliverSignInLink(
      { RESEND_API_KEY: resendKey, APP_URL: 'https://lienclock.example' },
      { to: 'office@example.com', token, savingJob: true },
      { fetch: fetchImpl, log: () => expect.unreachable() },
    );
    expect(result).toBe('sent');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe(`lienclock-signin-${hashToken(token).slice(0, 32)}`);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({ from: 'LienClock <onboarding@resend.dev>', to: ['office@example.com'] });
    expect(body.subject).toMatch(/confirm/i);
    expect(body.text).toContain(`https://lienclock.example/signin?token=${token}`);
    expect(body.text).toContain(`${SIGN_IN_LINK_MINUTES} minutes`);
  });

  it('prints the link to the local dev console when email is not configured', async () => {
    const lines: string[] = [];
    const result = await deliverSignInLink(
      { APP_URL: 'http://localhost:3000' },
      { to: 'office@example.com', token, savingJob: false },
      { fetch: (() => expect.unreachable()) as unknown as typeof fetch, log: (line) => lines.push(line) },
    );
    expect(result).toBe('logged');
    expect(lines).toEqual([expect.stringContaining(`http://localhost:3000/signin?token=${token}`)]);
  });

  it('fails on Vercel when email is not configured, instead of logging links', async () => {
    const lines: string[] = [];
    await expect(
      deliverSignInLink({ VERCEL: '1' }, { to: 'office@example.com', token, savingJob: false }, { log: (l) => lines.push(l) }),
    ).rejects.toThrow(/not configured/);
    expect(lines).toEqual([]);
  });

  it('surfaces Resend errors without the API key', async () => {
    const fetchImpl = (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
    const error = await deliverSignInLink(
      { RESEND_API_KEY: resendKey },
      { to: 'office@example.com', token, savingJob: false },
      { fetch: fetchImpl },
    ).catch((e: Error) => e);
    expect(String(error)).toMatch(/429/);
    expect(String(error)).not.toContain(resendKey);
  });
});
