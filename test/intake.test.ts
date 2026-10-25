import { describe, expect, it } from 'vitest';
import { htmlToText, parseLooseDate, proposeJobFromEmail, US_STATES } from '@/lib/intake';

const propose = (text: string, subject = '') => proposeJobFromEmail({ subject, text });

describe('proposeJobFromEmail: forwarded formats', () => {
  it('reads an Outlook forward ("-----Original Message-----")', () => {
    const proposal = propose(
      [
        'FYI, new one from Lone Star.',
        '',
        '-----Original Message-----',
        'From: Pat Lee <pat@lonestargc.example>',
        'Sent: Tuesday, March 3, 2026 10:02 AM',
        'To: office@ourshop.example',
        'Subject: PO 8831 Riverside Apartments',
        '',
        'Contractor: Lone Star General Contractors',
        'Ship To: 2100 Riverside Dr, Austin, TX 78741',
        'Requested Delivery: 04/06/2026',
      ].join('\r\n'),
    );
    expect(proposal.forwarded).toBe(true);
    expect(proposal.originalFrom).toBe('Pat Lee <pat@lonestargc.example>');
    expect(proposal.fields).toEqual({
      state: { value: 'TX', status: 'unconfirmed', source: 'Ship To: 2100 Riverside Dr, Austin, TX 78741' },
      firstFurnishDate: { value: '2026-04-06', status: 'unconfirmed', source: 'Requested Delivery: 04/06/2026' },
      counterparty: { value: 'Lone Star General Contractors', status: 'unconfirmed', source: 'Contractor: Lone Star General Contractors' },
    });
  });

  it('reads an Apple Mail forward with quoted lines and full state names', () => {
    const proposal = propose(
      [
        'Begin forwarded message:',
        '',
        '> From: Harbor Builders <pm@harbor.example>',
        '> Subject: Award letter',
        '> Date: March 1, 2026 at 8:00:00 AM PST',
        '>',
        '> GC: Harbor Builders Inc.',
        '> Jobsite: 77 Harbor Blvd, Long Beach, California 90802',
        '> Mobilization Date: 2026-05-11',
      ].join('\n'),
    );
    expect(proposal.forwarded).toBe(true);
    expect(proposal.fields.state).toMatchObject({ value: 'CA', status: 'unconfirmed' });
    expect(proposal.fields.firstFurnishDate).toMatchObject({ value: '2026-05-11', status: 'unconfirmed' });
    expect(proposal.fields.counterparty).toMatchObject({ value: 'Harbor Builders Inc.' });
  });

  it('spots an Outlook header block without a marker line', () => {
    const proposal = propose(
      ['From: Sam <sam@gc.example>', 'Sent: Monday, April 6, 2026 9:00 AM', 'To: me@sub.example', 'Subject: PO', '', 'Start: 4/13/2026'].join('\n'),
    );
    expect(proposal.forwarded).toBe(true);
    expect(proposal.fields.firstFurnishDate?.value).toBe('2026-04-13');
  });

  it('still proposes fields for an email that was not forwarded', () => {
    const proposal = propose('Job Site: 9 Desert Rd, Henderson, NV 89052\nStart Date: 06/01/2026');
    expect(proposal.forwarded).toBe(false);
    expect(proposal.originalFrom).toBeNull();
    expect(proposal.fields.state?.value).toBe('NV');
    expect(proposal.fields.firstFurnishDate?.value).toBe('2026-06-01');
  });
});

describe('proposeJobFromEmail: which address is the job site', () => {
  it('prefers the ship-to address over bill-to and vendor addresses in other states', () => {
    const proposal = propose(
      [
        'Bill To: Pacific GC',
        '  350 S Grand Ave, Los Angeles, CA 90071',
        '',
        'Vendor: Our Shop LLC, 1 Main St, Seattle, WA 98101',
        '',
        'Ship To:',
        '  2100 Riverside Dr',
        '  Austin, TX 78741',
      ].join('\n'),
    );
    expect(proposal.fields.state).toEqual({ value: 'TX', status: 'unconfirmed', source: 'Austin, TX 78741' });
  });

  it('proposes no state when only billing and vendor addresses are present', () => {
    const proposal = propose('Bill To: Pacific GC, Los Angeles, CA 90071\nRemit To: Our Shop, Seattle, WA 98101');
    expect(proposal.fields.state).toBeUndefined();
  });

  it('reads side-by-side columns by their position', () => {
    const proposal = propose(
      [
        'Bill To: Pacific GC                          Ship To: Mill Ave Medical',
        '         350 S Grand Ave                              500 S Mill Ave',
        '         Los Angeles, CA 90071                        Tempe, AZ 85281',
      ].join('\n'),
    );
    expect(proposal.fields.state).toMatchObject({ value: 'AZ', source: 'Tempe, AZ 85281' });
  });

  it('prefers an address inside the forwarded message over the forwarder’s own signature', () => {
    const proposal = propose(
      [
        'Can you set this up?',
        'Dana | Brightline Drywall | Las Vegas, NV 89118',
        '',
        '---------- Forwarded message ---------',
        'From: GC <pm@gc.example>',
        '',
        'Thanks for bidding the clinic at 1 Main St, Scottsdale, AZ 85251.',
      ].join('\n'),
    );
    expect(proposal.fields.state?.value).toBe('AZ');
  });

  it('falls back to the subject line', () => {
    expect(proposeJobFromEmail({ subject: 'PO 55 - Clinic, Henderson, NV 89052', text: 'See attached.' }).fields.state?.value).toBe('NV');
  });

  it('flags a state LienClock does not cover yet instead of guessing a covered one', () => {
    const proposal = propose('Job Site: 12 Pine St, Portland, OR 97201\nBill To: GC, Sacramento, CA 95814');
    expect(proposal.fields.state).toMatchObject({ value: 'OR', status: 'unconfirmed' });
    expect(US_STATES.OR).toBe('Oregon');
  });

  it('does not read a company named after a state as an address', () => {
    expect(propose('Contractor: Washington Group International\nNevada Concrete Supply').fields.state).toBeUndefined();
  });
});

describe('proposeJobFromEmail: first-furnish date', () => {
  it('prefers a start date over a delivery date that comes first', () => {
    const proposal = propose('Delivery Date: 05/04/2026\nScheduled Start: 05/11/2026');
    expect(proposal.fields.firstFurnishDate).toMatchObject({ value: '2026-05-11', source: 'Scheduled Start: 05/11/2026' });
  });

  it('uses a delivery date when there is no start date', () => {
    expect(propose('Need By: May 4, 2026').fields.firstFurnishDate?.value).toBe('2026-05-04');
  });

  it('reads the date on the line after a bare label', () => {
    expect(propose('Start Date:\nMonday, March 2, 2026').fields.firstFurnishDate?.value).toBe('2026-03-02');
  });

  it('reads start dates written as a sentence', () => {
    expect(propose('Crews start on April 13, 2026 at 7am.').fields.firstFurnishDate?.value).toBe('2026-04-13');
    expect(propose('We will mobilize on 4/20/26.').fields.firstFurnishDate?.value).toBe('2026-04-20');
  });

  it('ignores PO, sent and completion dates', () => {
    const proposal = propose('PO Date: 02/23/2026\nDate: Mon, Feb 23, 2026\nEstimated Completion: 06/30/2026');
    expect(proposal.fields.firstFurnishDate).toBeUndefined();
  });

  it('ignores impossible dates', () => {
    expect(propose('Start Date: 02/30/2026').fields.firstFurnishDate).toBeUndefined();
  });
});

describe('parseLooseDate', () => {
  it.each([
    ['2026-03-02', '2026-03-02'],
    ['3/2/2026', '2026-03-02'],
    ['03/02/26', '2026-03-02'],
    ['3-2-2026', '2026-03-02'],
    ['March 2, 2026', '2026-03-02'],
    ['Mar. 2, 2026', '2026-03-02'],
    ['March 2nd, 2026', '2026-03-02'],
    ['Sept 14 2026', '2026-09-14'],
    ['2 March 2026', '2026-03-02'],
    ['Monday, March 2, 2026', '2026-03-02'],
    ['Mon, Mar 2, 2026 at 9:14 AM', '2026-03-02'],
    ['25/03/2026', '2026-03-25'], // only readable one way
  ])('reads %s', (input, expected) => {
    expect(parseLooseDate(input)).toBe(expected);
  });

  it.each(['02/30/2026', '13/13/2026', 'March 32, 2026', '1899-01-01', 'soon', '12345', ''])('rejects %s', (input) => {
    expect(parseLooseDate(input)).toBeNull();
  });
});

describe('proposeJobFromEmail: GC or owner', () => {
  it('takes the general contractor over the bill-to name', () => {
    const proposal = propose('Bill To: Accounts Payable Dept\nGeneral Contractor: Desert Ridge Builders, LLC');
    expect(proposal.fields.counterparty?.value).toBe('Desert Ridge Builders, LLC');
  });

  it('never mistakes the subcontractor or vendor for the GC', () => {
    const proposal = propose('Subcontractor: Our Shop Inc.\nVendor: Our Shop Inc.');
    expect(proposal.fields.counterparty).toBeUndefined();
  });

  it('strips email addresses and reads the name from the next line after a bare label', () => {
    expect(propose('Contractor: Big GC Co <pm@biggc.example>').fields.counterparty?.value).toBe('Big GC Co');
    expect(propose('General Contractor:\nSunbelt Builders').fields.counterparty?.value).toBe('Sunbelt Builders');
  });

  it('keeps names within the job form’s 120-character limit', () => {
    const value = propose(`GC: ${'Very Long Name '.repeat(20)}`).fields.counterparty?.value ?? '';
    expect(value.length).toBeLessThanOrEqual(120);
    expect(value.length).toBeGreaterThan(0);
  });
});

describe('proposeJobFromEmail: hostile or empty input', () => {
  it('proposes nothing for an email with no job details', () => {
    expect(propose('Hi, see attached. Thanks!')).toEqual({ fields: {}, forwarded: false, originalFrom: null });
    expect(proposeJobFromEmail({})).toEqual({ fields: {}, forwarded: false, originalFrom: null });
  });

  it('keeps sources short and free of control characters', () => {
    const proposal = propose(`Job Site: ${'x'.repeat(300)} Tempe, AZ 85281\u0007\u001b[31m`);
    const source = proposal.fields.state!.source;
    expect(source.length).toBeLessThanOrEqual(160);
    expect(source).not.toMatch(/\p{Cc}/u);
  });

  it('handles very large bodies quickly', () => {
    const started = Date.now();
    propose(`${'> '.repeat(50_000)}\n${' '.repeat(100_000)}x\n${'Start Date: '.repeat(5_000)}`);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it.each([
    ['thousands of labels with no value', 'GC:\n'.repeat(30_000)],
    ['"start on" over and over in one line', `${'start on '.repeat(11_000)}x`],
    ['very wide lines under very wide lines', `${'Ship To: a    '.repeat(5_000)}\n${'b    '.repeat(20_000)}`],
    ['a huge token after a label', `GC: ${'x'.repeat(99_000)}`],
  ])('stays fast on hostile input: %s', (_label, text) => {
    const started = Date.now();
    propose(text);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('HTML-only emails', () => {
  const html = `<html><head><style>td { color: red }</style><script>alert(1)</script></head><body>
    <p>PO from Desert Ridge Builders &amp; Sons</p>
    <table>
      <tr><td>Job Site:</td><td>500 S Mill Ave, Tempe, AZ&nbsp;85281</td></tr>
      <tr><td>Start Date:</td><td>March 2, 2026</td></tr>
    </table></body></html>`;

  it('converts HTML to text lines without scripts or styles', () => {
    const text = htmlToText(html);
    expect(text).toContain('Desert Ridge Builders & Sons');
    expect(text).toMatch(/Job Site:\s+500 S Mill Ave, Tempe, AZ 85281/);
    expect(text).not.toContain('alert(1)');
    expect(text).not.toContain('color: red');
    expect(htmlToText('&#65;&#x42;&lt;&gt;&quot;&apos;&bogus;&#xFFFFFFF;')).toBe('AB<>"\'&bogus;&#xFFFFFFF;');
  });

  it('proposes fields from the HTML part when there is no text part', () => {
    const proposal = proposeJobFromEmail({ subject: 'PO', text: null, html });
    expect(proposal.fields.state?.value).toBe('AZ');
    expect(proposal.fields.firstFurnishDate?.value).toBe('2026-03-02');
  });

  it('handles unclosed script tags and runs of "<" quickly', () => {
    const started = Date.now();
    htmlToText('<script>'.repeat(20_000));
    htmlToText('<'.repeat(400_000));
    htmlToText(`<p>${'<a'.repeat(200_000)}`);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
