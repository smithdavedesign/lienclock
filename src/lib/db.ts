// One tiny query interface over Postgres: `pg` against Neon in production, embedded PGlite
// (WASM Postgres) for tests and for local dev without DATABASE_URL. Same SQL everywhere.
import type { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs several statements in one implicit transaction (no parameters). */
  exec(sql: string): Promise<void>;
}

export function pgliteDb(pg: PGlite): Db {
  return {
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await pg.query<T>(sql, params)).rows }),
    exec: async (sql) => {
      await pg.exec(sql);
    },
  };
}

export function pgPoolDb(pool: Pool): Db {
  return {
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await pool.query(sql, params)).rows as T[] }),
    exec: async (sql) => {
      await pool.query(sql);
    },
  };
}

/** A fresh in-memory Postgres. Used by tests. */
export async function createMemoryDb(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  await pg.waitReady;
  return pgliteDb(pg);
}

// Dates are `date` columns but always read back with `::text` casts: node-postgres would
// otherwise turn them into local-midnight JS Dates and shift them across time zones.
// The advisory lock serialises concurrent cold starts that all try to create the schema.
const SCHEMA = `
SELECT pg_advisory_xact_lock(727260151);

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY,
  state text NOT NULL,
  role text NOT NULL,
  project_type text NOT NULL,
  counterparty text NOT NULL CHECK (length(counterparty) BETWEEN 1 AND 120),
  first_furnish_date date NOT NULL,
  last_furnish_date date CHECK (last_furnish_date IS NULL OR last_furnish_date >= first_furnish_date),
  done jsonb NOT NULL DEFAULT '{}'::jsonb,
  alert_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alerts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  deadline_key text NOT NULL,
  deadline_date date NOT NULL,
  threshold_days integer NOT NULL,
  to_email text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  claimed_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, deadline_key, deadline_date, threshold_days)
);

CREATE INDEX IF NOT EXISTS alerts_queue_idx ON alerts (id) WHERE status IN ('pending', 'sending');

-- M2: accounts. Emails are stored lowercased; the feed and intake tokens are per-account secrets.
CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  feed_token text NOT NULL UNIQUE,
  intake_token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Sign-in links and sessions keep only the SHA-256 of their token.
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash text PRIMARY KEY,
  email text NOT NULL,
  next_path text NOT NULL,
  pending_job jsonb,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS login_tokens_email_idx ON login_tokens (email, created_at);
CREATE INDEX IF NOT EXISTS login_tokens_created_idx ON login_tokens (created_at);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions (account_id);

-- NULL only for M1-era jobs; the app no longer creates account-less jobs.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES accounts(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS jobs_account_idx ON jobs (account_id, created_at);

-- Job fields proposed from an email, waiting for the user to confirm them.
CREATE TABLE IF NOT EXISTS intake_proposals (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('email', 'paste')),
  external_id text,
  from_email text,
  subject text NOT NULL DEFAULT '',
  fields jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'discarded')),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, external_id)
);
CREATE INDEX IF NOT EXISTS intake_proposals_pending_idx ON intake_proposals (account_id, created_at) WHERE status = 'pending';
`;

export async function ensureSchema(db: Db): Promise<void> {
  await db.exec(SCHEMA);
}

type Env = Record<string, string | undefined>;

async function openDb(env: Env): Promise<Db> {
  if (env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    return pgPoolDb(new pg.Pool({ connectionString: env.DATABASE_URL, max: 3 }));
  }
  if (env.VERCEL) {
    throw new Error('DATABASE_URL is not set. Provision the Neon database and add it to the Vercel env.');
  }
  const [{ PGlite }, { mkdir }] = await Promise.all([import('@electric-sql/pglite'), import('node:fs/promises')]);
  const dir = env.PGLITE_DIR ?? '.data/pglite';
  await mkdir(dir, { recursive: true });
  const pg = new PGlite(dir);
  await pg.waitReady;
  return pgliteDb(pg);
}

const cache = globalThis as unknown as { __lienclockDb?: Promise<Db> };

/** The app database, opened once per process with the schema in place. */
export function getDb(env: Env = process.env): Promise<Db> {
  cache.__lienclockDb ??= openDb(env)
    .then(async (db) => {
      await ensureSchema(db);
      return db;
    })
    .catch((error: unknown) => {
      cache.__lienclockDb = undefined;
      throw error;
    });
  return cache.__lienclockDb;
}
