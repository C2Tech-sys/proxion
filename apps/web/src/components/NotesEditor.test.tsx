import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { NotesEditor } from '@/components/NotesEditor';
import { GuestActionError } from '@/api/actions';

const mockUpdateGuestConfig = vi.fn();

vi.mock('@/api/actions', async () => {
  const actual = await vi.importActual<typeof import('@/api/actions')>('@/api/actions');
  return { ...actual, updateGuestConfig: (...args: unknown[]) => mockUpdateGuestConfig(...args) };
});

function renderEditor(initialValue = 'hello') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onDone = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <NotesEditor node="pve1" type="qemu" vmid={100} initialValue={initialValue} onDone={onDone} />
    </QueryClientProvider>,
  );
  return { onDone };
}

describe('NotesEditor', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('enters with the initial value in the textarea', () => {
    renderEditor('existing notes');
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveValue('existing notes');
  });

  it('shows no counter under the threshold, and one past 7,000 characters', () => {
    renderEditor('short');
    expect(screen.queryByText(/\/8192/)).not.toBeInTheDocument();

    const textarea = screen.getByRole('textbox', { name: 'Notes' });
    fireEvent.change(textarea, { target: { value: 'a'.repeat(7001) } });
    expect(screen.getByText('7001/8192')).toBeInTheDocument();
  });

  it('Ctrl+Enter saves with the current text', async () => {
    mockUpdateGuestConfig.mockResolvedValue({ ok: true, changed: ['description'] });
    const { onDone } = renderEditor('old');
    const textarea = screen.getByRole('textbox', { name: 'Notes' });

    fireEvent.change(textarea, { target: { value: 'new notes' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    await waitFor(() =>
      expect(mockUpdateGuestConfig).toHaveBeenCalledWith('pve1', 'qemu', 100, { description: 'new notes' }),
    );
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('Escape restores (calls onDone without saving)', () => {
    const { onDone } = renderEditor('old');
    const textarea = screen.getByRole('textbox', { name: 'Notes' });

    fireEvent.change(textarea, { target: { value: 'unsaved edit' } });
    fireEvent.keyDown(textarea, { key: 'Escape' });

    expect(onDone).toHaveBeenCalled();
    expect(mockUpdateGuestConfig).not.toHaveBeenCalled();
  });

  it('shows the server error inline and stays in edit mode on failure', async () => {
    mockUpdateGuestConfig.mockRejectedValue(new GuestActionError(502, 'Proxmox VE is unreachable'));
    const { onDone } = renderEditor('old');
    const textarea = screen.getByRole('textbox', { name: 'Notes' });

    fireEvent.change(textarea, { target: { value: 'new notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Proxmox VE is unreachable')).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });
});
