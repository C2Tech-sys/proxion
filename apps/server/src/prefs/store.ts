import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import { PREFS_DEFAULTS, userPrefsPatchSchema, userPrefsSchema, type UserPrefs } from './schema.js';

const MAX_SANITISED_LENGTH = 128;

/**
 * Turns a PVE identity's username (`user@realm`, or a token id like `user@realm!tokenname`) into
 * a safe filename component: lower-cased, anything other than `[a-z0-9@._-]` becomes `_` --
 * which in particular means a literal `/` or `\` (a path separator, on either platform) is never
 * preserved, so `../../etc/passwd` sanitises to `.._.._etc_passwd`, a harmless single path
 * segment with no separators left to traverse with. Truncated to 128 chars, and never empty
 * (falls back to `_`) so the result is always a valid, boring filename.
 */
export function sanitiseUsername(username: string): string {
  const cleaned = username.toLowerCase().replace(/[^a-z0-9@._-]/g, '_').slice(0, MAX_SANITISED_LENGTH);
  return cleaned.length > 0 ? cleaned : '_';
}

function formatIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

export type PrefsWriteResult = { ok: true; prefs: UserPrefs } | { ok: false; message: string };

interface CacheEntry {
  doc: UserPrefs;
  /** `undefined` caches "no file on disk yet" (the all-defaults document). */
  mtimeMs: number | undefined;
}

/**
 * One JSON file per user under `<PROXION_DATA_DIR>/prefs/`. Reads are cached in memory and
 * revalidated by the file's mtime (so a write from *this* process is never re-read from disk,
 * while an external change -- restoring a backup, editing by hand -- is still picked up); writes
 * are atomic (temp file + rename) and serialised per user, so two concurrent `PATCH`es for the
 * same user always merge onto each other rather than racing and dropping one.
 *
 * Never logs a document's contents -- only paths, and only the resolved data directory once at
 * startup (see `create`).
 */
export class PrefsStore {
  private readonly cache = new Map<string, CacheEntry>();
  /** Per-username write queue: each entry is the tail of that user's chain of pending writes. */
  private readonly locks = new Map<string, Promise<void>>();

  private constructor(private readonly prefsDir: string) {}

  /**
   * Resolves `PROXION_DATA_DIR`, creates it (and the `prefs/` subdirectory) if missing (mode
   * `0700` where the platform honors a directory mode), logs the resolved path once, and throws
   * a clear, actionable error if the directory exists but isn't writable -- so a misconfigured
   * volume/permission fails startup instead of every preferences read/write failing later.
   */
  static async create(config: Config, log: FastifyBaseLogger): Promise<PrefsStore> {
    const dataDir = path.resolve(process.cwd(), config.PROXION_DATA_DIR);
    const prefsDir = path.join(dataDir, 'prefs');

    try {
      await fs.mkdir(prefsDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      // On POSIX a data dir the process can't write to fails right here, while creating the
      // `prefs/` subdirectory -- say "not writable" (the actionable fact) rather than "could
      // not create", which reads like a typo in the path.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
        throw new Error(
          `Proxion data directory "${dataDir}" exists but is not writable by this process (${code}). ` +
            'Fix its ownership/permissions (or point PROXION_DATA_DIR somewhere writable) and restart.',
          { cause: error },
        );
      }
      throw new Error(
        `Could not create Proxion data directory "${dataDir}": ${(error as Error).message}`,
        { cause: error },
      );
    }

    try {
      await fs.access(dataDir, fsConstants.W_OK);
    } catch (error) {
      throw new Error(
        `Proxion data directory "${dataDir}" exists but is not writable by this process. ` +
          'Fix its ownership/permissions (or point PROXION_DATA_DIR somewhere writable) and restart.',
        { cause: error },
      );
    }

    log.info({ dataDir }, 'Proxion data directory ready');
    return new PrefsStore(prefsDir);
  }

  private filePath(username: string): string {
    return path.join(this.prefsDir, `${sanitiseUsername(username)}.json`);
  }

  /** Runs `fn` after every previously-queued op for this `username` has settled, and queues
   *  behind it -- serialising concurrent reads-during-a-write and writes-during-a-write for the
   *  same user without blocking other users at all. */
  private async runExclusive<T>(username: string, fn: () => Promise<T>): Promise<T> {
    // Keyed like the cache and the file: two spellings that sanitise to one file share one lock.
    const key = sanitiseUsername(username);
    const tail = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Chained onto `tail` regardless of whether the previous op resolved or rejected, so one
    // failed write never wedges every later op for this user behind a permanently-pending lock.
    this.locks.set(
      key,
      tail.then(
        () => gate,
        () => gate,
      ),
    );
    await tail.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** The caller's prefs merged over defaults -- a missing file, a corrupt one, or one that fails
   *  schema validation all resolve to `PREFS_DEFAULTS` (logging a warning for the latter two)
   *  rather than throwing; a preferences read should never be why a page fails to load. */
  async get(username: string, log?: FastifyBaseLogger): Promise<UserPrefs> {
    const file = this.filePath(username);
    // The cache is keyed by the sanitised name -- the file's identity -- so two spellings of one
    // user (`same@pam` / `SAME@pam`) share one entry. Keying by the raw username let a write
    // under one spelling leave a stale entry under the other, which the mtime check cannot
    // catch when both writes land inside one filesystem timestamp tick (coarse on Linux).
    const key = sanitiseUsername(username);

    let mtimeMs: number | undefined;
    try {
      mtimeMs = (await fs.stat(file)).mtimeMs;
    } catch {
      // No file yet for this user -- that's the normal "never saved a preference" state.
      this.cache.set(key, { doc: PREFS_DEFAULTS, mtimeMs: undefined });
      return PREFS_DEFAULTS;
    }

    const cached = this.cache.get(key);
    if (cached && cached.mtimeMs === mtimeMs) return cached.doc;

    let doc: UserPrefs;
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
      const parsed = userPrefsSchema.safeParse(raw);
      doc = parsed.success ? parsed.data : PREFS_DEFAULTS;
      if (!parsed.success) {
        log?.warn(
          { file, issue: formatIssues(parsed.error) },
          'Stored preferences failed validation; serving defaults',
        );
      }
    } catch (error) {
      log?.warn({ file, err: error }, 'Could not read stored preferences; serving defaults');
      doc = PREFS_DEFAULTS;
    }

    this.cache.set(key, { doc, mtimeMs });
    return doc;
  }

  private async persist(username: string, doc: UserPrefs): Promise<UserPrefs> {
    const file = this.filePath(username);
    const tmp = path.join(
      this.prefsDir,
      `.${sanitiseUsername(username)}.${randomBytes(6).toString('hex')}.tmp`,
    );
    await fs.writeFile(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
    await fs.rename(tmp, file);
    const { mtimeMs } = await fs.stat(file);
    this.cache.set(sanitiseUsername(username), { doc, mtimeMs });
    return doc;
  }

  /** `PUT`: replace the whole document. Rejects (without writing anything) if `input` doesn't
   *  match the schema. */
  async replace(username: string, input: unknown): Promise<PrefsWriteResult> {
    const parsed = userPrefsSchema.safeParse(input);
    if (!parsed.success) return { ok: false, message: formatIssues(parsed.error) };
    return this.runExclusive(username, async () => ({
      ok: true,
      prefs: await this.persist(username, parsed.data),
    }));
  }

  /** `PATCH`: validate `input` as a partial document, merge it onto the current one, and persist
   *  the result -- the read-modify-write happens inside this user's write queue, so two
   *  concurrent `PATCH`es never both read the same "current" doc and clobber each other. */
  async merge(username: string, input: unknown): Promise<PrefsWriteResult> {
    const parsed = userPrefsPatchSchema.safeParse(input);
    if (!parsed.success) return { ok: false, message: formatIssues(parsed.error) };
    return this.runExclusive(username, async () => {
      const current = await this.get(username);
      const merged = userPrefsSchema.parse({ ...current, ...parsed.data });
      return { ok: true, prefs: await this.persist(username, merged) };
    });
  }
}
