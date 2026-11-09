// The rules changelog. Rules ship as versioned JSON in the repo; this module notices when they change
// and tells the people affected. Nobody has to remember to write a changelog entry.
//
//   daily cron ─▶ syncRuleChanges(shipped rules)
//     no snapshots yet? seed them from the baseline (the rules M1–M2 shipped with, before tracking)
//     per state: fingerprint of the rules' material fields (lastVerified is not material)
//       same fingerprint → refresh the stored copy silently (a re-verification)
//       different        → diff → one statement: UPDATE rule_snapshots … WHERE revision = old
//                          (compare-and-swap) + INSERT rule_changes (state, revision + 1) only if it swapped
//     every change not yet emailed → one email per address with a job in that state
//       → INSERT rule_change_emails ON CONFLICT (change, address) DO NOTHING → mark the change emailed
//   The emails go out through the alert sender (alerts.ts), after the deadline alerts.
import { createHash } from 'node:crypto';
import baselineFile from '../../rules/baseline-2026-10-25.json';
import type { Db } from './db';
import { STATES, parseRules, type Rule, type RuleSet } from './rules';

/** The rules as shipped before change tracking (version 2026-10-25): what a fresh database starts from. */
export const RULES_BASELINE: Rule[] = parseRules(baselineFile);

/** Jobs listed by name in one email; the rest are summarized with a link to the dashboard. */
const MAX_JOBS_LISTED = 20;

export type ChangeKind = 'added' | 'changed' | 'removed';

export interface FieldChange {
  label: string;
  /** Empty for an added rule. */
  before: string;
  /** Empty for a removed rule. */
  after: string;
}

export interface ChangeItem {
  ruleId: string;
  title: string;
  change: ChangeKind;
  fields: FieldChange[];
}

/** One changelog entry: everything that changed in one state's rules in one sync. */
export interface RuleChange {
  id: number;
  state: string;
  stateName: string;
  revision: number;
  rulesVersion: string;
  items: ChangeItem[];
  createdAt: string;
}

// ── Describing rules in words ──────────────────────────────────────────────────────────────────

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "20 days after you first furnish", "the 15th of the 3rd month after each month you furnish", … */
export function describeDeadline(rule: Pick<Rule, 'trigger' | 'offset'>): string {
  const { trigger, offset } = rule;
  const after = trigger === 'eachFurnishMonth' ? 'each month you furnish' : trigger === 'firstFurnish' ? 'you first furnish' : 'you last furnish';
  switch (offset.unit) {
    case 'days':
      return `${count(offset.days, 'day')} after ${after}`;
    case 'monthDay': {
      const month = trigger === 'eachFurnishMonth' ? 'each month you furnish' : `the month ${after}`;
      return `the ${ordinal(offset.day)} of the ${ordinal(offset.months)} month after ${month}`;
    }
    case 'months': {
      const base = `${count(offset.months, 'month')} after ${after}`;
      if (offset.days === 0) return base;
      return offset.days < 0 ? `${base}, less ${count(-offset.days, 'day')}` : `${base}, plus ${count(offset.days, 'day')}`;
    }
  }
}

/** What a late notice still protects. Empty for liens. */
export function describeLateNotice(rule: Pick<Rule, 'kind' | 'lateLookbackDays'>): string {
  if (rule.kind !== 'notice') return '';
  const days = rule.lateLookbackDays;
  if (days === undefined) return 'A late notice protects nothing';
  if (days > 0) return `A late notice still protects work from ${count(days, 'day')} before it is given`;
  if (days < 0) return `A late notice protects only work from ${count(-days, 'day')} after it is given`;
  return 'A late notice protects work from the day it is given';
}

// Everything a user relies on. lastVerified is left out: re-checking a rule is not a change.
const FIELDS: { label: string; value: (rule: Rule) => string }[] = [
  { label: 'Name', value: (r) => r.title },
  { label: 'Type', value: (r) => (r.kind === 'lien' ? 'Lien' : 'Notice') },
  { label: 'Applies to', value: (r) => `${r.role}, ${r.projectType}` },
  { label: 'Deadline', value: describeDeadline },
  { label: 'Late notice', value: describeLateNotice },
  { label: 'Statute', value: (r) => r.citation },
  { label: 'Statute link', value: (r) => r.citationUrl },
  { label: 'What to do', value: (r) => r.note },
];

/** JSON with object keys sorted, so equal values always give the same string (jsonb reorders keys). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return `{${entries
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Identifies a state's rules by their material fields, in id order. */
export function rulesFingerprint(rules: Rule[]): string {
  const material = [...rules]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ lastVerified: _verified, ...rest }) => ({ ...rest, offset: { ...rest.offset } }));
  return createHash('sha256').update(canonical(material)).digest('hex');
}

/** Field-by-field differences between two versions of a state's rules, by rule id. */
export function diffRules(before: Rule[], after: Rule[]): ChangeItem[] {
  const old = new Map(before.map((r) => [r.id, r]));
  const now = new Map(after.map((r) => [r.id, r]));
  const ids = [...new Set([...old.keys(), ...now.keys()])].sort();
  return ids.flatMap((id): ChangeItem[] => {
    const a = old.get(id);
    const b = now.get(id);
    if (a && !b) {
      return [{ ruleId: id, title: a.title, change: 'removed', fields: [
        { label: 'Deadline', before: describeDeadline(a), after: '' },
        { label: 'Statute', before: a.citation, after: '' },
      ] }];
    }
    if (!a && b) {
      return [{ ruleId: id, title: b.title, change: 'added', fields: [
        { label: 'Deadline', before: '', after: describeDeadline(b) },
        { label: 'Statute', before: '', after: b.citation },
      ] }];
    }
    const fields = FIELDS.map((f) => ({ label: f.label, before: f.value(a!), after: f.value(b!) })).filter((f) => f.before !== f.after);
    return fields.length > 0 ? [{ ruleId: id, title: b!.title, change: 'changed', fields }] : [];
  });
}

// ── Snapshots and entries ──────────────────────────────────────────────────────────────────────

function byState(rules: Rule[]): Map<string, Rule[]> {
  const groups = new Map<string, Rule[]>();
  for (const rule of rules) groups.set(rule.state, [...(groups.get(rule.state) ?? []), rule]);
  return groups;
}

interface SnapshotRow {
  state: string;
  revision: number;
  fingerprint: string;
  rules: unknown;
}

interface ChangeRow {
  id: number;
  state: string;
  revision: number;
  rules_version: string;
  items: unknown;
  created_at: Date | string;
}

const CHANGE_COLUMNS = 'id, state, revision, rules_version, items, created_at';

const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** Keeps only well-formed items, so a damaged row can't break the page or an email. */
function cleanItems(raw: unknown): ChangeItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): ChangeItem[] => {
    const i = item as Record<string, unknown> | null;
    if (!i || !['added', 'changed', 'removed'].includes(String(i.change))) return [];
    const fields = Array.isArray(i.fields) ? i.fields : [];
    return [{
      ruleId: text(i.ruleId),
      title: text(i.title),
      change: i.change as ChangeKind,
      fields: fields.map((f: Record<string, unknown>) => ({ label: text(f?.label), before: text(f?.before), after: text(f?.after) })),
    }];
  });
}

function fromChangeRow(row: ChangeRow, states: Record<string, { name: string }> = STATES): RuleChange {
  return {
    id: row.id,
    state: row.state,
    stateName: states[row.state]?.name ?? row.state,
    revision: row.revision,
    rulesVersion: row.rules_version,
    items: cleanItems(row.items),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** On a database with no snapshots, stores the baseline as revision 0 of each of its states. */
async function seedSnapshots(db: Db, baseline: Rule[], now: Date): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM rule_snapshots LIMIT 1');
  if (rows.length > 0) return false;
  let seeded = false;
  for (const [state, rules] of byState(baseline)) {
    const inserted = await db.query(
      `INSERT INTO rule_snapshots (state, revision, fingerprint, rules, updated_at) VALUES ($1, 0, $2, $3::jsonb, $4)
       ON CONFLICT (state) DO NOTHING RETURNING state`,
      [state, rulesFingerprint(rules), JSON.stringify(rules), now],
    );
    seeded ||= inserted.rows.length > 0;
  }
  return seeded;
}

export interface SyncResult {
  /** True when this run stored the baseline (first run on this database). */
  seeded: boolean;
  /** Changelog entries this run created. */
  changes: RuleChange[];
  /** Rule-change emails this run queued (for its own entries or ones a stopped run left behind). */
  emailsQueued: number;
}

export async function syncRuleChanges(
  db: Db,
  opts: { rules: RuleSet; baseline: Rule[]; now: Date; appUrl: string },
): Promise<SyncResult> {
  const { now } = opts;
  const seeded = await seedSnapshots(db, opts.baseline, now);
  const { rows: stored } = await db.query<SnapshotRow>('SELECT state, revision, fingerprint, rules FROM rule_snapshots');
  const snapshots = new Map(stored.map((s) => [s.state, s]));
  const current = byState(opts.rules.rules);
  const changes: RuleChange[] = [];

  for (const state of [...new Set([...snapshots.keys(), ...current.keys()])].sort()) {
    const after = current.get(state) ?? [];
    const snapshot = snapshots.get(state);
    const fingerprint = rulesFingerprint(after);
    const json = JSON.stringify(after);
    if (snapshot?.fingerprint === fingerprint) {
      await db.query(
        `UPDATE rule_snapshots SET rules = $3::jsonb, updated_at = $4
          WHERE state = $1 AND revision = $2 AND rules <> $3::jsonb`,
        [state, snapshot.revision, json, now],
      );
      continue;
    }
    if (!snapshot && after.length === 0) continue;
    const before = Array.isArray(snapshot?.rules) ? (snapshot.rules as Rule[]) : [];
    const revision = (snapshot?.revision ?? 0) + 1;
    // One statement: the compare-and-swap of the snapshot, and the entry only if the swap happened.
    // Either both are stored or neither, so a run that fails leaves the old snapshot and the next run
    // diffs the rules that are live by then. Of two overlapping runs, only one wins the swap.
    const params: unknown[] = [state, revision, fingerprint, json, now, opts.rules.version, JSON.stringify(diffRules(before, after))];
    const swap = snapshot
      ? `UPDATE rule_snapshots SET revision = $2::int, fingerprint = $3::text, rules = $4::jsonb, updated_at = $5::timestamptz
          WHERE state = $1::text AND revision = $8::int RETURNING state`
      : `INSERT INTO rule_snapshots (state, revision, fingerprint, rules, updated_at)
         VALUES ($1::text, $2::int, $3::text, $4::jsonb, $5::timestamptz)
         ON CONFLICT (state) DO NOTHING RETURNING state`;
    if (snapshot) params.push(snapshot.revision);
    const entry = await db.query<ChangeRow>(
      `WITH swap AS (${swap})
       INSERT INTO rule_changes (state, revision, rules_version, items, created_at)
       SELECT $1::text, $2::int, $6::text, $7::jsonb, $5::timestamptz FROM swap
       ON CONFLICT (state, revision) DO NOTHING RETURNING ${CHANGE_COLUMNS}`,
      params,
    );
    if (entry.rows[0]) changes.push(fromChangeRow(entry.rows[0], opts.rules.states));
  }

  const emailsQueued = await queueChangeEmails(db, { now, appUrl: opts.appUrl, states: opts.rules.states });
  return { seeded, changes, emailsQueued };
}

/** Newest first, for the /changelog page. */
export async function listRuleChanges(db: Db, opts: { limit?: number } = {}): Promise<RuleChange[]> {
  const { rows } = await db.query<ChangeRow>(
    `SELECT ${CHANGE_COLUMNS} FROM rule_changes ORDER BY created_at DESC, id DESC LIMIT $1`,
    [opts.limit ?? 200],
  );
  return rows.map((row) => fromChangeRow(row));
}

// ── Emails to the people affected ──────────────────────────────────────────────────────────────

interface Recipient {
  email: string;
  jobs: { id: string; counterparty: string; firstFurnishDate: string }[];
}

function fieldLine(item: ChangeItem, field: FieldChange): string {
  if (item.change === 'added') return `  ${field.label}: ${field.after}`;
  if (item.change === 'removed') return `  ${field.label} was: ${field.before}`;
  return `  ${field.label}: ${field.before || '(none)'} → ${field.after || '(none)'}`;
}

export function ruleChangeEmail(change: RuleChange, recipient: Recipient, appUrl: string): { subject: string; body: string } {
  const name = change.stateName;
  const n = recipient.jobs.length;
  const subject = `${name} lien rules changed: check your ${n === 1 ? `${name} job` : `${n} ${name} jobs`}`;
  const heading = { added: 'New', removed: 'Removed', changed: 'Changed' } as const;
  const body = [
    `LienClock changed a rule it uses for your ${name} ${n === 1 ? 'job' : 'jobs'} (rules version ${change.rulesVersion}). The deadlines on your jobs already follow the new rule.`,
    '',
    'What changed:',
    ...change.items.flatMap((item) => [`- ${heading[item.change]}: ${item.title}`, ...item.fields.map((f) => fieldLine(item, f))]),
    '',
    `Your ${name} ${n === 1 ? 'job' : 'jobs'}:`,
    ...recipient.jobs.slice(0, MAX_JOBS_LISTED).map((j) => `- ${j.counterparty} (first furnished ${j.firstFurnishDate}): ${appUrl}/jobs/${j.id}`),
    ...(n > MAX_JOBS_LISTED ? [`- and ${n - MAX_JOBS_LISTED} more: ${appUrl}/jobs`] : []),
    '',
    `Every rule change, with the statutes: ${appUrl}/changelog`,
    '',
    'LienClock is a deadline reference, not legal advice. Dates are calendar days and are never extended for weekends or holidays. Check the statute or a construction attorney before you rely on them.',
    `You get this email because you track a ${name} job in LienClock. To stop, delete the job or your account.`,
  ].join('\n');
  return { subject, body };
}

/** Queues one email per address with a job in the state of each change that hasn't been emailed yet. */
async function queueChangeEmails(
  db: Db,
  opts: { now: Date; appUrl: string; states: Record<string, { name: string }> },
): Promise<number> {
  const { rows: pending } = await db.query<ChangeRow>(
    `SELECT ${CHANGE_COLUMNS} FROM rule_changes WHERE emails_queued_at IS NULL ORDER BY id`,
  );
  let queued = 0;
  for (const row of pending) {
    const change = fromChangeRow(row, opts.states);
    // Grouped by address: account jobs alert the account email, M1-era jobs their own alert address.
    const { rows: recipients } = await db.query<Recipient>(
      `SELECT lower(alert_email) AS email,
              json_agg(json_build_object('id', id::text, 'counterparty', counterparty,
                                         'firstFurnishDate', first_furnish_date::text) ORDER BY created_at, id) AS jobs
         FROM jobs WHERE state = $1
        GROUP BY lower(alert_email)
        ORDER BY 1`,
      [change.state],
    );
    for (const recipient of recipients) {
      const { subject, body } = ruleChangeEmail(change, recipient, opts.appUrl);
      const inserted = await db.query(
        `INSERT INTO rule_change_emails (change_id, to_email, subject, body) VALUES ($1, $2, $3, $4)
         ON CONFLICT (change_id, to_email) DO NOTHING RETURNING id`,
        [change.id, recipient.email, subject, body],
      );
      queued += inserted.rows.length;
    }
    await db.query('UPDATE rule_changes SET emails_queued_at = $2 WHERE id = $1 AND emails_queued_at IS NULL', [change.id, opts.now]);
  }
  return queued;
}
