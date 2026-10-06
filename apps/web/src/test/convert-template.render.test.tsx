import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';

import { ObjectHeader } from '@/components/ObjectHeader';
import { InventoryTree } from '@/components/InventoryTree';
import { GuestContextMenu } from '@/components/actions/GuestContextMenu';
import { ConvertToTemplateDialog } from '@/components/actions/ConvertToTemplateDialog';
import { GuestActionError } from '@/api/actions';
import { createQueryClient } from '@/api/queryClient';
import type { AuthIdentity } from '@/api/client-types';
import type { GuestPermissions } from '@/api/actionHooks';
import type { GuestType } from '@/api/types';

/**
 * "Convert to template…" (T63) in the object header's "More" menu / the guest context menu (same
 * setup as `delete-guest.render.test.tsx`): a signed-in session and `VM.Allocate` gate the item, a
 * running/paused or already-template guest disables it with a reason, and the dialog (typed-VMID
 * confirm) is exercised against a mocked `convertToTemplate` so a confirm's exact call is asserted
 * directly. The last test flips `flags.fixtures` to run the real fixture flow through the inventory
 * tree instead.
 */
const flags = vi.hoisted(() => ({ fixtures: false }));
const mockUseAuthMe = vi.fn();
const mockUsePermissions = vi.fn();
const mockUseClusterResources = vi.fn();
const mockConvertToTemplate = vi.fn();

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    get USE_FIXTURES() {
      return flags.fixtures;
    },
  };
});

vi.mock('@/api/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/api/hooks')>('@/api/hooks');
  return {
    ...actual,
    useAuthMe: () => (flags.fixtures ? actual.useAuthMe() : mockUseAuthMe()),
    useClusterResources: () => (flags.fixtures ? actual.useClusterResources() : mockUseClusterResources()),
  };
});

vi.mock('@/api/actionHooks', async () => {
  const actual = await vi.importActual<typeof import('@/api/actionHooks')>('@/api/actionHooks');
  return {
    ...actual,
    usePermissions: (vmid: number) => (flags.fixtures ? actual.usePermissions(vmid) : mockUsePermissions(vmid)),
  };
});

vi.mock('@/api/actions', async () => {
  const actual = await vi.importActual<typeof import('@/api/actions')>('@/api/actions');
  return {
    ...actual,
    convertToTemplate: (...args: Parameters<typeof actual.convertToTemplate>) =>
      flags.fixtures ? actual.convertToTemplate(...args) : mockConvertToTemplate(...args),
  };
});

function authData(mode: AuthIdentity['mode']) {
  return { data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode } };
}

function permissionsData(can: boolean) {
  const value: GuestPermissions = { can: () => can };
  return { data: value };
}

const UPID = 'UPID:pve1:00000001:00000000:00000000:qmtemplate:100:root@pam:';

interface GuestOptions {
  status?: string;
  template?: boolean;
  type?: GuestType;
  vmid?: number;
}

function renderHeader({ status = 'stopped', template = false, type = 'qemu', vmid = 100 }: GuestOptions = {}) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <ObjectHeader
        breadcrumb={[{ label: 'Datacenter', to: 'home' }, { label: 'web-prod-01' }]}
        name="web-prod-01"
        vmid={vmid}
        status={status}
        template={template}
        node="pve1"
        type={type}
      />
    ),
  });
  const routeTree = rootRoute.addChildren([indexRoute]);
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/'] }) });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function renderContextMenu({ status = 'stopped', template = false, type = 'qemu', vmid = 100 }: GuestOptions = {}) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <GuestContextMenu guest={{ node: 'pve1', type, vmid, name: 'web-prod-01', status, template }}>
        <button type="button">web-prod-01</button>
      </GuestContextMenu>
    ),
  });
  const routeTree = rootRoute.addChildren([indexRoute]);
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/'] }) });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function openMoreMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.pointerUp(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(trigger);
}

async function headerConvertItem() {
  openMoreMenu(await screen.findByRole('button', { name: 'More actions' }));
  return screen.findByRole('menuitem', { name: /Convert to template/ });
}

async function contextConvertItem() {
  fireEvent.contextMenu(await screen.findByText('web-prod-01'));
  const menu = await screen.findByRole('menu');
  return within(menu).getByRole('menuitem', { name: /Convert to template/ });
}

describe('Convert to template…', () => {
  beforeEach(() => {
    flags.fixtures = false;
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
    mockUseClusterResources.mockReturnValue({ data: [] });
    mockConvertToTemplate.mockResolvedValue({ upid: UPID });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('(a) token mode: the context menu item is disabled with the read-only tooltip and the header "More" trigger is disabled', async () => {
    mockUseAuthMe.mockReturnValue(authData('token'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    renderContextMenu();
    const item = await contextConvertItem();
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveAttribute('title', 'Read-only: signed in with a service token');
  });

  it('(a2) token mode: the object header "More" trigger is disabled, so the item is unreachable', async () => {
    mockUseAuthMe.mockReturnValue(authData('token'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    renderHeader();
    expect(await screen.findByRole('button', { name: 'More actions' })).toBeDisabled();
  });

  it('(b) missing VM.Allocate: disabled with the permission tooltip in both menus', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(false));

    renderHeader();
    const headerItem = await headerConvertItem();
    expect(headerItem).toHaveAttribute('aria-disabled', 'true');
    expect(headerItem).toHaveAttribute('title', "You don't have VM.Allocate on this guest");
  });

  it('(b2) missing VM.Allocate: the context menu item carries the same tooltip', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(false));

    renderContextMenu();
    const item = await contextConvertItem();
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveAttribute('title', "You don't have VM.Allocate on this guest");
  });

  it('(c) a running or paused guest: disabled with the stop-first reason', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    renderHeader({ status: 'running' });
    const headerItem = await headerConvertItem();
    expect(headerItem).toHaveAttribute('aria-disabled', 'true');
    expect(headerItem).toHaveAttribute('title', 'Stop the guest first to convert it to a template');
  });

  it('(c2) a paused guest in the context menu: disabled with the stop-first reason', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    renderContextMenu({ status: 'paused' });
    const item = await contextConvertItem();
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveAttribute('title', 'Stop the guest first to convert it to a template');
  });

  it('(d) an already-template guest: disabled with its own reason in both menus', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    renderHeader({ template: true });
    const headerItem = await headerConvertItem();
    expect(headerItem).toHaveAttribute('aria-disabled', 'true');
    expect(headerItem).toHaveAttribute('title', 'This guest is already a template');
  });

  it('(d2) an already-template guest in the context menu: same reason', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    renderContextMenu({ template: true });
    const item = await contextConvertItem();
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveAttribute('title', 'This guest is already a template');
  });

  it('(e) stopped guest: the item sits just above Delete, the dialog says it is permanent, and the confirm needs the exact VMID', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    renderHeader();
    const item = await headerConvertItem();
    expect(item).not.toHaveAttribute('aria-disabled', 'true');
    const items = screen.getAllByRole('menuitem');
    expect(items.at(-2)).toBe(item);
    expect(items.at(-1)).toHaveTextContent('Delete');

    fireEvent.click(item);
    const dialog = await screen.findByRole('alertdialog');
    within(dialog).getByText('Convert web-prod-01 (100) to a template?');
    within(dialog).getByText(/This is permanent/);
    expect(within(dialog).queryByText('Stop the guest first')).toBeNull();

    const confirm = within(dialog).getByRole('button', { name: 'Convert 100' });
    const input = within(dialog).getByLabelText('Type the VMID to confirm');
    expect(confirm).toBeDisabled();
    fireEvent.change(input, { target: { value: '10' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(input, { target: { value: '1000' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(input, { target: { value: '100' } });
    expect(confirm).toBeEnabled();
    expect(mockConvertToTemplate).not.toHaveBeenCalled();

    fireEvent.click(confirm);

    await waitFor(() => expect(mockConvertToTemplate).toHaveBeenCalledTimes(1));
    expect(mockConvertToTemplate.mock.calls).toStrictEqual([['pve1', 'qemu', 100]]);
  });

  it('(f) lxc through the context menu: calls convertToTemplate with the lxc type and closes the dialog when the request returns no task', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));
    mockConvertToTemplate.mockResolvedValue({ ok: true });

    renderContextMenu({ type: 'lxc', vmid: 200 });
    fireEvent.click(await contextConvertItem());
    const dialog = await screen.findByRole('alertdialog');
    within(dialog).getByText(/cannot be converted back to a container/);
    fireEvent.change(within(dialog).getByLabelText('Type the VMID to confirm'), { target: { value: '200' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Convert 200' }));

    await waitFor(() => expect(mockConvertToTemplate).toHaveBeenCalledTimes(1));
    expect(mockConvertToTemplate.mock.calls).toStrictEqual([['pve1', 'lxc', 200]]);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('(g) a rejected request keeps the dialog open', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));
    mockConvertToTemplate.mockRejectedValue(new GuestActionError(400, 'VM is locked (backup)'));

    renderHeader();
    fireEvent.click(await headerConvertItem());
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByLabelText('Type the VMID to confirm'), { target: { value: '100' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Convert 100' }));

    await waitFor(() => expect(mockConvertToTemplate).toHaveBeenCalledTimes(1));
    // Give the failed mutation a beat to (not) close the dialog.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('(h) the dialog itself guards a running guest: warning shown, confirm stays disabled with the VMID typed', async () => {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <ConvertToTemplateDialog
          open
          onOpenChange={() => {}}
          node="pve1"
          type="qemu"
          vmid={100}
          name="web-prod-01"
          status="running"
        />
      </QueryClientProvider>,
    );
    const dialog = await screen.findByRole('alertdialog');
    within(dialog).getByText('Stop the guest first');
    fireEvent.change(within(dialog).getByLabelText('Type the VMID to confirm'), { target: { value: '100' } });
    const confirm = within(dialog).getByRole('button', { name: 'Convert 100' });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(mockConvertToTemplate).not.toHaveBeenCalled();
  });

  it('(i) fixture mode: converting a stopped guest through the inventory tree shows the template badge afterwards', async () => {
    flags.fixtures = true;

    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: InventoryTree });
    const vmRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/vm/$node/$type/$vmid',
      validateSearch: (): { tab: string } => ({ tab: 'summary' }),
      component: () => <div>VM PAGE</div>,
    });
    const nodeRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/node/$node',
      validateSearch: (): { tab: string } => ({ tab: 'summary' }),
      component: () => <div>NODE PAGE</div>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, vmRoute, nodeRoute]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    // db-prod-02 (vmid 103) is a stopped, non-template guest in the fixture data.
    const label = await screen.findByText('db-prod-02');
    const row = label.closest('a')!;
    expect(within(row).getByLabelText('Status: stopped')).toBeInTheDocument();
    expect(within(row).queryByLabelText('Status: template')).toBeNull();

    fireEvent.contextMenu(label);
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Convert to template/ }));

    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByLabelText('Type the VMID to confirm'), { target: { value: '103' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Convert 103' }));

    await waitFor(
      () => expect(within(screen.getByText('db-prod-02').closest('a')!).getByLabelText('Status: template')).toBeInTheDocument(),
      { timeout: 10_000 },
    );

    // The converted guest can't be converted again.
    fireEvent.contextMenu(screen.getByText('db-prod-02'));
    const menuAgain = await screen.findByRole('menu');
    const itemAgain = within(menuAgain).getByRole('menuitem', { name: /Convert to template/ });
    expect(itemAgain).toHaveAttribute('aria-disabled', 'true');
    expect(itemAgain).toHaveAttribute('title', 'This guest is already a template');
  });
});
