import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeadlineTable } from '@/app/DeadlineTable';
import { computeDeadlines } from '@/lib/deadlines';

const job = {
  state: 'CA',
  role: 'sub',
  projectType: 'commercial',
  counterparty: 'Acme Builders',
  firstFurnishDate: '2026-03-01',
  lastFurnishDate: '2026-05-15',
} as const;

describe('DeadlineTable', () => {
  const deadlines = computeDeadlines(job, { today: '2026-03-14' });
  const html = renderToStaticMarkup(<DeadlineTable deadlines={deadlines} />);

  it('shows every deadline with its date, status, citation link and last-verified date', () => {
    for (const d of deadlines) {
      expect(html).toContain(d.date);
      expect(html).toContain(`href="${d.citationUrl.replaceAll('&', '&amp;')}"`);
      expect(html).toContain(d.citation);
      expect(html).toContain(`Last verified ${d.lastVerified}`);
    }
    expect(html).toContain('At risk');
    expect(html).toContain('7 days left');
  });

  it('opens statute links in a new tab without leaking the opener', () => {
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('shows partial protection with its start date', () => {
    const key = deadlines.find((d) => d.kind === 'notice')!.key;
    const late = computeDeadlines({ ...job, done: { [key]: '2026-04-10' } }, { today: '2026-04-11' });
    const lateHtml = renderToStaticMarkup(<DeadlineTable deadlines={late} />);
    expect(lateHtml).toContain('Partially protected');
    expect(lateHtml).toContain('protects work from 2026-03-21');
  });

  it('renders an empty state', () => {
    expect(renderToStaticMarkup(<DeadlineTable deadlines={[]} />)).toContain('No deadlines yet');
  });
});
