// Statute-derived fixtures: PRD success metric "100% of the rule fixtures per state (at least 5
// each) match statute-derived expected dates". Expected dates were counted by hand from the
// statute wording in rules/rules.json (calendar days, no weekend/holiday extension).
import { describe, expect, it } from 'vitest';
import rawRules from '../rules/rules.json';
import { isIsoDate } from '@/lib/dates';
import { computeDeadlines, type DeadlineKind } from '@/lib/deadlines';
import { RULES, STATES, SUPPORTED_STATES, rulesFor, validateRuleSet, type StateCode } from '@/lib/rules';

interface Fixture {
  state: StateCode;
  kind: DeadlineKind;
  /** First furnishing for notices, last furnishing for liens. */
  from: string;
  expected: string;
  why: string;
}

const FIXTURES: Fixture[] = [
  // CA — notice: 20 days after first furnishing (Civ. Code § 8204); lien: 90 days (§ 8414, last-furnish proxy).
  { state: 'CA', kind: 'notice', from: '2026-03-01', expected: '2026-03-21', why: 'roadmap example' },
  { state: 'CA', kind: 'notice', from: '2026-01-15', expected: '2026-02-04', why: 'crosses month end' },
  { state: 'CA', kind: 'notice', from: '2026-12-20', expected: '2027-01-09', why: 'crosses year end' },
  { state: 'CA', kind: 'notice', from: '2028-02-15', expected: '2028-03-06', why: 'leap February' },
  { state: 'CA', kind: 'notice', from: '2026-02-10', expected: '2026-03-02', why: 'non-leap February' },
  { state: 'CA', kind: 'lien', from: '2026-01-10', expected: '2026-04-10', why: '90 days' },
  { state: 'CA', kind: 'lien', from: '2026-06-30', expected: '2026-09-28', why: '90 days across two 31-day months' },
  { state: 'CA', kind: 'lien', from: '2026-11-15', expected: '2027-02-13', why: '90 days across year end' },

  // TX — notice: 15th of the 3rd month after each month furnished (Prop. Code § 53.056);
  // lien: 15th of the 4th month after the month of last furnishing (§ 53.052).
  { state: 'TX', kind: 'notice', from: '2026-01-20', expected: '2026-04-15', why: 'January work' },
  { state: 'TX', kind: 'notice', from: '2026-11-03', expected: '2027-02-15', why: 'November work, next year' },
  { state: 'TX', kind: 'notice', from: '2026-12-31', expected: '2027-03-15', why: 'last day of December' },
  { state: 'TX', kind: 'lien', from: '2026-02-10', expected: '2026-06-15', why: 'roadmap example' },
  { state: 'TX', kind: 'lien', from: '2026-09-30', expected: '2027-01-15', why: 'month end, next year' },
  { state: 'TX', kind: 'lien', from: '2026-10-01', expected: '2027-02-15', why: 'first of month' },
  { state: 'TX', kind: 'lien', from: '2026-12-31', expected: '2027-04-15', why: 'year end' },
  { state: 'TX', kind: 'lien', from: '2026-01-31', expected: '2026-05-15', why: 'day does not matter, only the month' },

  // FL — Notice to Owner: 45 days after commencing (§ 713.06(2)(a)); lien: 90 days after final furnishing (§ 713.08(5)).
  { state: 'FL', kind: 'notice', from: '2026-03-01', expected: '2026-04-15', why: '45 days' },
  { state: 'FL', kind: 'notice', from: '2026-12-01', expected: '2027-01-15', why: '45 days across year end' },
  { state: 'FL', kind: 'notice', from: '2028-01-20', expected: '2028-03-05', why: '45 days across leap February' },
  { state: 'FL', kind: 'lien', from: '2026-03-15', expected: '2026-06-13', why: '90 days' },
  { state: 'FL', kind: 'lien', from: '2026-10-31', expected: '2027-01-29', why: '90 days across year end' },

  // WA — lien: 90 days after ceasing to furnish (RCW 60.04.091). No notice for a first-tier sub.
  { state: 'WA', kind: 'lien', from: '2026-01-10', expected: '2026-04-10', why: 'roadmap example' },
  { state: 'WA', kind: 'lien', from: '2026-05-01', expected: '2026-07-30', why: '90 days' },
  { state: 'WA', kind: 'lien', from: '2026-12-15', expected: '2027-03-15', why: 'across year end' },
  { state: 'WA', kind: 'lien', from: '2027-12-15', expected: '2028-03-14', why: 'across leap February' },
  { state: 'WA', kind: 'lien', from: '2026-08-31', expected: '2026-11-29', why: 'from a month end' },

  // AZ — notice: 20 days after first furnishing (A.R.S. § 33-992.01); lien: 120 days (§ 33-993, last-furnish proxy).
  { state: 'AZ', kind: 'notice', from: '2026-03-01', expected: '2026-03-21', why: '20 days' },
  { state: 'AZ', kind: 'notice', from: '2026-07-25', expected: '2026-08-14', why: 'crosses month end' },
  { state: 'AZ', kind: 'lien', from: '2026-01-10', expected: '2026-05-10', why: '120 days' },
  { state: 'AZ', kind: 'lien', from: '2026-09-01', expected: '2026-12-30', why: '120 days in the fall' },
  { state: 'AZ', kind: 'lien', from: '2027-11-01', expected: '2028-02-29', why: 'lands on leap day' },

  // NV — notice: full protection if given within 31 days of first furnishing (NRS 108.245); lien: 90 days (NRS 108.226).
  { state: 'NV', kind: 'notice', from: '2026-03-01', expected: '2026-04-01', why: '31 days' },
  { state: 'NV', kind: 'notice', from: '2026-12-15', expected: '2027-01-15', why: 'across year end' },
  { state: 'NV', kind: 'notice', from: '2028-02-01', expected: '2028-03-03', why: 'across leap February' },
  { state: 'NV', kind: 'lien', from: '2026-02-01', expected: '2026-05-02', why: '90 days' },
  { state: 'NV', kind: 'lien', from: '2026-07-04', expected: '2026-10-02', why: '90 days in summer' },
];

function earliestOfKind(state: StateCode, kind: DeadlineKind, from: string) {
  const deadlines = computeDeadlines(
    { state, role: 'sub', projectType: 'commercial', counterparty: 'Fixture GC', firstFurnishDate: from, lastFurnishDate: from },
    { today: from },
  );
  const matching = deadlines.filter((d) => d.kind === kind).map((d) => d.date).sort();
  return matching[0];
}

describe('statute-derived fixtures', () => {
  it.each(FIXTURES)('$state $kind from $from → $expected ($why)', ({ state, kind, from, expected }) => {
    expect(earliestOfKind(state, kind, from)).toBe(expected);
  });

  it('has at least 5 fixtures for every supported state', () => {
    for (const state of SUPPORTED_STATES) {
      expect(FIXTURES.filter((f) => f.state === state).length, state).toBeGreaterThanOrEqual(5);
    }
  });
});

describe('rules table', () => {
  it('covers exactly CA, TX, FL, WA, AZ, NV for commercial subcontractors', () => {
    expect([...SUPPORTED_STATES].sort()).toEqual(['AZ', 'CA', 'FL', 'NV', 'TX', 'WA']);
    for (const state of SUPPORTED_STATES) {
      const rules = rulesFor(state, 'sub', 'commercial');
      expect(rules.some((r) => r.kind === 'lien'), `${state} lien rule`).toBe(true);
    }
    expect(rulesFor('WA', 'sub', 'commercial').some((r) => r.kind === 'notice')).toBe(false);
  });

  it('gives every rule a citation, an official https URL and a valid last-verified date', () => {
    expect(RULES.rules.length).toBeGreaterThanOrEqual(11);
    for (const rule of RULES.rules) {
      expect(rule.citation.trim(), rule.id).not.toBe('');
      expect(new URL(rule.citationUrl).protocol, rule.id).toBe('https:');
      expect(isIsoDate(rule.lastVerified), rule.id).toBe(true);
      expect(rule.note.trim(), rule.id).not.toBe('');
    }
  });

  it('uses unique rule ids', () => {
    const ids = RULES.rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('knows a time zone for every state', () => {
    for (const state of SUPPORTED_STATES) {
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: STATES[state].timeZone })).not.toThrow();
    }
  });

  it('accepts the shipped rules file', () => {
    expect(() => validateRuleSet(rawRules)).not.toThrow();
  });

  describe('validateRuleSet rejects malformed rules', () => {
    const good = rawRules as unknown as { rules: Record<string, unknown>[] };
    const withRule = (patch: Record<string, unknown>) => ({
      ...rawRules,
      rules: [{ ...good.rules[0], ...patch }, ...good.rules.slice(1)],
    });

    it.each([
      ['empty citation URL', { citationUrl: '' }],
      ['non-https citation URL', { citationUrl: 'http://example.com/statute' }],
      ['missing last-verified date', { lastVerified: undefined }],
      ['invalid last-verified date', { lastVerified: '2026-02-30' }],
      ['empty citation', { citation: '  ' }],
      ['unknown trigger', { trigger: 'whenever' }],
      ['unknown kind', { kind: 'bond' }],
      ['unknown state', { state: 'ZZ' }],
      ['negative offset', { offset: { unit: 'days', days: -1 } }],
      ['month offset on day 31', { offset: { unit: 'monthDay', months: 1, day: 31 } }],
      ['look-back on a lien rule', { kind: 'lien', lateLookbackDays: 20 }],
    ])('%s', (_label, patch) => {
      expect(() => validateRuleSet(withRule(patch))).toThrow();
    });

    it('duplicate ids', () => {
      expect(() => validateRuleSet({ ...rawRules, rules: [good.rules[0], good.rules[0]] })).toThrow(/duplicate/i);
    });
  });
});
