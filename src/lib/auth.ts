// Passwordless accounts: an emailed single-use link proves the address, then a session cookie.
//
//   email form, or "Save & email me alerts" ─▶ startSignIn: rate limit → login_tokens(sha256, 30 min, job?)
//        └─▶ deliverSignInLink: email with /signin?token=… (the GET only renders a button, so
//            mail scanners that pre-fetch links can't use it up)
//   the button (server action) ─▶ finishSignIn: consume the token atomically → find-or-create the
//        account → save the job that was waiting, if any → session (sha256, 30 days) → cookie
//
// Raw tokens exist only in the email and the cookie; the database keeps their SHA-256.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resendSender } from './alerts';
import { DEFAULT_FROM, appUrlFrom, type CronEnv } from './cron';
import type { Db } from './db';
import type { JobInput } from './deadlines';
import { parseEmail } from './jobInput';
import { createJob, isJobId as isUuid, type StoredJob } from './jobs';

export const SESSION_COOKIE = 'lc_session';
export const SESSION_DAYS = 30;
export const SIGN_IN_LINK_MINUTES = 30;
/** Links per address per link lifetime: stops anyone flooding a victim's inbox. */
export const MAX_SIGN_IN_EMAILS_PER_ADDRESS = 3;
/** Links per hour for the whole app: keeps Resend's 100/day free quota for deadline alerts. */
export const MAX_SIGN_IN_EMAILS_PER_HOUR = 60;

const MINUTE = 60_000;
const SECRET_TOKEN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
const INTAKE_TOKEN = /^po-[0-9a-f]{32}$/;

export interface Account {
  id: string;
  email: string;
  /** Secret path segment of the account's calendar feed. */
  feedToken: string;
  /** Local part of the account's email-forward address. */
  intakeToken: string;
}

/** The job fields held in a sign-in link until the address is confirmed. */
export type PendingJob = Pick<JobInput, 'state' | 'role' | 'projectType' | 'counterparty' | 'firstFurnishDate'> & {
  lastFurnishDate: string | null;
};

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const newSecretToken = () => randomBytes(32).toString('base64url');
const newIntakeToken = () => `po-${randomBytes(16).toString('hex')}`;
const isSecretToken = (value: unknown): value is string => typeof value === 'string' && SECRET_TOKEN.test(value);

/** A same-site path to return to after signing in; anything else (other hosts, odd characters) → fallback. */
export function safeNextPath(raw: unknown, fallback = '/jobs'): string {
  if (typeof raw !== 'string' || raw.length > 2000) return fallback;
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\\\s\p{Cc}]/u.test(raw)) return fallback;
  return raw;
}

const ACCOUNT_COLUMNS = 'id::text AS id, email, feed_token, intake_token';

interface AccountRow {
  id: string;
  email: string;
  feed_token: string;
  intake_token: string;
}

const fromRow = (row: AccountRow): Account => ({
  id: row.id,
  email: row.email,
  feedToken: row.feed_token,
  intakeToken: row.intake_token,
});

/** One account per (lowercased) email. Safe under concurrency: the UNIQUE index decides. */
export async function findOrCreateAccount(db: Db, rawEmail: string): Promise<Account> {
  const email = parseEmail(rawEmail);
  if (!email) throw new Error('Invalid email address');
  const { rows } = await db.query<AccountRow>(
    `INSERT INTO accounts (id, email, feed_token, intake_token) VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET email = accounts.email
     RETURNING ${ACCOUNT_COLUMNS}`,
    [randomUUID(), email, newSecretToken(), newIntakeToken()],
  );
  return fromRow(rows[0]);
}

export async function accountByFeedToken(db: Db, token: string): Promise<Account | null> {
  if (!isSecretToken(token)) return null;
  const { rows } = await db.query<AccountRow>(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE feed_token = $1`, [token]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function accountByIntakeToken(db: Db, token: string): Promise<Account | null> {
  const normalized = token.toLowerCase();
  if (!INTAKE_TOKEN.test(normalized)) return null;
  const { rows } = await db.query<AccountRow>(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE intake_token = $1`, [normalized]);
  return rows[0] ? fromRow(rows[0]) : null;
}

/** Replaces the calendar feed token: the old feed URL stops working at once. */
export async function rotateFeedToken(db: Db, accountId: string): Promise<Account | null> {
  if (!isUuid(accountId)) return null;
  const { rows } = await db.query<AccountRow>(
    `UPDATE accounts SET feed_token = $2 WHERE id = $1 RETURNING ${ACCOUNT_COLUMNS}`,
    [accountId, newSecretToken()],
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

export type StartSignIn = { ok: true; token: string; email: string } | { ok: false; error: 'invalid_email' | 'rate_limited' };

export async function startSignIn(
  db: Db,
  input: { email: string; next?: string; pendingJob?: PendingJob | null; now: Date },
): Promise<StartSignIn> {
  const email = parseEmail(input.email);
  if (!email) return { ok: false, error: 'invalid_email' };
  const { now } = input;
  const token = newSecretToken();
  // Housekeeping: links older than a day are past any use, including rate limiting.
  await db.query('DELETE FROM login_tokens WHERE created_at < $1', [new Date(now.getTime() - 24 * 60 * MINUTE)]);
  // One statement: the rate-limit counts and the insert can't be split by another request's insert
  // (concurrent requests can still overshoot by the number in flight, which is bounded).
  const { rows } = await db.query(
    `INSERT INTO login_tokens (token_hash, email, next_path, pending_job, expires_at, created_at)
     SELECT $1::text, $2::text, $3::text, $4::jsonb, $5::timestamptz, $6::timestamptz
      WHERE (SELECT count(*) FROM login_tokens WHERE email = $2 AND created_at > $7) < $8
        AND (SELECT count(*) FROM login_tokens WHERE created_at > $9) < $10
     RETURNING token_hash`,
    [
      hashToken(token),
      email,
      safeNextPath(input.next),
      input.pendingJob ? JSON.stringify(pendingJobFrom(input.pendingJob)) : null,
      new Date(now.getTime() + SIGN_IN_LINK_MINUTES * MINUTE),
      now,
      new Date(now.getTime() - SIGN_IN_LINK_MINUTES * MINUTE),
      MAX_SIGN_IN_EMAILS_PER_ADDRESS,
      new Date(now.getTime() - 60 * MINUTE),
      MAX_SIGN_IN_EMAILS_PER_HOUR,
    ],
  );
  if (rows.length === 0) return { ok: false, error: 'rate_limited' };
  return { ok: true, token, email };
}

function pendingJobFrom(raw: unknown): PendingJob | null {
  const j = raw as Record<string, unknown> | null;
  if (!j || typeof j !== 'object') return null;
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    state: text(j.state) as PendingJob['state'],
    role: text(j.role) as PendingJob['role'],
    projectType: text(j.projectType) as PendingJob['projectType'],
    counterparty: text(j.counterparty),
    firstFurnishDate: text(j.firstFurnishDate),
    lastFurnishDate: typeof j.lastFurnishDate === 'string' && j.lastFurnishDate ? j.lastFurnishDate : null,
  };
}

/**
 * What a link would do, without using it up: the confirmation page shows the address (and the job
 * it saves), so nobody can be signed in to someone else's account by a link they were sent.
 */
export async function peekSignIn(
  db: Db,
  token: string,
  opts: { now: Date },
): Promise<{ email: string; pendingJob: PendingJob | null } | null> {
  if (!isSecretToken(token)) return null;
  const { rows } = await db.query<{ email: string; pending_job: unknown }>(
    'SELECT email, pending_job FROM login_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2',
    [hashToken(token), opts.now],
  );
  return rows[0] ? { email: rows[0].email, pendingJob: pendingJobFrom(rows[0].pending_job) } : null;
}

export type FinishSignIn =
  | { ok: true; account: Account; sessionToken: string; next: string; job: StoredJob | null }
  | { ok: false };

export async function finishSignIn(db: Db, token: string, opts: { now: Date }): Promise<FinishSignIn> {
  if (!isSecretToken(token)) return { ok: false };
  // Single use: only one concurrent caller can flip used_at from NULL.
  const { rows } = await db.query<{ email: string; next_path: string; pending_job: unknown }>(
    `UPDATE login_tokens SET used_at = $2
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2
      RETURNING email, next_path, pending_job`,
    [hashToken(token), opts.now],
  );
  if (!rows[0]) return { ok: false };
  const account = await findOrCreateAccount(db, rows[0].email);
  let next = safeNextPath(rows[0].next_path);
  let job: StoredJob | null = null;
  const pending = pendingJobFrom(rows[0].pending_job);
  if (pending) {
    try {
      job = await createJob(db, { ...pending, alertEmail: account.email, accountId: account.id });
      next = `/jobs/${job.id}`;
    } catch (error) {
      // Signing in still works; the user can enter the job again.
      console.error('auth: could not save the pending job:', error instanceof Error ? error.message : error);
    }
  }
  const sessionToken = await createSession(db, account.id, opts.now);
  return { ok: true, account, sessionToken, next, job };
}

async function createSession(db: Db, accountId: string, now: Date): Promise<string> {
  const token = newSecretToken();
  await db.query('DELETE FROM sessions WHERE account_id = $1 AND expires_at <= $2', [accountId, now]);
  await db.query('INSERT INTO sessions (token_hash, account_id, expires_at, created_at) VALUES ($1, $2, $3, $4)', [
    hashToken(token),
    accountId,
    new Date(now.getTime() + SESSION_DAYS * 24 * 60 * MINUTE),
    now,
  ]);
  return token;
}

export async function getSessionAccount(db: Db, token: string, opts: { now: Date }): Promise<Account | null> {
  if (!isSecretToken(token)) return null;
  const { rows } = await db.query<AccountRow>(
    `SELECT a.id::text AS id, a.email, a.feed_token, a.intake_token
       FROM sessions s JOIN accounts a ON a.id = s.account_id
      WHERE s.token_hash = $1 AND s.expires_at > $2`,
    [hashToken(token), opts.now],
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function endSession(db: Db, token: string): Promise<void> {
  if (!isSecretToken(token)) return;
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

/** Built from the configured app URL, never the request's Host header (which an attacker controls). */
export function signInLink(env: CronEnv, token: string): string {
  return `${appUrlFrom(env)}/signin?token=${token}`;
}

function signInEmail(link: string, savingJob: boolean): { subject: string; text: string } {
  const subject = savingJob ? 'Confirm your email to save your LienClock job' : 'Your LienClock sign-in link';
  const text = [
    savingJob
      ? 'Click the link below to confirm your email. Your job is saved and deadline alerts start as soon as you do.'
      : 'Click the link below to sign in to LienClock.',
    '',
    link,
    '',
    `The link works once and expires in ${SIGN_IN_LINK_MINUTES} minutes. If you didn't ask for it, ignore this email: nothing happens without a click.`,
  ].join('\n');
  return { subject, text };
}

/**
 * Emails the sign-in link through Resend. Without RESEND_API_KEY, local dev prints the link to the
 * server console instead; on Vercel that would hide links in logs, so it fails instead.
 */
export async function deliverSignInLink(
  env: CronEnv,
  message: { to: string; token: string; savingJob: boolean },
  deps: { fetch?: typeof fetch; log?: (line: string) => void } = {},
): Promise<'sent' | 'logged'> {
  const link = signInLink(env, message.token);
  if (env.RESEND_API_KEY) {
    const { subject, text } = signInEmail(link, message.savingJob);
    await resendSender({ apiKey: env.RESEND_API_KEY, from: env.ALERT_FROM_EMAIL || DEFAULT_FROM, fetch: deps.fetch }).send({
      to: message.to,
      subject,
      text,
      idempotencyKey: `lienclock-signin-${hashToken(message.token).slice(0, 32)}`,
    });
    return 'sent';
  }
  if (env.VERCEL) throw new Error('Email sign-in is not configured: RESEND_API_KEY is missing.');
  (deps.log ?? console.info)(`[dev] RESEND_API_KEY is not set, so here is the sign-in link for ${message.to}: ${link}`);
  return 'logged';
}
