// Proposes job fields from a forwarded PO or contract email. Pure and deterministic: no LLM, no I/O.
// Every value comes back flagged "unconfirmed" with the text it was read from; nothing becomes a
// job until the user confirms it on the review page (inbound.ts confirmProposal).
//
//   text (or HTML → text) → lines, "> " quoting blanked out → cells (split on wide gaps, " | ", or
//   before a "Label:") → each cell's label: its own "Label:", else the label above it in the block
//     state: job-site address > other address (inside the forward) > subject > text above the forward;
//            billing, vendor and sender addresses never count
//     first-furnish date: start-type label > "start on <date>" sentence > delivery-type label
//     GC: general contractor > contractor / customer / buyer > bill-to name
import { isIsoDate } from './dates';
import { MAX_COUNTERPARTY } from './jobInput';

export const INTAKE_FIELDS = ['state', 'counterparty', 'firstFurnishDate'] as const;
export type IntakeField = (typeof INTAKE_FIELDS)[number];

export interface ProposedField {
  value: string;
  status: 'unconfirmed';
  /** The text the value was read from, for the user to check. */
  source: string;
}

export type ProposedFields = Partial<Record<IntakeField, ProposedField>>;

export interface EmailProposal {
  fields: ProposedFields;
  /** Whether the text contains a forwarded message. */
  forwarded: boolean;
  /** The forwarded message's original sender, if found. */
  originalFrom: string | null;
}

export const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

const MAX_TEXT = 100_000;
const MAX_HTML = 500_000;
const MAX_SOURCE = 160;
const MAX_CELLS_PER_LINE = 20;
/** Enough text after "start on" to hold any date form. */
const DATE_WINDOW = 80;
// C0/C1 control characters, no-break space and the Unicode line/paragraph separators.
const ODD_SPACE = /[\x00-\x1f\x7f-\xa0\u{2028}\u{2029}]/gu;

// ── HTML → text ────────────────────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (match, ref: string) => {
    if (ref.startsWith('#')) {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return valid ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[ref.toLowerCase()] ?? match;
  });
}

/** Removes <script>, <style>, <head> and <title> blocks in one linear pass (no backtracking regex). */
function dropBlocks(html: string): string {
  const open = /<(script|style|head|title)\b/gi;
  let out = '';
  let from = 0;
  let m: RegExpExecArray | null;
  while ((m = open.exec(html))) {
    out += html.slice(from, m.index);
    const close = new RegExp(`</${m[1]}\\s*>`, 'gi');
    close.lastIndex = open.lastIndex;
    const end = close.exec(html);
    if (!end) return out;
    from = end.index + end[0].length;
    open.lastIndex = from;
  }
  return out + html.slice(from);
}

export function htmlToText(html: string): string {
  return decodeEntities(
    dropBlocks(html.slice(0, MAX_HTML))
      .replace(/\s+/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|tr|li|h[1-6]|table|blockquote|section|article)\s*>/gi, '\n')
      .replace(/<\/t[dh]\s*>/gi, '  ')
      // [^<>] rather than [^>]: a run of unclosed "<" can't make this quadratic.
      .replace(/<[^<>]*>/g, ''),
  )
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

// ── Dates ──────────────────────────────────────────────────────────────────────────────────────

const WEEKDAY = String.raw`(?:(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?\.?,?\s+)?`;
const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const ORDINAL = '(?:st|nd|rd|th)?';
const DATE_FORMS: { re: RegExp; read: (m: RegExpExecArray) => [number, number, number] }[] = [
  { re: new RegExp(String.raw`^\s*${WEEKDAY}(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)`, 'i'), read: (m) => [+m[1], +m[2], +m[3]] },
  {
    re: new RegExp(String.raw`^\s*${WEEKDAY}(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})(?!\d)`, 'i'),
    read: (m) => {
      const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      const [a, b] = [+m[1], +m[2]];
      // US order (month first) unless only day-first can be a real date, e.g. 25/03/2026.
      return a > 12 && b <= 12 ? [year, b, a] : [year, a, b];
    },
  },
  {
    re: new RegExp(String.raw`^\s*${WEEKDAY}${MONTH}\.?\s+(\d{1,2})${ORDINAL},?\s+(\d{4})(?!\d)`, 'i'),
    read: (m) => [+m[3], monthNumber(m[1]), +m[2]],
  },
  {
    re: new RegExp(String.raw`^\s*${WEEKDAY}(\d{1,2})${ORDINAL}\s+${MONTH}\.?,?\s+(\d{4})(?!\d)`, 'i'),
    read: (m) => [+m[3], monthNumber(m[2]), +m[1]],
  },
];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthNumber = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;

/** Reads a date at the start of `text` (ISO, US numeric, or with a month name). Null if none or invalid. */
export function parseLooseDate(text: string): string | null {
  for (const form of DATE_FORMS) {
    const m = form.re.exec(text);
    if (!m) continue;
    const [y, mo, d] = form.read(m);
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return y >= 2000 && y <= 2099 && isIsoDate(iso) ? iso : null;
  }
  return null;
}

// ── Labels ─────────────────────────────────────────────────────────────────────────────────────

const LABEL = /^([A-Za-z][A-Za-z0-9#&./()' -]{0,38}[A-Za-z0-9#).])\s*:\s*(.*)$/;
const LABEL_AHEAD = String.raw`[A-Za-z][A-Za-z0-9#&./()' -]{0,38}[A-Za-z0-9#).]\s*:(?!\/\/)`;
// Cells: three or more spaces, " | ", or two spaces before something that looks like a label.
const CELL_GAP = new RegExp(String.raw`\s{3,}|\s+\|\s+|\s{2}(?=${LABEL_AHEAD})`, 'g');

const SITE_LABEL =
  /^(?:job ?site|job (?:address|location|site address)|project (?:address|location|site)|site(?: address| location)?|ship ?to|ship to address|deliver(?:y)? (?:to|address|location)|work (?:site|location|address)|location(?: of work)?|project)$/;
const EXCLUDED_LABEL =
  /^(?:bill ?to|billing(?: address)?|invoice to|remit(?: to)?|vendor|supplier|sub ?-?contractor|seller|sold by|from|to|cc|bcc|sent|reply ?-?to|mailing address|office(?: address)?|our address|headquarters|corporate office)$/;
const START_LABEL =
  /^(?:(?:estimated|scheduled|anticipated|projected|planned|proposed|target|expected) )?(?:start(?:ing)?(?: date)?|start of work|work start(?: date)?|mobiliz(?:ation|e)(?: date)?|commence(?:ment)?(?: date)?|begin(?:ning)?(?: date)?|on ?-?site date|first (?:day|delivery)(?: date)?|notice to proceed(?: date)?|ntp(?: date)?)$/;
const DELIVERY_LABEL =
  /^(?:(?:requested|required|scheduled|estimated|expected|anticipated) )?(?:delivery(?: date)?|deliver (?:by|on)|ship(?:ping)? date|need(?:ed)? (?:by|on|date)|required (?:by|on|date)|date required|due on ?site)$/;
const START_SENTENCE = /\b(?:start|begin|mobiliz|commenc)[a-z]{0,6}\s+(?:work\s+)?on\s+(?:or\s+about\s+)?/gi;
const GC_LABELS: RegExp[] = [
  /^(?:general contractor|prime contractor|gc|g\.c)$/,
  /^(?:contractor|original contractor|customer|buyer|purchaser|ordered by|issued by|client)$/,
  /^(?:bill ?to|sold to|invoice to)$/,
];

const normalizeLabel = (label: string) => label.toLowerCase().replace(/\s+/g, ' ').replace(/[#.\s]+$/, '');

// ── States ─────────────────────────────────────────────────────────────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ABBRS = Object.keys(US_STATES).join('|');
const NAMES = Object.values(US_STATES)
  .sort((a, b) => b.length - a.length)
  .map(escapeRe)
  .join('|');
const CODE_BY_NAME = new Map(Object.entries(US_STATES).map(([code, name]) => [name.toLowerCase(), code]));
const STATE_PATTERNS: { re: RegExp; code: (m: RegExpExecArray) => string }[] = [
  { re: new RegExp(String.raw`(?:^|[\s,])(${ABBRS})\.?\s+\d{5}(?:-\d{4})?(?!\d)`), code: (m) => m[1] }, // "Tempe, AZ 85281"
  { re: new RegExp(String.raw`,\s*(${ABBRS})\.?\s*$`), code: (m) => m[1] }, // "Tempe, AZ"
  {
    re: new RegExp(String.raw`,\s*(${NAMES})(?=\s+\d{5}(?!\d)|\s*$|\s*[,.;)])`, 'i'), // "Tempe, Arizona 85281"
    code: (m) => CODE_BY_NAME.get(m[1].toLowerCase())!,
  },
];

function findState(text: string): { code: string; index: number } | null {
  for (const { re, code } of STATE_PATTERNS) {
    const m = re.exec(text);
    if (m) return { code: code(m), index: m.index };
  }
  return null;
}

// ── Text → cells ───────────────────────────────────────────────────────────────────────────────

type Zone = 'body' | 'forward' | 'preface' | 'subject';

interface Cell {
  /** The cell as written. */
  text: string;
  /** Text after "Label:" for a labeled cell, else the whole cell. */
  value: string;
  /** Own or inherited label, normalized. */
  label: string | null;
  /** Index of the cell that carries the label (itself when labeled), or -1. */
  owner: number;
  zone: Zone;
  /** For a labeled cell: the first non-empty cell below that inherits its label. */
  below?: Cell;
}

const FORWARD_MARKER =
  /^\s*(?:-{2,}\s*(?:forwarded message|original message)\s*-{2,}|begin forwarded message:?|-{2,}\s*forwarded by\b.*)\s*$/i;

function toLines(text: string): string[] {
  return text
    .slice(0, MAX_TEXT)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) =>
      line
        .replace(/\t/g, '    ')
        .replace(ODD_SPACE, ' ')
        // Blank out "> " quoting but keep the width, so columns still line up.
        .replace(/^[ >]*>/, (quote) => ' '.repeat(quote.length)),
    );
}

function forwardStart(lines: string[]): number {
  const marker = lines.findIndex((line) => FORWARD_MARKER.test(line));
  if (marker !== -1) return marker;
  // Outlook often forwards with just a header block: From: … then Sent:/Date: within a few lines.
  return lines.findIndex(
    (line, i) => /^\s*from:/i.test(line) && lines.slice(i + 1, i + 4).some((next) => /^\s*(?:sent|date):/i.test(next)),
  );
}

function splitCells(line: string): { text: string; offset: number }[] {
  const cells: { text: string; offset: number }[] = [];
  const push = (raw: string, offset: number) => {
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim().replace(/^\|\s*|\s*\|$/g, '');
    if (text) cells.push({ text, offset: offset + lead });
  };
  let from = 0;
  CELL_GAP.lastIndex = 0;
  let m: RegExpExecArray | null;
  // Past MAX_CELLS_PER_LINE the rest of the line is one cell: keeps column matching linear.
  while (cells.length < MAX_CELLS_PER_LINE - 1 && (m = CELL_GAP.exec(line))) {
    push(line.slice(from, m.index), from);
    from = m.index + m[0].length;
  }
  push(line.slice(from), from);
  return cells;
}

function toCells(lines: string[], fwd: number, subject: string): Cell[] {
  const cells: Cell[] = [];
  // Labeled cells of the block's latest labeled line: unlabeled cells below inherit by position.
  let columns: { label: string; offset: number; index: number }[] = [];
  const add = (zone: Zone, line: string) => {
    if (line.trim() === '') {
      columns = [];
      return;
    }
    const labeled: typeof columns = [];
    for (const { text, offset } of splitCells(line)) {
      const index = cells.length;
      const m = LABEL.exec(text);
      if (m && !m[2].startsWith('//')) {
        const label = normalizeLabel(m[1]);
        cells.push({ text, value: m[2].trim(), label, owner: index, zone });
        labeled.push({ label, offset, index });
        continue;
      }
      const left = columns.filter((c) => c.offset <= offset + 2);
      const column = left.length > 0 ? left[left.length - 1] : columns[0];
      const cell: Cell = { text, value: text, label: column?.label ?? null, owner: column?.index ?? -1, zone };
      if (column) cells[column.index].below ??= cell;
      cells.push(cell);
    }
    if (labeled.length > 0) columns = labeled;
  };
  lines.forEach((line, i) => add(fwd === -1 ? 'body' : i < fwd ? 'preface' : 'forward', line));
  if (subject.trim()) {
    columns = [];
    add('subject', `Subject: ${subject.replace(ODD_SPACE, ' ')}`);
  }
  return cells;
}

/** The text a value came from, short enough to show: a window around the match for long cells. */
function sourceOf(text: string, index = 0): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= MAX_SOURCE) return clean;
  const start = Math.max(0, Math.min(index - 60, clean.length - (MAX_SOURCE - 2)));
  const window = clean.slice(start, start + MAX_SOURCE - 2);
  return `${start > 0 ? '…' : ''}${window}${start + window.length < clean.length ? '…' : ''}`;
}

const proposed = (value: string, source: string): ProposedField => ({ value, status: 'unconfirmed', source });

/** The value of a labeled cell, or of the first cell below it when the label stands alone. */
function labeledValue(cells: Cell[], i: number): Cell | null {
  return cells[i].value ? cells[i] : (cells[i].below ?? null);
}

// ── Fields ─────────────────────────────────────────────────────────────────────────────────────

const ZONE_RANK: Record<Zone, number> = { body: 1, forward: 1, subject: 2, preface: 3 };

function proposeState(cells: Cell[]): ProposedField | undefined {
  let best: { rank: number; field: ProposedField } | null = null;
  for (const cell of cells) {
    if (cell.label && EXCLUDED_LABEL.test(cell.label)) continue;
    const rank = cell.label && SITE_LABEL.test(cell.label) ? 0 : ZONE_RANK[cell.zone];
    if (best && best.rank <= rank) continue;
    const found = findState(cell.text);
    if (found) best = { rank, field: proposed(found.code, sourceOf(cell.text, found.index)) };
  }
  return best?.field;
}

function proposeFirstFurnish(cells: Cell[]): ProposedField | undefined {
  const byLabel = (pattern: RegExp) => {
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].owner !== i || !pattern.test(cells[i].label!)) continue;
      const value = labeledValue(cells, i);
      const date = value ? parseLooseDate(value.value) : null;
      if (date) return proposed(date, sourceOf(value!.text));
    }
    return undefined;
  };
  const bySentence = () => {
    for (const cell of cells) {
      for (const m of cell.text.matchAll(START_SENTENCE)) {
        const after = m.index! + m[0].length;
        const date = parseLooseDate(cell.text.slice(after, after + DATE_WINDOW));
        if (date) return proposed(date, sourceOf(cell.text, m.index));
      }
    }
    return undefined;
  };
  return byLabel(START_LABEL) ?? bySentence() ?? byLabel(DELIVERY_LABEL);
}

function cleanName(value: string): string {
  // Cap first: a name is at most MAX_COUNTERPARTY characters, and the patterns below backtrack on long tokens.
  const name = value
    .slice(0, MAX_COUNTERPARTY * 4)
    .replace(/<[^<>]*>/g, ' ')
    .replace(/\S+@\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:|-]+|[\s,;:|-]+$/g, '');
  if (name.length <= MAX_COUNTERPARTY) return name;
  const cut = name.slice(0, MAX_COUNTERPARTY);
  return (cut.lastIndexOf(' ') > 40 ? cut.slice(0, cut.lastIndexOf(' ')) : cut).trim();
}

function proposeCounterparty(cells: Cell[]): ProposedField | undefined {
  for (const pattern of GC_LABELS) {
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].owner !== i || !pattern.test(cells[i].label!)) continue;
      const value = labeledValue(cells, i);
      const name = value ? cleanName(value.value) : '';
      if (/\p{L}/u.test(name)) return proposed(name, sourceOf(value!.text));
    }
  }
  return undefined;
}

export function proposeJobFromEmail(email: { subject?: string | null; text?: string | null; html?: string | null }): EmailProposal {
  const text = email.text?.trim() ? email.text : email.html ? htmlToText(email.html) : '';
  const lines = toLines(text);
  const fwd = forwardStart(lines);
  const cells = toCells(lines, fwd, (email.subject ?? '').slice(0, 500));

  const fields: ProposedFields = {};
  const state = proposeState(cells);
  if (state) fields.state = state;
  const counterparty = proposeCounterparty(cells);
  if (counterparty) fields.counterparty = counterparty;
  const firstFurnishDate = proposeFirstFurnish(cells);
  if (firstFurnishDate) fields.firstFurnishDate = firstFurnishDate;

  const from = fwd === -1 ? undefined : cells.find((c, i) => c.zone === 'forward' && c.owner === i && c.label === 'from');
  return {
    fields,
    forwarded: fwd !== -1,
    originalFrom: from?.value ? from.value.replace(/\s+/g, ' ').slice(0, 200) : null,
  };
}
