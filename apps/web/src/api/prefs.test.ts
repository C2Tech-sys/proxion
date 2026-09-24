import { beforeEach, describe, expect, it } from 'vitest';
import { getPrefs, patchPrefs, putPrefs, PREFS_DEFAULTS } from '@/api/prefs';

// Runs with VITE_USE_FIXTURES=1 (see apps/web/.env.test), so `api/prefs.ts` is exercising its
// fixture-mode branch throughout -- there is no real server in this test environment.
describe('api/prefs (fixture mode)', () => {
  // The fixture store is a module-level singleton (there's no server to reset between tests),
  // so every test starts by putting it back to a known state.
  beforeEach(async () => {
    await putPrefs({ ...PREFS_DEFAULTS });
  });

  it('getPrefs resolves to the seeded defaults, not readOnly', async () => {
    const prefs = await getPrefs();
    expect(prefs).toEqual({ ...PREFS_DEFAULTS, readOnly: false });
  });

  it('putPrefs replaces the whole document and getPrefs reflects it', async () => {
    await putPrefs({
      version: 1,
      theme: 'dark',
      defaultRange: 'week',
      consoleThumbnails: false,
      thumbnailRefreshSeconds: 120,
      density: 'compact',
    });
    const prefs = await getPrefs();
    expect(prefs).toMatchObject({ theme: 'dark', defaultRange: 'week', density: 'compact' });
  });

  it('patchPrefs merges a partial update onto the current document', async () => {
    await putPrefs({ ...PREFS_DEFAULTS, theme: 'dark' });
    const patched = await patchPrefs({ density: 'compact' });
    expect(patched).toMatchObject({ theme: 'dark', density: 'compact' });
  });

  it('patchPrefs can set and then clear summaryLayout', async () => {
    const withLayout = await patchPrefs({ summaryLayout: { qemu: ['notes', 'console'] } });
    expect(withLayout.summaryLayout).toEqual({ qemu: ['notes', 'console'] });

    const cleared = await patchPrefs({ summaryLayout: {} });
    expect(cleared.summaryLayout).toEqual({});
  });

  it('simulates network latency (the call does not resolve on the same tick)', async () => {
    let resolved = false;
    const promise = getPrefs().then((value) => {
      resolved = true;
      return value;
    });
    expect(resolved).toBe(false);
    await promise;
    expect(resolved).toBe(true);
  });
});
