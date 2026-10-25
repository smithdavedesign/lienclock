// Next's request APIs (`cookies()`) only work inside a request. Tests stand in for one: the cookie
// store is an in-memory jar, empty before every test (a signed-out visitor), that tests can fill.
import { beforeEach, vi } from 'vitest';
import { cookieJar } from './helpers/cookies';

vi.mock('next/headers', async () => (await import('./helpers/cookies')).nextHeadersMock);

beforeEach(() => {
  cookieJar.clear();
});
