// In-memory stand-in for `next/headers` cookies(), shared by every test file through test/setup.ts.
export interface JarCookie {
  value: string;
  options: Record<string, unknown>;
}

export const cookieJar = new Map<string, JarCookie>();

const store = {
  get(name: string) {
    const cookie = cookieJar.get(name);
    return cookie ? { name, value: cookie.value } : undefined;
  },
  has(name: string) {
    return cookieJar.has(name);
  },
  getAll() {
    return [...cookieJar].map(([name, cookie]) => ({ name, value: cookie.value }));
  },
  set(name: string, value: string, options: Record<string, unknown> = {}) {
    cookieJar.set(name, { value, options });
    return store;
  },
  delete(name: string) {
    cookieJar.delete(name);
    return store;
  },
};

export const nextHeadersMock = {
  cookies: async () => store,
  headers: async () => new Headers(),
};
