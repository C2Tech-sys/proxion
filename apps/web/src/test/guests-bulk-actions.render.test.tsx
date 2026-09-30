import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import { createQueryClient } from '@/api/queryClient';
import { GuestActionError } from '@/api/actions';
import { BulkActionsBar } from '@/components/actions/BulkActionsBar';

/**
 * T44: bulk power actions on the Guests list. Runs in this suite's default fixture mode (see
 * `guests-page.render.test.tsx`) so the bar's buttons are enabled (session/fixture gate) without
 * needing to mock auth -- only `guestAction` itself is mocked, so a confirm's exact requests can
 * be asserted directly, same trick `object-header-actions.render.test.tsx` uses for the per-guest
 * flow. Token-mode's disabled state is exercised directly against `BulkActionsBar` at the bottom
 * of this file (a pure presentational component, so no router/auth wiring is needed for it).
 */
const mockGuestAction = vi.fn();

vi.mock('@/api/actions', async () => {
  const actual = await vi.importActual<typeof import('@/api/actions')>('@/api/actions');
  return { ...actual, guestAction: (...args: unknown[]) => mockGuestAction(...args) };
});

const FIND_TIMEOUT_MS = 5000;

function renderGuests(initialEntry = '/guests') {
  const queryClient = createQueryClient();
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [initialEntry] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

function guestCheckbox(name: string) {
  return screen.getByRole('checkbox', { name: `Select ${name}` });
}

describe('Guests list bulk power actions (T44)', () => {
  afterEach(() => {
    mockGuestAction.mockReset();
  });

  it('selecting two running guests via checkboxes does not navigate, and shows "2 selected"', async () => {
    const router = renderGuests();
    await screen.findByRole('table', {}, { timeout: FIND_TIMEOUT_MS });

    fireEvent.click(guestCheckbox('web-prod-01'));
    fireEvent.click(guestCheckbox('web-prod-02'));

    expect(await screen.findByText('2 selected')).toBeInTheDocument();
    // Clicking a row's checkbox must never trigger the row's own "open the guest" navigation.
    expect(router.state.location.pathname).toBe('/guests');
    expect(guestCheckbox('web-prod-01').closest('tr')).toHaveAttribute('aria-selected', 'true');
  });

  it('a keydown bubbling up from the row checkbox does not navigate the row (T44 fix pass)', async () => {
    const router = renderGuests();
    await screen.findByRole('table', {}, { timeout: FIND_TIMEOUT_MS });

    const checkbox = guestCheckbox('web-prod-01');
    checkbox.focus();
    // Radix's Checkbox calls `preventDefault()` on Enter (so Enter never toggles it -- only Space
    // does, per the ARIA checkbox pattern) but not `stopPropagation()`; before the fix, this
    // keydown bubbled up to the row's own `onKeyDown` and navigated to the guest.
    fireEvent.keyDown(checkbox, { key: 'Enter' });

    expect(router.state.location.pathname).toBe('/guests');
    // Enter isn't a checkbox's activation key, so it must not have toggled either.
    expect(checkbox).not.toBeChecked();
  });

  it('Shut down: the dialog lists both selected guests, and confirm calls guestAction for each with the shutdown body', async () => {
    mockGuestAction.mockResolvedValue({ upid: 'UPID:pve1:test' });
    renderGuests();
    await screen.findByRole('table', {}, { timeout: FIND_TIMEOUT_MS });

    fireEvent.click(guestCheckbox('web-prod-01'));
    fireEvent.click(guestCheckbox('web-prod-02'));
    fireEvent.click(await screen.findByRole('button', { name: 'Shut down' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Shut down 2 guests?')).toBeInTheDocument();
    expect(within(dialog).getByText('web-prod-01')).toBeInTheDocument();
    expect(within(dialog).getByText('web-prod-02')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Shut down 2 guests' }));

    await waitFor(() => expect(mockGuestAction).toHaveBeenCalledTimes(2));
    expect(mockGuestAction).toHaveBeenCalledWith('pve1', 'qemu', 100, 'shutdown', undefined);
    expect(mockGuestAction).toHaveBeenCalledWith('pve1', 'qemu', 101, 'shutdown', undefined);
    await within(dialog).findByText('2 started');
  });

  it('one mocked failure: the summary shows the count and the failing guest\'s name', async () => {
    mockGuestAction.mockImplementation((_node: string, _type: string, vmid: number) =>
      vmid === 101
        ? Promise.reject(new GuestActionError(403, "You don't have VM.PowerMgmt on this guest"))
        : Promise.resolve({ upid: 'UPID:pve1:test' }),
    );
    renderGuests();
    await screen.findByRole('table', {}, { timeout: FIND_TIMEOUT_MS });

    fireEvent.click(guestCheckbox('web-prod-01'));
    fireEvent.click(guestCheckbox('web-prod-02'));
    fireEvent.click(await screen.findByRole('button', { name: 'Shut down' }));

    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Shut down 2 guests' }));

    await within(dialog).findByText('1 started, 1 failed');
    expect(within(dialog).getByText(/web-prod-02:.*VM\.PowerMgmt/)).toBeInTheDocument();
  });

  it('the header checkbox selects only the filtered rows (?node=pve2 -> 3 selected)', async () => {
    renderGuests('/guests?node=pve2');
    await screen.findByRole('table', {}, { timeout: FIND_TIMEOUT_MS });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all guests' }));

    expect(await screen.findByText('3 selected')).toBeInTheDocument();
  });

  it('a template is skipped with reason "template" and never sent to guestAction', async () => {
    mockGuestAction.mockResolvedValue({ upid: 'UPID:pve1:test' });
    renderGuests();
    await screen.findByRole('table', {}, { timeout: FIND_TIMEOUT_MS });

    // lab-arch is a stopped, non-template guest (applicable for Start); tpl-ubuntu-2404 is a
    // stopped template (always skipped, regardless of status) -- see fixtures/resources.json.
    fireEvent.click(guestCheckbox('lab-arch'));
    fireEvent.click(guestCheckbox('tpl-ubuntu-2404'));
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Start 1 guest?')).toBeInTheDocument();
    expect(within(dialog).getByText('Skipped (1)')).toBeInTheDocument();
    expect(within(dialog).getByText(/tpl-ubuntu-2404.*template/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Start 1 guest' }));

    await waitFor(() => expect(mockGuestAction).toHaveBeenCalledTimes(1));
    expect(mockGuestAction).toHaveBeenCalledWith('pve1', 'qemu', 105, 'start', undefined);
  });
});

describe('BulkActionsBar token mode', () => {
  it('disables every action button with the read-only tooltip', () => {
    render(
      <BulkActionsBar selectedCount={2} tokenMode onAction={() => {}} onClear={() => {}} />,
    );

    for (const name of ['Start', 'Shut down', 'Reboot', 'Stop']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'Read-only: signed in with a service token');
    }
    // Clear stays usable in token mode -- it only changes local selection state.
    expect(screen.getByRole('button', { name: 'Clear' })).not.toBeDisabled();
  });
});
