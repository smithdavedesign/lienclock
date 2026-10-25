import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findOrCreateAccount, rotateFeedToken, type Account } from '@/lib/auth';
import { createMemoryDb, ensureSchema, type Db } from '@/lib/db';
import { buildCalendar, escapeText, feedUrls, foldLine, handleCalendarFeed } from '@/lib/ics';
import { createJob, getJob, markDeadlineDone, type StoredJob } from '@/lib/jobs';
import { prop, unescapeText, validateIcs } from './helpers/icsValidator';

const APP_URL = 'https://lienclock.example';
const NOW = new Date('2026-03-14T16:00:00Z');

let db: Db;
let account: Account;
beforeAll(async () => {
  db = await createMemoryDb();
  await ensureSchema(db);
});
beforeEach(async () => {
  await db.exec('TRUNCATE alerts, jobs, accounts RESTART IDENTITY CASCADE');
  account = await findOrCreateAccount(db, 'office@example.com');
});

function job(overrides: Partial<StoredJob> = {}): Promise<StoredJob> {
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

const feed = (param: string, getDb: () => Promise<Db> = async () => db) =>
  handleCalendarFeed(param, { env: { APP_URL }, getDb, now: () => NOW });

describe('escapeText', () => {
  it('escapes backslashes, semicolons, commas and newlines (RFC 5545 §3.3.11)', () => {
    expect(escapeText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
    expect(escapeText('one\r\ntwo\rthree')).toBe('one\\ntwo\\nthree');
  });

  it('drops other control characters', () => {
    expect(escapeText('bell\u0007 tab\there')).toBe('bell  tab here');
  });
});

describe('foldLine', () => {
  it('keeps every physical line within 75 octets and unfolds to the original', () => {
    const line = `DESCRIPTION:${'abcdefghij'.repeat(20)}`;
    const folded = foldLine(line);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(75);
    expect(parts.slice(1).every((p) => p.startsWith(' '))).toBe(true);
    expect(parts.map((p, i) => (i === 0 ? p : p.slice(1))).join('')).toBe(line);
  });

  it('never splits a multi-byte character', () => {
    const line = `SUMMARY:${'É—'.repeat(50)}`;
    const parts = foldLine(line).split('\r\n');
    for (const part of parts) {
      expect(Buffer.byteLength(part)).toBeLessThanOrEqual(75);
      expect(Buffer.from(part, 'utf8').toString('utf8')).toBe(part);
      expect(part).not.toContain('�');
    }
    expect(parts.map((p, i) => (i === 0 ? p : p.slice(1))).join('')).toBe(line);
  });

  it('leaves short lines alone', () => {
    expect(foldLine('VERSION:2.0')).toBe('VERSION:2.0');
  });
});

describe('buildCalendar', () => {
  it('is a valid, named calendar even with no jobs', () => {
    const text = buildCalendar([], { now: NOW, appUrl: APP_URL });
    const check = validateIcs(text);
    expect(check.errors).toEqual([]);
    expect(check.events).toEqual([]);
    expect(unescapeText(prop(check.calendar!, 'X-WR-CALNAME')!.value)).toBe('LienClock deadlines');
    expect(prop(check.calendar!, 'METHOD')!.value).toBe('PUBLISH');
  });

  it('writes all-day events with an exclusive DTEND, across a year boundary', async () => {
    const saved = await job({ firstFurnishDate: '2026-12-11' }); // CA notice due 2026-12-31
    const check = validateIcs(buildCalendar([saved], { now: NOW, appUrl: APP_URL }));
    expect(check.errors).toEqual([]);
    const [event] = check.events;
    expect(prop(event, 'DTSTART')!.value).toBe('20261231');
    expect(prop(event, 'DTEND')).toMatchObject({ params: { VALUE: 'DATE' }, value: '20270101' });
    expect(prop(event, 'DTSTAMP')!.value).toBe('20260314T160000Z');
    expect(prop(event, 'TRANSP')!.value).toBe('TRANSPARENT');
  });

  it('puts the status in the summary and the statute, note and disclaimer in the description', async () => {
    const saved = await job();
    const [notice] = validateIcs(buildCalendar([saved], { now: NOW, appUrl: APP_URL })).events;
    expect(unescapeText(prop(notice, 'SUMMARY')!.value)).toBe('[At risk] CA Preliminary 20-day notice — Acme Builders');
    const description = unescapeText(prop(notice, 'DESCRIPTION')!.value);
    expect(description).toContain('Cal. Civ. Code § 8204');
    expect(description).toContain('https://leginfo.legislature.ca.gov/');
    expect(description).toContain('last verified 2026-10-25');
    expect(description).toContain('Serve the owner');
    expect(description).toMatch(/not legal advice/i);
    expect(description).toContain(`${APP_URL}/jobs/${saved.id}`);
  });

  it('marks served notices and missed deadlines', async () => {
    const served = await job();
    const key = 'ca-preliminary-notice';
    await markDeadlineDone(db, served.id, key, '2026-03-10', { today: '2026-03-14' });
    const missed = await job({ firstFurnishDate: '2026-01-02' }); // due 2026-01-22, nothing served
    const events = validateIcs(buildCalendar([(await getJob(db, served.id))!, missed], { now: NOW, appUrl: APP_URL })).events;
    const summaries = events.map((e) => unescapeText(prop(e, 'SUMMARY')!.value)).sort();
    expect(summaries).toEqual([
      '[Missed] CA Preliminary 20-day notice — Acme Builders',
      '[Protected] CA Preliminary 20-day notice — Acme Builders',
    ]);
  });

  it('skips a job whose stored data can no longer be computed instead of failing the whole feed', async () => {
    const good = await job();
    const broken = { ...good, id: '00000000-0000-4000-8000-000000000000', state: 'OR' } as unknown as StoredJob;
    const check = validateIcs(buildCalendar([broken, good], { now: NOW, appUrl: APP_URL }));
    expect(check.errors).toEqual([]);
    expect(check.events).toHaveLength(1);
  });
});

describe('handleCalendarFeed', () => {
  it('serves the account calendar with private, non-indexed caching headers', async () => {
    await job();
    const res = await feed(`${account.feedToken}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('content-disposition')).toBe('inline; filename="lienclock.ics"');
    expect(validateIcs(await res.text()).events).toHaveLength(1);
  });

  it('accepts the token without the .ics suffix', async () => {
    expect((await feed(account.feedToken)).status).toBe(200);
  });

  it('returns 404 for malformed tokens without touching the database', async () => {
    let touched = false;
    const spy = async () => {
      touched = true;
      return db;
    };
    for (const bad of ['', 'x.ics', `${account.feedToken}x.ics`, "' OR 1=1 --", '../../etc/passwd']) {
      expect((await feed(bad, spy)).status).toBe(404);
    }
    expect(touched).toBe(false);
  });

  it('returns 404 for an unknown token and for the old token after a reset', async () => {
    const unknown = 'A'.repeat(43);
    expect((await feed(`${unknown}.ics`)).status).toBe(404);
    const old = account.feedToken;
    const rotated = await rotateFeedToken(db, account.id);
    expect(rotated!.feedToken).not.toBe(old);
    expect((await feed(`${old}.ics`)).status).toBe(404);
    expect((await feed(`${rotated!.feedToken}.ics`)).status).toBe(200);
  });

  it('answers 500 without details when the database fails', async () => {
    const res = await feed(`${account.feedToken}.ics`, async () => Promise.reject(new Error('connection refused at 10.0.0.5')));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('10.0.0.5');
  });
});

describe('feedUrls', () => {
  it('gives an https URL and a webcal:// subscribe link', () => {
    expect(feedUrls(account, APP_URL)).toEqual({
      https: `${APP_URL}/calendar/${account.feedToken}.ics`,
      webcal: `webcal://lienclock.example/calendar/${account.feedToken}.ics`,
    });
    expect(feedUrls(account, 'http://localhost:3000').webcal).toBe(`webcal://localhost:3000/calendar/${account.feedToken}.ics`);
  });
});
