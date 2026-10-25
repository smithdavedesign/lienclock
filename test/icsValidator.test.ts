// The RFC 5545 checker behind M2-EC1 must itself reject broken calendars, or "validates" means nothing.
import { describe, expect, it } from 'vitest';
import { prop, unescapeText, validateIcs } from './helpers/icsValidator';

const EVENT = [
  'BEGIN:VEVENT',
  'UID:job-1.notice@lienclock',
  'DTSTAMP:20260314T160000Z',
  'DTSTART;VALUE=DATE:20260321',
  'DTEND;VALUE=DATE:20260322',
  'SUMMARY:Notice for Acme Builders\\, Inc.',
  'END:VEVENT',
];
const calendar = (events: string[][] = [EVENT], head = ['VERSION:2.0', 'PRODID:-//Test//EN']) =>
  ['BEGIN:VCALENDAR', ...head, ...events.flat(), 'END:VCALENDAR'].join('\r\n') + '\r\n';
const withEvent = (replace: (lines: string[]) => string[]) => calendar([replace([...EVENT])]);

describe('validateIcs', () => {
  it('accepts a minimal valid calendar and exposes its events', () => {
    const check = validateIcs(calendar());
    expect(check.errors).toEqual([]);
    expect(check.events).toHaveLength(1);
    expect(unescapeText(prop(check.events[0], 'SUMMARY')!.value)).toBe('Notice for Acme Builders, Inc.');
    expect(prop(check.events[0], 'DTSTART')).toEqual({ name: 'DTSTART', params: { VALUE: 'DATE' }, value: '20260321' });
  });

  it('rejects bare LF line endings and a missing final CRLF', () => {
    expect(validateIcs(calendar().replaceAll('\r\n', '\n')).errors.join()).toMatch(/CRLF/);
    expect(validateIcs(calendar().slice(0, -2)).errors.join()).toMatch(/end with CRLF/);
  });

  it('rejects lines longer than 75 octets but accepts and unfolds folded lines', () => {
    const long = `SUMMARY:${'x'.repeat(80)}`;
    expect(validateIcs(withEvent((l) => [...l.slice(0, 5), long, ...l.slice(6)])).errors.join()).toMatch(/75 octets/);
    const folded = `SUMMARY:${'x'.repeat(60)}\r\n ${'y'.repeat(30)}`;
    const check = validateIcs(withEvent((l) => [...l.slice(0, 5), folded, ...l.slice(6)]));
    expect(check.errors).toEqual([]);
    expect(prop(check.events[0], 'SUMMARY')!.value).toBe(`${'x'.repeat(60)}${'y'.repeat(30)}`);
  });

  it('counts octets, not characters', () => {
    const accented = `SUMMARY:${'é'.repeat(40)}`; // 48 characters, 88 octets
    expect(validateIcs(withEvent((l) => [...l.slice(0, 5), accented, ...l.slice(6)])).errors.join()).toMatch(/75 octets/);
  });

  it('rejects unbalanced components and stray properties', () => {
    expect(validateIcs(calendar().replace('END:VEVENT\r\n', '')).errors.join()).toMatch(/does not close|unclosed/);
    expect(validateIcs(`X-STRAY:1\r\n${calendar()}`).errors.join()).toMatch(/outside any component/);
    expect(validateIcs(calendar() + calendar()).errors.join()).toMatch(/exactly one VCALENDAR/);
  });

  it('requires VERSION:2.0 and PRODID on the calendar', () => {
    expect(validateIcs(calendar([EVENT], ['PRODID:-//Test//EN'])).errors.join()).toMatch(/VERSION/);
    expect(validateIcs(calendar([EVENT], ['VERSION:2.0'])).errors.join()).toMatch(/PRODID/);
  });

  it('requires UID, DTSTAMP and DTSTART on every event, and unique UIDs', () => {
    for (const name of ['UID', 'DTSTAMP', 'DTSTART']) {
      const check = validateIcs(withEvent((l) => l.filter((line) => !line.startsWith(name))));
      expect(check.errors.join()).toContain(`exactly one ${name}`);
    }
    expect(validateIcs(calendar([EVENT, EVENT])).errors.join()).toMatch(/repeats UID/);
    const twice = withEvent((l) => [...l.slice(0, 5), 'SUMMARY:again', ...l.slice(5)]);
    expect(validateIcs(twice).errors.join()).toMatch(/more than one SUMMARY/);
  });

  it('checks DATE values, DTEND ordering and value types', () => {
    const bad = (from: string, to: string) => validateIcs(withEvent((l) => l.map((line) => (line === from ? to : line)))).errors.join();
    expect(bad('DTSTART;VALUE=DATE:20260321', 'DTSTART;VALUE=DATE:20260230')).toMatch(/not a valid DATE/);
    expect(bad('DTEND;VALUE=DATE:20260322', 'DTEND;VALUE=DATE:20260321')).toMatch(/after DTSTART/);
    expect(bad('DTEND;VALUE=DATE:20260322', 'DTEND:20260322T000000Z')).toMatch(/same value type/);
    expect(bad('DTSTAMP:20260314T160000Z', 'DTSTAMP:20260314')).toMatch(/UTC date-time/);
  });

  it('rejects unescaped commas and semicolons in TEXT', () => {
    const bad = (summary: string) =>
      validateIcs(withEvent((l) => l.map((line) => (line.startsWith('SUMMARY') ? `SUMMARY:${summary}` : line)))).errors.join();
    expect(bad('Acme, Inc.')).toMatch(/unescaped TEXT/);
    expect(bad('Acme; Dallas')).toMatch(/unescaped TEXT/);
    expect(bad('trailing backslash \\')).toMatch(/unescaped TEXT/);
    expect(bad('Line one\\nLine two \\; ok')).toBe('');
  });

  it('rejects malformed content lines and control characters', () => {
    expect(validateIcs(withEvent((l) => [...l.slice(0, 5), 'NOT A PROPERTY', ...l.slice(5)])).errors.join()).toMatch(/malformed/);
    expect(validateIcs(withEvent((l) => [...l.slice(0, 5), 'SUMMARY:bell\u0007', ...l.slice(6)])).errors.join()).toMatch(/control/);
  });
});
