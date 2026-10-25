import { computeDeadlines, pendingRules } from '@/lib/deadlines';
import { parseJobForm, type JobForm } from '@/lib/jobInput';
import { saveJob } from './actions';
import { DeadlineTable } from './DeadlineTable';
import { JobFields } from './JobFields';
import { currentAccount } from './session';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// The calculator is a plain GET form: no database, no JavaScript needed, shareable URLs.
export default async function CalculatorPage({ searchParams }: { searchParams: SearchParams }) {
  const [params, account] = await Promise.all([searchParams, currentAccount()]);
  const form: JobForm = {
    state: first(params.state),
    counterparty: first(params.counterparty),
    firstFurnishDate: first(params.firstFurnishDate),
    lastFurnishDate: first(params.lastFurnishDate),
  };
  const submitted = Object.values(form).some(Boolean);
  const parsed = submitted ? parseJobForm(form, { requireEmail: false }) : null;
  const errors = parsed && !parsed.ok ? parsed.errors : {};
  const job = parsed?.ok ? parsed.value : null;
  const pending = job ? pendingRules(job) : [];

  return (
    <>
      <h1>Which lien clocks just started?</h1>
      <p className="lede">
        Enter a job to see every preliminary-notice and lien deadline it triggers, with the statute behind each date. Save it
        to get email alerts 14, 7 and 2 days before each deadline, and on the day.
      </p>

      <form method="get" action="/" className="job-form">
        <JobFields values={form} errors={errors} />
        <button type="submit">Show deadlines</button>
        <fieldset className="save">
          <legend>Get alerts</legend>
          {account ? (
            <p>
              Alerts go to <strong>{account.email}</strong>. The job is saved to <a href="/jobs">your jobs</a>.
            </p>
          ) : (
            <>
              <label>
                Email for alerts
                <input type="email" name="alertEmail" autoComplete="email" maxLength={254} aria-describedby="email-error" />
                {first(params.emailError) && (
                  <span className="error" id="email-error">
                    Enter a valid email address to save the job.
                  </span>
                )}
              </label>
              <p className="hint">
                We email you a link to confirm the address. Your job is saved, and your account created, when you click it.
              </p>
            </>
          )}
          <button type="submit" formAction={saveJob}>
            Save &amp; email me alerts
          </button>
        </fieldset>
      </form>

      {job && (
        <section aria-labelledby="deadlines-heading">
          <h2 id="deadlines-heading">Deadlines for your job with {job.counterparty}</h2>
          <DeadlineTable deadlines={computeDeadlines(job)} />
          {pending.length > 0 && (
            <p className="pending">Add your last furnishing date to see: {pending.map((r) => r.title).join(', ')}.</p>
          )}
        </section>
      )}
    </>
  );
}
