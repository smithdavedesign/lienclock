import { describe, expect, it } from 'vitest';
import { parseDoneDate, parseJobForm } from '@/lib/jobInput';

const valid = {
  state: 'CA',
  counterparty: '  Acme Builders  ',
  firstFurnishDate: '2026-03-01',
  lastFurnishDate: '',
  alertEmail: ' office@example.com ',
};

describe('parseJobForm', () => {
  it('accepts a valid job and normalises it', () => {
    const result = parseJobForm(valid, { requireEmail: true });
    expect(result).toEqual({
      ok: true,
      value: {
        state: 'CA',
        role: 'sub',
        projectType: 'commercial',
        counterparty: 'Acme Builders',
        firstFurnishDate: '2026-03-01',
        lastFurnishDate: null,
        alertEmail: 'office@example.com',
      },
    });
  });

  it('accepts lowercase state codes and an optional last-furnishing date', () => {
    const result = parseJobForm({ ...valid, state: 'tx', lastFurnishDate: '2026-04-02' }, { requireEmail: false });
    expect(result.ok && result.value.state).toBe('TX');
    expect(result.ok && result.value.lastFurnishDate).toBe('2026-04-02');
  });

  it('does not require an email for the calculator', () => {
    const result = parseJobForm({ ...valid, alertEmail: '' }, { requireEmail: false });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.alertEmail).toBeUndefined();
  });

  it.each([
    ['state', { state: '' }, /state/i],
    ['state', { state: 'OR' }, /CA, TX, FL, WA, AZ, NV/],
    ['counterparty', { counterparty: '   ' }, /GC or owner/i],
    ['counterparty', { counterparty: 'x'.repeat(121) }, /120/],
    ['firstFurnishDate', { firstFurnishDate: '' }, /first/i],
    ['firstFurnishDate', { firstFurnishDate: '2026-02-30' }, /valid date/i],
    ['firstFurnishDate', { firstFurnishDate: '1999-12-31' }, /2000/],
    ['lastFurnishDate', { lastFurnishDate: '2026-02-01' }, /on or after/i],
    ['lastFurnishDate', { lastFurnishDate: '03/05/2026' }, /valid date/i],
    ['alertEmail', { alertEmail: '' }, /email/i],
    ['alertEmail', { alertEmail: 'not-an-email' }, /email/i],
    ['alertEmail', { alertEmail: `${'a'.repeat(250)}@example.com` }, /email/i],
  ])('reports a %s error', (field, patch, message) => {
    const result = parseJobForm({ ...valid, ...patch }, { requireEmail: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[field]).toMatch(message);
  });

  it('collects several errors at once', () => {
    const result = parseJobForm({}, { requireEmail: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors).sort()).toEqual(['alertEmail', 'counterparty', 'firstFurnishDate', 'state']);
  });

  it('strips control characters so names cannot inject email headers', () => {
    const result = parseJobForm({ ...valid, counterparty: 'Acme\r\nBcc: victim@example.com' }, { requireEmail: true });
    expect(result.ok && result.value.counterparty).toBe('Acme Bcc: victim@example.com');
  });

  it('rejects an email with header-breaking characters', () => {
    const result = parseJobForm({ ...valid, alertEmail: 'a@example.com\nBcc: b@example.com' }, { requireEmail: true });
    expect(result.ok).toBe(false);
  });
});

describe('parseDoneDate', () => {
  it('accepts a past or same-day date', () => {
    expect(parseDoneDate('2026-04-10', '2026-04-10')).toEqual({ ok: true, value: '2026-04-10' });
  });

  it('treats an empty value as "clear"', () => {
    expect(parseDoneDate('', '2026-04-10')).toEqual({ ok: true, value: null });
    expect(parseDoneDate(undefined, '2026-04-10')).toEqual({ ok: true, value: null });
  });

  it('rejects invalid and future dates', () => {
    expect(parseDoneDate('2026-04-31', '2026-05-10').ok).toBe(false);
    expect(parseDoneDate('2026-04-11', '2026-04-10')).toEqual({ ok: false, error: expect.stringMatching(/future/i) });
  });
});
