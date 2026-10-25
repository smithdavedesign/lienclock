import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getDb } from '@/lib/db';
import { getProposal } from '@/lib/inbound';
import { US_STATES, type IntakeField, type ProposedField } from '@/lib/intake';
import { parseJobForm, type JobForm } from '@/lib/jobInput';
import { isJobId } from '@/lib/jobs';
import { isSupportedState } from '@/lib/rules';
import { confirmProposalAction, discardProposalAction } from '../../actions';
import { JobFields } from '../../JobFields';
import { requireAccount } from '../../session';

export const metadata: Metadata = { title: 'Confirm a job — LienClock', robots: { index: false, follow: false } };

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

function FieldFlag({ field, extra }: { field?: ProposedField; extra?: string }) {
  if (!field) return <span className="flag"><span className="badge badge-missing">Not found in the email</span></span>;
  return (
    <span className="flag">
      <span className="badge badge-unconfirmed">Unconfirmed</span> <span className="source">{`Found in: “${field.source}”`}</span>
      {extra && <span className="error">{extra}</span>}
    </span>
  );
}

// Every value read from an email is a proposal: it is shown flagged "Unconfirmed" next to the text
// it came from, and only the user's confirmation turns it into a job.
export default async function IntakePage({ params, searchParams }: Props) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (!isJobId(id)) notFound();
  const account = await requireAccount(`/intake/${id}`);
  const proposal = await getProposal(await getDb(), account.id, id);
  if (!proposal || proposal.status === 'discarded') notFound();
  if (proposal.status === 'accepted') redirect(proposal.jobId ? `/jobs/${proposal.jobId}` : '/jobs');

  const { fields } = proposal;
  const resubmitted = first(query.invalid) === '1';
  const values: JobForm = resubmitted
    ? {
        state: first(query.state),
        counterparty: first(query.counterparty),
        firstFurnishDate: first(query.firstFurnishDate),
        lastFurnishDate: first(query.lastFurnishDate),
      }
    : {
        state: fields.state?.value,
        counterparty: fields.counterparty?.value,
        firstFurnishDate: fields.firstFurnishDate?.value,
      };
  const parsed = resubmitted ? parseJobForm(values, { requireEmail: false }) : null;
  const errors = parsed && !parsed.ok ? parsed.errors : {};
  const proposedState = fields.state?.value;
  const uncovered =
    proposedState && !isSupportedState(proposedState)
      ? `LienClock doesn’t cover ${US_STATES[proposedState] ?? proposedState} yet.`
      : undefined;
  const flag = (name: IntakeField, extra?: string) => <FieldFlag field={fields[name]} extra={extra} />;

  return (
    <>
      <p>
        <a href="/jobs">← Your jobs</a>
      </p>
      <h1>Confirm the job from this email</h1>
      <p className="lede">
        {proposal.source === 'email' ? 'Forwarded' : 'Pasted'} email
        {proposal.subject ? ` “${proposal.subject}”` : ''}
        {proposal.fromEmail ? ` from ${proposal.fromEmail}` : ''}. LienClock read these fields from it. Check each one
        against the email: nothing is saved, and no alerts start, until you confirm.
      </p>
      <form action={confirmProposalAction} className="job-form">
        <input type="hidden" name="proposalId" value={proposal.id} />
        <JobFields
          values={values}
          errors={errors}
          notes={{
            state: flag('state', uncovered),
            counterparty: flag('counterparty'),
            firstFurnishDate: flag('firstFurnishDate'),
          }}
        />
        <button type="submit">Confirm &amp; save job</button>
      </form>
      <form action={discardProposalAction} className="danger">
        <input type="hidden" name="proposalId" value={proposal.id} />
        <button type="submit">Discard this email</button>
      </form>
    </>
  );
}
