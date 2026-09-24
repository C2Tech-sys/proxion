import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { routeTree } from '@/routeTree.gen';

const prefsState: { defaultRange: 'hour' | 'day' | 'week' | 'month' | 'year' } = { defaultRange: 'week' };
/** Route + fixture data render takes a while when the whole suite runs in parallel. */
const FIND_TIMEOUT_MS = 8000;

vi.mock('@/api/prefsHooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/prefsHooks')>();
  const { PREFS_DEFAULTS } = await import('@/api/prefs');
  return {
    ...actual,
    usePrefs: () => ({
      data: { ...PREFS_DEFAULTS, readOnly: false, defaultRange: prefsState.defaultRange },
    }),
    useThemePreferenceSync: () => undefined,
  };
});

/**
 * The Monitor tabs read the range from the URL first and the user's `defaultRange`
 * preference second (Preferences page), falling back to 'hour'. The preference must not
 * rewrite the address bar: it applies where the range is read.
 */
async function renderAt(path: string) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByRole('group', { name: 'Time range' })).toBeInTheDocument(), {
    timeout: FIND_TIMEOUT_MS,
  });
  return router;
}

function activeChip(): string | null {
  const group = screen.getByRole('group', { name: 'Time range' });
  const pressed = group.querySelector('[aria-pressed="true"]');
  return pressed?.textContent ?? null;
}

describe('Monitor tab default range preference', () => {
  afterEach(() => cleanup());

  it('VM Monitor: no ?range= in the URL -> the preference is used, and the URL is left alone', async () => {
    prefsState.defaultRange = 'week';
    const router = await renderAt('/vm/pve1/qemu/100?tab=monitor');
    await waitFor(() => expect(activeChip()).toBe('Week'), { timeout: FIND_TIMEOUT_MS });
    expect(router.state.location.search).not.toHaveProperty('range');
  });

  it('VM Monitor: an explicit ?range= wins over the preference', async () => {
    prefsState.defaultRange = 'week';
    await renderAt('/vm/pve1/qemu/100?tab=monitor&range=day');
    await waitFor(() => expect(activeChip()).toBe('Day'), { timeout: FIND_TIMEOUT_MS });
  });

  it('Node Monitor: the preference applies there too', async () => {
    prefsState.defaultRange = 'month';
    const router = await renderAt('/node/pve1?tab=monitor');
    await waitFor(() => expect(activeChip()).toBe('Month'), { timeout: FIND_TIMEOUT_MS });
    expect(router.state.location.search).not.toHaveProperty('range');
  });
});
