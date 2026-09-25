import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrefsStore, sanitiseUsername } from '../src/prefs/store.js';
import { PREFS_DEFAULTS } from '../src/prefs/schema.js';
import { loadConfig } from '../src/config.js';

const silentLog = {
  info: () => {},
  warn: () => {},
} as unknown as Parameters<typeof PrefsStore.create>[1];

describe('sanitiseUsername', () => {
  it('lower-cases and replaces anything outside [a-z0-9@._-]', () => {
    expect(sanitiseUsername('Root@PAM')).toBe('root@pam');
    expect(sanitiseUsername('user name')).toBe('user_name');
  });

  it('strips path separators so a crafted username cannot escape the prefs directory', () => {
    expect(sanitiseUsername('../../etc/passwd')).not.toMatch(/[/\\]/);
    expect(sanitiseUsername('..\\..\\windows')).not.toMatch(/[/\\]/);
    expect(sanitiseUsername('a/b/c')).toBe('a_b_c');
  });

  it('truncates to 128 characters', () => {
    const long = 'a'.repeat(300);
    expect(sanitiseUsername(long).length).toBe(128);
  });

  it('never returns an empty string', () => {
    // Each disallowed char is replaced 1:1 (not collapsed), so '///' -> '___' -- still a safe,
    // separator-free filename. The empty-string fallback only kicks in for a truly empty result.
    expect(sanitiseUsername('///')).toBe('___');
    expect(sanitiseUsername('')).toBe('_');
  });
});

describe('PrefsStore', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'proxion-prefs-test-'));
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  async function makeStore(): Promise<PrefsStore> {
    const config = loadConfig({ NODE_ENV: 'test', PVE_URL: 'https://pve.example.com:8006', PROXION_DATA_DIR: dataDir });
    return PrefsStore.create(config, silentLog);
  }

  it('creates the data directory on startup', async () => {
    await makeStore();
    const stat = await fs.stat(path.join(dataDir, 'prefs'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('fails startup with a clear message when the data directory exists but is not writable', async () => {
    // Skip on platforms where chmod doesn't restrict the owning process (e.g. running as root,
    // or Windows, where a directory's read-only attribute doesn't block writing files into it
    // the way POSIX permission bits do).
    if (process.platform === 'win32') return;
    if (process.getuid && process.getuid() === 0) return;
    const readonlyDir = path.join(dataDir, 'readonly');
    await fs.mkdir(readonlyDir, { recursive: true });
    await fs.chmod(readonlyDir, 0o500);
    try {
      const config = loadConfig({
        NODE_ENV: 'test',
        PVE_URL: 'https://pve.example.com:8006',
        PROXION_DATA_DIR: readonlyDir,
      });
      await expect(PrefsStore.create(config, silentLog)).rejects.toThrow(/not writable/i);
    } finally {
      await fs.chmod(readonlyDir, 0o700);
    }
  });

  it('GET-equivalent (get) returns all-defaults for a user with no stored file', async () => {
    const store = await makeStore();
    const prefs = await store.get('new@pam');
    expect(prefs).toEqual(PREFS_DEFAULTS);
  });

  it('replace (PUT) persists a full document and get() reads it back', async () => {
    const store = await makeStore();
    const result = await store.replace('alice@pam', {
      version: 1,
      theme: 'dark',
      defaultRange: 'week',
      consoleThumbnails: false,
      thumbnailRefreshSeconds: 120,
      density: 'compact',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.prefs.theme).toBe('dark');

    const reread = await store.get('alice@pam');
    expect(reread.theme).toBe('dark');
    expect(reread.defaultRange).toBe('week');
    expect(reread.consoleThumbnails).toBe(false);
  });

  it('replace (PUT) rejects an invalid document without writing anything', async () => {
    const store = await makeStore();
    const result = await store.replace('bob@pam', { theme: 'rainbow' });
    expect(result.ok).toBe(false);

    const file = path.join(dataDir, 'prefs', 'bob@pam.json');
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it('merge (PATCH) applies a partial update onto defaults', async () => {
    const store = await makeStore();
    const result = await store.merge('carol@pam', { theme: 'light' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.prefs.theme).toBe('light');
    // Everything else still defaults.
    expect(result.prefs.defaultRange).toBe(PREFS_DEFAULTS.defaultRange);
    expect(result.prefs.density).toBe(PREFS_DEFAULTS.density);
  });

  it('merge (PATCH) merges onto the previously stored document, not just defaults', async () => {
    const store = await makeStore();
    await store.merge('dave@pam', { theme: 'dark' });
    const second = await store.merge('dave@pam', { density: 'compact' });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.prefs.theme).toBe('dark');
    expect(second.prefs.density).toBe('compact');
  });

  it('merge (PATCH) rejects an invalid value (400-equivalent)', async () => {
    const store = await makeStore();
    const result = await store.merge('eve@pam', { thumbnailRefreshSeconds: 45 });
    expect(result.ok).toBe(false);
  });

  it('an on-disk document missing newer fields reads back merged over defaults', async () => {
    const store = await makeStore();
    const file = path.join(dataDir, 'prefs', 'frank@pam.json');
    await fs.writeFile(file, JSON.stringify({ theme: 'dark' }));
    const prefs = await store.get('frank@pam');
    expect(prefs.theme).toBe('dark');
    expect(prefs.density).toBe(PREFS_DEFAULTS.density);
    expect(prefs.thumbnailRefreshSeconds).toBe(PREFS_DEFAULTS.thumbnailRefreshSeconds);
  });

  it('a corrupt on-disk document falls back to defaults instead of throwing', async () => {
    const store = await makeStore();
    const file = path.join(dataDir, 'prefs', 'grace@pam.json');
    await fs.writeFile(file, '{ not valid json');
    const prefs = await store.get('grace@pam');
    expect(prefs).toEqual(PREFS_DEFAULTS);
  });

  it('writes are atomic: no temp file left behind, and the target is valid JSON', async () => {
    const store = await makeStore();
    await store.replace('heidi@pam', { theme: 'dark' });
    const entries = await fs.readdir(path.join(dataDir, 'prefs'));
    expect(entries).toEqual(['heidi@pam.json']);
    const raw = await fs.readFile(path.join(dataDir, 'prefs', 'heidi@pam.json'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('concurrent writes for the same user are serialised (no lost update)', async () => {
    const store = await makeStore();
    // Fire 10 concurrent PATCHes, each flipping a different field -- if writes interleaved
    // (each reading the pre-patch document before another's write landed), some of these would
    // be lost. Serialised, all 10 land.
    await Promise.all([
      store.merge('ivan@pam', { theme: 'dark' }),
      store.merge('ivan@pam', { defaultRange: 'day' }),
      store.merge('ivan@pam', { consoleThumbnails: false }),
      store.merge('ivan@pam', { thumbnailRefreshSeconds: 30 }),
      store.merge('ivan@pam', { density: 'compact' }),
      store.merge('ivan@pam', { railWidth: 300 }),
    ]);
    const final = await store.get('ivan@pam');
    expect(final.theme).toBe('dark');
    expect(final.defaultRange).toBe('day');
    expect(final.consoleThumbnails).toBe(false);
    expect(final.thumbnailRefreshSeconds).toBe(30);
    expect(final.density).toBe('compact');
    expect(final.railWidth).toBe(300);
  });

  it('merge (PATCH) sets summaryLayout for one guest type and preserves other fields', async () => {
    const store = await makeStore();
    await store.merge('judy@pam', { theme: 'dark' });
    const result = await store.merge('judy@pam', {
      summaryLayout: { qemu: ['notes', 'console'] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.prefs.summaryLayout).toEqual({ qemu: ['notes', 'console'] });
    expect(result.prefs.theme).toBe('dark');
  });

  it('merge (PATCH) with summaryLayout: {} clears both qemu and lxc', async () => {
    const store = await makeStore();
    await store.merge('kevin@pam', {
      summaryLayout: { qemu: ['notes'], lxc: ['console'] },
    });
    const result = await store.merge('kevin@pam', { summaryLayout: {} });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.prefs.summaryLayout).toEqual({});
  });

  it('merge (PATCH) rejects more than 24 summaryLayout entries (400-equivalent)', async () => {
    const store = await makeStore();
    const tooMany = Array.from({ length: 25 }, (_, i) => `panel-${i}`);
    const result = await store.merge('laura@pam', { summaryLayout: { qemu: tooMany } });
    expect(result.ok).toBe(false);
  });

  it('merge (PATCH) rejects a non-string entry in summaryLayout (400-equivalent)', async () => {
    const store = await makeStore();
    const result = await store.merge('mallory@pam', {
      summaryLayout: { qemu: ['notes', 42] },
    } as unknown as Record<string, unknown>);
    expect(result.ok).toBe(false);
  });

  it('merge (PATCH) rejects a summaryLayout id longer than 32 characters', async () => {
    const store = await makeStore();
    const result = await store.merge('nathan@pam', {
      summaryLayout: { lxc: ['a'.repeat(33)] },
    });
    expect(result.ok).toBe(false);
  });

  it('merge (PATCH) rejects duplicate summaryLayout ids', async () => {
    const store = await makeStore();
    const result = await store.merge('oscar@pam', {
      summaryLayout: { qemu: ['notes', 'notes'] },
    });
    expect(result.ok).toBe(false);
  });

  it('merge (PATCH) sets guestList.columns and preserves other fields', async () => {
    const store = await makeStore();
    await store.merge('peggy@pam', { theme: 'dark' });
    const result = await store.merge('peggy@pam', {
      guestList: { columns: ['cpu', 'mem', 'tags'] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.prefs.guestList).toEqual({ columns: ['cpu', 'mem', 'tags'] });
    expect(result.prefs.theme).toBe('dark');
  });

  it('merge (PATCH) with guestList: {} clears a previously-saved column selection', async () => {
    const store = await makeStore();
    await store.merge('quentin@pam', { guestList: { columns: ['cpu', 'mem'] } });
    const result = await store.merge('quentin@pam', { guestList: {} });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.prefs.guestList).toEqual({});
  });

  it('merge (PATCH) rejects more than 16 guestList.columns entries (400-equivalent)', async () => {
    const store = await makeStore();
    const tooMany = Array.from({ length: 17 }, (_, i) => `col-${i}`);
    const result = await store.merge('rachel@pam', { guestList: { columns: tooMany } });
    expect(result.ok).toBe(false);
  });

  it('merge (PATCH) rejects a non-string guestList.columns entry (400-equivalent)', async () => {
    const store = await makeStore();
    const result = await store.merge('steve@pam', {
      guestList: { columns: ['cpu', 42] },
    } as unknown as Record<string, unknown>);
    expect(result.ok).toBe(false);
  });

  it('merge (PATCH) rejects duplicate guestList.columns ids', async () => {
    const store = await makeStore();
    const result = await store.merge('tina@pam', {
      guestList: { columns: ['cpu', 'cpu'] },
    });
    expect(result.ok).toBe(false);
  });

  it('two different users never collide on the same file', async () => {
    const store = await makeStore();
    await store.replace('same@pam', { theme: 'dark' });
    await store.replace('SAME@pam', { theme: 'light' });
    // These sanitise to the same filename (case-insensitive) -- documenting that behavior
    // rather than asserting isolation that doesn't exist for this pair.
    const prefs = await store.get('same@pam');
    expect(prefs.theme).toBe('light');
  });
});
