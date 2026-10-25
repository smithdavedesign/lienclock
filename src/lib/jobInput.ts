// Parses untrusted form input into a job. Pure: no I/O, so the calculator page and server actions share it.
import { isIsoDate } from './dates';
import type { JobInput } from './deadlines';
import { SUPPORTED_STATES, isSupportedState } from './rules';

export type JobForm = Partial<Record<'state' | 'counterparty' | 'firstFurnishDate' | 'lastFurnishDate' | 'alertEmail', string>>;

export interface JobFormValue extends JobInput {
  lastFurnishDate: string | null;
  alertEmail?: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> };

export const MAX_COUNTERPARTY = 120;
const MAX_EMAIL = 254;
// Deliberately simple: one @, no whitespace or control characters, a dot in the domain.
const EMAIL = /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+\.[^\s@\p{Cc}]+$/u;
const MIN_DATE = '2000-01-01';
const MAX_DATE = '2099-12-31';

/** Collapses control characters (CR/LF, tabs…) and repeated spaces so names are safe in email subjects. */
function cleanText(value: string | undefined): string {
  return (value ?? '').replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** The trimmed, lowercased address if it is a plausible email, else null. Accounts are keyed on this. */
export function parseEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= MAX_EMAIL && EMAIL.test(email) ? email : null;
}

function checkDate(value: string, label: string): string | null {
  if (!isIsoDate(value)) return `Enter a valid date for the ${label} (YYYY-MM-DD).`;
  if (value < MIN_DATE || value > MAX_DATE) return `The ${label} must be between 2000 and 2099.`;
  return null;
}

export function parseJobForm(form: JobForm, opts: { requireEmail: boolean }): Parsed<JobFormValue> {
  const errors: Record<string, string> = {};

  const state = (form.state ?? '').trim().toUpperCase();
  if (!state) errors.state = 'Choose the state the project is in.';
  else if (!isSupportedState(state)) errors.state = `LienClock covers ${SUPPORTED_STATES.join(', ')} for now.`;

  const counterparty = cleanText(form.counterparty);
  if (!counterparty) errors.counterparty = 'Enter the GC or owner you are working for.';
  else if (counterparty.length > MAX_COUNTERPARTY) errors.counterparty = `Keep the GC or owner name under ${MAX_COUNTERPARTY} characters.`;

  const first = (form.firstFurnishDate ?? '').trim();
  if (!first) errors.firstFurnishDate = 'Enter the first date you furnished labor or materials.';
  else {
    const problem = checkDate(first, 'first furnishing date');
    if (problem) errors.firstFurnishDate = problem;
  }

  const lastRaw = (form.lastFurnishDate ?? '').trim();
  const last = lastRaw === '' ? null : lastRaw;
  if (last !== null) {
    const problem = checkDate(last, 'last furnishing date');
    if (problem) errors.lastFurnishDate = problem;
    else if (!errors.firstFurnishDate && first && last < first) {
      errors.lastFurnishDate = 'The last furnishing date must be on or after the first.';
    }
  }

  const emailRaw = form.alertEmail ?? '';
  const email = emailRaw.trim();
  if (email || opts.requireEmail) {
    if (!email) errors.alertEmail = 'Enter the email address for deadline alerts.';
    else if (email.length > MAX_EMAIL || !EMAIL.test(email)) errors.alertEmail = 'Enter a valid email address.';
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      state: state as JobFormValue['state'],
      role: 'sub',
      projectType: 'commercial',
      counterparty,
      firstFurnishDate: first,
      lastFurnishDate: last,
      ...(email ? { alertEmail: email } : {}),
    },
  };
}

export function parseDoneDate(value: string | undefined, today: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const v = (value ?? '').trim();
  if (v === '') return { ok: true, value: null };
  const problem = checkDate(v, 'date');
  if (problem) return { ok: false, error: problem };
  if (v > today) return { ok: false, error: 'That date is in the future. Record it once it has happened.' };
  return { ok: true, value: v };
}
