// Per-request state on Cloudflare Workers. One Worker isolate serves many requests at once, and a socket
// opened while serving one request can't be used by another, so the database connection lives here
// instead of in a module-level cache:
//
//   worker.ts fetch/scheduled ─▶ runInRequestScope(scope, …) ─▶ Next.js ─▶ getDb() opens scope.db once
//                              ◀─ response body fully sent ─── closeRequestScope(scope) ends the connection
//
// worker.ts and the Next.js server bundle each bundle their own copy of this file, so the
// AsyncLocalStorage they share hangs off a global symbol.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestScope {
  /** The request's database connection, opened on first use (see getDb in db.ts). */
  db?: Promise<unknown>;
  /** Run once the response has been sent: each closes something the request opened. */
  onClose: Array<() => Promise<void>>;
}

const KEY = Symbol.for('lienclock.requestScope');

function storage(): AsyncLocalStorage<RequestScope> {
  const holder = globalThis as unknown as Record<symbol, AsyncLocalStorage<RequestScope> | undefined>;
  return (holder[KEY] ??= new AsyncLocalStorage<RequestScope>());
}

export function newRequestScope(): RequestScope {
  return { onClose: [] };
}

/** The scope of the request being served, or undefined outside one (Node.js, tests). */
export function currentRequestScope(): RequestScope | undefined {
  return storage().getStore();
}

export function runInRequestScope<T>(scope: RequestScope, fn: () => T): T {
  return storage().run(scope, fn);
}

/** Closes everything the request opened. Never throws: a failed close must not fail the response. */
export async function closeRequestScope(scope: RequestScope): Promise<void> {
  const closers = scope.onClose.splice(0);
  scope.db = undefined;
  const results = await Promise.allSettled(closers.map((close) => close()));
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('worker: closing a request resource failed:', result.reason instanceof Error ? result.reason.message : result.reason);
    }
  }
}
