// Jobs repository. Every query is parameterised. Since M2 a job belongs to an account, and every
// read or write the app makes passes `{ accountId }`, which goes into the query's WHERE clause, so
// another account's job is simply "not found". Unscoped calls are for the cron and tests.
import { randomUUID } from 'node:crypto';
import { isIsoDate, todayIn } from './dates';
import type { Db } from './db';
import { assertValidJob, compareDeadlines, computeDeadlines, type Deadline, type JobInput } from './deadlines';
import { parseDoneDate } from './jobInput';
import { STATES, type ProjectType, type Role, type StateCode } from './rules';

export interface JobDraft extends JobInput {
  alertEmail: string;
  /** The owning account. Absent only on M1-era jobs. */
  accountId?: string;
}

export interface StoredJob extends JobDraft {
  id: string;
  lastFurnishDate: string | null;
  done: Record<string, string>;
}

/** Restricts a query to one account's jobs. */
export interface JobScope {
  accountId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isJobId(id: unknown): id is string {
  return typeof id === 'string' && UUID.test(id);
}

/** The account id as a query parameter: null means unscoped; an invalid id can match nothing. */
function scopeParam(scope: JobScope): string | null | false {
  if (scope.accountId === undefined) return null;
  return isJobId(scope.accountId) ? scope.accountId : false;
}

// `$n::uuid IS NULL OR account_id = $n::uuid`: one static, parameterised query for both cases.
const IN_SCOPE = (n: number) => `($${n}::uuid IS NULL OR account_id = $${n}::uuid)`;

const COLUMNS = `id::text AS id, state, role, project_type, counterparty,
  first_furnish_date::text AS first_furnish_date, last_furnish_date::text AS last_furnish_date,
  done, alert_email, account_id::text AS account_id`;

interface JobRow {
  id: string;
  state: StateCode;
  role: Role;
  project_type: ProjectType;
  counterparty: string;
  first_furnish_date: string;
  last_furnish_date: string | null;
  done: Record<string, string> | null;
  alert_email: string;
  account_id: string | null;
}

function fromRow(row: JobRow): StoredJob {
  return {
    id: row.id,
    state: row.state,
    role: row.role,
    projectType: row.project_type,
    counterparty: row.counterparty,
    firstFurnishDate: row.first_furnish_date,
    lastFurnishDate: row.last_furnish_date,
    done: row.done ?? {},
    alertEmail: row.alert_email,
    ...(row.account_id ? { accountId: row.account_id } : {}),
  };
}

export async function createJob(db: Db, draft: JobDraft): Promise<StoredJob> {
  assertValidJob(draft);
  if (!draft.alertEmail) throw new Error('An alert email is required to save a job');
  if (draft.accountId !== undefined && !isJobId(draft.accountId)) throw new Error('Invalid account id');
  const { rows } = await db.query<JobRow>(
    `INSERT INTO jobs (id, state, role, project_type, counterparty, first_furnish_date, last_furnish_date, alert_email, account_id)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9::uuid)
     RETURNING ${COLUMNS}`,
    [
      randomUUID(),
      draft.state,
      draft.role,
      draft.projectType,
      draft.counterparty,
      draft.firstFurnishDate,
      draft.lastFurnishDate ?? null,
      draft.alertEmail,
      draft.accountId ?? null,
    ],
  );
  return fromRow(rows[0]);
}

export async function getJob(db: Db, id: string, scope: JobScope = {}): Promise<StoredJob | null> {
  const accountId = scopeParam(scope);
  if (!isJobId(id) || accountId === false) return null;
  const { rows } = await db.query<JobRow>(`SELECT ${COLUMNS} FROM jobs WHERE id = $1 AND ${IN_SCOPE(2)}`, [id, accountId]);
  return rows[0] ? fromRow(rows[0]) : null;
}

/** Every job, for the alert cron. */
export async function listJobs(db: Db): Promise<StoredJob[]> {
  const { rows } = await db.query<JobRow>(`SELECT ${COLUMNS} FROM jobs ORDER BY created_at, id`);
  return rows.map(fromRow);
}

export async function listJobsForAccount(db: Db, accountId: string): Promise<StoredJob[]> {
  if (!isJobId(accountId)) return [];
  const { rows } = await db.query<JobRow>(`SELECT ${COLUMNS} FROM jobs WHERE account_id = $1 ORDER BY created_at, id`, [
    accountId,
  ]);
  return rows.map(fromRow);
}

export async function deleteJob(db: Db, id: string, scope: JobScope = {}): Promise<boolean> {
  const accountId = scopeParam(scope);
  if (!isJobId(id) || accountId === false) return false;
  const { rows } = await db.query(`DELETE FROM jobs WHERE id = $1 AND ${IN_SCOPE(2)} RETURNING id`, [id, accountId]);
  return rows.length > 0;
}

/** Sets (or clears, with null) the last-furnishing date. Returns null if the job doesn't exist (in scope). */
export async function setLastFurnish(
  db: Db,
  id: string,
  date: string | null,
  scope: JobScope = {},
): Promise<StoredJob | null> {
  const accountId = scopeParam(scope);
  if (!isJobId(id) || accountId === false) return null;
  if (date !== null && !isIsoDate(date)) throw new Error('Invalid last furnishing date');
  // The date check lives in the WHERE clause so it's atomic with the write.
  const { rows } = await db.query<JobRow>(
    `UPDATE jobs SET last_furnish_date = $2::date, updated_at = now()
      WHERE id = $1 AND ${IN_SCOPE(3)} AND ($2::date IS NULL OR $2::date >= first_furnish_date)
      RETURNING ${COLUMNS}`,
    [id, date, accountId],
  );
  if (rows[0]) return fromRow(rows[0]);
  if (await getJob(db, id, scope)) throw new Error('The last furnishing date must be on or after the first furnishing date.');
  return null;
}

/** Atomic jsonb merge/removal, so concurrent updates to different deadlines don't overwrite each other. */
async function setDone(db: Db, id: string, key: string, date: string | null, accountId: string | null): Promise<StoredJob | null> {
  const { rows } =
    date === null
      ? await db.query<JobRow>(
          `UPDATE jobs SET done = done - $2::text, updated_at = now() WHERE id = $1 AND ${IN_SCOPE(3)} RETURNING ${COLUMNS}`,
          [id, key, accountId],
        )
      : await db.query<JobRow>(
          `UPDATE jobs SET done = done || jsonb_build_object($2::text, $3::text), updated_at = now()
            WHERE id = $1 AND ${IN_SCOPE(4)} RETURNING ${COLUMNS}`,
          [id, key, date, accountId],
        );
  return rows[0] ? fromRow(rows[0]) : null;
}

export type ActionResult = { ok: true; job: StoredJob } | { ok: false; error: string };

/**
 * Records the date a notice was served or a lien recorded (null clears it). The key must be
 * one of the job's current deadlines and the date can't be in the future.
 */
export async function markDeadlineDone(
  db: Db,
  id: string,
  key: string,
  date: string | null,
  opts: { today?: string } & JobScope = {},
): Promise<ActionResult> {
  const scope = { accountId: opts.accountId };
  const job = await getJob(db, id, scope);
  if (!job) return { ok: false, error: 'Job not found.' };
  const today = opts.today ?? todayIn(STATES[job.state].timeZone);
  if (!computeDeadlines(job, { today }).some((d) => d.key === key)) {
    return { ok: false, error: 'That deadline is not part of this job.' };
  }
  const parsed = parseDoneDate(date ?? '', today);
  if (!parsed.ok) return parsed;
  const updated = await setDone(db, id, key, parsed.value, scopeParam(scope) || null);
  return updated ? { ok: true, job: updated } : { ok: false, error: 'Job not found.' };
}

export interface JobSummary {
  job: StoredJob;
  /** The job's most urgent deadline, or null if it has none yet. */
  next: Deadline | null;
  /** Deadlines still open (at risk). */
  openCount: number;
}

/** One row per job for the dashboard, most urgent job first; jobs without deadlines go last. */
export function summarizeJobs(jobs: StoredJob[], now: Date): JobSummary[] {
  const summaries = jobs.map((job): JobSummary => {
    try {
      const deadlines = computeDeadlines(job, { today: todayIn(STATES[job.state].timeZone, now) });
      return { job, next: deadlines[0] ?? null, openCount: deadlines.filter((d) => d.status === 'at_risk').length };
    } catch {
      return { job, next: null, openCount: 0 };
    }
  });
  // Array.prototype.sort is stable, so ties keep the repository's created-at order.
  return summaries.sort((a, b) => {
    if (!a.next || !b.next) return (a.next ? 0 : 1) - (b.next ? 0 : 1);
    return compareDeadlines(a.next, b.next);
  });
}
