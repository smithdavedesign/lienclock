// A strict RFC 5545 checker for the iCalendar subset LienClock serves. Deliberately independent of
// src/lib/ics.ts: it re-derives each rule from the RFC instead of reusing the serializer's helpers.
export interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

export interface IcsComponent {
  name: string;
  props: IcsProperty[];
  children: IcsComponent[];
}

export interface IcsCheck {
  errors: string[];
  calendar: IcsComponent | null;
  events: IcsComponent[];
}

const KNOWN_CALENDAR_CHILDREN = new Set(['VEVENT', 'VTODO', 'VJOURNAL', 'VFREEBUSY', 'VTIMEZONE']);
// RFC 5545 §3.6.1: properties a VEVENT may carry at most once.
const SINGLE_EVENT_PROPS = [
  'UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'DURATION', 'CLASS', 'CREATED', 'DESCRIPTION', 'GEO',
  'LAST-MODIFIED', 'LOCATION', 'ORGANIZER', 'PRIORITY', 'SEQUENCE', 'STATUS', 'SUMMARY', 'TRANSP',
  'URL', 'RECURRENCE-ID',
];
const TEXT_PROPS = ['SUMMARY', 'DESCRIPTION', 'LOCATION', 'COMMENT', 'X-WR-CALNAME', 'X-WR-CALDESC'];
// TEXT (§3.3.11): backslash, semicolon and comma must be escaped; \n or \N is a newline.
const ESCAPED_TEXT = /^(?:[^\\;,]|\\[\\;,nN])*$/;
const ESCAPED_TEXT_LIST = /^(?:[^\\;]|\\[\\;,nN])*$/;
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;

function parseContentLine(line: string): IcsProperty | null {
  const name = /^[A-Za-z0-9-]+/.exec(line);
  if (!name) return null;
  let i = name[0].length;
  const params: Record<string, string> = {};
  while (line[i] === ';') {
    const param = /^;([A-Za-z0-9-]+)=((?:"[^"]*"|[^";:,]*)(?:,(?:"[^"]*"|[^";:,]*))*)/.exec(line.slice(i));
    if (!param) return null;
    params[param[1].toUpperCase()] = param[2].replace(/^"|"$/g, '');
    i += param[0].length;
  }
  if (line[i] !== ':') return null;
  return { name: name[0].toUpperCase(), params, value: line.slice(i + 1) };
}

function isCalendarDate(value: string): boolean {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function isUtcDateTime(value: string): boolean {
  const m = /^(\d{8})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  return !!m && isCalendarDate(m[1]) && Number(m[2]) < 24 && Number(m[3]) < 60 && Number(m[4]) < 61;
}

export function props(component: IcsComponent, name: string): IcsProperty[] {
  return component.props.filter((p) => p.name === name);
}

export function prop(component: IcsComponent, name: string): IcsProperty | undefined {
  return props(component, name)[0];
}

export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

export function validateIcs(text: string): IcsCheck {
  const errors: string[] = [];
  if (!text.endsWith('\r\n')) errors.push('the calendar must end with CRLF');
  if (/\r(?!\n)|(?<!\r)\n/.test(text)) errors.push('every line must end with CRLF (found a bare CR or LF)');

  const physical = text.split('\r\n');
  if (physical.at(-1) === '') physical.pop();
  physical.forEach((line, i) => {
    if (Buffer.byteLength(line, 'utf8') > 75) errors.push(`line ${i + 1} is longer than 75 octets`);
    if (CONTROL.test(line)) errors.push(`line ${i + 1} contains a control character`);
  });

  // Unfold (§3.1): a line starting with a space or tab continues the previous one.
  const lines: string[] = [];
  for (const line of physical) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (lines.length === 0) errors.push('the first line is a continuation');
      else lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }

  const roots: IcsComponent[] = [];
  const stack: IcsComponent[] = [];
  for (const line of lines) {
    const property = parseContentLine(line);
    if (!property) {
      errors.push(`malformed content line: ${JSON.stringify(line.slice(0, 60))}`);
      continue;
    }
    if (property.name === 'BEGIN') {
      const component: IcsComponent = { name: property.value.toUpperCase(), props: [], children: [] };
      (stack.length > 0 ? stack[stack.length - 1].children : roots).push(component);
      stack.push(component);
    } else if (property.name === 'END') {
      const open = stack.pop();
      if (!open || open.name !== property.value.toUpperCase()) {
        errors.push(`END:${property.value} does not close BEGIN:${open?.name ?? '(nothing)'}`);
      }
    } else if (stack.length === 0) {
      errors.push(`property ${property.name} is outside any component`);
    } else {
      stack[stack.length - 1].props.push(property);
    }
  }
  if (stack.length > 0) errors.push(`unclosed component(s): ${stack.map((c) => c.name).join(', ')}`);

  if (roots.length !== 1 || roots[0].name !== 'VCALENDAR') {
    errors.push('the stream must contain exactly one VCALENDAR');
    return { errors, calendar: null, events: [] };
  }
  const calendar = roots[0];
  const version = props(calendar, 'VERSION');
  if (version.length !== 1 || version[0].value !== '2.0') errors.push('VCALENDAR needs exactly one VERSION:2.0');
  const prodid = props(calendar, 'PRODID');
  if (prodid.length !== 1 || prodid[0].value.trim() === '') errors.push('VCALENDAR needs exactly one non-empty PRODID');
  const calscale = prop(calendar, 'CALSCALE');
  if (calscale && calscale.value !== 'GREGORIAN') errors.push('CALSCALE must be GREGORIAN');
  for (const child of calendar.children) {
    if (!KNOWN_CALENDAR_CHILDREN.has(child.name) && !child.name.startsWith('X-')) {
      errors.push(`unknown component ${child.name} in VCALENDAR`);
    }
  }
  for (const p of calendar.props) {
    if (TEXT_PROPS.includes(p.name) && !ESCAPED_TEXT.test(p.value)) errors.push(`${p.name} has unescaped TEXT`);
  }

  const events = calendar.children.filter((c) => c.name === 'VEVENT');
  const uids = new Set<string>();
  events.forEach((event, n) => {
    const where = `VEVENT #${n + 1}`;
    for (const name of SINGLE_EVENT_PROPS) {
      if (props(event, name).length > 1) errors.push(`${where} has more than one ${name}`);
    }
    for (const required of ['UID', 'DTSTAMP', 'DTSTART']) {
      if (props(event, required).length !== 1) errors.push(`${where} needs exactly one ${required}`);
    }
    const uid = prop(event, 'UID')?.value ?? '';
    if (uid.trim() === '') errors.push(`${where} has an empty UID`);
    if (uids.has(uid)) errors.push(`${where} repeats UID ${uid}`);
    uids.add(uid);

    const stamp = prop(event, 'DTSTAMP');
    if (stamp && !isUtcDateTime(stamp.value)) errors.push(`${where} DTSTAMP must be a UTC date-time`);

    const start = prop(event, 'DTSTART');
    const end = prop(event, 'DTEND');
    const isDate = start?.params.VALUE === 'DATE';
    if (start) {
      if (isDate ? !isCalendarDate(start.value) : !/^\d{8}T\d{6}Z?$/.test(start.value)) {
        errors.push(`${where} DTSTART ${start.value} is not a valid ${isDate ? 'DATE' : 'DATE-TIME'}`);
      }
    }
    if (end && start) {
      if ((end.params.VALUE === 'DATE') !== isDate) errors.push(`${where} DTEND must have the same value type as DTSTART`);
      else if (isDate && !isCalendarDate(end.value)) errors.push(`${where} DTEND is not a valid DATE`);
      else if (end.value <= start.value) errors.push(`${where} DTEND must be after DTSTART`);
    }
    if (end && prop(event, 'DURATION')) errors.push(`${where} cannot have both DTEND and DURATION`);

    for (const p of event.props) {
      if (TEXT_PROPS.includes(p.name) && !ESCAPED_TEXT.test(p.value)) errors.push(`${where} ${p.name} has unescaped TEXT`);
    }
    for (const p of props(event, 'CATEGORIES')) {
      if (!ESCAPED_TEXT_LIST.test(p.value)) errors.push(`${where} CATEGORIES has unescaped TEXT`);
    }
    const status = prop(event, 'STATUS');
    if (status && !['TENTATIVE', 'CONFIRMED', 'CANCELLED'].includes(status.value)) errors.push(`${where} has an invalid STATUS`);
    const transp = prop(event, 'TRANSP');
    if (transp && !['OPAQUE', 'TRANSPARENT'].includes(transp.value)) errors.push(`${where} has an invalid TRANSP`);
    const url = prop(event, 'URL');
    if (url) {
      try {
        new URL(url.value);
      } catch {
        errors.push(`${where} URL is not a URI`);
      }
    }
  });

  return { errors, calendar, events };
}
