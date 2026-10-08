import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostIsAllowed, loadConfig, parseAllowedHosts } from '../src/config.js';
import {
  NOTIFY_SETTINGS_FILE_NAME,
  NotifySettingsStore,
  allowedNotifyHosts,
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

  it('env addresses must be bare: a bad EMAIL_TO or EMAIL_FROM names its key in notifyConfigError', () => {
    const email = {
      PROXION_NOTIFY_SMTP_URL: 'smtp://u:p@smtp.example.com:587',
      PROXION_NOTIFY_EMAIL_FROM: 'from@example.com',
      PROXION_NOTIFY_EMAIL_TO: 'a@example.com',
    };
    expect(loadConfig({ ...baseEnv, ...email }).notifyConfigError).toBeUndefined();
    expect(loadConfig({ ...baseEnv, ...email, PROXION_NOTIFY_EMAIL_TO: 'a@example.com, b@example.com' }).notifyConfigError).toBeUndefined();

    for (const [key, value] of [
      ['PROXION_NOTIFY_EMAIL_TO', 'garbage'],
      ['PROXION_NOTIFY_EMAIL_TO', 'a@example.com, not an email'],
      ['PROXION_NOTIFY_EMAIL_TO', 'Ops <ops@example.com>'],
      ['PROXION_NOTIFY_EMAIL_FROM', 'Ops <ops@example.com>'],
      ['PROXION_NOTIFY_EMAIL_FROM', 'nobody'],
    ] as const) {
      const config = loadConfig({ ...baseEnv, ...email, [key]: value });
      expect(config.notifyConfigError).toContain(key);
      // A bad value drops every channel (T59): nothing is built from it.
      expect(buildNotifyChannels(effectiveNotifySettings(config, undefined))).toHaveLength(0);
    }
  });

  it('the settings schema applies the same address rule', () => {
    const base = { ...FULL };
    const withEmail = (from: string, to: string[]) =>
      notifySettingsSchema.safeParse({ ...base, email: { smtpUrl: 'smtp://x.example.com', from, to } }).success;
    expect(withEmail('ops@example.com', ['a@example.com'])).toBe(true);
    expect(withEmail('ops@example.com', ['not an email'])).toBe(false);
    expect(withEmail('ops@example.com', ['a@b.c\r\nBcc: x@y.z'])).toBe(false);
    expect(withEmail('ops@example.com', ['a@b.c,d@e.f'])).toBe(false);
    expect(withEmail('Ops <ops@example.com>', ['a@example.com'])).toBe(false);
    expect(withEmail('ops@example.com\n', ['a@example.com'])).toBe(false);
    expect(withEmail('@.', ['a@example.com'])).toBe(false);
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

describe('PROXION_NOTIFY_ALLOWED_HOSTS', () => {
  const baseEnv = { NODE_ENV: 'test', PVE_URL: 'https://pve.example.com:8006' };

  it('parseAllowedHosts: unset or empty = unrestricted; entries are lower-cased, de-dotted and de-duplicated', () => {
    expect(parseAllowedHosts(undefined)).toBeNull();
    expect(parseAllowedHosts('')).toBeNull();
    expect(parseAllowedHosts(' , ,')).toBeNull();
    expect(parseAllowedHosts('Hooks.Example.COM., ntfy.lan,hooks.example.com')).toStrictEqual(['hooks.example.com', 'ntfy.lan']);
  });

  it('hostIsAllowed: exact match after normalisation, ports ignored, null allows everything', () => {
    expect(hostIsAllowed('anything.example', null)).toBe(true);
    const allowed = ['hooks.example.com', 'ntfy.lan'];
    expect(hostIsAllowed('hooks.example.com', allowed)).toBe(true);
    expect(hostIsAllowed('HOOKS.Example.Com', allowed)).toBe(true);
    expect(hostIsAllowed('hooks.example.com.', allowed)).toBe(true); // trailing dot
    expect(hostIsAllowed('evil-hooks.example.com', allowed)).toBe(false);
    expect(hostIsAllowed('hooks.example.com.evil.net', allowed)).toBe(false);
    expect(hostIsAllowed('x.hooks.example.com', allowed)).toBe(false);
    expect(hostIsAllowed('', allowed)).toBe(false);
  });

  it('hostIsAllowed: *.example.com matches exactly one extra label', () => {
    const allowed = ['*.example.com'];
    expect(hostIsAllowed('hooks.example.com', allowed)).toBe(true);
    expect(hostIsAllowed('HOOKS.EXAMPLE.COM.', allowed)).toBe(true);
    expect(hostIsAllowed('example.com', allowed)).toBe(false);
    expect(hostIsAllowed('a.b.example.com', allowed)).toBe(false);
    expect(hostIsAllowed('hooksexample.com', allowed)).toBe(false);
    expect(hostIsAllowed('.example.com', allowed)).toBe(false);
  });

  it('config: a good value is kept as written; a bad value FAILS CLOSED (deny-all) and leaves the other notify values alone', () => {
    expect(loadConfig({ ...baseEnv, PROXION_NOTIFY_ALLOWED_HOSTS: 'hooks.example.com,*.lan' }).notifyConfigError).toBeUndefined();
    expect(loadConfig(baseEnv).PROXION_NOTIFY_ALLOWED_HOSTS).toBeUndefined();
    expect(allowedNotifyHosts(loadConfig({ ...baseEnv, PROXION_NOTIFY_ALLOWED_HOSTS: 'Hooks.Example.COM.,*.lan' }))).toStrictEqual([
      'hooks.example.com',
      '*.lan',
    ]);
    expect(allowedNotifyHosts(loadConfig(baseEnv))).toBeNull();
    expect(allowedNotifyHosts(loadConfig({ ...baseEnv, PROXION_NOTIFY_ALLOWED_HOSTS: ' , ' }))).toBeNull();

    const message = 'PROXION_NOTIFY_ALLOWED_HOSTS is invalid; fix proxion.env and redeploy';
    for (const bad of [
      'hooks.example.com:443',
      'http://hooks.example.com',
      'hooks.example.com/path',
      'a b',
      '*',
      '**.example.com',
      'ex*ample.com',
    ]) {
      const config = loadConfig({
        ...baseEnv,
        PROXION_NOTIFY_WEBHOOK_URL: 'https://hooks.example.com/x',
        PROXION_NOTIFY_ALLOWED_HOSTS: bad,
      });
      expect(config.allowedHostsError, bad).toBe(message);
      expect(config.PROXION_NOTIFY_ALLOWED_HOSTS).toBeUndefined();
      expect(allowedNotifyHosts(config), bad).toStrictEqual([]); // deny-all, NOT "unset"
      // the rest of the notify env is untouched (T59 behaviour is unchanged)
      expect(config.notifyConfigError).toBeUndefined();
      expect(config.PROXION_NOTIFY_WEBHOOK_URL).toBe('https://hooks.example.com/x');
    }

    // an allowlist error and a T59 error are independent
    const both = loadConfig({ ...baseEnv, PROXION_NOTIFY_WEBHOOK_FORMAT: 'nope', PROXION_NOTIFY_ALLOWED_HOSTS: 'a:1' });
    expect(both.allowedHostsError).toBe(message);
    expect(both.notifyConfigError).toContain('PROXION_NOTIFY_WEBHOOK_FORMAT');
  });

  it('deny-all builds nothing and warns once, naming the key and not the hosts', () => {
    const warn = vi.fn();
    expect(buildNotifyChannels(FULL, { allowedHosts: [], log: { warn } })).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('PROXION_NOTIFY_ALLOWED_HOSTS');
    expect(logged).not.toContain('example.com');
  });

  it('buildNotifyChannels drops a target outside the allowlist with a warning naming the key, never the host', () => {
    const warn = vi.fn();
    const channels = buildNotifyChannels(FULL, { allowedHosts: ['smtp.example.com'], log: { warn } });
    expect(channels.map((c) => c.name)).toStrictEqual(['email']);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('PROXION_NOTIFY_ALLOWED_HOSTS');
    expect(logged).toContain('webhook');
    expect(logged).not.toContain('hooks.example.com');
    expect(logged).not.toContain('smtp.example.com');

    expect(buildNotifyChannels(FULL, { allowedHosts: ['*.example.com'], log: { warn } })).toHaveLength(2);
    expect(buildNotifyChannels(FULL, { allowedHosts: ['other.net'], log: { warn } })).toHaveLength(0);
    expect(buildNotifyChannels(FULL, { allowedHosts: null })).toHaveLength(2);
  });
});
