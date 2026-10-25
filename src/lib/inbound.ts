// Email-forward intake: Resend Inbound → signed webhook → fetch the body → proposed job fields.
//
//   user forwards a PO to po-<intake token>@<INTAKE_EMAIL_DOMAIN> (Resend's free <id>.resend.app)
//     └─▶ Resend ─POST /api/intake/email (Svix-signed; metadata only, no body)
//           └─▶ verify signature (5 min window) → account by recipient token (unknown → 200, dropped)
//               → already stored this email id? (Resend retries) → GET api.resend.com/emails/receiving/<id>
//               → proposeJobFromEmail → intake_proposals (pending)
//   /intake/<id>: every field "unconfirmed" → user confirms → parseJobForm → claim → createJob
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { accountByIntakeToken, type Account } from './auth';
import type { CronEnv } from './cron';
import type { Db } from './db';
import { INTAKE_FIELDS, proposeJobFromEmail, type ProposedFields } from './intake';
import { parseJobForm, type JobForm } from './jobInput';
import { createJob, isJobId, type StoredJob } from './jobs';

export interface IntakeEnv extends CronEnv {
  RESEND_WEBHOOK_SECRET?: string;
  INTAKE_EMAIL_DOMAIN?: string;
}

/** Unreviewed proposals per account; beyond this, forwarded mail is dropped (a leaked address can't flood). */
export const MAX_PENDING_PROPOSALS = 50;
/** The webhook carries metadata only; anything larger isn't from Resend. */
const MAX_WEBHOOK_BYTES = 256 * 1024;
const MAX_BODY_CHARS = 200_000;
const SIGNATURE_TOLERANCE_S = 5 * 60;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL_ID = /^[A-Za-z0-9-]{1,100}$/;

// ── Webhook signatures (Svix) ──────────────────────────────────────────────────────────────────

/**
 * Svix: HMAC-SHA256 over "<svix-id>.<svix-timestamp>.<raw body>" with the base64 key after "whsec_".
 * The header may list several "v1,<base64>" signatures (secret rotation); any one may match.
 */
export function verifySvixSignature(body: string, headers: Headers, secret: string, now: Date): boolean {
  const id = headers.get('svix-id');
  const timestamp = headers.get('svix-timestamp');
  const signatures = headers.get('svix-signature');
  if (!id || !timestamp || !signatures || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_S) return false;
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret, 'base64');
  if (key.length === 0) return false;
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
  return signatures.split(' ').some((entry) => {
    const [version, signature] = entry.split(',', 2);
    if (version !== 'v1' || !signature) return false;
    const actual = Buffer.from(signature, 'base64');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

// ── Intake addresses ───────────────────────────────────────────────────────────────────────────

function intakeDomain(env: IntakeEnv): string | null {
  const domain = env.INTAKE_EMAIL_DOMAIN?.trim().toLowerCase();
  return domain && DOMAIN.test(domain) ? domain : null;
}

/** The account's forwarding address, or null until a receiving domain is configured. */
export function intakeAddressFor(account: Pick<Account, 'intakeToken'>, env: IntakeEnv): string | null {
  const domain = intakeDomain(env);
  return domain ? `${account.intakeToken}@${domain}` : null;
}

/** The intake token in the first recipient that is one of our addresses. */
export function intakeTokenFrom(recipients: unknown[], domain?: string | null): string | null {
  for (const recipient of recipients) {
    if (typeof recipient !== 'string') continue;
    const address = (/<([^<>]+)>/.exec(recipient)?.[1] ?? recipient).trim().toLowerCase();
    const at = address.lastIndexOf('@');
    if (at < 1) continue;
    const local = address.slice(0, at);
    if (domain && address.slice(at + 1) !== domain) continue;
    if (/^po-[0-9a-f]{32}$/.test(local)) return local;
  }
  return null;
}

// ── Proposals repository ───────────────────────────────────────────────────────────────────────

export type ProposalSource = 'email' | 'paste';
export type ProposalStatus = 'pending' | 'accepted' | 'discarded';

export interface StoredProposal {
  id: string;
  accountId: string;
  source: ProposalSource;
  fromEmail: string | null;
  subject: string;
  fields: ProposedFields;
  status: ProposalStatus;
  jobId: string | null;
  createdAt: string;
}

const COLUMNS = `id::text AS id, account_id::text AS account_id, source, from_email, subject, fields, status,
  job_id::text AS job_id, created_at::text AS created_at`;

interface ProposalRow {
  id: string;
  account_id: string;
  source: ProposalSource;
  from_email: string | null;
  subject: string;
  fields: unknown;
  status: ProposalStatus;
  job_id: string | null;
  created_at: string;
}

/** Keeps only well-formed known fields, so a bad row can't reach the review form. */
function cleanFields(raw: unknown): ProposedFields {
  const fields: ProposedFields = {};
  const source = (raw ?? {}) as Record<string, unknown>;
  for (const name of INTAKE_FIELDS) {
    const f = source[name] as Record<string, unknown> | undefined;
    if (f && typeof f.value === 'string' && typeof f.source === 'string') {
      fields[name] = { value: f.value, status: 'unconfirmed', source: f.source };
    }
  }
  return fields;
}

const fromRow = (row: ProposalRow): StoredProposal => ({
  id: row.id,
  accountId: row.account_id,
  source: row.source,
  fromEmail: row.from_email,
  subject: row.subject,
  fields: cleanFields(row.fields),
  status: row.status,
  jobId: row.job_id,
  createdAt: row.created_at,
});

const oneLine = (value: string | null | undefined, max: number) =>
  (value ?? '').replace(/[\p{Cc}\s]+/gu, ' ').trim().slice(0, max);

/** Null when the account already has MAX_PENDING_PROPOSALS waiting, or this email id is already stored. */
export async function createProposal(
  db: Db,
  input: {
    accountId: string;
    source: ProposalSource;
    externalId?: string | null;
    fromEmail?: string | null;
    subject: string;
    fields: ProposedFields;
  },
): Promise<StoredProposal | null> {
  const { rows } = await db.query<ProposalRow>(
    `INSERT INTO intake_proposals (id, account_id, source, external_id, from_email, subject, fields)
     SELECT $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text, $7::jsonb
      WHERE (SELECT count(*) FROM intake_proposals WHERE account_id = $2::uuid AND status = 'pending') < $8
     ON CONFLICT (account_id, external_id) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      randomUUID(),
      input.accountId,
      input.source,
      input.externalId ?? null,
      oneLine(input.fromEmail, 254) || null,
      oneLine(input.subject, 300),
      JSON.stringify(cleanFields(input.fields)),
      MAX_PENDING_PROPOSALS,
    ],
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function getProposal(db: Db, accountId: string, id: string): Promise<StoredProposal | null> {
  if (!isJobId(id) || !isJobId(accountId)) return null;
  const { rows } = await db.query<ProposalRow>(`SELECT ${COLUMNS} FROM intake_proposals WHERE id = $1 AND account_id = $2`, [
    id,
    accountId,
  ]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function listPendingProposals(db: Db, accountId: string): Promise<StoredProposal[]> {
  if (!isJobId(accountId)) return [];
  const { rows } = await db.query<ProposalRow>(
    `SELECT ${COLUMNS} FROM intake_proposals WHERE account_id = $1 AND status = 'pending' ORDER BY created_at DESC, id`,
    [accountId],
  );
  return rows.map(fromRow);
}

export async function discardProposal(db: Db, accountId: string, id: string): Promise<boolean> {
  if (!isJobId(id) || !isJobId(accountId)) return false;
  const { rows } = await db.query(
    `UPDATE intake_proposals SET status = 'discarded' WHERE id = $1 AND account_id = $2 AND status = 'pending' RETURNING id`,
    [id, accountId],
  );
  return rows.length > 0;
}

export type ConfirmResult =
  | { ok: true; job: StoredJob }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'invalid'; errors: Record<string, string> };

/** Creates the job from the values the user confirmed (or corrected). Exactly once per proposal. */
export async function confirmProposal(db: Db, account: Account, id: string, form: JobForm): Promise<ConfirmResult> {
  const parsed = parseJobForm({ ...form, alertEmail: undefined }, { requireEmail: false });
  if (!isJobId(id)) return { ok: false, reason: 'not_found' };
  if (!parsed.ok) {
    return (await getProposal(db, account.id, id))?.status === 'pending'
      ? { ok: false, reason: 'invalid', errors: parsed.errors }
      : { ok: false, reason: 'not_found' };
  }
  // Claim first (atomic status transition), so a double submit creates one job.
  const claimed = await db.query(
    `UPDATE intake_proposals SET status = 'accepted' WHERE id = $1 AND account_id = $2 AND status = 'pending' RETURNING id`,
    [id, account.id],
  );
  if (claimed.rows.length === 0) return { ok: false, reason: 'not_found' };
  let job: StoredJob;
  try {
    job = await createJob(db, { ...parsed.value, alertEmail: account.email, accountId: account.id });
  } catch (error) {
    await db.query(`UPDATE intake_proposals SET status = 'pending' WHERE id = $1 AND status = 'accepted' AND job_id IS NULL`, [id]);
    throw error;
  }
  await db.query('UPDATE intake_proposals SET job_id = $2 WHERE id = $1', [id, job.id]);
  return { ok: true, job };
}

// ── Webhook ────────────────────────────────────────────────────────────────────────────────────

interface ReceivedEmail {
  subject: string;
  text: string | null;
  html: string | null;
}

/** Resend may hand HTML back as a data: URI; anything else is returned as is. */
function decodeDataUri(value: string): string {
  const m = /^data:([^,]*),/.exec(value);
  if (!m) return value;
  const payload = value.slice(m[0].length);
  if (m[1].endsWith(';base64')) return Buffer.from(payload, 'base64').toString('utf8');
  try {
    return decodeURIComponent(payload);
  } catch {
    return payload;
  }
}

async function fetchReceivedEmail(emailId: string, apiKey: string, fetchImpl: typeof fetch): Promise<ReceivedEmail> {
  const res = await fetchImpl(`https://api.resend.com/emails/receiving/${emailId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Resend responded ${res.status} when fetching a received email`);
  const email = (await res.json()) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, MAX_BODY_CHARS) : null);
  return {
    subject: text(email.subject) ?? '',
    text: text(email.text),
    html: typeof email.html === 'string' ? decodeDataUri(email.html).slice(0, MAX_BODY_CHARS) : null,
  };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined ? [] : [value]);

/** POST /api/intake/email — Resend's email.received webhook. */
export async function handleInboundEmail(
  req: Request,
  deps: { env: IntakeEnv; getDb: () => Promise<Db>; now?: () => Date; fetch?: typeof fetch },
): Promise<Response> {
  const { RESEND_WEBHOOK_SECRET: secret, RESEND_API_KEY: apiKey } = deps.env;
  if (!secret || !apiKey) {
    // Fail closed: without the secret anyone could post fake mail; without the key we can't read it.
    console.error('intake: RESEND_WEBHOOK_SECRET or RESEND_API_KEY is not configured; refusing to run');
    return json({ ok: false, error: 'Intake is not configured.' }, 500);
  }
  if (Number(req.headers.get('content-length') ?? 0) > MAX_WEBHOOK_BYTES) return json({ ok: false, error: 'Too large' }, 413);
  const body = await req.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_WEBHOOK_BYTES) return json({ ok: false, error: 'Too large' }, 413);

  const now = deps.now?.() ?? new Date();
  if (!verifySvixSignature(body, req.headers, secret, now)) return json({ ok: false, error: 'Invalid signature' }, 401);

  let event: { type?: unknown; data?: Record<string, unknown> };
  try {
    event = JSON.parse(body);
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }
  if (event?.type !== 'email.received') return json({ ok: true, ignored: true });
  const data = event.data ?? {};
  const emailId = typeof data.email_id === 'string' && EMAIL_ID.test(data.email_id) ? data.email_id : null;
  if (!emailId) return json({ ok: false, error: 'Missing email id' }, 400);

  try {
    const db = await deps.getDb();
    const recipients = [...list(data.to), ...list(data.received_for), ...list(data.cc), ...list(data.bcc)];
    const token = intakeTokenFrom(recipients, intakeDomain(deps.env));
    const account = token ? await accountByIntakeToken(db, token) : null;
    // Unknown or rotated address: accept and drop, so Resend doesn't retry and nothing leaks.
    if (!account) return json({ ok: true, stored: false });

    const seen = await db.query('SELECT 1 FROM intake_proposals WHERE account_id = $1 AND external_id = $2', [account.id, emailId]);
    if (seen.rows.length > 0) return json({ ok: true, stored: false, duplicate: true });

    const email = await fetchReceivedEmail(emailId, apiKey, deps.fetch ?? fetch);
    const subject = email.subject || (typeof data.subject === 'string' ? data.subject : '');
    const proposal = proposeJobFromEmail({ subject, text: email.text, html: email.html });
    const stored = await createProposal(db, {
      accountId: account.id,
      source: 'email',
      externalId: emailId,
      fromEmail: proposal.originalFrom ?? (typeof data.from === 'string' ? data.from : null),
      subject,
      fields: proposal.fields,
    });
    return json({ ok: true, stored: stored !== null });
  } catch (error) {
    // 500 makes Resend retry later; nothing was stored.
    console.error('intake: inbound email failed:', error instanceof Error ? error.message : error);
    return json({ ok: false, error: 'Intake failed.' }, 500);
  }
}
