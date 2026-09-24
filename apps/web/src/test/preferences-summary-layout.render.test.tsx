import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import { createQueryClient } from '@/api/queryClient';
import { PREFS_DEFAULTS, type UserPrefs } from '@/api/prefs';

/** Generous on purpose -- see tab-range-preservation.render.test.tsx for why. */
const FIND_TIMEOUT_MS = 5000;

const { patchPrefsMock } = vi.hoisted(() => ({ patchPrefsMock: vi.fn() }));

let getPrefsResult: UserPrefs = { ...PREFS_DEFAULTS };

vi.mock('@/api/prefs', async () => {
  const actual = await vi.importActual<typeof import('@/api/prefs')>('@/api/prefs');
  return {
    ...actual,
    getPrefs: () => Promise.resolve({ ...getPrefsResult, readOnly: false }),
    patchPrefs: patchPrefsMock,
  };
});

function renderPreferences() {
  const queryClient = createQueryClient();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/preferences'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('Preferences page: Summary layout row (T22)', () => {
  it('both reset buttons are disabled when nothing is customised', async () => {
    getPrefsResult = { ...PREFS_DEFAULTS };
    renderPreferences();
    await screen.findByRole('heading', { name: 'Preferences' }, { timeout: FIND_TIMEOUT_MS });

    // The un-customised fallback and the (also un-customised) fetched document render the same
    // disabled state, so no extra wait is needed here -- unlike the two tests below, which assert
    // on values that only exist once the mocked `getPrefs()` has actually resolved.
    expect(screen.getByRole('button', { name: 'Reset (VMs)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset (containers)' })).toBeDisabled();
  });

  it('only the customised guest type\'s reset button is enabled', async () => {
    getPrefsResult = { ...PREFS_DEFAULTS, summaryLayout: { qemu: ['notes', 'console'] } };
    renderPreferences();
    await screen.findByRole('heading', { name: 'Preferences' }, { timeout: FIND_TIMEOUT_MS });

    await waitFor(
      () => expect(screen.getByRole('button', { name: 'Reset (VMs)' })).toBeEnabled(),
      { timeout: FIND_TIMEOUT_MS },
    );
    expect(screen.getByRole('button', { name: 'Reset (containers)' })).toBeDisabled();
  });

  it('clicking "Reset (VMs)" patches summaryLayout, clearing only qemu', async () => {
    getPrefsResult = {
      ...PREFS_DEFAULTS,
      summaryLayout: { qemu: ['notes', 'console'], lxc: ['guest', 'hardware'] },
    };
    patchPrefsMock.mockReset();
    patchPrefsMock.mockResolvedValue({ ...PREFS_DEFAULTS, readOnly: false });

    renderPreferences();
    await screen.findByRole('heading', { name: 'Preferences' }, { timeout: FIND_TIMEOUT_MS });

    await waitFor(
      () => expect(screen.getByRole('button', { name: 'Reset (VMs)' })).toBeEnabled(),
      { timeout: FIND_TIMEOUT_MS },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reset (VMs)' }));

    await waitFor(() =>
      expect(patchPrefsMock).toHaveBeenCalledWith({ summaryLayout: { lxc: ['guest', 'hardware'] } }),
    );
  });
});
