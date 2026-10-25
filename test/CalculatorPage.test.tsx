// Renders the real calculator page (a server component) the way Next.js would for a GET request.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import CalculatorPage from '@/app/page';

async function render(params: Record<string, string>) {
  return renderToStaticMarkup(await CalculatorPage({ searchParams: Promise.resolve(params) }));
}

describe('calculator page', () => {
  it('shows the empty form with every supported state', async () => {
    const html = await render({});
    for (const name of ['California', 'Texas', 'Florida', 'Washington', 'Arizona', 'Nevada']) expect(html).toContain(name);
    expect(html).toContain('Show deadlines');
    expect(html).toContain('Save &amp; email me alerts');
    expect(html).not.toContain('<table');
  });

  it('lists the deadlines for a submitted job, with statute links', async () => {
    const html = await render({ state: 'CA', counterparty: 'Acme Builders', firstFurnishDate: '2026-03-01', lastFurnishDate: '' });
    expect(html).toContain('Deadlines for your job with Acme Builders');
    expect(html).toContain('2026-03-21');
    expect(html).toContain('Cal. Civ. Code § 8204');
    expect(html).toContain('Add your last furnishing date to see: Record mechanics lien.');
  });

  it('shows Texas month-by-month notices and the lien deadline', async () => {
    const html = await render({ state: 'TX', counterparty: 'Lone Star GC', firstFurnishDate: '2026-01-05', lastFurnishDate: '2026-02-10' });
    expect(html).toContain('January 2026 work');
    expect(html).toContain('February 2026 work');
    expect(html).toContain('2026-06-15');
  });

  it('shows field errors instead of deadlines for invalid input', async () => {
    const html = await render({ state: 'OR', counterparty: '', firstFurnishDate: '2026-02-30' });
    expect(html).toContain('LienClock covers CA, TX, FL, WA, AZ, NV for now.');
    expect(html).toContain('Enter the GC or owner you are working for.');
    expect(html).toContain('Enter a valid date for the first furnishing date');
    expect(html).not.toContain('<table');
  });

  it('escapes user input', async () => {
    const html = await render({ state: 'CA', counterparty: '<script>alert(1)</script>', firstFurnishDate: '2026-03-01' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('shows the save error flag without echoing the email', async () => {
    const html = await render({ state: 'CA', counterparty: 'Acme', firstFurnishDate: '2026-03-01', emailError: '1' });
    expect(html).toContain('Enter a valid email address to save the job.');
  });
});
