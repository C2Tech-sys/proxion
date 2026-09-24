import { USE_FIXTURES } from '@/api/client';

/**
 * Per-user preferences, persisted server-side (one JSON file per user -- see
 * `apps/server/src/prefs/schema.ts`, which this shape mirrors exactly) so they follow the
 * signed-in user across browsers. A separate module from `client.ts`/`fixtures.ts` (not woven
 * into `ApiClient`) since it has its own fixture-mode behavior (a real, mutable in-memory demo
 * store, not a fixed JSON fixture) and its own hooks (`prefsHooks.ts`).
 */
export type Theme = 'light' | 'dark' | 'system';
export type DefaultRange = 'hour' | 'day' | 'week' | 'month' | 'year';
export type ThumbnailRefreshSeconds = 30 | 60 | 120 | 300;
export type Density = 'comfortable' | 'compact';

/** A saved Summary-tab panel order, per guest type -- see `pages/vm/summaryLayout.ts`'s
 *  `normaliseOrder` for how an id this client version doesn't (or no longer) recognize is
 *  handled. Mirrors the server's generic shape (`apps/server/src/prefs/schema.ts`): an array of
 *  short, unique strings, not a list of known panel ids -- the server doesn't validate against
 *  the panel registry at all. */
export interface SummaryLayoutPrefs {
  qemu?: string[];
  lxc?: string[];
}

export interface UserPrefs {
  version: 1;
  theme: Theme;
  defaultRange: DefaultRange;
  consoleThumbnails: boolean;
  thumbnailRefreshSeconds: ThumbnailRefreshSeconds;
  /** `undefined` = "use the rail's own built-in default", not a stored 200-600 value. */
  railWidth?: number;
  density: Density;
  /** `undefined` = no custom order saved for either guest type yet. */
  summaryLayout?: SummaryLayoutPrefs;
}

export type PrefsPatch = Partial<UserPrefs>;

/** What `GET`/`PUT`/`PATCH` all return: the document plus whether writes are accepted for the
 *  caller's identity (`false` for a session, always `true` in token mode -- a shared service
 *  token is not a person). */
export type PrefsResponse = UserPrefs & { readOnly: boolean };

export const PREFS_DEFAULTS: UserPrefs = {
  version: 1,
  theme: 'system',
  defaultRange: 'hour',
  consoleThumbnails: true,
  thumbnailRefreshSeconds: 60,
  density: 'comfortable',
};

const PREFS_PATH = '/api/prefs';

async function request(init?: RequestInit): Promise<PrefsResponse> {
  const res = await fetch(PREFS_PATH, {
    ...init,
    headers: {
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    let detail: string | undefined;
    try {
      const body = (await res.clone().json()) as { error?: string };
      detail = body?.error;
    } catch {
      detail = undefined;
    }
    throw new Error(detail ?? `Request to ${PREFS_PATH} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as PrefsResponse;
}

// --- Fixture mode -----------------------------------------------------------------------------
// No real backend in the demo: an in-memory object seeded from defaults, mutable across
// getPrefs/putPrefs/patchPrefs calls (unlike the read-only, checked-in JSON fixtures elsewhere in
// `fixtures.ts`) so the Preferences page's controls actually do something when clicked -- with a
// simulated round-trip so its "Saved" indicator and optimistic-update path both get exercised.
const FIXTURE_LATENCY_MS = 300;
let fixtureState: PrefsResponse = { ...PREFS_DEFAULTS, readOnly: false };

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), FIXTURE_LATENCY_MS));
}

export function getPrefs(): Promise<PrefsResponse> {
  if (USE_FIXTURES) return delay(fixtureState);
  return request();
}

export function putPrefs(doc: UserPrefs): Promise<PrefsResponse> {
  if (USE_FIXTURES) {
    fixtureState = { ...doc, readOnly: false };
    return delay(fixtureState);
  }
  return request({ method: 'PUT', body: JSON.stringify(doc) });
}

export function patchPrefs(patch: PrefsPatch): Promise<PrefsResponse> {
  if (USE_FIXTURES) {
    fixtureState = { ...fixtureState, ...patch, readOnly: false };
    return delay(fixtureState);
  }
  return request({ method: 'PATCH', body: JSON.stringify(patch) });
}
