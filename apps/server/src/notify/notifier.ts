import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Alert, ResourceLike } from '@proxion/core';
import { computeTransitions, type KnownAlert } from './transitions.js';
import type { NotifyChannel, NotifyEvent, NotifyMessage } from './types.js';

const STATE_FILE_NAME = 'notify-state.json';
const STATE_VERSION = 1;
const DEFAULT_MAX_ATTEMPTS = 3;

/** Minimal logger shape `Notifier` needs -- satisfied by `FastifyBaseLogger` and by `console`
 *  (used in tests), so this module never imports `fastify` just for a type. */
export interface NotifyLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface NotifierOptions {
  /** Resolved `PROXION_DATA_DIR` -- state persists to `<dataDir>/notify-state.json`. */
  dataDir: string;
  minSeverity: 'warning' | 'error';
  includeResolved: boolean;
  debounceMs: number;
  siteName: string;
  publicUrl?: string | undefined;
  channels: NotifyChannel[];
  log: NotifyLogger;
  /** Epoch ms -- overridable in tests. Defaults to `() => Date.now()` (not `Date.now` itself, so
   *  a later `vi.setSystemTime` is honoured -- same rationale as `thumbnailService.ts`'s `now`). */
  clock?: () => number;
  /** How PVE's own resource list is looked up for deep-link guest-type resolution (see
   *  `format.ts`'s `buildDeepLink`) -- defaults to `() => []` (no deep links beyond the bare
   *  `PROXION_PUBLIC_URL`). */
  getResources?: () => readonly ResourceLike[];
  /** Per-batch channel-send attempts before giving up and logging at `error`. Default 3. */
  maxAttempts?: number;
}

interface PersistedState {
  version: 1;
  alerts: Record<string, KnownAlert>;
}

function toPersisted(known: ReadonlyMap<string, KnownAlert>): PersistedState {
  return { version: STATE_VERSION, alerts: Object.fromEntries(known) };
}

function fromPersisted(raw: unknown): Map<string, KnownAlert> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const alerts = (raw as Partial<PersistedState>).alerts;
  if (typeof alerts !== 'object' || alerts === null) return undefined;
  return new Map(Object.entries(alerts as Record<string, KnownAlert>));
}

/**
 * Turns the poller's alert snapshots into "something happened" notifications on the configured
 * channels (webhook/email) -- opened/resolved/cleared/escalated, batched within `debounceMs` into
 * one message per channel, with a one-time "notifications are active" summary on first run (no
 * state file yet) so a fresh deployment doesn't stay silent about pre-existing alerts forever.
 *
 * State (`known`: alert id -> last-seen severity/whether it was ever announced) is kept in memory
 * and persisted to `<PROXION_DATA_DIR>/notify-state.json` after every processed snapshot (atomic
 * write, same temp-file + rename convention as `prefs/store.ts`) -- a restart re-reads it and so
 * never re-announces an alert it already told someone about.
 *
 * A channel throwing is never allowed to reach the poller's listener: `flush` catches per-channel,
 * retries up to `maxAttempts` times, and logs a `warn` (escalating to `error` once attempts are
 * exhausted) naming only the channel and its host -- never a URL, token or SMTP credential.
 */
export class Notifier {
  private readonly clock: () => number;
  private readonly maxAttempts: number;
  private readonly getResources: () => readonly ResourceLike[];
  private readonly stateFile: string;
  private known: Map<string, KnownAlert> = new Map();
  private firstRun = true;
  private pendingEvents: NotifyEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Serialises `processSnapshot` calls -- the poller's listener is synchronous, but each call
   *  does async work (persistence, and on first run, an immediate send); chaining onto this
   *  guarantees two snapshots arriving back-to-back are still processed in order against a
   *  consistent `this.known`. */
  private chain: Promise<void> = Promise.resolve();
  /** The most recently scheduled `deliver()` call from `scheduleFlush` -- awaited by
   *  `flushForTest` alongside `chain` so a test advancing fake timers past `debounceMs` can
   *  deterministically wait for that flush's channel sends (and their retries) to finish, rather
   *  than racing them. */
  private lastFlush: Promise<void> = Promise.resolve();

  private constructor(private readonly options: NotifierOptions) {
    this.clock = options.clock ?? (() => Date.now());
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.getResources = options.getResources ?? (() => []);
    this.stateFile = path.join(options.dataDir, STATE_FILE_NAME);
  }

  /** Loads any persisted state (absent -> first run) and returns a ready `Notifier`. Never
   *  throws: a corrupt/unreadable state file is treated the same as "no file yet". */
  static async create(options: NotifierOptions): Promise<Notifier> {
    const notifier = new Notifier(options);
    try {
      await fs.mkdir(options.dataDir, { recursive: true, mode: 0o700 });
      const raw = JSON.parse(await fs.readFile(notifier.stateFile, 'utf8')) as unknown;
      const known = fromPersisted(raw);
      if (known) {
        notifier.known = known;
        notifier.firstRun = false;
      }
    } catch {
      // No file, unreadable, or malformed -- stays a first run.
    }
    return notifier;
  }

  /** Entry point for a fresh alerts snapshot -- called from the poller's `on(listener)` (see
   *  `app.ts`: `poller.on((event) => { if (event.type === 'alerts') notifier.onAlerts(event.data);
   *  })`). Kept as a plain method (rather than this class doing its own subscribing) so it never
   *  needs to know `Poller`'s event-union type, and so tests can drive it directly. Synchronous
   *  (never throws, never returns a promise the poller's listener would need to await) -- all
   *  async work is chained internally; `processSnapshot` itself never rejects (it catches and
   *  logs internally), so this chain never produces an unhandled rejection either. */
  onAlerts(alerts: Alert[]): void {
    this.chain = this.chain.then(() => this.processSnapshot(alerts));
  }

  /** Waits for every currently-chained/in-flight snapshot processing (and, on tests using a real
   *  clock, lets callers `await` before asserting) -- not needed in production, but keeps tests
   *  from racing the internal promise chain. */
  async flushForTest(): Promise<void> {
    await this.chain;
    await this.lastFlush;
  }

  /** Never rejects -- see `onAlerts`'s doc comment for why that matters. Everything this calls
   *  that talks to a channel or the filesystem already catches its own errors; this outer
   *  try/catch is only a backstop against a bug in the pure transition logic itself. */
  private async processSnapshot(alerts: Alert[]): Promise<void> {
    try {
      if (this.firstRun) {
        await this.sendFirstRunSummary(alerts);
        return;
      }

      const { events, nextKnown } = computeTransitions({
        currentAlerts: alerts,
        known: this.known,
        minSeverity: this.options.minSeverity,
        includeResolved: this.options.includeResolved,
        now: this.clock(),
        publicUrl: this.options.publicUrl,
        resources: this.getResources(),
      });
      this.known = nextKnown;
      await this.persistState();

      if (events.length === 0) return;
      this.pendingEvents.push(...events);
      this.scheduleFlush();
    } catch (error) {
      this.options.log.error({ err: describeError(error) }, 'Notifier: failed to process alerts snapshot');
    }
  }

  private async sendFirstRunSummary(alerts: Alert[]): Promise<void> {
    // Seed `known` exactly as `computeTransitions` would from an empty map -- this both decides
    // which of today's alerts count as "already open" for future escalate/resolve/clear logic,
    // and lets the summary reuse the same per-alert formatting (`'summary-item'` instead of
    // `'opened'`) rather than duplicating the threshold logic here.
    const { nextKnown } = computeTransitions({
      currentAlerts: alerts,
      known: new Map(),
      minSeverity: this.options.minSeverity,
      includeResolved: this.options.includeResolved,
      now: this.clock(),
      publicUrl: this.options.publicUrl,
      resources: this.getResources(),
    });

    const summaryEvents: NotifyEvent[] = alerts
      .filter((alert) => alert.severity !== 'healed')
      .map((alert) => ({
        type: 'summary-item',
        severity: alert.severity,
        kind: alert.kind,
        title: alert.title,
        detail: alert.detail,
        node: alert.node,
        vmid: alert.vmid,
        at: alert.at,
      }));

    this.known = nextKnown;
    this.firstRun = false;
    await this.persistState();
    await this.deliver({ kind: 'summary', siteName: this.options.siteName, events: summaryEvents });
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      const events = this.pendingEvents;
      this.pendingEvents = [];
      this.lastFlush = this.deliver({ kind: 'transitions', siteName: this.options.siteName, events });
    }, this.options.debounceMs);
  }

  /** Sends one message to every configured channel, retrying a failing channel up to
   *  `maxAttempts` times (immediately, within this same batch -- see the class doc comment)
   *  before giving up on it for this batch and logging at `error`. */
  private async deliver(message: NotifyMessage): Promise<void> {
    await Promise.all(
      this.options.channels.map(async (channel) => {
        for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
          try {
            await channel.send(message);
            return;
          } catch {
            this.options.log.warn(
              { channel: channel.name, host: channel.host, attempt, maxAttempts: this.maxAttempts },
              'Notifier: channel send failed',
            );
          }
        }
        this.options.log.error(
          { channel: channel.name, host: channel.host, attempts: this.maxAttempts },
          'Notifier: channel send failed after all retries; batch dropped for this channel',
        );
      }),
    );
  }

  private async persistState(): Promise<void> {
    const tmp = path.join(this.options.dataDir, `.${STATE_FILE_NAME}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await fs.mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(tmp, JSON.stringify(toPersisted(this.known), null, 2), { mode: 0o600 });
      await fs.rename(tmp, this.stateFile);
    } catch (error) {
      this.options.log.warn({ err: describeError(error) }, 'Notifier: could not persist notification state');
    }
  }

  /** Sends a single synthetic `'test'` message through every configured channel independently,
   *  for `POST /api/notify/test` -- results keyed by channel name, never throwing (a failure is
   *  reported back to the caller as a sanitised string, not surfaced as an exception). */
  async sendTest(): Promise<Record<string, 'ok' | string>> {
    const testEvent: NotifyEvent = {
      type: 'test',
      severity: 'warning',
      kind: 'task',
      title: 'This is a test notification from Proxion',
      at: Math.floor(this.clock() / 1000),
    };
    const message: NotifyMessage = { kind: 'test', siteName: this.options.siteName, events: [testEvent] };

    const results: Record<string, 'ok' | string> = {};
    await Promise.all(
      this.options.channels.map(async (channel) => {
        try {
          await channel.send(message);
          results[channel.name] = 'ok';
        } catch (error) {
          this.options.log.warn(
            { channel: channel.name, host: channel.host },
            'Notifier: test notification failed',
          );
          results[channel.name] = sanitiseTestError(error);
        }
      }),
    );
    return results;
  }
}

/** Never includes the raw error message in a *log* (it could echo back a URL with a query-string
 *  token, or an SMTP error that quotes the connection string) -- only its constructor name, for a
 *  little extra debuggability without the risk. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

const MAX_SANITISED_ERROR_LENGTH = 200;

/** Unlike `describeError` (for logs), the test-button response IS shown to the signed-in operator
 *  who just clicked it, so it's worth keeping the error's own wording where possible (a webhook's
 *  own "404 Not Found" or a timeout message is genuinely useful) -- but any URL-shaped substring
 *  (which could carry a query-string token) or `Bearer <token>` header value, and nodemailer
 *  errors that echo the full `smtp(s)://user:pass@host` connection string, must never reach the
 *  caller verbatim. */
function sanitiseTestError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = message
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  return redacted.length > MAX_SANITISED_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_SANITISED_ERROR_LENGTH - 1)}…`
    : redacted;
}
