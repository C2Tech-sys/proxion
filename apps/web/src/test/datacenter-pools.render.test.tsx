import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import { PoolsTab } from '@/pages/datacenter/tabs/PoolsTab';
import { createQueryClient } from '@/api/queryClient';
import { GuestActionError } from '@/api/actions';
import { getFixturePools, resetFixturePools } from '@/api/fixtures';
import type { AuthIdentity } from '@/api/client-types';
import type { GuestPermissions } from '@/api/actionHooks';

/**
 * Datacenter -> Pools (T70): the pool table, Add pool, Edit comment, the Members sheet (add
 * guests / storages, remove with checkboxes), Delete (typed confirm, disabled while members exist)
 * and the gating on session mode + `Pool.Allocate`. `useAuthMe` and `usePathPermissions` are mocked
 * so each test controls the gate; `@/api/pools`' write functions are mocked so the exact request
 * each dialog builds can be asserted. The last tests flip `USE_FIXTURES` on and run the real
 * fixture flow instead.
 */
const mockUseAuthMe = vi.fn();
const mockUsePathPermissions = vi.fn();
const mockCreatePool = vi.fn();
const mockUpdatePool = vi.fn();
const mockDeletePool = vi.fn();

const state = vi.hoisted(() => ({ fixtures: false }));

// A getter, so the fixture-flow tests can flip `USE_FIXTURES` per test (it is true in this env).
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    get USE_FIXTURES() {
      return state.fixtures;
    },
  };
});

vi.mock('@/api/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/api/hooks')>('@/api/hooks');
  return { ...actual, useAuthMe: () => mockUseAuthMe() };
});

vi.mock('@/api/datacenterPermissionHooks', () => ({
  usePathPermissions: (path: string) => mockUsePathPermissions(path),
}));

vi.mock('@/api/pools', async () => {
  const actual = await vi.importActual<typeof import('@/api/pools')>('@/api/pools');
  const fixtures = await vi.importActual<typeof import('@/api/fixtures')>('@/api/fixtures');
  return {
    ...actual,
    // Not in fixture mode the real function would `fetch`; serve the same data from memory.
    getPools: () =>
      state.fixtures
        ? actual.getPools()
        : Promise.resolve(fixtures.getFixturePools().map((p) => ({ poolid: p.poolid, comment: p.comment, members: p.members }))),
    createPool: (...args: Parameters<typeof actual.createPool>) =>
      state.fixtures ? actual.createPool(...args) : mockCreatePool(...args),
    updatePool: (...args: Parameters<typeof actual.updatePool>) =>
      state.fixtures ? actual.updatePool(...args) : mockUpdatePool(...args),
    deletePool: (...args: Parameters<typeof actual.deletePool>) =>
      state.fixtures ? actual.deletePool(...args) : mockDeletePool(...args),
  };
});

function authData(mode: AuthIdentity['mode']) {
  return { data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode } };
}

function permissionsData(privs: Record<string, boolean> | true) {
  const value: GuestPermissions = { can: (p: string) => privs === true || privs[p] === true };
  return { data: value };
}

function renderTab() {
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <PoolsTab />
    </QueryClientProvider>,
  );
}

async function openRowDialog(buttonName: string, role: 'dialog' | 'alertdialog' = 'dialog') {
  fireEvent.click(await screen.findByRole('button', { name: buttonName }));
  return screen.findByRole(role);
}

function change(dialog: HTMLElement, label: string, value: string) {
  fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
}

describe('Datacenter Pools tab', () => {
  beforeEach(() => {
    state.fixtures = false;
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePathPermissions.mockImplementation(() => permissionsData(true));
    mockCreatePool.mockImplementation((poolid: string) => Promise.resolve({ ok: true, poolid }));
    mockUpdatePool.mockImplementation((poolid: string) => Promise.resolve({ ok: true, poolid }));
    mockDeletePool.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    state.fixtures = false;
    resetFixturePools();
    vi.clearAllMocks();
  });

  it('(a) lists the pools with their comment and member count', async () => {
    renderTab();

    const prod = await screen.findByTestId('pool-row-prod');
    const cells = within(prod).getAllByRole('cell');
    expect(cells[0]).toHaveTextContent('prod');
    expect(cells[1]).toHaveTextContent('Production guests');
    expect(cells[2]).toHaveTextContent('4');
    expect(within(screen.getByTestId('pool-row-dev')).getAllByRole('cell')[2]).toHaveTextContent('3');
    expect(within(screen.getByTestId('pool-row-archive')).getAllByRole('cell')[2]).toHaveTextContent('0');
  });

  it('(b) token mode: Add, Edit and Delete are disabled with the read-only tooltip', async () => {
    mockUseAuthMe.mockReturnValue(authData('token'));

    renderTab();
    await screen.findByTestId('pool-row-prod');

    for (const name of ['Add pool', 'Edit prod', 'Delete archive']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'Read-only: signed in with a service token');
    }
    // Looking at the members stays possible.
    expect(screen.getByRole('button', { name: 'Members of prod' })).toBeEnabled();
  });

  it('(c) a session without Pool.Allocate gets the privilege tooltip, per path', async () => {
    mockUsePathPermissions.mockImplementation((path: string) =>
      permissionsData(path === '/pool/dev' ? { 'Pool.Allocate': true } : { 'Pool.Audit': true }),
    );

    renderTab();
    await screen.findByTestId('pool-row-prod');

    expect(screen.getByRole('button', { name: 'Add pool' })).toHaveAttribute('title', "You don't have Pool.Allocate on /pool");
    expect(screen.getByRole('button', { name: 'Edit prod' })).toHaveAttribute('title', "You don't have Pool.Allocate on this pool");
    expect(screen.getByRole('button', { name: 'Edit dev' })).toBeEnabled();
  });

  it('(d) Add pool sends the id and comment; a bad id keeps Create disabled', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Add pool' }));
    const dialog = await screen.findByRole('dialog');
    const create = within(dialog).getByRole('button', { name: 'Create' });
    expect(create).toBeDisabled();

    change(dialog, 'Name', 'bad name');
    expect(within(dialog).getByText(/Use 1-64 letters/)).toBeInTheDocument();
    expect(create).toBeDisabled();
    change(dialog, 'Name', 'qa');
    change(dialog, 'Comment', 'QA environment');
    expect(create).toBeEnabled();
    fireEvent.click(create);

    await waitFor(() => expect(mockCreatePool).toHaveBeenCalledTimes(1));
    expect(mockCreatePool.mock.calls[0]).toStrictEqual(['qa', 'QA environment']);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('(e) Edit comment sends only the comment; clearing it sends an empty string', async () => {
    renderTab();
    const dialog = await openRowDialog('Edit prod');
    expect(within(dialog).getByLabelText('Comment')).toHaveValue('Production guests');
    change(dialog, 'Comment', 'Customer-facing');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockUpdatePool).toHaveBeenCalledTimes(1));
    expect(mockUpdatePool.mock.calls[0]).toStrictEqual(['prod', { comment: 'Customer-facing' }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const again = await openRowDialog('Edit prod');
    change(again, 'Comment', '');
    fireEvent.click(within(again).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockUpdatePool).toHaveBeenCalledTimes(2));
    expect(mockUpdatePool.mock.calls[1]).toStrictEqual(['prod', { comment: '' }]);
  });

  it('(f) Members sheet: adds guests, and a guest from another pool is added with allow-move', async () => {
    renderTab();
    const sheet = await openRowDialog('Members of dev');
    expect(within(sheet).getByRole('heading', { name: 'Pool members: dev' })).toBeInTheDocument();
    expect(await within(sheet).findByText('VM 104 lab-ubuntu (pve1)')).toBeInTheDocument();

    fireEvent.click(await within(sheet).findByRole('checkbox', { name: 'Add VM 106 win-dc01' }));
    expect(within(sheet).getAllByText(/in pool prod/).length).toBeGreaterThan(0); // guests of prod are marked
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add selected guests (1)' }));
    await waitFor(() => expect(mockUpdatePool).toHaveBeenCalledTimes(1));
    expect(mockUpdatePool.mock.calls[0]).toStrictEqual(['dev', { vms: [106] }]);

    fireEvent.click(within(sheet).getByRole('checkbox', { name: 'Add VM 100 web-prod-01' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add selected guests (1)' }));
    await waitFor(() => expect(mockUpdatePool).toHaveBeenCalledTimes(2));
    expect(mockUpdatePool.mock.calls[1]).toStrictEqual(['dev', { vms: [100], 'allow-move': true }]);
  });

  it('(g) Members sheet: adds storages', async () => {
    renderTab();
    const sheet = await openRowDialog('Members of dev');
    fireEvent.click(await within(sheet).findByRole('checkbox', { name: 'Add storage tank' }));
    fireEvent.click(within(sheet).getByRole('checkbox', { name: 'Add storage local-zfs' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add selected storages (2)' }));

    await waitFor(() => expect(mockUpdatePool).toHaveBeenCalledTimes(1));
    expect(mockUpdatePool.mock.calls[0]).toStrictEqual(['dev', { storage: ['tank', 'local-zfs'] }]);
  });

  it('(h) Members sheet: removes the ticked members with remove: true', async () => {
    renderTab();
    const sheet = await openRowDialog('Members of prod');
    const removeButton = within(sheet).getByRole('button', { name: 'Remove selected (0)' });
    expect(removeButton).toBeDisabled();

    fireEvent.click(await within(sheet).findByRole('checkbox', { name: 'Select VM 100 web-prod-01 (pve1)' }));
    fireEvent.click(within(sheet).getByRole('checkbox', { name: 'Select Storage tank-backups (pve1)' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove selected (2)' }));

    await waitFor(() => expect(mockUpdatePool).toHaveBeenCalledTimes(1));
    expect(mockUpdatePool.mock.calls[0]).toStrictEqual(['prod', { vms: [100], storage: ['tank-backups'], remove: true }]);
  });

  it('(i) Members sheet controls are disabled with the reason when the caller cannot change the pool', async () => {
    mockUseAuthMe.mockReturnValue(authData('token'));
    renderTab();
    const sheet = await openRowDialog('Members of prod');

    const select = await within(sheet).findByRole('checkbox', { name: 'Select VM 100 web-prod-01 (pve1)' });
    expect(select).toBeDisabled();
    const addGuests = within(sheet).getByRole('button', { name: 'Add selected guests (0)' });
    expect(addGuests).toBeDisabled();
    expect(addGuests).toHaveAttribute('title', 'Read-only: signed in with a service token');
  });

  it('(j) Delete is disabled while the pool has members; an empty pool needs the typed name', async () => {
    renderTab();
    await screen.findByTestId('pool-row-prod');
    const blocked = screen.getByRole('button', { name: 'Delete prod' });
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveAttribute('title', 'Remove all members first');

    const dialog = await openRowDialog('Delete archive', 'alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete archive' });
    expect(confirm).toBeDisabled();
    change(dialog, 'Type the pool name to confirm', 'arch');
    expect(confirm).toBeDisabled();
    change(dialog, 'Type the pool name to confirm', 'archive');
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(mockDeletePool).toHaveBeenCalledTimes(1));
    expect(mockDeletePool.mock.calls[0]).toStrictEqual(['archive']);
  });

  it('(k) a server error stays inline and the dialog stays open', async () => {
    mockCreatePool.mockRejectedValue(new GuestActionError(400, "pool 'qa' already exists"));
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Add pool' }));
    const dialog = await screen.findByRole('dialog');
    change(dialog, 'Name', 'qa');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent("pool 'qa' already exists");
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('(l) fixture round trip: create a pool, add and move guests, remove members, delete it', async () => {
    state.fixtures = true;
    renderTab();

    fireEvent.click(await screen.findByRole('button', { name: 'Add pool' }));
    const add = await screen.findByRole('dialog');
    change(add, 'Name', 'qa');
    change(add, 'Comment', 'QA environment');
    fireEvent.click(within(add).getByRole('button', { name: 'Create' }));
    const row = await screen.findByTestId('pool-row-qa');
    expect(within(row).getAllByRole('cell')[1]).toHaveTextContent('QA environment');
    expect(within(row).getAllByRole('cell')[2]).toHaveTextContent('0');

    // VM 100 sits in `prod`: choosing it moves it into `qa` (the sheet sends allow-move).
    fireEvent.click(screen.getByRole('button', { name: 'Members of qa' }));
    const sheet = await screen.findByRole('dialog');
    fireEvent.click(await within(sheet).findByRole('checkbox', { name: 'Add VM 100 web-prod-01' }));
    fireEvent.click(within(sheet).getByRole('checkbox', { name: 'Add VM 106 win-dc01' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add selected guests (2)' }));
    await waitFor(() => expect(within(screen.getByTestId('pool-row-qa')).getAllByRole('cell', { hidden: true })[2]).toHaveTextContent('2'));
    expect(getFixturePools().find((p) => p.poolid === 'prod')!.members.some((m) => m.vmid === 100)).toBe(false);
    expect(getFixturePools().find((p) => p.poolid === 'qa')!.members.map((m) => m.id)).toStrictEqual(['qemu/100', 'qemu/106']);

    fireEvent.click(await within(sheet).findByRole('checkbox', { name: 'Select VM 100 web-prod-01 (pve1)' }));
    fireEvent.click(within(sheet).getByRole('checkbox', { name: 'Select VM 106 win-dc01 (pve1)' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove selected (2)' }));
    await waitFor(() => expect(within(screen.getByTestId('pool-row-qa')).getAllByRole('cell', { hidden: true })[2]).toHaveTextContent('0'));
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const del = await openRowDialog('Delete qa', 'alertdialog');
    change(del, 'Type the pool name to confirm', 'qa');
    fireEvent.click(within(del).getByRole('button', { name: 'Delete qa' }));
    await waitFor(() => expect(screen.queryByTestId('pool-row-qa')).not.toBeInTheDocument());
    expect(screen.getByTestId('pool-row-prod')).toBeInTheDocument();
  });
});
