// Loads and validates the versioned rules table in rules/rules.json.
import rawRules from '../../rules/rules.json';
import { isIsoDate } from './dates';

export const SUPPORTED_STATES = ['CA', 'TX', 'FL', 'WA', 'AZ', 'NV'] as const;
export type StateCode = (typeof SUPPORTED_STATES)[number];
export const ROLES = ['sub'] as const;
export type Role = (typeof ROLES)[number];
export const PROJECT_TYPES = ['commercial'] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];
export const RULE_KINDS = ['notice', 'lien'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];
/** firstFurnish / lastFurnish: one deadline from that date. eachFurnishMonth: one per month furnished (TX). */
export const TRIGGERS = ['firstFurnish', 'lastFurnish', 'eachFurnishMonth'] as const;
export type Trigger = (typeof TRIGGERS)[number];

export type Offset = { unit: 'days'; days: number } | { unit: 'monthDay'; months: number; day: number };

export interface Rule {
  id: string;
  state: StateCode;
  role: Role;
  projectType: ProjectType;
  kind: RuleKind;
  title: string;
  trigger: Trigger;
  offset: Offset;
  /** A late notice still protects work furnished this many days before it was served (CA, AZ, NV). */
  lateLookbackDays?: number;
  citation: string;
  citationUrl: string;
  lastVerified: string;
  note: string;
}

export interface StateInfo {
  name: string;
  timeZone: string;
}

export interface RuleSet {
  version: string;
  scope: string;
  verification: string;
  states: Record<StateCode, StateInfo>;
  rules: Rule[];
}

const includes = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

const positiveInt = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;

function validateOffset(offset: unknown, where: string): Offset {
  const o = offset as Record<string, unknown> | null;
  if (o?.unit === 'days' && positiveInt(o.days, 3650)) return { unit: 'days', days: o.days };
  if (o?.unit === 'monthDay' && positiveInt(o.months, 120) && positiveInt(o.day, 28) && o.day >= 1) {
    return { unit: 'monthDay', months: o.months, day: o.day };
  }
  throw new Error(`${where}: invalid offset ${JSON.stringify(offset)}`);
}

function validateRule(raw: unknown, states: Record<string, StateInfo>): Rule {
  const r = raw as Record<string, unknown>;
  const where = `rule ${JSON.stringify(r?.id)}`;
  const fail = (what: string): never => {
    throw new Error(`${where}: ${what}`);
  };
  if (!nonEmpty(r?.id)) fail('missing id');
  if (!includes(SUPPORTED_STATES, r.state) || !states[r.state as string]) fail(`unknown state ${JSON.stringify(r.state)}`);
  if (!includes(ROLES, r.role)) fail(`unknown role ${JSON.stringify(r.role)}`);
  if (!includes(PROJECT_TYPES, r.projectType)) fail(`unknown project type ${JSON.stringify(r.projectType)}`);
  if (!includes(RULE_KINDS, r.kind)) fail(`unknown kind ${JSON.stringify(r.kind)}`);
  if (!includes(TRIGGERS, r.trigger)) fail(`unknown trigger ${JSON.stringify(r.trigger)}`);
  if (!nonEmpty(r.title)) fail('missing title');
  if (!nonEmpty(r.citation)) fail('missing citation');
  if (!nonEmpty(r.note)) fail('missing note');
  let url: URL | null = null;
  try {
    url = new URL(String(r.citationUrl));
  } catch {
    fail('citationUrl is not a URL');
  }
  if (url!.protocol !== 'https:') fail('citationUrl must be https');
  if (!isIsoDate(r.lastVerified)) fail('lastVerified must be a YYYY-MM-DD date');
  if (r.lateLookbackDays !== undefined) {
    if (r.kind !== 'notice') fail('lateLookbackDays only applies to notices');
    if (!positiveInt(r.lateLookbackDays, 365)) fail('lateLookbackDays must be a whole number of days');
  }
  return {
    id: r.id as string,
    state: r.state as StateCode,
    role: r.role as Role,
    projectType: r.projectType as ProjectType,
    kind: r.kind as RuleKind,
    title: r.title as string,
    trigger: r.trigger as Trigger,
    offset: validateOffset(r.offset, where),
    ...(r.lateLookbackDays !== undefined ? { lateLookbackDays: r.lateLookbackDays as number } : {}),
    citation: r.citation as string,
    citationUrl: r.citationUrl as string,
    lastVerified: r.lastVerified as string,
    note: r.note as string,
  };
}

/** Throws with a precise message if the rules file is malformed, so a bad edit fails tests and builds. */
export function validateRuleSet(raw: unknown): RuleSet {
  const set = raw as Record<string, unknown>;
  if (!nonEmpty(set?.version)) throw new Error('rules: missing version');
  const states = set.states as Record<string, StateInfo>;
  for (const code of SUPPORTED_STATES) {
    if (!nonEmpty(states?.[code]?.name) || !nonEmpty(states[code].timeZone)) {
      throw new Error(`rules: missing state info for ${code}`);
    }
  }
  if (!Array.isArray(set.rules)) throw new Error('rules: missing rules array');
  const rules = set.rules.map((r) => validateRule(r, states));
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) throw new Error(`rules: duplicate id ${rule.id}`);
    seen.add(rule.id);
  }
  return {
    version: set.version as string,
    scope: String(set.scope ?? ''),
    verification: String(set.verification ?? ''),
    states: states as Record<StateCode, StateInfo>,
    rules,
  };
}

export const RULES: RuleSet = validateRuleSet(rawRules);
export const STATES = RULES.states;

export function isSupportedState(value: unknown): value is StateCode {
  return includes(SUPPORTED_STATES, value);
}

export function rulesFor(state: StateCode, role: Role, projectType: ProjectType): Rule[] {
  return RULES.rules.filter((r) => r.state === state && r.role === role && r.projectType === projectType);
}
