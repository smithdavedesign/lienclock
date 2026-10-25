// The one place that touches the session cookie. Not a 'use server' file on purpose: these helpers
// must never be callable from the browser as server actions.
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, SESSION_DAYS, getSessionAccount, type Account } from '@/lib/auth';
import { getDb } from '@/lib/db';

export async function sessionToken(): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null;
}

/** The signed-in account, or null. No database call for visitors without a session cookie. */
export async function currentAccount(): Promise<Account | null> {
  const token = await sessionToken();
  if (!token) return null;
  return getSessionAccount(await getDb(), token, { now: new Date() });
}

/** The signed-in account, or a redirect to sign in that comes back to `next`. */
export async function requireAccount(next: string): Promise<Account> {
  const account = await currentAccount();
  if (!account) redirect(`/signin?next=${encodeURIComponent(next)}`);
  return account;
}

export async function setSessionCookie(token: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
