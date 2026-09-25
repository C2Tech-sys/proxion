import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { SnapshotCreateDialog, SnapshotDeleteDialog, SnapshotRollbackDialog } from '@/components/actions/SnapshotDialogs';
import { GuestActionError } from '@/api/actions';

const mockCreateSnapshot = vi.fn();
const mockDeleteSnapshot = vi.fn();
const mockRollbackSnapshot = vi.fn();

// Mocking `@/api/actions` (not `@/api/actionHooks`) keeps `useSnapshotAction` itself real --
// same pattern `RenameGuestDialog.test.tsx` uses for `updateGuestConfig`/`useUpdateGuestConfig`.
vi.mock('@/api/actions', async () => {
  const actual = await vi.importActual<typeof import('@/api/actions')>('@/api/actions');
  return {
    ...actual,
    createSnapshot: (...args: unknown[]) => mockCreateSnapshot(...args),
    deleteSnapshot: (...args: unknown[]) => mockDeleteSnapshot(...args),
    rollbackSnapshot: (...args: unknown[]) => mockRollbackSnapshot(...args),
  };
});

function withClient(children: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('SnapshotCreateDialog', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function renderDialog(props: Partial<React.ComponentProps<typeof SnapshotCreateDialog>> = {}) {
    const onOpenChange = vi.fn();
    render(
      withClient(
        <SnapshotCreateDialog
          open
          onOpenChange={onOpenChange}
          node="pve1"
          type="qemu"
          vmid={100}
          canIncludeRam
          {...props}
        />,
      ),
    );
    return { onOpenChange };
  }

  it('blocks submit and shows an inline error for an invalid name', () => {
    renderDialog();
    const input = screen.getByRole('textbox', { name: 'Snapshot name' });
    fireEvent.change(input, { target: { value: '1bad' } });

    expect(screen.getByRole('button', { name: 'Take snapshot' })).toBeDisabled();
    expect(screen.getByText(/Must start with a letter/)).toBeInTheDocument();
    expect(mockCreateSnapshot).not.toHaveBeenCalled();
  });

  it('Enter submits with the trimmed name, description, and vmstate only when checked', async () => {
    mockCreateSnapshot.mockResolvedValue({ upid: 'UPID:pve1:snap' });
    const { onOpenChange } = renderDialog();

    fireEvent.change(screen.getByRole('textbox', { name: 'Snapshot name' }), {
      target: { value: '  pre-upgrade  ' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Snapshot description' }), {
      target: { value: 'before the upgrade' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /Include RAM/ }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Snapshot name' }), { key: 'Enter' });

    await waitFor(() =>
      expect(mockCreateSnapshot).toHaveBeenCalledWith('pve1', 'qemu', 100, {
        snapname: 'pre-upgrade',
        description: 'before the upgrade',
        vmstate: true,
      }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('omits vmstate when the RAM checkbox is not checked', async () => {
    mockCreateSnapshot.mockResolvedValue({ upid: 'UPID:pve1:snap' });
    renderDialog();

    fireEvent.change(screen.getByRole('textbox', { name: 'Snapshot name' }), { target: { value: 'plain-snap' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Snapshot name' }), { key: 'Enter' });

    await waitFor(() =>
      expect(mockCreateSnapshot).toHaveBeenCalledWith('pve1', 'qemu', 100, { snapname: 'plain-snap' }),
    );
  });

  it('does not offer the RAM checkbox when canIncludeRam is false', () => {
    renderDialog({ canIncludeRam: false });
    expect(screen.queryByRole('checkbox', { name: /Include RAM/ })).not.toBeInTheDocument();
  });

  it('Escape cancels without submitting', () => {
    const { onOpenChange } = renderDialog();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Snapshot name' }), { key: 'Escape' });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockCreateSnapshot).not.toHaveBeenCalled();
  });

  it('shows the server error inline on failure', async () => {
    mockCreateSnapshot.mockRejectedValue(new GuestActionError(400, 'snapshot name already used'));
    renderDialog();

    fireEvent.change(screen.getByRole('textbox', { name: 'Snapshot name' }), { target: { value: 'dup' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Snapshot name' }), { key: 'Enter' });

    expect(await screen.findByText('snapshot name already used')).toBeInTheDocument();
  });
});

describe('SnapshotRollbackDialog', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function renderDialog(props: Partial<React.ComponentProps<typeof SnapshotRollbackDialog>> = {}) {
    const onOpenChange = vi.fn();
    render(
      withClient(
        <SnapshotRollbackDialog
          open
          onOpenChange={onOpenChange}
          node="pve1"
          type="qemu"
          vmid={100}
          guestName="web-prod-01"
          snapname="pre-upgrade"
          snaptime={1700000000}
          {...props}
        />,
      ),
    );
    return { onOpenChange };
  }

  it('shows the guest name and snapshot name in the confirmation copy', () => {
    renderDialog();
    expect(screen.getByText('Roll back web-prod-01 to pre-upgrade?')).toBeInTheDocument();
  });

  it('confirm calls rollbackSnapshot with start when the checkbox is checked (qemu)', async () => {
    mockRollbackSnapshot.mockResolvedValue({ upid: 'UPID:pve1:rb' });
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole('checkbox', { name: /Start the guest afterwards/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Roll back' }));

    await waitFor(() =>
      expect(mockRollbackSnapshot).toHaveBeenCalledWith('pve1', 'qemu', 100, 'pre-upgrade', { start: true }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('confirm without checking the box calls rollbackSnapshot with no options', async () => {
    mockRollbackSnapshot.mockResolvedValue({ upid: 'UPID:pve1:rb' });
    renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Roll back' }));

    await waitFor(() =>
      expect(mockRollbackSnapshot).toHaveBeenCalledWith('pve1', 'qemu', 100, 'pre-upgrade', undefined),
    );
  });

  it('does not offer the start checkbox for an lxc guest', () => {
    renderDialog({ type: 'lxc' });
    expect(screen.queryByRole('checkbox', { name: /Start the guest afterwards/ })).not.toBeInTheDocument();
  });

  it('cancel closes without calling rollbackSnapshot', () => {
    const { onOpenChange } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockRollbackSnapshot).not.toHaveBeenCalled();
  });
});

describe('SnapshotDeleteDialog', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function renderDialog(props: Partial<React.ComponentProps<typeof SnapshotDeleteDialog>> = {}) {
    const onOpenChange = vi.fn();
    render(
      withClient(
        <SnapshotDeleteDialog open onOpenChange={onOpenChange} node="pve1" type="qemu" vmid={100} snapname="pre-upgrade" {...props} />,
      ),
    );
    return { onOpenChange };
  }

  it('confirm calls deleteSnapshot with the snapshot name', async () => {
    mockDeleteSnapshot.mockResolvedValue({ upid: 'UPID:pve1:del' });
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(mockDeleteSnapshot).toHaveBeenCalledWith('pve1', 'qemu', 100, 'pre-upgrade', undefined));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('cancel closes without calling deleteSnapshot', () => {
    const { onOpenChange } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockDeleteSnapshot).not.toHaveBeenCalled();
  });

  it('shows the server error inline on failure', async () => {
    mockDeleteSnapshot.mockRejectedValue(new GuestActionError(502, 'Proxmox VE is unreachable'));
    renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Proxmox VE is unreachable')).toBeInTheDocument();
  });
});
