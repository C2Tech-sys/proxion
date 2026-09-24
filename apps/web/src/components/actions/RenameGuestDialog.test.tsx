import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { RenameGuestDialog } from '@/components/actions/RenameGuestDialog';
import { GuestActionError } from '@/api/actions';

const mockUpdateGuestConfig = vi.fn();

// Mocking `@/api/actions` (not `@/api/actionHooks`) keeps `useUpdateGuestConfig` itself real --
// same pattern `object-header-actions.render.test.tsx` uses for `guestAction`/`useGuestAction`.
vi.mock('@/api/actions', async () => {
  const actual = await vi.importActual<typeof import('@/api/actions')>('@/api/actions');
  return { ...actual, updateGuestConfig: (...args: unknown[]) => mockUpdateGuestConfig(...args) };
});

function renderDialog(props: Partial<React.ComponentProps<typeof RenameGuestDialog>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <RenameGuestDialog
        open
        onOpenChange={onOpenChange}
        node="pve1"
        type="qemu"
        vmid={100}
        currentName="web-prod-01"
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

describe('RenameGuestDialog', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('prefills the input with the current name', () => {
    renderDialog();
    expect(screen.getByRole('textbox', { name: 'Guest name' })).toHaveValue('web-prod-01');
  });

  it('blocks submit and shows an inline error for an invalid name', () => {
    renderDialog();
    const input = screen.getByRole('textbox', { name: 'Guest name' });
    fireEvent.change(input, { target: { value: 'bad_name!' } });

    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
    expect(screen.getByText(/Must be a valid hostname/)).toBeInTheDocument();
    expect(mockUpdateGuestConfig).not.toHaveBeenCalled();
  });

  it('Enter submits with the trimmed name', async () => {
    mockUpdateGuestConfig.mockResolvedValue({ ok: true, changed: ['name'] });
    const { onOpenChange } = renderDialog();
    const input = screen.getByRole('textbox', { name: 'Guest name' });

    fireEvent.change(input, { target: { value: '  web-02  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(mockUpdateGuestConfig).toHaveBeenCalledWith('pve1', 'qemu', 100, { name: 'web-02' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('Escape cancels without submitting', () => {
    const { onOpenChange } = renderDialog();
    const input = screen.getByRole('textbox', { name: 'Guest name' });

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockUpdateGuestConfig).not.toHaveBeenCalled();
  });

  it('shows the server error inline on failure', async () => {
    mockUpdateGuestConfig.mockRejectedValue(new GuestActionError(400, 'name already in use'));
    renderDialog();
    const input = screen.getByRole('textbox', { name: 'Guest name' });

    fireEvent.change(input, { target: { value: 'web-02' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByText('name already in use')).toBeInTheDocument();
  });
});
