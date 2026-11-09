// The Cloudflare Worker around OpenNext: each request gets its own database connection, closed once the
// response has been sent (a socket can't be shared between Worker requests), and the daily Cron Trigger
// runs the alert route with CRON_SECRET. `pg` is replaced by a fake that records what it was asked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, onCloudflareWorkers } from '@/lib/db';
import { closeRequestScope, currentRequestScope, newRequestScope, runInRequestScope } from '@/lib/requestScope';
import { CRON_PATH, createWorker, type WorkerContext } from '@/lib/worker';

const clients: FakeClient[] = [];

class FakeClient {
  queries: string[] = [];
  connected = false;
  ended = false;
  constructor(readonly options: { connectionString: string }) {
    clients.push(this);
  }
  on() {
    return this;
  }
  async connect() {
    this.connected = true;
  }
  async query(sql: string) {
    if (this.ended) throw new Error('query on a closed connection');
    this.queries.push(sql);
    return { rows: [] };
  }
  async end() {
    this.ended = true;
  }
}

vi.mock('pg', () => ({ default: { Client: FakeClient, Pool: class {} } }));

// No password in it: the fake client never connects anywhere.
const ENV = { DATABASE_URL: 'postgres://lienclock@db.example/lienclock' };

beforeEach(() => {
  clients.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const onWorkers = () => vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' });

describe('getDb on Cloudflare Workers', () => {
  it('detects the workerd runtime by its user agent', () => {
    expect(onCloudflareWorkers()).toBe(false); // Node.js
    onWorkers();
    expect(onCloudflareWorkers()).toBe(true);
  });

  it('opens one connection per request, shared within it, ends it with the request, and creates the schema once', async () => {
    onWorkers();
    const first = newRequestScope();
    const [a, b] = await runInRequestScope(first, () => Promise.all([getDb(ENV), getDb(ENV)]));
    expect(a).toBe(b);
    expect(clients).toHaveLength(1);
    expect(clients[0].options.connectionString).toBe(ENV.DATABASE_URL);
    expect(clients[0].connected).toBe(true);
    expect(clients[0].queries.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS jobs'))).toBe(true);

    const second = newRequestScope();
    const c = await runInRequestScope(second, () => getDb(ENV));
    expect(c).not.toBe(a);
    expect(clients).toHaveLength(2);
    // The isolate already has the schema: the next request goes straight to its queries.
    expect(clients[1].queries).toEqual([]);

    await closeRequestScope(first);
    expect(clients[0].ended).toBe(true);
    expect(clients[1].ended).toBe(false);
    await closeRequestScope(second);
    expect(clients[1].ended).toBe(true);
  });

  it('refuses to run outside a request scope or without DATABASE_URL (no files to fall back on)', async () => {
    onWorkers();
    await expect(getDb(ENV)).rejects.toThrow(/request scope/);
    await expect(runInRequestScope(newRequestScope(), () => getDb({}))).rejects.toThrow(/DATABASE_URL is not set/);
    expect(clients).toHaveLength(0);
  });
});

/** A stand-in for ExecutionContext: collects waitUntil promises so tests can wait for them. */
function context() {
  const pending: Promise<unknown>[] = [];
  const ctx: WorkerContext = { waitUntil: (promise) => void pending.push(promise) };
  return { ctx, settled: () => Promise.allSettled(pending) };
}

describe('the Worker entry', () => {
  it('runs each request in its own scope and closes it once the streamed body has been read', async () => {
    const closed: string[] = [];
    const worker = createWorker({
      fetch: async (request) => {
        const scope = currentRequestScope();
        expect(scope).toBeDefined();
        const id = new URL(request.url).pathname;
        scope!.onClose.push(async () => void closed.push(id));
        const body = new ReadableStream({
          async pull(controller) {
            // Still in the request's scope while streaming, after the headers went out.
            expect(currentRequestScope()).toBe(scope);
            controller.enqueue(new TextEncoder().encode(`page ${id}`));
            controller.close();
          },
        });
        return new Response(body, { status: 201, headers: { 'x-page': id } });
      },
    });

    const { ctx, settled } = context();
    const response = await worker.fetch(new Request('https://lienclock.example/one'), {}, ctx);
    expect(response.status).toBe(201);
    expect(response.headers.get('x-page')).toBe('/one');
    expect(closed).toEqual([]); // the body hasn't been sent yet
    expect(await response.text()).toBe('page /one');
    await settled();
    expect(closed).toEqual(['/one']);
  });

  it('closes the scope for empty bodies and when the handler throws', async () => {
    let scopes = 0;
    const closed = vi.fn(async () => undefined);
    const worker = createWorker({
      fetch: async (request) => {
        scopes += 1;
        currentRequestScope()!.onClose.push(closed);
        if (request.url.endsWith('/boom')) throw new Error('boom');
        return new Response(null, { status: 204 });
      },
    });
    const { ctx, settled } = context();
    expect((await worker.fetch(new Request('https://lienclock.example/empty'), {}, ctx)).status).toBe(204);
    await expect(worker.fetch(new Request('https://lienclock.example/boom'), {}, ctx)).rejects.toThrow('boom');
    await settled();
    expect(scopes).toBe(2);
    expect(closed).toHaveBeenCalledTimes(2);
  });

  it('the daily cron calls the alert route in-process with CRON_SECRET, and fails loudly if it fails', async () => {
    const secret = ['cron', 'Q3w8E5r2'.repeat(3)].join('-');
    const seen: Request[] = [];
    let status = 200;
    const worker = createWorker({
      fetch: async (request) => {
        seen.push(request);
        return Response.json({ ok: status === 200 }, { status });
      },
    });
    const env = { APP_URL: 'https://lienclock.example', CRON_SECRET: secret };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await worker.scheduled({}, env, context().ctx);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('GET');
    expect(new URL(seen[0].url).pathname).toBe(CRON_PATH);
    expect(CRON_PATH).toBe('/api/cron/alerts');
    expect(seen[0].headers.get('authorization')).toBe(`Bearer ${secret}`);
    expect(log.mock.calls.flat().join(' ')).not.toContain(secret);

    status = 500;
    await expect(worker.scheduled({}, env, context().ctx)).rejects.toThrow(/answered 500/);
    log.mockRestore();
  });
});
