import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  NOTIFY_SETTINGS_FILE_NAME,
  NotifySettingsStore,
  buildNotifyChannels,
  effectiveNotifySettings,
  isMuted,
  notifySettingsSchema,
  type NotifySettings,
} from '../src/notify/settingsStore.js';

function logger() {
  return { warn: vi.fn() };
}

const FULL: NotifySettings = {
  version: 1,
  enabled: false,
  muteUntil: '2030-01-01T00:00:00.000Z',
  mutedKinds: ['backup', 'storage'],
  minSeverity: 'error',
  includeResolved: false,
  debounceMs: 30_000,
  siteName: 'Rack 4',
  publicUrl: 'https://proxion.example.com',
  webhook: { url: 'https://hooks.example.com/abc/def?k=v', format: 'slack', token: 'tok-123' },
  email: { smtpUrl: 'smtps://mailer:pw@smtp.example.com:465', from: 'proxion@example.com', to: ['a@example.com', 'b@example.com'] },
};

describe('NotifySettingsStore', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'proxion-notify-settings-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('starts empty when there is no file', async () => {
    const log = logger();
    const store = await NotifySettingsStore.load(dataDir, log);
    expect(store.current).toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('round-trips a full document through save and load', async () => {
    const store = await NotifySettingsStore.load(dataDir, logger());
    await store.save(FULL);
    expect(store.current).toStrictEqual(FULL);

    const reloaded = await NotifySettingsStore.load(dataDir, logger());
    expect(reloaded.current).toStrictEqual(FULL);
    expect(JSON.parse(readFileSync(path.join(dataDir, NOTIFY_SETTINGS_FILE_NAME), 'utf8'))).toStrictEqual(FULL);
  });

  it('writes atomically (no temp files left behind) and with mode 0600 on POSIX', async () => {
    const store = await NotifySettingsStore.load(dataDir, logger());
    await store.save(FULL);
    await store.save({ ...FULL, siteName: 'Rack 5' });

    expect(readdirSync(dataDir)).toStrictEqual([NOTIFY_SETTINGS_FILE_NAME]);
    if (process.platform !== 'win32') {
      expect(statSync(path.join(dataDir, NOTIFY_SETTINGS_FILE_NAME)).mode & 0o777).toBe(0o600);
    }
  });

  it('ignores a file that is not JSON, with a warning that never carries file content', async () => {
    writeFileSync(path.join(dataDir, NOTIFY_SETTINGS_FILE_NAME), '{ "webhook": "SECRET-IN-BAD-JSON', 'utf8');
    const log = logger();
    const store = await NotifySettingsStore.load(dataDir, log);
    expect(store.current).toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('SECRET-IN-BAD-JSON');
  });

  it('ignores a file that fails the schema, naming the fields but not the values', async () => {
    const bad = { ...FULL, debounceMs: 5, webhook: { ...FULL.webhook, url: 'ftp://hooks.example.com/SECRETPATH' } };
    writeFileSync(path.join(dataDir, NOTIFY_SETTINGS_FILE_NAME), JSON.stringify(bad), 'utf8');
    const log = logger();
    const store = await NotifySettingsStore.load(dataDir, log);
    expect(store.current).toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(log.warn.mock.calls);
    expect(logged).toContain('debounceMs');
    expect(logged).toContain('webhook.url');
    expect(logged).not.toContain('SECRETPATH');
  });

  it('refuses to save an invalid document and leaves the previous file in place', async () => {
    const store = await NotifySettingsStore.load(dataDir, logger());
    await store.save(FULL);
    await expect(store.save({ ...FULL, debounceMs: 10 })).rejects.toThrow();
    expect(store.current).toStrictEqual(FULL);
    expect(JSON.parse(readFileSync(path.join(dataDir, NOTIFY_SETTINGS_FILE_NAME), 'utf8'))).toStrictEqual(FULL);
    expect(readdirSync(dataDir)).toStrictEqual([NOTIFY_SETTINGS_FILE_NAME]);
  });

  it('the schema is strict', () => {
    expect(notifySettingsSchema.safeParse({ ...FULL, extra: 1 }).success).toBe(false);
    expect(notifySettingsSchema.safeParse({ ...FULL, version: 2 }).success).toBe(false);
  });
});

describe('effectiveNotifySettings', () => {
  const baseEnv = { NODE_ENV: 'test', PVE_URL: 'https://pve.example.com:8006' };

  it('env only: the env defaults, source env, comma-separated recipients split', () => {
    const config = loadConfig({
      ...baseEnv,
      PROXION_NOTIFY_WEBHOOK_URL: 'https://hooks.example.com/x',
      PROXION_NOTIFY_WEBHOOK_FORMAT: 'discord',
      PROXION_NOTIFY_WEBHOOK_TOKEN: 'envtoken',
      PROXION_NOTIFY_SMTP_URL: 'smtp://u:p@smtp.example.com:587',
      PROXION_NOTIFY_EMAIL_FROM: 'from@example.com',
      PROXION_NOTIFY_EMAIL_TO: 'a@example.com, b@example.com',
      PROXION_NOTIFY_MIN_SEVERITY: 'error',
      PROXION_NOTIFY_INCLUDE_RESOLVED: 'false',
      PROXION_NOTIFY_DEBOUNCE_MS: '5000',
      PROXION_NOTIFY_SITE_NAME: 'Lab',
      PROXION_PUBLIC_URL: 'https://proxion.example.com',
    });
    expect(effectiveNotifySettings(config, undefined)).toStrictEqual({
      version: 1,
      source: 'env',
      enabled: true,
      mutedKinds: [],
      minSeverity: 'error',
      includeResolved: false,
      debounceMs: 5000,
      siteName: 'Lab',
      publicUrl: 'https://proxion.example.com',
      webhook: { url: 'https://hooks.example.com/x', format: 'discord', token: 'envtoken' },
      email: { smtpUrl: 'smtp://u:p@smtp.example.com:587', from: 'from@example.com', to: ['a@example.com', 'b@example.com'] },
    });
  });

  it('env only with nothing configured: enabled, no channels, defaults', () => {
    const effective = effectiveNotifySettings(loadConfig(baseEnv), undefined);
    expect(effective).toStrictEqual({
      version: 1,
      source: 'env',
      enabled: true,
      mutedKinds: [],
      minSeverity: 'warning',
      includeResolved: true,
      debounceMs: 10_000,
      siteName: 'Proxion',
    });
    expect(buildNotifyChannels(effective)).toHaveLength(0);
  });

  it('the file wins outright, with no per-field merge from the env', () => {
    const config = loadConfig({
      ...baseEnv,
      PROXION_NOTIFY_WEBHOOK_URL: 'https://env.example.com/x',
      PROXION_NOTIFY_SITE_NAME: 'FromEnv',
    });
    const fileOnly: NotifySettings = {
      version: 1,
      enabled: true,
      mutedKinds: [],
      minSeverity: 'warning',
      includeResolved: true,
      debounceMs: 10_000,
      siteName: 'FromFile',
    };
    const effective = effectiveNotifySettings(config, fileOnly);
    expect(effective.source).toBe('file');
    expect(effective.siteName).toBe('FromFile');
    expect(effective.webhook).toBeUndefined();
  });

  it('isMuted: only a future muteUntil mutes', () => {
    const now = Date.parse('2030-06-01T00:00:00.000Z');
    expect(isMuted({}, now)).toBe(false);
    expect(isMuted({ muteUntil: '2030-06-01T00:00:01.000Z' }, now)).toBe(true);
    expect(isMuted({ muteUntil: '2030-05-31T23:59:59.000Z' }, now)).toBe(false);
  });

  it('buildNotifyChannels makes one channel per configured target, exposing hosts only', () => {
    const channels = buildNotifyChannels(FULL);
    expect(channels.map((c) => [c.name, c.host])).toStrictEqual([
      ['webhook', 'hooks.example.com'],
      ['email', 'smtp.example.com:465'],
    ]);
  });
});
