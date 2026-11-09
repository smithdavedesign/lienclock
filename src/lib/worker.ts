// The Cloudflare Worker around OpenNext's Next.js handler (worker.ts at the repo root is the entry).
// It adds what the handler doesn't do on its own:
//   fetch      every request runs in its own request scope (requestScope.ts), and the database
//              connection it opened is closed once the response body has been sent (pages stream).
//   scheduled  the daily Cron Trigger (wrangler.jsonc) calls GET /api/cron/alerts in-process with
//              CRON_SECRET, as Vercel Cron does on Vercel. The route checks the secret as usual.
import { closeRequestScope, newRequestScope, runInRequestScope } from './requestScope';

export interface WorkerEnv {
  [name: string]: unknown;
  APP_URL?: string;
  CRON_SECRET?: string;
}

export interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface FetchHandler {
  fetch(request: Request, env: WorkerEnv, ctx: WorkerContext): Promise<Response>;
}

export const CRON_PATH = '/api/cron/alerts';

export function createWorker(next: FetchHandler) {
  async function fetch(request: Request, env: WorkerEnv, ctx: WorkerContext): Promise<Response> {
    const scope = newRequestScope();
    let response: Response;
    try {
      response = await runInRequestScope(scope, () => next.fetch(request, env, ctx));
    } catch (error) {
      ctx.waitUntil(closeRequestScope(scope));
      throw error;
    }
    if (!response.body) {
      ctx.waitUntil(closeRequestScope(scope));
      return response;
    }
    // A streamed page can still be querying after the headers went out: close when the body ends.
    const { readable, writable } = new TransformStream();
    ctx.waitUntil(
      response.body
        .pipeTo(writable)
        .catch(() => undefined) // the visitor went away: nothing to do but close
        .finally(() => closeRequestScope(scope)),
    );
    return new Response(readable, response);
  }

  async function scheduled(_controller: unknown, env: WorkerEnv, ctx: WorkerContext): Promise<void> {
    const base = typeof env.APP_URL === 'string' && env.APP_URL ? env.APP_URL : 'https://lienclock.invalid';
    const request = new Request(new URL(CRON_PATH, base), {
      headers: { authorization: `Bearer ${typeof env.CRON_SECRET === 'string' ? env.CRON_SECRET : ''}` },
    });
    const response = await fetch(request, env, ctx);
    const summary = await response.text(); // counts only; reading it to the end also closes the scope
    if (!response.ok) throw new Error(`cron: ${CRON_PATH} answered ${response.status}: ${summary}`);
    console.log(`cron: ${summary}`);
  }

  return { fetch, scheduled };
}
