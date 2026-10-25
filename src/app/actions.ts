'use server';
// Thin server actions: parse with the tested helpers in src/lib, write, redirect.
// Errors travel back as short codes (never free text) so URLs can't inject page content.
// Every export here is callable from the browser, so each one checks the session itself, and
// job and proposal writes are scoped to the signed-in account in SQL.
import { redirect } from 'next/navigation';
import {
  deliverSignInLink,
  endSession,
  finishSignIn,
  rotateFeedToken,
  safeNextPath,
  startSignIn,
  type PendingJob,
} from '@/lib/auth';
import { isIsoDate, todayIn } from '@/lib/dates';
import { getDb, type Db } from '@/lib/db';
import { confirmProposal, createProposal, discardProposal } from '@/lib/inbound';
import { proposeJobFromEmail } from '@/lib/intake';
import { parseDoneDate, parseJobForm, type JobForm } from '@/lib/jobInput';
import { createJob, deleteJob, getJob, isJobId, markDeadlineDone, setLastFurnish } from '@/lib/jobs';
import { STATES } from '@/lib/rules';
import { clearSessionCookie, currentAccount, requireAccount, sessionToken, setSessionCookie } from './session';

const JOB_FIELDS = ['state', 'counterparty', 'firstFurnishDate', 'lastFurnishDate'] as const;
const MAX_PASTE = 100_000;

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

function jobForm(formData: FormData): JobForm {
  const form: JobForm = {};
  for (const name of JOB_FIELDS) form[name] = text(formData, name);
  return form;
}

/** The job fields (never the email) as a query string, so a form can show its errors again. */
function jobQuery(form: JobForm): URLSearchParams {
  const query = new URLSearchParams();
  for (const name of JOB_FIELDS) if (form[name]) query.set(name, form[name]!);
  return query;
}

/** Emails a sign-in link (holding a job to save, if any) and shows "check your email". */
async function emailSignInLink(db: Db, email: string, next: string, pendingJob: PendingJob | null): Promise<never> {
  const started = await startSignIn(db, { email, next, pendingJob, now: new Date() });
  if (!started.ok) redirect(`/signin?error=${started.error === 'rate_limited' ? 'rate' : 'email'}`);
  let delivered = true;
  try {
    await deliverSignInLink(process.env, { to: started.email, token: started.token, savingJob: pendingJob !== null });
  } catch (error) {
    console.error('signin: could not send the link:', error instanceof Error ? error.message : error);
    delivered = false;
  }
  redirect(delivered ? `/signin?sent=${pendingJob ? 'job' : '1'}` : '/signin?error=unavailable');
}

export async function saveJob(formData: FormData): Promise<void> {
  const account = await currentAccount();
  const form: JobForm = { ...jobForm(formData), alertEmail: account ? '' : text(formData, 'alertEmail') };
  const parsed = parseJobForm(form, { requireEmail: !account });
  if (!parsed.ok) {
    const back = jobQuery(form);
    if (parsed.errors.alertEmail) back.set('emailError', '1');
    redirect(`/?${back}`);
  }
  const { alertEmail, ...job } = parsed.value;
  const db = await getDb();
  if (account) {
    // Alerts only ever go to the verified account address.
    const saved = await createJob(db, { ...job, alertEmail: account.email, accountId: account.id });
    redirect(`/jobs/${saved.id}`);
  }
  // Signed out: saving is signing up. The job waits in the link until the address is confirmed.
  await emailSignInLink(db, alertEmail!, '/jobs', job);
}

export async function requestSignInAction(formData: FormData): Promise<void> {
  await emailSignInLink(await getDb(), text(formData, 'email'), safeNextPath(text(formData, 'next')), null);
}

export async function finishSignInAction(formData: FormData): Promise<void> {
  const result = await finishSignIn(await getDb(), text(formData, 'token'), { now: new Date() });
  if (!result.ok) redirect('/signin?error=expired');
  await setSessionCookie(result.sessionToken);
  redirect(result.next);
}

export async function signOutAction(): Promise<void> {
  const token = await sessionToken();
  if (token) await endSession(await getDb(), token);
  await clearSessionCookie();
  redirect('/');
}

function jobIdFrom(formData: FormData): string {
  const id = text(formData, 'jobId');
  if (!isJobId(id)) redirect('/jobs');
  return id;
}

export async function updateLastFurnishAction(formData: FormData): Promise<void> {
  const id = jobIdFrom(formData);
  const { id: accountId } = await requireAccount(`/jobs/${id}`);
  const raw = text(formData, 'lastFurnishDate').trim();
  if (raw && !isIsoDate(raw)) redirect(`/jobs/${id}?error=last-date`);
  let updated;
  try {
    updated = await setLastFurnish(await getDb(), id, raw || null, { accountId });
  } catch (e) {
    if (e instanceof Error && /on or after/.test(e.message)) redirect(`/jobs/${id}?error=last-date`);
    throw e;
  }
  if (!updated) redirect('/jobs');
  redirect(`/jobs/${id}`);
}

export async function markDoneAction(formData: FormData): Promise<void> {
  const id = jobIdFrom(formData);
  const { id: accountId } = await requireAccount(`/jobs/${id}`);
  const db = await getDb();
  const job = await getJob(db, id, { accountId });
  if (!job) redirect('/jobs');
  const today = todayIn(STATES[job.state].timeZone);
  const date = parseDoneDate(text(formData, 'doneDate'), today);
  if (!date.ok) redirect(`/jobs/${id}?error=done-date`);
  const result = await markDeadlineDone(db, id, text(formData, 'key'), date.value, { today, accountId });
  redirect(`/jobs/${id}${result.ok ? '' : '?error=done-key'}`);
}

export async function deleteJobAction(formData: FormData): Promise<void> {
  const id = jobIdFrom(formData);
  const { id: accountId } = await requireAccount(`/jobs/${id}`);
  const deleted = await deleteJob(await getDb(), id, { accountId });
  redirect(deleted ? '/jobs?deleted=1' : '/jobs');
}

export async function rotateFeedAction(): Promise<void> {
  const account = await requireAccount('/jobs');
  await rotateFeedToken(await getDb(), account.id);
  redirect('/jobs#calendar');
}

export async function pasteIntakeAction(formData: FormData): Promise<void> {
  const account = await requireAccount('/jobs');
  const pasted = text(formData, 'emailText').slice(0, MAX_PASTE);
  if (!pasted.trim()) redirect('/jobs?error=paste-empty#intake');
  const { fields } = proposeJobFromEmail({ text: pasted });
  const proposal = await createProposal(await getDb(), { accountId: account.id, source: 'paste', subject: '', fields });
  if (!proposal) redirect('/jobs?error=intake-full#intake');
  redirect(`/intake/${proposal.id}`);
}

function proposalIdFrom(formData: FormData): string {
  const id = text(formData, 'proposalId');
  if (!isJobId(id)) redirect('/jobs');
  return id;
}

export async function confirmProposalAction(formData: FormData): Promise<void> {
  const id = proposalIdFrom(formData);
  const account = await requireAccount(`/intake/${id}`);
  const form = jobForm(formData);
  const result = await confirmProposal(await getDb(), account, id, form);
  if (result.ok) redirect(`/jobs/${result.job.id}`);
  if (result.reason === 'invalid') redirect(`/intake/${id}?invalid=1&${jobQuery(form)}`);
  redirect('/jobs');
}

export async function discardProposalAction(formData: FormData): Promise<void> {
  const id = proposalIdFrom(formData);
  const account = await requireAccount(`/intake/${id}`);
  await discardProposal(await getDb(), account.id, id);
  redirect('/jobs');
}
