// computeDeadlines(job): every preliminary-notice and lien deadline for a job, with status.
import { addDays, addMonthsOnDay, daysBetween, isIsoDate, monthLabel, monthsBetween, todayIn } from './dates';
import {
  PROJECT_TYPES,
  ROLES,
  STATES,
  isSupportedState,
  rulesFor,
  type ProjectType,
  type Role,
  type Rule,
  type RuleKind,
  type StateCode,
} from './rules';

export type DeadlineKind = RuleKind;
export type DeadlineStatus = 'protected' | 'partial' | 'at_risk' | 'missed';

export interface JobInput {
  state: StateCode;
  role: Role;
  projectType: ProjectType;
  /** GC or owner the work is for. */
  counterparty: string;
  firstFurnishDate: string;
  lastFurnishDate?: string | null;
  /** Deadline key → date the notice was served or the lien recorded. */
  done?: Record<string, string>;
}

export interface Deadline {
  /** Stable per job: the rule id, plus `:YYYY-MM` for month-by-month notices. */
  key: string;
  ruleId: string;
  kind: DeadlineKind;
  title: string;
  date: string;
  /** Calendar days from today to the deadline; negative once it has passed. */
  daysLeft: number;
  status: DeadlineStatus;
  /** When the notice was served or the lien recorded. */
  doneDate?: string;
  /** For served notices: the first day of work the notice protects. */
  protectedFrom?: string;
  /** For month-by-month notices: the month of work this notice covers. */
  periodMonth?: string;
  citation: string;
  citationUrl: string;
  lastVerified: string;
  note: string;
}

const STATUS_LABELS: Record<DeadlineStatus, string> = {
  protected: 'Protected',
  partial: 'Partially protected',
  at_risk: 'At risk',
  missed: 'Missed',
};

export function statusLabel(status: DeadlineStatus): string {
  return STATUS_LABELS[status];
}

// Open deadlines first (soonest on top), then closed windows that need attention, then done ones.
const URGENCY: Record<DeadlineStatus, number> = { at_risk: 0, missed: 1, partial: 2, protected: 3 };

/** Most urgent first: by status, then date, then key. */
export function compareDeadlines(a: Deadline, b: Deadline): number {
  return URGENCY[a.status] - URGENCY[b.status] || a.date.localeCompare(b.date) || a.key.localeCompare(b.key);
}

/** Throws if the job is outside M1's scope or its dates are invalid. */
export function assertValidJob(job: JobInput): void {
  if (!isSupportedState(job.state)) throw new Error(`Unsupported state: ${JSON.stringify(job.state)}`);
  if (!(ROLES as readonly string[]).includes(job.role)) throw new Error(`Unsupported role: ${JSON.stringify(job.role)}`);
  if (!(PROJECT_TYPES as readonly string[]).includes(job.projectType)) {
    throw new Error(`Unsupported project type: ${JSON.stringify(job.projectType)}`);
  }
  if (!isIsoDate(job.firstFurnishDate)) throw new Error('Invalid first furnishing date');
  if (job.lastFurnishDate != null) {
    if (!isIsoDate(job.lastFurnishDate)) throw new Error('Invalid last furnishing date');
    if (job.lastFurnishDate < job.firstFurnishDate) throw new Error('The last furnishing date is before the first');
  }
}

function applyOffset(rule: Rule, from: string): string {
  return rule.offset.unit === 'days'
    ? addDays(from, rule.offset.days)
    : addMonthsOnDay(from, rule.offset.months, rule.offset.day);
}

interface Occurrence {
  key: string;
  date: string;
  /** First day of work this deadline protects when met on time. */
  coversFrom: string;
  periodMonth?: string;
  title: string;
}

function occurrences(rule: Rule, job: JobInput, today: string): Occurrence[] {
  switch (rule.trigger) {
    case 'firstFurnish':
      return [{ key: rule.id, date: applyOffset(rule, job.firstFurnishDate), coversFrom: job.firstFurnishDate, title: rule.title }];
    case 'lastFurnish':
      if (!job.lastFurnishDate) return [];
      return [{ key: rule.id, date: applyOffset(rule, job.lastFurnishDate), coversFrom: job.firstFurnishDate, title: rule.title }];
    case 'eachFurnishMonth': {
      // Months not furnished yet have no notice yet: stop at the last-furnish month or this month.
      const end = job.lastFurnishDate ?? (today > job.firstFurnishDate ? today : job.firstFurnishDate);
      return monthsBetween(job.firstFurnishDate, end).map((month) => ({
        key: `${rule.id}:${month}`,
        date: applyOffset(rule, `${month}-01`),
        coversFrom: month === job.firstFurnishDate.slice(0, 7) ? job.firstFurnishDate : `${month}-01`,
        periodMonth: month,
        title: `${rule.title} — ${monthLabel(month)} work`,
      }));
    }
  }
}

function statusFor(rule: Rule, occ: Occurrence, doneDate: string | undefined, today: string) {
  if (doneDate === undefined) {
    return { status: (today <= occ.date ? 'at_risk' : 'missed') as DeadlineStatus };
  }
  if (doneDate <= occ.date) {
    return rule.kind === 'notice'
      ? { status: 'protected' as const, protectedFrom: occ.coversFrom }
      : { status: 'protected' as const };
  }
  if (rule.kind === 'notice' && rule.lateLookbackDays !== undefined) {
    return { status: 'partial' as const, protectedFrom: addDays(doneDate, -rule.lateLookbackDays) };
  }
  return { status: 'missed' as const };
}

/**
 * All deadlines for a job, most urgent first. `today` defaults to the current date in the
 * job's state. Lien deadlines appear once a last-furnishing date is known (see pendingRules).
 */
export function computeDeadlines(job: JobInput, opts: { today?: string } = {}): Deadline[] {
  assertValidJob(job);
  const today = opts.today ?? todayIn(STATES[job.state].timeZone);
  if (!isIsoDate(today)) throw new Error('Invalid "today" date');
  const done = job.done ?? {};
  const deadlines: Deadline[] = [];
  for (const rule of rulesFor(job.state, job.role, job.projectType)) {
    for (const occ of occurrences(rule, job, today)) {
      const doneDate = isIsoDate(done[occ.key]) ? done[occ.key] : undefined;
      deadlines.push({
        key: occ.key,
        ruleId: rule.id,
        kind: rule.kind,
        title: occ.title,
        date: occ.date,
        daysLeft: daysBetween(today, occ.date),
        ...statusFor(rule, occ, doneDate, today),
        ...(doneDate ? { doneDate } : {}),
        ...(occ.periodMonth ? { periodMonth: occ.periodMonth } : {}),
        citation: rule.citation,
        citationUrl: rule.citationUrl,
        lastVerified: rule.lastVerified,
        note: rule.note,
      });
    }
  }
  return deadlines.sort(compareDeadlines);
}

/** Rules that can't produce a date yet because the job has no last-furnishing date. */
export function pendingRules(job: JobInput): Rule[] {
  if (job.lastFurnishDate) return [];
  return rulesFor(job.state, job.role, job.projectType).filter((r) => r.trigger === 'lastFurnish');
}
