import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import { createQueryClient } from '@/api/queryClient';
import { useCreateStore } from '@/store/createStore';
import type { AuthIdentity } from '@/api/client-types';

/**
 * The "Create" entry points (top bar button, node context menu) and the two stub dialogs mounted
 * in the shell. `useAuthMe` is mocked to switch between a signed-in session and the shared service
 * token; `USE_FIXTURES` is forced off so the session gate is actually evaluated (in fixture mode it
 * always passes). Everything else still reads the bundled fixtures.
 */
const FIND_TIMEOUT_MS = 5000;

let authMode: AuthIdentity['mode'] = 'session';

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return { ...actual, USE_FIXTURES: false };
});

vi.mock('@/api/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/api/hooks')>('@/api/hooks');
  return {
    ...actual,
    useAuthMe: () => ({
      data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode: authMode },
      isLoading: false,
      isFetching: false,
    }),
  };
});

/** Radix's DropdownMenu trigger opens on `pointerdown`, not `click` -- same sequence
 * `node-actions.render.test.tsx` uses. */
function openDropdown(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.pointerUp(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(trigger);
}

function renderShell() {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/'] }) });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** The inventory rail's row for a node, found through its chevron (the node name also appears on the
 * dashboard, so a text query is ambiguous); the context-menu event bubbles up to the row trigger. */
function findNodeRow(node: string) {
  return screen.findByRole('button', { name: `Collapse ${node}` }, { timeout: FIND_TIMEOUT_MS });
}

async function findTopBarAnchor() {
  return screen.findByRole('button', { name: 'All tasks' }, { timeout: FIND_TIMEOUT_MS });
}

describe('Create entry points', () => {
  beforeEach(() => {
    cleanup();
    authMode = 'session';
    useCreateStore.setState({ open: null });
  });

  it('the top bar has no Create button in token mode', async () => {
    authMode = 'token';
    renderShell();
    await findTopBarAnchor();

    expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument();
  });

  it('the node context menu has no create items in token mode', async () => {
    authMode = 'token';
    renderShell();
    fireEvent.contextMenu(await findNodeRow('pve1'));
    const menu = await screen.findByRole('menu');

    expect(within(menu).getByRole('menuitem', { name: /Open shell/ })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /Create/ })).not.toBeInTheDocument();
  });

  it('the Create button appears in session mode and its menu opens the VM stub with no node', async () => {
    renderShell();
    await findTopBarAnchor();
    expect(screen.queryByTestId('create-vm-dialog')).not.toBeInTheDocument();

    openDropdown(await screen.findByRole('button', { name: 'Create' }, { timeout: FIND_TIMEOUT_MS }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /^Container/ })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Virtual machine/ }));

    const dialog = await screen.findByTestId('create-vm-dialog');
    expect(within(dialog).getByText('Create virtual machine')).toBeInTheDocument();
    expect(within(dialog).getByText('Coming soon.')).toBeInTheDocument();
    expect(within(dialog).getByText('No node selected yet.')).toBeInTheDocument();
    expect(useCreateStore.getState().open).toEqual({ kind: 'qemu' });
    expect(screen.queryByTestId('create-ct-dialog')).not.toBeInTheDocument();
  });

  it('the node context menu opens the CT stub with that node preselected', async () => {
    renderShell();
    fireEvent.contextMenu(await findNodeRow('pve1'));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Create VM here/ })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Create container here/ }));

    const dialog = await screen.findByTestId('create-ct-dialog');
    expect(within(dialog).getByText('Create container')).toBeInTheDocument();
    expect(within(dialog).getByText('Node: pve1')).toBeInTheDocument();
    expect(useCreateStore.getState().open).toEqual({ kind: 'lxc', node: 'pve1' });
    expect(screen.queryByTestId('create-vm-dialog')).not.toBeInTheDocument();
  });

  it('Cancel closes the dialog and clears the store', async () => {
    renderShell();
    fireEvent.contextMenu(await findNodeRow('pve1'));
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Create VM here/ }));

    const dialog = await screen.findByTestId('create-vm-dialog');
    expect(within(dialog).getByText('Node: pve1')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByTestId('create-vm-dialog')).not.toBeInTheDocument());
    expect(useCreateStore.getState().open).toBeNull();
  });
});
