// ICS calendar feed (RFC 5545): one all-day VEVENT per deadline of every job in an account.
//
//   calendar app ─GET /calendar/<feed token>.ics─▶ handleCalendarFeed → account by token
//     → its jobs → computeDeadlines (today in each job's state) → buildCalendar → text/calendar
//
// Calendar apps can't send cookies, so the secret URL is the credential (like Google Calendar's
// "secret address"); the dashboard can reset it. Deadlines are DATE values with an exclusive DTEND,
// so no time zone can move them to another day.
import { accountByFeedToken, type Account } from './auth';
import { appUrlFrom, type CronEnv } from './cron';
import { addDays, todayIn } from './dates';
import type { Db } from './db';
import { computeDeadlines, statusLabel, type Deadline } from './deadlines';
import { listJobsForAccount, type StoredJob } from './jobs';
import { STATES } from './rules';

const PRODID = '-//LienClock//Lien and notice deadlines//EN';
const CALENDAR_NAME = 'LienClock deadlines';
const MAX_OCTETS = 75;
const DISCLAIMER =
  'LienClock is a deadline reference, not legal advice. Dates are calendar days and are never extended for weekends or holidays. Check the statute or a construction attorney before you rely on them.';

/** TEXT escaping (§3.3.11): backslash, semicolon, comma and newline; other control characters become spaces. */
export function escapeText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\\;,]/g, (c) => `\\${c}`)
    .replace(/\n/g, '\\n');
}

/** Folds a content line at 75 octets (§3.1), never inside a UTF-8 character. */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  let limit = MAX_OCTETS;
  for (const char of line) {
    const size = Buffer.byteLength(char, 'utf8');
    if (octets + size > limit) {
      parts.push(current);
      current = '';
      octets = 0;
      limit = MAX_OCTETS - 1; // continuation lines start with a space
    }
    current += char;
    octets += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

const icsDate = (iso: string) => iso.replaceAll('-', '');
const icsTimestamp = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

export function eventUid(jobId: string, deadlineKey: string): string {
  return `${jobId}.${deadlineKey}@lienclock`;
}

function eventLines(job: StoredJob, d: Deadline, stamp: string, appUrl: string): string[] {
  const jobUrl = `${appUrl}/jobs/${job.id}`;
  const timing = d.doneDate
    ? `Done ${d.doneDate}.`
    : d.daysLeft >= 0
      ? `Due ${d.date} (${d.daysLeft === 0 ? 'today' : `${d.daysLeft} days left`} when this calendar was fetched).`
      : `Passed on ${d.date}.`;
  const description = [
    `${statusLabel(d.status)}: ${d.title} for your ${STATES[job.state].name} job with ${job.counterparty}. ${timing}`,
    d.protectedFrom ? `Covers work from ${d.protectedFrom}.` : null,
    '',
    d.note,
    '',
    `Statute: ${d.citation} — ${d.citationUrl} (last verified ${d.lastVerified})`,
    `Open the job: ${jobUrl}`,
    '',
    DISCLAIMER,
  ]
    .filter((line) => line !== null)
    .join('\n');
  return [
    'BEGIN:VEVENT',
    `UID:${escapeText(eventUid(job.id, d.key))}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${icsDate(d.date)}`,
    `DTEND;VALUE=DATE:${icsDate(addDays(d.date, 1))}`,
    `SUMMARY:${escapeText(`[${statusLabel(d.status)}] ${job.state} ${d.title} — ${job.counterparty}`)}`,
    `DESCRIPTION:${escapeText(description)}`,
    `URL:${jobUrl}`,
    `CATEGORIES:${escapeText('LienClock')},${escapeText(d.kind === 'lien' ? 'Lien' : 'Notice')}`,
    'TRANSP:TRANSPARENT',
    'STATUS:CONFIRMED',
    'END:VEVENT',
  ];
}

/** The whole calendar for some jobs. A job that can't be computed is skipped, not fatal. */
export function buildCalendar(jobs: StoredJob[], opts: { now: Date; appUrl: string }): string {
  const stamp = icsTimestamp(opts.now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(CALENDAR_NAME)}`,
    `X-WR-CALDESC:${escapeText('Preliminary-notice and lien deadlines for your jobs. Not legal advice.')}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
    'X-PUBLISHED-TTL:PT12H',
  ];
  for (const job of jobs) {
    let deadlines: Deadline[];
    try {
      deadlines = computeDeadlines(job, { today: todayIn(STATES[job.state].timeZone, opts.now) });
    } catch (error) {
      console.error(`ics: skipped job ${job.id}:`, error instanceof Error ? error.message : error);
      continue;
    }
    for (const d of deadlines) lines.push(...eventLines(job, d, stamp, opts.appUrl));
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

export function feedUrls(account: Pick<Account, 'feedToken'>, appUrl: string): { https: string; webcal: string } {
  const https = `${appUrl}/calendar/${account.feedToken}.ics`;
  return { https, webcal: https.replace(/^https?:/, 'webcal:') };
}

const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

/** GET /calendar/<token>.ics */
export async function handleCalendarFeed(
  feedParam: string,
  deps: { env: CronEnv; getDb: () => Promise<Db>; now?: () => Date },
): Promise<Response> {
  const token = feedParam.replace(/\.ics$/i, '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return notFound();
  try {
    const db = await deps.getDb();
    const account = await accountByFeedToken(db, token);
    if (!account) return notFound();
    const jobs = await listJobsForAccount(db, account.id);
    const body = buildCalendar(jobs, { now: deps.now?.() ?? new Date(), appUrl: appUrlFrom(deps.env) });
    return new Response(body, {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'inline; filename="lienclock.ics"',
        'Cache-Control': 'private, max-age=300',
        'X-Robots-Tag': 'noindex',
      },
    });
  } catch (error) {
    console.error('ics: feed failed:', error instanceof Error ? error.message : error);
    return new Response('Calendar unavailable', { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}
