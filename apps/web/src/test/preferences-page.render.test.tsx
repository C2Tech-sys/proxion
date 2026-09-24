import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import { createQueryClient } from '@/api/queryClient';
import { PREFS_DEFAULTS } from '@/api/prefs';

/** Generous on purpose -- see tab-range-preservation.render.test.tsx for why. */
const FIND_TIMEOUT_MS = 5000;

const { patchPrefsMock } = vi.hoisted(() => ({ patchPrefsMock: vi.fn() }));

vi.mock('@/api/prefs', async () => {
  const actual = await vi.importActual<typeof import('@/api/prefs')>('@/api/prefs');
  return {
    ...actual,
    getPrefs: () => Promise.resolve({ ...actual.PREFS_DEFAULTS, readOnly: false }),
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

describe('Preferences page', () => {
  it('renders every group with its controls', async () => {
    renderPreferences();

    expect(
      await screen.findByRole('heading', { name: 'Preferences' }, { timeout: FIND_TIMEOUT_MS }),
    ).toBeInTheDocument();

    expect(screen.getByText('Appearance')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Density' })).toBeInTheDocument();

    expect(screen.getByText('Dashboard & charts')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Default Monitor range' })).toBeInTheDocument();

    expect(screen.getByText('Console thumbnails')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Show console thumbnails' })).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'Console thumbnail refresh interval' }),
    ).toBeInTheDocument();

    expect(screen.getByText('Layout')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset to default' })).toBeInTheDocument();

    expect(screen.getByText('Account')).toBeInTheDocument();
    expect(screen.getByText('Username')).toBeInTheDocument();
  });

  it('clicking a theme option saves the change (calls patchPrefs)', async () => {
    patchPrefsMock.mockReset();
    patchPrefsMock.mockResolvedValue({ ...PREFS_DEFAULTS, theme: 'dark', readOnly: false });

    renderPreferences();
    await screen.findByRole('heading', { name: 'Preferences' }, { timeout: FIND_TIMEOUT_MS });

    const themeGroup = screen.getByRole('group', { name: 'Theme' });
    fireEvent.click(within(themeGroup).getByRole('button', { name: 'Dark' }));

    await waitFor(() => expect(patchPrefsMock).toHaveBeenCalledWith({ theme: 'dark' }));
  });

  it('shows a brief "Saved" indicator after a change lands', async () => {
    patchPrefsMock.mockReset();
    patchPrefsMock.mockResolvedValue({ ...PREFS_DEFAULTS, density: 'compact', readOnly: false });

    renderPreferences();
    await screen.findByRole('heading', { name: 'Preferences' }, { timeout: FIND_TIMEOUT_MS });

    const densityGroup = screen.getByRole('group', { name: 'Density' });
    fireEvent.click(within(densityGroup).getByRole('button', { name: 'Compact' }));

    expect(await screen.findByText('Saved', {}, { timeout: FIND_TIMEOUT_MS })).toBeInTheDocument();
  });
});
