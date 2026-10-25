// Pages and server actions, called the way Next.js calls them. `next/headers` cookies come from the
// in-memory jar in test/setup.ts, and getDb() is one embedded Postgres for this file.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as actions from '@/app/actions';
import IntakePage from '@/app/intake/[id]/page';
import JobPage from '@/app/jobs/[id]/page';
import JobsPage from '@/app/jobs/page';
import CalculatorPage from '@/app/page';
import SignInPage from '@/app/signin/page';
import { SESSION_COOKIE, finishSignIn, getSessionAccount, startSignIn, type Account } from '@/lib/auth';
import { getDb, type Db } from '@/lib/db';
import { createProposal, getProposal, listPendingProposals } from '@/lib/inbound';
import { createJob, getJob, listJobsForAccount, type StoredJob } from '@/lib/jobs';
import { cookieJar } from './helpers/cookies';

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  const ready = actual.createMemoryDb().then(async (db) => {
    await actual.ensureSchema(db);
    return db;
  });
  return { ...actual, getDb: () => ready };
});

let db: Db;
beforeAll(async () => {
  db = await getDb();
});
beforeEach(async () => {
  await db.exec('TRUNCATE alerts, jobs, accounts, login_tokens, sessions, intake_proposals RESTART IDENTITY CASCADE');
  vi.stubEnv('RESEND_API_KEY', '');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('APP_URL', 'https://lienclock.example');
  vi.stubEnv('INTAKE_EMAIL_DOMAIN', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const params = <T,>(value: T) => Promise.resolve(value);
const html = async (element: Promise<React.ReactElement> | React.ReactElement) => renderToStaticMarkup(await element);

async function signInAs(email: string): Promise<Account> {
  const started = await startSignIn(db, { email, now: new Date() });
  if (!started.ok) throw new Error(started.error);
  const finished = await finishSignIn(db, started.token, { now: new Date() });
  if (!finished.ok) throw new Error('finish failed');
  cookieJar.set(SESSION_COOKIE, { value: finished.sessionToken, options: {} });
  return finished.account;
}

function jobFor(account: Account, overrides: Partial<StoredJob> = {}) {
  return createJob(db, {
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
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
}

/** The URL a server action or page redirected to (Next throws to redirect). */
async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest;
    if (typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT;')) return digest.split(';').slice(2, -2).join(';');
    throw error;
  }
  throw new Error('expected a redirect');
}

async function isNotFound(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (error) {
    if ((error as { digest?: unknown }).digest === 'NEXT_HTTP_ERROR_FALLBACK;404') return true;
    throw error;
  }
}

function captureDevLinks(): () => string[] {
  const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
  return () =>
    spy.mock.calls.map((call) => /token=([A-Za-z0-9_-]{43})/.exec(String(call[0]))?.[1]).filter((t): t is string => Boolean(t));
}

describe('calculator page', () => {
  it('asks a signed-out visitor for an email and explains the confirmation link', async () => {
    const page = await html(CalculatorPage({ searchParams: params({}) }));
    expect(page).toContain('name="alertEmail"');
    expect(page).toContain('Save &amp; email me alerts');
    expect(page).toMatch(/link to confirm/);
  });

  it('saves straight to the signed-in account, without asking for an email', async () => {
    await signInAs('office@example.com');
    const page = await html(CalculatorPage({ searchParams: params({}) }));
    expect(page).not.toContain('name="alertEmail"');
    expect(page).toContain('Alerts go to <strong>office@example.com</strong>');
    expect(page).toContain('Save &amp; email me alerts');
  });
});

describe('sign-in page', () => {
  it('shows the email form with a sanitized next path', async () => {
    const page = await html(SignInPage({ searchParams: params({ next: '//evil.example' }) }));
    expect(page).toContain('name="email"');
    expect(page).toContain('name="next" value="/jobs"');
    expect(page).not.toContain('evil.example');
  });

  it('renders a button for a link instead of signing in on GET (link scanners must not use it up)', async () => {
    const started = await startSignIn(db, { email: 'office@example.com', now: new Date() });
    if (!started.ok) throw new Error(started.error);
    const page = await html(SignInPage({ searchParams: params({ token: started.token }) }));
    expect(page).toContain(`name="token" value="${started.token}"`);
    expect(page).toContain('Sign in to LienClock');
    expect((await finishSignIn(db, started.token, { now: new Date() })).ok).toBe(true);
  });

  it('says which address the link signs in to, and which job it saves (no silent sign-in to someone else’s account)', async () => {
    const started = await startSignIn(db, {
      email: 'office@example.com',
      pendingJob: { state: 'AZ', role: 'sub', projectType: 'commercial', counterparty: 'Desert Ridge', firstFurnishDate: '2026-03-02', lastFurnishDate: null },
      now: new Date(),
    });
    if (!started.ok) throw new Error(started.error);
    const page = await html(SignInPage({ searchParams: params({ token: started.token }) }));
    expect(page).toContain('Sign in as <strong>office@example.com</strong>');
    expect(page).toContain('save your Arizona job for <strong>Desert Ridge</strong>');
  });

  it('shows "expired" instead of a button for a used link', async () => {
    const started = await startSignIn(db, { email: 'office@example.com', now: new Date() });
    if (!started.ok) throw new Error(started.error);
    await finishSignIn(db, started.token, { now: new Date() });
    const page = await html(SignInPage({ searchParams: params({ token: started.token }) }));
    expect(page).toMatch(/expired or was already used/);
    expect(page).not.toContain('name="token"');
  });

  it('does not reflect a malformed token', async () => {
    const page = await html(SignInPage({ searchParams: params({ token: '"><script>x</script>' }) }));
    expect(page).not.toContain('<script>x');
    expect(page).toMatch(/expired or was already used/);
  });

  it('shows the check-your-email and error states', async () => {
    expect(await html(SignInPage({ searchParams: params({ sent: 'job' }) }))).toMatch(/Check your email[\s\S]*saved when you click/);
    expect(await html(SignInPage({ searchParams: params({ error: 'rate' }) }))).toMatch(/Too many sign-in emails/);
    expect(await html(SignInPage({ searchParams: params({ error: 'unavailable' }) }))).toMatch(/not available/);
  });
});

describe('dashboard', () => {
  it('sends signed-out visitors to sign in and back', async () => {
    expect(await redirectOf(() => JobsPage({ searchParams: params({}) }))).toBe('/signin?next=%2Fjobs');
  });

  it('lists only the account’s jobs, the calendar link, pending proposals and the intake box', async () => {
    const me = await signInAs('office@example.com');
    const stranger = await signInAs('stranger@example.com');
    await jobFor(stranger, { counterparty: 'Not Mine GC' });
    cookieJar.clear();
    await signInAs('office@example.com');
    await jobFor(me, { counterparty: 'Mine GC' });
    await jobFor(me, { state: 'TX', counterparty: 'Also Mine GC', firstFurnishDate: '2026-01-05' });
    await createProposal(db, { accountId: me.id, source: 'email', subject: 'Fwd: PO 77', fields: {} });
    vi.stubEnv('INTAKE_EMAIL_DOMAIN', 'in.lienclock.example');

    const page = await html(JobsPage({ searchParams: params({}) }));
    expect(page).toContain('Mine GC');
    expect(page).toContain('Also Mine GC');
    expect(page).not.toContain('Not Mine GC');
    expect(page).toContain(`webcal://lienclock.example/calendar/${me.feedToken}.ics`);
    expect(page).toContain(`https://lienclock.example/calendar/${me.feedToken}.ics`);
    expect(page).toContain('Fwd: PO 77');
    expect(page).toContain(`${me.intakeToken}@in.lienclock.example`);
    expect(page).toContain('name="emailText"');
    expect(page).toContain('office@example.com');
  });

  it('works without an intake address and with no jobs', async () => {
    await signInAs('office@example.com');
    const page = await html(JobsPage({ searchParams: params({ deleted: '1' }) }));
    expect(page).toMatch(/No jobs yet/);
    expect(page).toMatch(/Job deleted/);
    expect(page).toContain('name="emailText"');
    expect(page).not.toContain('@in.lienclock.example');
  });
});

describe('job page', () => {
  it('shows the owner’s job and hides it from everyone else', async () => {
    const owner = await signInAs('owner@example.com');
    const job = await jobFor(owner);
    const page = await html(JobPage({ params: params({ id: job.id }), searchParams: params({}) }));
    expect(page).toContain('2026-03-21');
    expect(page).toContain('href="/jobs"');

    cookieJar.clear();
    expect(await redirectOf(() => JobPage({ params: params({ id: job.id }), searchParams: params({}) }))).toBe(
      `/signin?next=${encodeURIComponent(`/jobs/${job.id}`)}`,
    );
    await signInAs('intruder@example.com');
    expect(await isNotFound(() => JobPage({ params: params({ id: job.id }), searchParams: params({}) }))).toBe(true);
  });
});

describe('intake review page', () => {
  it('flags every proposed field "Unconfirmed" with its source, and says what was not found', async () => {
    const me = await signInAs('office@example.com');
    const proposal = (await createProposal(db, {
      accountId: me.id,
      source: 'email',
      subject: 'Fwd: PO 2026-0412',
      fromEmail: 'Jordan Reyes <jreyes@desertridgebuilders.example>',
      fields: {
        state: { value: 'AZ', status: 'unconfirmed', source: 'Tempe, AZ 85281' },
        firstFurnishDate: { value: '2026-03-02', status: 'unconfirmed', source: 'Start Date: March 2, 2026' },
      },
    }))!;
    const page = await html(IntakePage({ params: params({ id: proposal.id }), searchParams: params({}) }));
    expect(page.match(/>Unconfirmed</g)).toHaveLength(2);
    expect(page).toContain('Tempe, AZ 85281');
    expect(page).toContain('Start Date: March 2, 2026');
    expect(page).toMatch(/Not found in the email/);
    expect(page).toContain('value="2026-03-02"');
    expect(page).toContain('<option value="AZ" selected="">');
    expect(page).toContain('Confirm &amp; save job');
  });

  it('warns about a state LienClock does not cover yet', async () => {
    const me = await signInAs('office@example.com');
    const proposal = (await createProposal(db, {
      accountId: me.id,
      source: 'paste',
      subject: '',
      fields: { state: { value: 'OR', status: 'unconfirmed', source: 'Portland, OR 97201' } },
    }))!;
    const page = await html(IntakePage({ params: params({ id: proposal.id }), searchParams: params({}) }));
    expect(page).toMatch(/doesn’t cover Oregon yet/);
  });

  it('is not found for another account', async () => {
    const me = await signInAs('office@example.com');
    const proposal = (await createProposal(db, { accountId: me.id, source: 'paste', subject: '', fields: {} }))!;
    cookieJar.clear();
    await signInAs('intruder@example.com');
    expect(await isNotFound(() => IntakePage({ params: params({ id: proposal.id }), searchParams: params({}) }))).toBe(true);
  });
});

describe('saving a job', () => {
  const fields = { state: 'CA', counterparty: 'Acme Builders', firstFurnishDate: '2026-03-01', lastFurnishDate: '' };

  it('signed out: emails a confirmation link and saves the job only when it is used', async () => {
    const links = captureDevLinks();
    expect(await redirectOf(() => actions.saveJob(form({ ...fields, alertEmail: 'Office@Example.com' })))).toBe('/signin?sent=job');
    const { rows } = await db.query('SELECT count(*)::int AS n FROM jobs');
    expect(rows[0]).toEqual({ n: 0 });
    const [token] = links();
    expect(token).toBeDefined();

    const target = await redirectOf(() => actions.finishSignInAction(form({ token })));
    const cookie = cookieJar.get(SESSION_COOKIE)!;
    expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: 30 * 24 * 60 * 60 });
    const account = (await getSessionAccount(db, cookie.value, { now: new Date() }))!;
    expect(account.email).toBe('office@example.com');
    const [job] = await listJobsForAccount(db, account.id);
    expect(job).toMatchObject({ state: 'CA', counterparty: 'Acme Builders', alertEmail: 'office@example.com' });
    expect(target).toBe(`/jobs/${job.id}`);
  });

  it('signed in: saves to the account and alerts the verified address, whatever email is posted', async () => {
    const me = await signInAs('office@example.com');
    const target = await redirectOf(() => actions.saveJob(form({ ...fields, alertEmail: 'victim@example.com' })));
    const [job] = await listJobsForAccount(db, me.id);
    expect(target).toBe(`/jobs/${job.id}`);
    expect(job.alertEmail).toBe('office@example.com');
  });

  it('sends invalid input back to the calculator', async () => {
    expect(await redirectOf(() => actions.saveJob(form({ ...fields, state: 'OR', alertEmail: 'nope' })))).toBe(
      '/?state=OR&counterparty=Acme+Builders&firstFurnishDate=2026-03-01&emailError=1',
    );
  });
});

describe('sign-in actions', () => {
  it('emails a link and keeps the next path', async () => {
    const links = captureDevLinks();
    expect(await redirectOf(() => actions.requestSignInAction(form({ email: 'office@example.com', next: '/jobs/abc' })))).toBe(
      '/signin?sent=1',
    );
    const [token] = links();
    expect(await redirectOf(() => actions.finishSignInAction(form({ token })))).toBe('/jobs/abc');
  });

  it('reports rate limits, bad emails and missing email configuration', async () => {
    captureDevLinks();
    for (let i = 0; i < 3; i++) await redirectOf(() => actions.requestSignInAction(form({ email: 'office@example.com' })));
    expect(await redirectOf(() => actions.requestSignInAction(form({ email: 'office@example.com' })))).toBe('/signin?error=rate');
    expect(await redirectOf(() => actions.requestSignInAction(form({ email: 'nope' })))).toBe('/signin?error=email');
    vi.stubEnv('VERCEL', '1');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await redirectOf(() => actions.requestSignInAction(form({ email: 'new@example.com' })))).toBe('/signin?error=unavailable');
  });

  it('refuses a bad or used link without setting a cookie', async () => {
    expect(await redirectOf(() => actions.finishSignInAction(form({ token: 'A'.repeat(43) })))).toBe('/signin?error=expired');
    expect(cookieJar.has(SESSION_COOKIE)).toBe(false);
  });

  it('signs out: the session ends and the cookie is cleared', async () => {
    await signInAs('office@example.com');
    const token = cookieJar.get(SESSION_COOKIE)!.value;
    expect(await redirectOf(() => actions.signOutAction())).toBe('/');
    expect(cookieJar.has(SESSION_COOKIE)).toBe(false);
    expect(await getSessionAccount(db, token, { now: new Date() })).toBeNull();
  });
});

describe('job actions check ownership', () => {
  it('sends signed-out requests to sign in', async () => {
    const owner = await signInAs('owner@example.com');
    const job = await jobFor(owner);
    cookieJar.clear();
    expect(await redirectOf(() => actions.deleteJobAction(form({ jobId: job.id })))).toMatch(/^\/signin\?next=/);
    expect(await getJob(db, job.id)).not.toBeNull();
  });

  it('refuses to change another account’s job', async () => {
    const owner = await signInAs('owner@example.com');
    const job = await jobFor(owner);
    cookieJar.clear();
    await signInAs('intruder@example.com');
    expect(await redirectOf(() => actions.markDoneAction(form({ jobId: job.id, key: 'ca-preliminary-notice', doneDate: '2026-03-10' })))).toBe('/jobs');
    expect(await redirectOf(() => actions.updateLastFurnishAction(form({ jobId: job.id, lastFurnishDate: '2026-05-01' })))).toBe('/jobs');
    expect(await redirectOf(() => actions.deleteJobAction(form({ jobId: job.id })))).toBe('/jobs');
    expect(await getJob(db, job.id)).toEqual(job);
  });

  it('lets the owner update, mark done and delete', async () => {
    const owner = await signInAs('owner@example.com');
    const job = await jobFor(owner);
    expect(await redirectOf(() => actions.updateLastFurnishAction(form({ jobId: job.id, lastFurnishDate: '2026-05-01' })))).toBe(`/jobs/${job.id}`);
    expect(await redirectOf(() => actions.markDoneAction(form({ jobId: job.id, key: 'ca-preliminary-notice', doneDate: '2026-03-10' })))).toBe(`/jobs/${job.id}`);
    expect(await getJob(db, job.id)).toMatchObject({ lastFurnishDate: '2026-05-01', done: { 'ca-preliminary-notice': '2026-03-10' } });
    expect(await redirectOf(() => actions.deleteJobAction(form({ jobId: job.id })))).toBe('/jobs?deleted=1');
    expect(await getJob(db, job.id)).toBeNull();
  });
});

describe('calendar and intake actions', () => {
  it('resets the calendar link', async () => {
    const me = await signInAs('office@example.com');
    expect(await redirectOf(() => actions.rotateFeedAction())).toBe('/jobs#calendar');
    const after = (await getSessionAccount(db, cookieJar.get(SESSION_COOKIE)!.value, { now: new Date() }))!;
    expect(after.feedToken).not.toBe(me.feedToken);
  });

  it('turns a pasted email into a proposal to review', async () => {
    const me = await signInAs('office@example.com');
    const target = await redirectOf(() =>
      actions.pasteIntakeAction(form({ emailText: 'Job Site: 500 S Mill Ave, Tempe, AZ 85281\nStart Date: March 2, 2026' })),
    );
    const [proposal] = await listPendingProposals(db, me.id);
    expect(target).toBe(`/intake/${proposal.id}`);
    expect(proposal).toMatchObject({ source: 'paste', fields: { state: { value: 'AZ', status: 'unconfirmed' } } });
  });

  it('confirms a proposal into a job, or sends invalid values back to the review page', async () => {
    const me = await signInAs('office@example.com');
    const proposal = (await createProposal(db, { accountId: me.id, source: 'paste', subject: '', fields: {} }))!;
    const invalid = await redirectOf(() =>
      actions.confirmProposalAction(form({ proposalId: proposal.id, state: 'AZ', counterparty: '', firstFurnishDate: '2026-03-02', lastFurnishDate: '' })),
    );
    expect(invalid).toBe(`/intake/${proposal.id}?invalid=1&state=AZ&firstFurnishDate=2026-03-02`);
    const review = await html(IntakePage({ params: params({ id: proposal.id }), searchParams: params({ invalid: '1', state: 'AZ', firstFurnishDate: '2026-03-02' }) }));
    expect(review).toContain('Enter the GC or owner you are working for.');

    const target = await redirectOf(() =>
      actions.confirmProposalAction(
        form({ proposalId: proposal.id, state: 'AZ', counterparty: 'Desert Ridge Builders', firstFurnishDate: '2026-03-02', lastFurnishDate: '' }),
      ),
    );
    const [job] = await listJobsForAccount(db, me.id);
    expect(target).toBe(`/jobs/${job.id}`);
    expect((await getProposal(db, me.id, proposal.id))!.status).toBe('accepted');
  });

  it('discards a proposal', async () => {
    const me = await signInAs('office@example.com');
    const proposal = (await createProposal(db, { accountId: me.id, source: 'paste', subject: '', fields: {} }))!;
    expect(await redirectOf(() => actions.discardProposalAction(form({ proposalId: proposal.id })))).toBe('/jobs');
    expect(await listPendingProposals(db, me.id)).toEqual([]);
  });
});
