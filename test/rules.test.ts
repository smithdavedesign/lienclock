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
  /** Pick one rule when a state has several of this kind (default: the earliest date of the kind). */
  rule?: string;
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

  // M3 states. "N months" lands on the same day N months later, or that month's last day when it
  // is shorter (the earlier reading; C.R.S. § 2-4-108(3) says the same for Colorado).

  // CO — lien statement: before 4 months after last furnishing (C.R.S. § 38-22-109(5)); notice of
  // intent: at least 10 days before filing (§ 38-22-109(3)), so 4 months less 10 days.
  { state: 'CO', kind: 'lien', from: '2026-01-10', expected: '2026-05-10', why: '4 months' },
  { state: 'CO', kind: 'lien', from: '2026-09-15', expected: '2027-01-15', why: '4 months across year end' },
  { state: 'CO', kind: 'lien', from: '2026-10-31', expected: '2027-02-28', why: 'no Feb 31: month end' },
  { state: 'CO', kind: 'lien', from: '2027-10-31', expected: '2028-02-29', why: 'no Feb 31: leap month end' },
  { state: 'CO', kind: 'notice', from: '2026-01-10', expected: '2026-04-30', why: '4 months less 10 days' },
  { state: 'CO', kind: 'notice', from: '2026-10-31', expected: '2027-02-18', why: 'month end, less 10 days' },

  // GA — claim of lien: 90 days after last furnishing (O.C.G.A. § 44-14-361.1(a)(2)).
  { state: 'GA', kind: 'lien', from: '2026-01-10', expected: '2026-04-10', why: '90 days' },
  { state: 'GA', kind: 'lien', from: '2026-05-01', expected: '2026-07-30', why: '90 days in summer' },
  { state: 'GA', kind: 'lien', from: '2026-12-15', expected: '2027-03-15', why: 'across year end' },
  { state: 'GA', kind: 'lien', from: '2027-12-15', expected: '2028-03-14', why: 'across leap February' },
  { state: 'GA', kind: 'lien', from: '2026-08-31', expected: '2026-11-29', why: 'from a month end' },

  // IL — subcontractor's notice: within 90 days after completion (770 ILCS 60/24); claim for lien:
  // within 4 months after completion to bind third parties (770 ILCS 60/7).
  { state: 'IL', kind: 'notice', from: '2026-01-10', expected: '2026-04-10', why: '90 days' },
  { state: 'IL', kind: 'notice', from: '2026-08-31', expected: '2026-11-29', why: '90 days from a month end' },
  { state: 'IL', kind: 'lien', from: '2026-01-10', expected: '2026-05-10', why: '4 months' },
  { state: 'IL', kind: 'lien', from: '2026-03-31', expected: '2026-07-31', why: '4 months, 31-day months' },
  { state: 'IL', kind: 'lien', from: '2026-10-31', expected: '2027-02-28', why: 'no Feb 31' },
  { state: 'IL', kind: 'lien', from: '2027-10-30', expected: '2028-02-29', why: 'no Feb 30 in a leap year' },

  // MN — prelien notice: 45 days after first furnishing (Minn. Stat. § 514.011 subd. 2); lien
  // statement: 120 days after last furnishing (§ 514.08 subd. 1).
  { state: 'MN', kind: 'notice', from: '2026-03-01', expected: '2026-04-15', why: '45 days' },
  { state: 'MN', kind: 'notice', from: '2026-12-01', expected: '2027-01-15', why: '45 days across year end' },
  { state: 'MN', kind: 'lien', from: '2026-01-10', expected: '2026-05-10', why: '120 days' },
  { state: 'MN', kind: 'lien', from: '2026-09-01', expected: '2026-12-30', why: '120 days in the fall' },
  { state: 'MN', kind: 'lien', from: '2027-11-01', expected: '2028-02-29', why: 'lands on leap day' },

  // NJ — lien claim: 90 days after the last work or materials (N.J.S.A. 2A:44A-6).
  { state: 'NJ', kind: 'lien', from: '2026-03-15', expected: '2026-06-13', why: '90 days' },
  { state: 'NJ', kind: 'lien', from: '2026-10-31', expected: '2027-01-29', why: '90 days across year end' },
  { state: 'NJ', kind: 'lien', from: '2026-01-10', expected: '2026-04-10', why: '90 days in winter' },
  { state: 'NJ', kind: 'lien', from: '2026-06-30', expected: '2026-09-28', why: 'across two 31-day months' },
  { state: 'NJ', kind: 'lien', from: '2026-11-15', expected: '2027-02-13', why: 'across February' },

  // NY — notice of lien: within 8 months after the last item of work or materials (Lien Law § 10).
  { state: 'NY', kind: 'lien', from: '2026-01-10', expected: '2026-09-10', why: '8 months' },
  { state: 'NY', kind: 'lien', from: '2026-05-31', expected: '2027-01-31', why: '8 months across year end' },
  { state: 'NY', kind: 'lien', from: '2026-06-30', expected: '2027-02-28', why: 'no Feb 30' },
  { state: 'NY', kind: 'lien', from: '2027-06-30', expected: '2028-02-29', why: 'no Feb 30 in a leap year' },
  { state: 'NY', kind: 'lien', from: '2026-07-31', expected: '2027-03-31', why: 'month end to month end' },

  // OH — Notice of Furnishing: 21 days after first furnishing (R.C. 1311.05); lien affidavit:
  // 75 days after last furnishing on a commercial job (R.C. 1311.06(B)(3)).
  { state: 'OH', kind: 'notice', from: '2026-03-01', expected: '2026-03-22', why: '21 days' },
  { state: 'OH', kind: 'notice', from: '2026-12-20', expected: '2027-01-10', why: '21 days across year end' },
  { state: 'OH', kind: 'notice', from: '2028-02-15', expected: '2028-03-07', why: '21 days across leap February' },
  { state: 'OH', kind: 'lien', from: '2026-01-10', expected: '2026-03-26', why: '75 days' },
  { state: 'OH', kind: 'lien', from: '2026-11-01', expected: '2027-01-15', why: '75 days across year end' },

  // PA — Notice of Furnishing: 45 days after first furnishing (49 P.S. § 1501.3); notice of
  // intent: 30 days before filing (§ 1501(b.1)); lien claim: 6 months after completion (§ 1502(a)(1)).
  { state: 'PA', kind: 'notice', from: '2026-03-01', expected: '2026-04-15', why: 'Notice of Furnishing, 45 days' },
  { state: 'PA', kind: 'notice', from: '2026-01-10', expected: '2026-06-10', why: '6 months less 30 days', rule: 'pa-notice-of-intent' },
  { state: 'PA', kind: 'notice', from: '2026-08-31', expected: '2027-01-29', why: 'Feb 28, less 30 days', rule: 'pa-notice-of-intent' },
  { state: 'PA', kind: 'lien', from: '2026-01-10', expected: '2026-07-10', why: '6 months' },
  { state: 'PA', kind: 'lien', from: '2026-08-31', expected: '2027-02-28', why: 'no Feb 31' },
  { state: 'PA', kind: 'lien', from: '2027-08-31', expected: '2028-02-29', why: 'no Feb 31 in a leap year' },

  // UT — preliminary notice: 20 days after starting work (Utah Code § 38-1a-501); notice of lien:
  // 180 days after final completion (§ 38-1a-502), counted from last furnishing, which is never later.
  { state: 'UT', kind: 'notice', from: '2026-03-01', expected: '2026-03-21', why: '20 days' },
  { state: 'UT', kind: 'notice', from: '2026-07-25', expected: '2026-08-14', why: '20 days across month end' },
  { state: 'UT', kind: 'lien', from: '2026-01-10', expected: '2026-07-09', why: '180 days' },
  { state: 'UT', kind: 'lien', from: '2026-09-01', expected: '2027-02-28', why: '180 days across year end' },
  { state: 'UT', kind: 'lien', from: '2027-09-01', expected: '2028-02-28', why: '180 days, leap year' },

  // VA — memorandum of lien: 90 days after last furnishing (the earlier, safe reading of Va. Code § 43-4).
  { state: 'VA', kind: 'lien', from: '2026-01-10', expected: '2026-04-10', why: '90 days' },
  { state: 'VA', kind: 'lien', from: '2026-05-01', expected: '2026-07-30', why: '90 days in summer' },
  { state: 'VA', kind: 'lien', from: '2026-12-15', expected: '2027-03-15', why: 'across year end' },
  { state: 'VA', kind: 'lien', from: '2027-12-15', expected: '2028-03-14', why: 'across leap February' },
  { state: 'VA', kind: 'lien', from: '2026-08-31', expected: '2026-11-29', why: 'from a month end' },
];

function earliestOfKind(state: StateCode, kind: DeadlineKind, from: string, rule?: string) {
  const deadlines = computeDeadlines(
    { state, role: 'sub', projectType: 'commercial', counterparty: 'Fixture GC', firstFurnishDate: from, lastFurnishDate: from },
    { today: from },
  );
  const matching = deadlines
    .filter((d) => d.kind === kind && (rule === undefined || d.ruleId === rule))
    .map((d) => d.date)
    .sort();
  return matching[0];
}

describe('statute-derived fixtures', () => {
  it.each(FIXTURES)('$state $kind from $from → $expected ($why)', ({ state, kind, from, expected, rule }) => {
    expect(earliestOfKind(state, kind, from, rule)).toBe(expected);
  });

  it('has at least 5 fixtures for every supported state', () => {
    for (const state of SUPPORTED_STATES) {
      expect(FIXTURES.filter((f) => f.state === state).length, state).toBeGreaterThanOrEqual(5);
    }
  });
});

describe('rules table', () => {
  it('covers exactly the 6 M1 states and the 10 added in M3, for commercial subcontractors', () => {
    expect([...SUPPORTED_STATES].sort()).toEqual(
      ['AZ', 'CA', 'CO', 'FL', 'GA', 'IL', 'MN', 'NJ', 'NV', 'NY', 'OH', 'PA', 'TX', 'UT', 'VA', 'WA'],
    );
    for (const state of SUPPORTED_STATES) {
      const rules = rulesFor(state, 'sub', 'commercial');
      expect(rules.some((r) => r.kind === 'lien'), `${state} lien rule`).toBe(true);
    }
    // No preliminary notice for a first-tier sub on a commercial job in these states.
    for (const state of ['WA', 'GA', 'NJ', 'NY', 'VA'] as const) {
      expect(rulesFor(state, 'sub', 'commercial').some((r) => r.kind === 'notice'), state).toBe(false);
    }
    // NC and MI are deliberately not covered (see BUILD.md): their late-notice rules don't fit the statuses.
    expect(SUPPORTED_STATES).not.toContain('NC');
    expect(SUPPORTED_STATES).not.toContain('MI');
  });

  it('dates every M3 rule 2026-11-08 and leaves every M1 rule as it was verified', () => {
    for (const rule of RULES.rules) {
      expect(rule.lastVerified, rule.id).toBe(['CA', 'TX', 'FL', 'WA', 'AZ', 'NV'].includes(rule.state) ? '2026-10-25' : '2026-11-08');
    }
    expect(RULES.version).toBe('2026-11-08');
  });

  it('protects a late notice the way each statute says', () => {
    const late = (state: StateCode, first: string, served: string) => {
      const job = { state, role: 'sub', projectType: 'commercial', counterparty: 'GC', firstFurnishDate: first } as const;
      const notice = computeDeadlines(job, { today: first }).find((d) => d.kind === 'notice')!;
      return computeDeadlines({ ...job, done: { [notice.key]: served } }, { today: served }).find((d) => d.key === notice.key)!;
    };
    // Ohio: work in the 21 days before a late Notice of Furnishing, and after.
    expect(late('OH', '2026-03-01', '2026-04-10')).toMatchObject({ status: 'partial', protectedFrom: '2026-03-20' });
    // Utah: a late preliminary notice covers only work from 5 days after it is filed.
    expect(late('UT', '2026-03-01', '2026-04-10')).toMatchObject({ status: 'partial', protectedFrom: '2026-04-15' });
    // Minnesota: no prelien notice, no lien.
    expect(late('MN', '2026-03-01', '2026-04-20')).toMatchObject({ status: 'missed' });
    // On time: everything from first furnishing.
    expect(late('UT', '2026-03-01', '2026-03-15')).toMatchObject({ status: 'protected', protectedFrom: '2026-03-01' });
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
      ['zero months', { offset: { unit: 'months', months: 0 } }],
      ['fractional months', { offset: { unit: 'months', months: 1.5 } }],
      ['months with a huge day shift', { offset: { unit: 'months', months: 4, days: -400 } }],
      ['months with fractional days', { offset: { unit: 'months', months: 4, days: 0.5 } }],
      ['fractional look-back', { lateLookbackDays: 2.5 }],
      ['look-back beyond a year', { lateLookbackDays: -400 }],
      ['unknown offset unit', { offset: { unit: 'weeks', weeks: 3 } }],
    ])('%s', (_label, patch) => {
      expect(() => validateRuleSet(withRule(patch))).toThrow();
    });

    it('duplicate ids', () => {
      expect(() => validateRuleSet({ ...rawRules, rules: [good.rules[0], good.rules[0]] })).toThrow(/duplicate/i);
    });
  });
});
