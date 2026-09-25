import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
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

function renderGuests() {
  const queryClient = createQueryClient();
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/guests'] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('GuestsPage: column visibility (T25)', () => {
  beforeEach(() => {
    // jsdom doesn't implement the Pointer Events API Radix's DropdownMenu relies on to open --
    // minimal no-op polyfills so a real click on its trigger works here (same as
    // topbar-preferences-menu.render.test.tsx's identical setup for the same primitive).
    if (!Element.prototype.hasPointerCapture) {
      Element.prototype.hasPointerCapture = () => false;
    }
    if (!Element.prototype.setPointerCapture) {
      Element.prototype.setPointerCapture = () => {};
    }
    if (!Element.prototype.releasePointerCapture) {
      Element.prototype.releasePointerCapture = () => {};
    }
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
  });

  it('shows every optional column when nothing is saved', async () => {
    getPrefsResult = { ...PREFS_DEFAULTS };
    renderGuests();
    const table = await screen.findByRole('table', {}, { timeout: FIND_TIMEOUT_MS });
    expect(within(table).getByRole('columnheader', { name: /Tags/ })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: /CPU/ })).toBeInTheDocument();
  });

  it('a previously-saved column selection hides everything not in it', async () => {
    getPrefsResult = { ...PREFS_DEFAULTS, guestList: { columns: ['cpu', 'mem'] } };
    renderGuests();
    const table = await screen.findByRole('table', {}, { timeout: FIND_TIMEOUT_MS });
    await waitFor(() => expect(within(table).getByRole('columnheader', { name: /CPU/ })).toBeInTheDocument());
    expect(within(table).queryByRole('columnheader', { name: /^Tags$/ })).not.toBeInTheDocument();
    expect(within(table).queryByRole('columnheader', { name: /Uptime/ })).not.toBeInTheDocument();
    // Always-on columns stay regardless.
    expect(within(table).getByRole('columnheader', { name: /Name/ })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: /VMID/ })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: /Node/ })).toBeInTheDocument();
  });

  it('unchecking a column in the Columns menu patches prefs and hides that column', async () => {
    getPrefsResult = { ...PREFS_DEFAULTS };
    patchPrefsMock.mockReset();
    patchPrefsMock.mockResolvedValue({ ...PREFS_DEFAULTS, readOnly: false });

    renderGuests();
    const table = await screen.findByRole('table', {}, { timeout: FIND_TIMEOUT_MS });
    expect(within(table).getByRole('columnheader', { name: /Tags/ })).toBeInTheDocument();

    const columnsButton = screen.getByRole('button', { name: /Columns/ });
    // Radix's trigger opens on `pointerdown`, not `click`.
    fireEvent.pointerDown(columnsButton, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.pointerUp(columnsButton, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(columnsButton);
    const tagsItem = await screen.findByRole('menuitemcheckbox', { name: 'Tags' }, { timeout: FIND_TIMEOUT_MS });
    expect(tagsItem).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(tagsItem);

    await waitFor(() => expect(patchPrefsMock).toHaveBeenCalled());
    const [patch] = patchPrefsMock.mock.calls.at(-1)!;
    expect(patch.guestList.columns).not.toContain('tags');
    expect(patch.guestList.columns).toEqual(expect.arrayContaining(['cpu', 'mem', 'disk', 'uptime', 'type', 'ha']));

    // The optimistic update (useUpdatePrefs) applies immediately, so the Tags column itself
    // disappears from the table without waiting for the mocked PATCH to resolve.
    await waitFor(() => expect(within(table).queryByRole('columnheader', { name: /^Tags$/ })).not.toBeInTheDocument());
  });
});
