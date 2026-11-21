import { afterEach, describe, expect, it } from 'vitest';
import {
  fixtureClient,
  getFixtureNotifySettings,
  putFixtureNotifySettings,
  resetFixtureNotifySettings,
  type FixtureNotifySettingsPut,
} from './fixtures';

/** Demo mode mirrors the server (T78): the demo's alerts strip honours the excluded-storage list. */
const BASE_PUT: FixtureNotifySettingsPut = {
  enabled: true,
  mutedKinds: [],
  minSeverity: 'warning',
  includeResolved: true,
  debounceMs: 10_000,
  siteName: 'Proxion',
};

afterEach(() => {
  resetFixtureNotifySettings();
});

describe('fixture notification settings: excludedStorages', () => {
  it('starts empty, and the over-threshold demo storage alerts as before', async () => {
    expect(getFixtureNotifySettings().excludedStorages).toEqual([]);
    const alerts = await fixtureClient.getAlerts();
    expect(alerts.some((a) => a.kind === 'storage' && a.storage === 'tank-backups')).toBe(true);
  });

  it('an excluded storage leaves the alerts strip but keeps its real usage numbers', async () => {
    putFixtureNotifySettings({ ...BASE_PUT, excludedStorages: ['tank-backups'] });
    expect(getFixtureNotifySettings().excludedStorages).toEqual(['tank-backups']);

    const alerts = await fixtureClient.getAlerts();
    expect(alerts.some((a) => a.kind === 'storage' && a.storage === 'tank-backups')).toBe(false);

    const resources = await fixtureClient.getClusterResources();
    const row = resources.find((r) => r.type === 'storage' && r.storage === 'tank-backups');
    expect(row?.maxdisk).toBeGreaterThan(0);
    expect((row?.disk ?? 0) / (row?.maxdisk ?? 1)).toBeGreaterThan(0.85);
  });

  it('stores the list deduplicated and sorted; omitting it keeps it; [] clears it', () => {
    putFixtureNotifySettings({ ...BASE_PUT, excludedStorages: ['tank', 'cloud', 'tank'] });
    expect(getFixtureNotifySettings().excludedStorages).toEqual(['cloud', 'tank']);
    putFixtureNotifySettings({ ...BASE_PUT, siteName: 'Renamed' });
    expect(getFixtureNotifySettings().excludedStorages).toEqual(['cloud', 'tank']);
    putFixtureNotifySettings({ ...BASE_PUT, excludedStorages: [] });
    expect(getFixtureNotifySettings().excludedStorages).toEqual([]);
  });

  it('rejects names the server would reject', () => {
    expect(() => putFixtureNotifySettings({ ...BASE_PUT, excludedStorages: ['bad name'] })).toThrow(/excludedStorages/);
    expect(() => putFixtureNotifySettings({ ...BASE_PUT, excludedStorages: [''] })).toThrow(/excludedStorages/);
    expect(() =>
      putFixtureNotifySettings({ ...BASE_PUT, excludedStorages: Array.from({ length: 65 }, (_, i) => `s${i}`) }),
    ).toThrow(/excludedStorages/);
  });
});
