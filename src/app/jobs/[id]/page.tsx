import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { todayIn } from '@/lib/dates';
import { getDb } from '@/lib/db';
import { computeDeadlines, pendingRules } from '@/lib/deadlines';
import { getJob, isJobId } from '@/lib/jobs';
import { STATES } from '@/lib/rules';
import { deleteJobAction, markDoneAction, updateLastFurnishAction } from '../../actions';
import { DeadlineTable } from '../../DeadlineTable';
import { requireAccount } from '../../session';

export const metadata: Metadata = { title: 'Your job — LienClock', robots: { index: false, follow: false } };

const ERRORS: Record<string, string> = {
  'last-date': 'Enter a valid last furnishing date, on or after the first furnishing date.',
  'done-date': 'Enter a valid date that is not in the future.',
  'done-key': 'That deadline could not be updated. Reload the page and try again.',
};

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function JobPage({ params, searchParams }: Props) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (!isJobId(id)) notFound();
  const account = await requireAccount(`/jobs/${id}`);
  // Scoped to the signed-in account: someone else's job is simply not found.
  const job = await getJob(await getDb(), id, { accountId: account.id });
  if (!job) notFound();
  const today = todayIn(STATES[job.state].timeZone);
  const deadlines = computeDeadlines(job, { today });
  const pending = pendingRules(job);
  const error = typeof query.error === 'string' ? ERRORS[query.error] : undefined;

  return (
    <>
      <p>
        <a href="/jobs">← Your jobs</a>
      </p>
      <h1>
        {STATES[job.state].name} job for {job.counterparty}
      </h1>
      <p className="lede">
        First furnished {job.firstFurnishDate}
        {job.lastFurnishDate ? `, last furnished ${job.lastFurnishDate}` : ''}. Alerts go to <strong>{job.alertEmail}</strong> 14,
        7 and 2 days before each open deadline, and on the day.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <DeadlineTable
        deadlines={deadlines}
        action={(d) => (
          <form action={markDoneAction} className="inline">
            <input type="hidden" name="jobId" value={job.id} />
            <input type="hidden" name="key" value={d.key} />
            <input
              type="date"
              name="doneDate"
              defaultValue={d.doneDate ?? ''}
              max={today}
              aria-label={`Date ${d.kind === 'lien' ? 'recorded' : 'served'}: ${d.title}`}
            />
            <button type="submit">Save</button>
          </form>
        )}
      />
      {pending.length > 0 && (
        <p className="pending">Add your last furnishing date to see: {pending.map((r) => r.title).join(', ')}.</p>
      )}

      <form action={updateLastFurnishAction} className="job-form">
        <input type="hidden" name="jobId" value={job.id} />
        <label>
          Last day you furnished labor or materials
          <input type="date" name="lastFurnishDate" defaultValue={job.lastFurnishDate ?? ''} min={job.firstFurnishDate} />
        </label>
        <button type="submit">Update and recompute lien deadlines</button>
      </form>

      <form action={deleteJobAction} className="danger">
        <input type="hidden" name="jobId" value={job.id} />
        <button type="submit">Delete this job and stop alerts</button>
      </form>
    </>
  );
}
