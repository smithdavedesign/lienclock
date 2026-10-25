// Calendar-day arithmetic on ISO `YYYY-MM-DD` strings.
// Every computation happens at UTC midnight, so server time zone and DST never shift a date.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

function parts(iso: string): [number, number, number] {
  const m = ISO_DATE.exec(iso);
  if (!m) throw new Error(`Invalid date: ${JSON.stringify(iso)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function toIso(utcMs: number): string {
  return new Date(utcMs).toISOString().slice(0, 10);
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [y, m, d] = parts(value);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function assertIso(iso: string): void {
  if (!isIsoDate(iso)) throw new Error(`Invalid date: ${JSON.stringify(iso)}`);
}

export function addDays(iso: string, days: number): string {
  assertIso(iso);
  const [y, m, d] = parts(iso);
  return toIso(Date.UTC(y, m - 1, d + days));
}

/** The given day of the month that is `months` calendar months after the month of `iso`. */
export function addMonthsOnDay(iso: string, months: number, day: number): string {
  assertIso(iso);
  if (!Number.isInteger(day) || day < 1 || day > 28) {
    throw new Error(`Day of month must be 1–28 so it exists in every month, got ${day}`);
  }
  const [y, m] = parts(iso);
  return toIso(Date.UTC(y, m - 1 + months, day));
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  assertIso(from);
  assertIso(to);
  const [y1, m1, d1] = parts(from);
  const [y2, m2, d2] = parts(to);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / MS_PER_DAY);
}

/** Calendar months (`YYYY-MM`) from the month of `start` through the month of `end`, inclusive. */
export function monthsBetween(start: string, end: string): string[] {
  assertIso(start);
  assertIso(end);
  const [y1, m1] = parts(start);
  const [y2, m2] = parts(end);
  const count = Math.max(1, (y2 - y1) * 12 + (m2 - m1) + 1);
  return Array.from({ length: count }, (_, i) => toIso(Date.UTC(y1, m1 - 1 + i, 1)).slice(0, 7));
}

/** Today's calendar date in an IANA time zone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const fields = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => fields.find((f) => f.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function monthLabel(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, 1)),
  );
}
