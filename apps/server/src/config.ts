import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/** Same floor as agent/proxion-agent.py enforces on its side. */
const AGENT_TOKEN_MIN_LENGTH = 32;

export const APP_NAME = 'proxion';

/**
 * A `boolean` parsed from an env var string. Unlike `z.coerce.boolean()`
 * (which is `Boolean(str)` -- true for *any* non-empty string, so
 * `"false"`/`"0"` both coerce to `true`), this only accepts an explicit
 * truthy/falsy spelling, and treats an unset/empty value as false.
 */
function stringboolSchema() {
  return z.stringbool({
    truthy: ['true', '1', 'yes', 'on'],
    falsy: ['false', '0', 'no', 'off', ''],
  });
}

function boolEnv(defaultValue: boolean) {
  return stringboolSchema().default(defaultValue);
}

/** Like `boolEnv`, but with no fixed default -- `loadConfig` resolves the default from other fields (e.g. `NODE_ENV`) after parsing. */
function optionalBoolEnv() {
  return stringboolSchema().optional();
}

const envSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3080),
    HOST: z.string().default('0.0.0.0'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

    // Proxmox VE connection.
    PVE_URL: z
      .string()
      .min(1, 'PVE_URL is required, e.g. https://pve.example.com:8006')
      .refine(
        (value) => {
          try {
            new URL(value);
            return true;
          } catch {
            return false;
          }
        },
        { message: 'PVE_URL must be a valid absolute URL, e.g. https://pve.example.com:8006' },
      ),
    PVE_TLS_INSECURE: boolEnv(false),
    PVE_TLS_FINGERPRINT: z.string().optional(),

    // Service token ("token mode") -- optional, but required together.
    PVE_TOKEN_ID: z.string().optional(),
    PVE_TOKEN_SECRET: z.string().optional(),

    // Session signing -- required in production, auto-generated (with a
    // warning) in development. See `loadConfig` below.
    SESSION_SECRET: z.string().min(1).optional(),

    // Off by default: when true (and a service token is configured),
    // unauthenticated requests are treated as the service token's identity.
    PROXION_ALLOW_TOKEN_MODE: boolEnv(false),

    // Whether the `proxion.sid` cookie gets `Secure`. Defaults to
    // `NODE_ENV === 'production'` (resolved in `loadConfig`, since zod can't
    // default one field from another) -- override for a production
    // deployment served over plain HTTP behind a mesh/reverse proxy that
    // doesn't itself terminate TLS.
    PROXION_COOKIE_SECURE: optionalBoolEnv(),

    // Overrides the directory `buildApp` serves the built web app from in
    // production (see `app.ts`'s `webDistDir`). Unset by default, which
    // resolves relative to the server module itself -- set this when the
    // web build is copied somewhere else, e.g. the Docker image's
    // `/app/web/dist`.
    PROXION_WEB_DIST: z.string().optional(),

    // Per-node proxion-agent hosts ("node=url" pairs, comma-separated, e.g.
    // "pve1=http://100.64.0.10:9420,pve2=http://100.64.0.11:9420") -- parsed
    // into `Config.agents` by `loadConfig` below. Optional: nodes without an
    // entry here (or entirely, when this is unset) always fall back to the
    // existing VNC-based capture.
    PROXION_AGENTS: z.string().optional(),
    // Bearer token sent to every configured agent. Required (and validated
    // below) when PROXION_AGENTS is set; a single shared token for all agents.
    PROXION_AGENT_TOKEN: z.string().optional(),
    // How long to wait for an agent's `/screenshot/<vmid>` (or `/health`)
    // before treating it as unreachable/timed out.
    PROXION_AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),

    // Where per-user data (currently: preferences, one JSON file per user under
    // `<dir>/prefs/`) is persisted. Relative to the process cwd in dev; the Docker image sets
    // this to `/app/data`. Created on startup (see `prefs/store.ts`'s `PrefsStore.create`),
    // which also fails startup with a clear message if the path exists but isn't writable.
    PROXION_DATA_DIR: z.string().min(1).default('./data'),
  })
  .superRefine((config, ctx) => {
    const hasId = Boolean(config.PVE_TOKEN_ID);
    const hasSecret = Boolean(config.PVE_TOKEN_SECRET);
    if (hasId !== hasSecret) {
      ctx.addIssue({
        code: 'custom',
        path: [hasId ? 'PVE_TOKEN_SECRET' : 'PVE_TOKEN_ID'],
        message: 'PVE_TOKEN_ID and PVE_TOKEN_SECRET must both be set, or both left unset',
      });
    }
  });

/**
 * `SESSION_SECRET` is optional on input but always populated by `loadConfig`
 * (generated when absent outside production); `PROXION_COOKIE_SECURE` is
 * optional on input but always resolved to a concrete boolean.
 */
export type Config = Omit<
  z.infer<typeof envSchema>,
  'SESSION_SECRET' | 'PROXION_COOKIE_SECURE' | 'PROXION_AGENTS'
> & {
  SESSION_SECRET: string;
  PROXION_COOKIE_SECURE: boolean;
  /** Parsed from `PROXION_AGENTS`: node name -> agent base URL (no trailing slash). Empty when unset. */
  agents: ReadonlyMap<string, string>;
};

function formatZodError(error: z.ZodError): string {
  const lines = error.issues.map(
    (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
  return `Invalid Proxion server configuration:\n${lines.join('\n')}`;
}

/**
 * Parses `PROXION_AGENTS` ("node=url,node2=url2") into a node -> base URL
 * map, normalising away a trailing slash so callers can always append a
 * path directly. Throws (in the same style as the rest of `loadConfig`) on
 * a malformed entry -- a missing node name, a missing `=`, or a URL that
 * isn't an absolute http(s) URL.
 */
function parseAgentsEnv(value: string | undefined): ReadonlyMap<string, string> {
  const agents = new Map<string, string>();
  if (!value) return agents;

  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  for (const entry of entries) {
    const eqIndex = entry.indexOf('=');
    const node = eqIndex >= 0 ? entry.slice(0, eqIndex).trim() : '';
    const rawUrl = eqIndex >= 0 ? entry.slice(eqIndex + 1).trim() : '';

    if (eqIndex < 0 || !node || !rawUrl) {
      throw new Error(
        'Invalid Proxion server configuration:\n' +
          `  - PROXION_AGENTS: malformed entry "${entry}" (expected "node=http://host:port")`,
      );
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      throw new Error(
        'Invalid Proxion server configuration:\n' +
          `  - PROXION_AGENTS: invalid URL "${rawUrl}" for node "${node}" (must be an absolute http(s) URL)`,
      );
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(
        'Invalid Proxion server configuration:\n' +
          `  - PROXION_AGENTS: URL for node "${node}" must be http(s), got "${parsedUrl.protocol}"`,
      );
    }

    // Normalise away a trailing slash so `${baseUrl}${path}` never yields "//path".
    agents.set(node, rawUrl.replace(/\/+$/, ''));
  }

  return agents;
}

/**
 * Parses and validates `process.env` (or a supplied env object) into a
 * `Config`, failing fast with a readable, multi-issue message when required
 * variables are missing or malformed.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(formatZodError(parsed.error));
  }

  const raw = parsed.data;

  let sessionSecret = raw.SESSION_SECRET;
  if (!sessionSecret) {
    if (raw.NODE_ENV === 'production') {
      throw new Error(
        'Invalid Proxion server configuration:\n' +
          '  - SESSION_SECRET: required in production (set a long random value; sessions are signed with it)',
      );
    }

    sessionSecret = randomBytes(32).toString('hex');
    if (raw.NODE_ENV !== 'test') {
      console.warn(
        '[proxion] SESSION_SECRET not set; generated an ephemeral development secret. ' +
          'Sessions will not survive a restart and will not be shared across multiple server instances. ' +
          'Set SESSION_SECRET explicitly for anything beyond local development.',
      );
    }
  }

  const cookieSecure = raw.PROXION_COOKIE_SECURE ?? raw.NODE_ENV === 'production';

  // Tests build dozens of `Config`s (one or more per test file) and never set
  // `PROXION_DATA_DIR` themselves -- left as the literal `./data` default, every one of those
  // would create (and never clean up) `apps/server/data/` in the actual repo checkout on every
  // `pnpm test`. Redirect the *unset* default (not an explicit `./data`) to a fresh, unique OS
  // temp directory per `Config` instead, same idea as the ephemeral `SESSION_SECRET` above.
  // Gated on `process.env.VITEST` (set by the test runner itself), not `NODE_ENV` -- some test
  // files deliberately build a `Config` with `NODE_ENV: 'production'` to exercise
  // production-only behavior (e.g. the SPA fallback) while still running under `vitest`, and
  // that must redirect too, or it writes straight into the repo just the same.
  let dataDir = raw.PROXION_DATA_DIR;
  if (process.env.VITEST && env.PROXION_DATA_DIR === undefined) {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'proxion-test-data-'));
  }

  const agents = parseAgentsEnv(raw.PROXION_AGENTS);
  if (agents.size > 0 && !raw.PROXION_AGENT_TOKEN) {
    throw new Error(
      'Invalid Proxion server configuration:\n' +
        '  - PROXION_AGENT_TOKEN: required when PROXION_AGENTS is set',
    );
  }
  // The agent refuses to start with a token under 32 characters, so a shorter value here
  // can only be a placeholder left over from an env example -- fail loudly at startup
  // instead of letting every thumbnail fail with "capture-failed" at runtime.
  if (agents.size > 0 && (raw.PROXION_AGENT_TOKEN ?? '').trim().length < AGENT_TOKEN_MIN_LENGTH) {
    throw new Error(
      'Invalid Proxion server configuration:\n' +
        `  - PROXION_AGENT_TOKEN: must be at least ${AGENT_TOKEN_MIN_LENGTH} characters (the token ` +
        'install.sh prints on the PVE node; this looks like a placeholder from an env example)',
    );
  }

  // `PROXION_AGENTS` (the raw env string) is replaced by the parsed `agents` map above --
  // strip it so the returned object matches `Config` exactly (it's optional on `raw`, so
  // `delete` is legal without touching the rest of the type).
  const rest = { ...raw };
  delete rest.PROXION_AGENTS;

  return {
    ...rest,
    SESSION_SECRET: sessionSecret,
    PROXION_COOKIE_SECURE: cookieSecure,
    PROXION_DATA_DIR: dataDir,
    agents,
  };
}
