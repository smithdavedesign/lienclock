// The RepoHQ visit beacon, so the owner can count real use of the live site:
//   visit     a public page was opened                          once per browser session (sessionStorage)
//   activate  the calculator showed someone a job's deadlines   once per browser (localStorage)
//   checkout  someone clicked a button that opens the Stripe Payment Link
// Each is a fire-and-forget POST of {"slug","kind","referrer"} with keepalive and no cookies. The
// referrer is sent only when it is another site, so LienClock URLs (calculator links hold the job
// typed in) never leave the page. Nothing is sent from automated browsers (navigator.webdriver), from
// any build but production, or from a browser where localStorage "repohq:notrack" is set (the owner's).
// The privacy policy describes all of this: keep them in step.

export const SIGNAL_URL = 'https://idea-factory.1426davejobs.workers.dev/api/ideas/signal';
export const SIGNAL_SLUG = 'lienclock';
export const NO_TRACK_KEY = 'repohq:notrack';

export type SignalKind = 'visit' | 'activate' | 'checkout';

/** Where each kind remembers it was sent; checkout counts every click. */
export const SENT_FLAGS: Record<SignalKind, { storage: 'sessionStorage' | 'localStorage'; key: string } | null> = {
  visit: { storage: 'sessionStorage', key: 'lienclock:signal:visit' },
  activate: { storage: 'localStorage', key: 'lienclock:signal:activate' },
  checkout: null,
};

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** The parts of `window` the beacon touches (tests pass a fake). */
export interface SignalBrowser {
  navigator: { webdriver?: boolean };
  location: { origin: string };
  document: { referrer: string };
  localStorage: KeyValueStorage;
  sessionStorage: KeyValueStorage;
  fetch: typeof fetch;
}

export interface DeployEnv {
  NEXT_PUBLIC_DEPLOY_ENV?: string;
  NEXT_PUBLIC_VERCEL_ENV?: string;
}

// Spelled out in full so Next.js inlines them into the browser bundle at build time.
const BUILD_ENV: DeployEnv = {
  NEXT_PUBLIC_DEPLOY_ENV: process.env.NEXT_PUBLIC_DEPLOY_ENV,
  NEXT_PUBLIC_VERCEL_ENV: process.env.NEXT_PUBLIC_VERCEL_ENV,
};

/** NEXT_PUBLIC_DEPLOY_ENV (set by cf:build), else Vercel's NEXT_PUBLIC_VERCEL_ENV, must be "production". */
export function isProductionBuild(env: DeployEnv): boolean {
  return (env.NEXT_PUBLIC_DEPLOY_ENV || env.NEXT_PUBLIC_VERCEL_ENV) === 'production';
}

/** document.referrer when it comes from another site; null for this site, an empty or a malformed one. */
export function externalReferrer(referrer: string, origin: string): string | null {
  if (!referrer) return null;
  try {
    return new URL(referrer).origin === origin ? null : referrer;
  } catch {
    return null;
  }
}

// Storage can be blocked (privacy modes, iframes): treat it as empty rather than fail.
function read(storage: KeyValueStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function write(storage: KeyValueStorage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // counted again next time; nothing else to do
  }
}

/** Sends one signal if allowed and not already sent. Returns whether it sent. Never throws. */
export function sendSignal(kind: SignalKind, browser: SignalBrowser, env: DeployEnv = BUILD_ENV): boolean {
  try {
    if (browser.navigator.webdriver) return false;
    if (!isProductionBuild(env)) return false;
    if (read(browser.localStorage, NO_TRACK_KEY) !== null) return false;
    const flag = SENT_FLAGS[kind];
    if (flag) {
      const storage = browser[flag.storage];
      if (read(storage, flag.key) !== null) return false;
      write(storage, flag.key, '1');
    }
    const body = JSON.stringify({
      slug: SIGNAL_SLUG,
      kind,
      referrer: externalReferrer(browser.document.referrer, browser.location.origin),
    });
    browser
      .fetch(SIGNAL_URL, {
        method: 'POST',
        keepalive: true, // survives the navigation a Buy click starts
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { 'content-type': 'application/json' },
        body,
      })
      .catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}
