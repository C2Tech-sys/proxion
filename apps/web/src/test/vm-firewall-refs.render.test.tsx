import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import { FirewallTab } from '@/pages/vm/tabs/FirewallTab';
import { createQueryClient } from '@/api/queryClient';
import {
  addFixtureGuestAlias,
  getFixtureClusterFirewall,
  getFixtureGuestRefs,
  resetFixtureClusterFirewall,
  resetFixtureGuestRefs,
} from '@/api/fixtures';
import type { AuthIdentity } from '@/api/client-types';
import type { GuestPermissions } from '@/api/actionHooks';

/**
 * The guest Firewall tab's Aliases and IP Sets sub-tabs (T73): the datacenter panels pointed at one
 * guest. The wire tests run with `USE_FIXTURES` off and a stubbed `fetch`, so the exact URL, method
 * and JSON body of every read and write is asserted (reads through the `/api/pve/nodes/...` proxy,
 * writes through the `/api/actions/guest/...` routes); the fixture tests flip it on and run the real
 * fixture round trip. `useAuthMe` / `usePermissions` are mocked so each test controls the gate.
 */
const mockUseAuthMe = vi.fn();
const mockUsePermissions = vi.fn();

const state = vi.hoisted(() => ({ fixtures: false }));

// A getter, so each test chooses between the fetch path and the fixture path.
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

vi.mock('@/api/actionHooks', async () => {
  const actual = await vi.importActual<typeof import('@/api/actionHooks')>('@/api/actionHooks');
  return { ...actual, usePermissions: (vmid: number) => mockUsePermissions(vmid) };
});

function authData(mode: AuthIdentity['mode']) {
  return { data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode } };
}

function permissionsData(privs: Record<string, boolean> | true) {
  const value: GuestPermissions = { can: (p: string) => privs === true || privs[p] === true };
  return { data: value };
}

const TOKEN_REASON = 'Read-only: signed in with a service token';
const PRIVILEGE_REASON = "You don't have VM.Config.Network on this guest";
const D = 'guest-digest-1';
const PROXY = '/api/pve/nodes/pve1/qemu/100/firewall';
const ACTIONS = '/api/actions/guest/pve1/qemu/100/firewall';

/** What the stubbed PVE proxy returns for the wire tests (digest on every row, like a real read). */
const WIRE_ALIASES = [
  { name: 'web-net', cidr: '10.20.0.0/24', comment: 'Web tier', digest: D },
  { name: 'db-host', cidr: '10.20.0.5', digest: D },
];
const WIRE_IPSETS = [{ name: 'allowed', comment: 'Allowed clients', digest: D }];
const WIRE_ENTRIES = [
  { cidr: '10.20.0.0/24', comment: 'Web tier', digest: D },
  { cidr: '203.0.113.7', nomatch: 1, digest: D },
];

interface Call {
  method: string;
  url: string;
  body: unknown;
}
const calls: Call[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
  if (method !== 'GET') return json(method === 'POST' ? 201 : 200, { ok: true });
  if (url === `${PROXY}/aliases`) return json(200, { data: WIRE_ALIASES });
  if (url === `${PROXY}/ipset`) return json(200, { data: WIRE_IPSETS });
  if (url === `${PROXY}/ipset/allowed`) return json(200, { data: WIRE_ENTRIES });
  if (url === `${PROXY}/refs`) return json(200, { data: [] });
  return json(200, { data: [] });
});

const writeCalls = () => calls.filter((c) => c.method !== 'GET');
const readUrls = () => calls.filter((c) => c.method === 'GET').map((c) => c.url);

function renderTab(guest: { node: string; type: 'qemu' | 'lxc'; vmid: number } = { node: 'pve1', type: 'qemu', vmid: 100 }) {
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <FirewallTab node={guest.node} type={guest.type} vmid={guest.vmid} />
    </QueryClientProvider>,
  );
}

/** Radix's TabsTrigger switches tabs on `mousedown`, not `click`. */
async function openSubTab(name: string) {
  fireEvent.mouseDown(await screen.findByRole('tab', { name }), { button: 0 });
}

async function openDialog(buttonName: string) {
  fireEvent.click(await screen.findByRole('button', { name: buttonName }));
  return screen.findByRole('dialog');
}

describe('Guest Firewall tab: aliases and IP sets', () => {
  beforeEach(() => {
    state.fixtures = false;
    calls.length = 0;
    vi.stubGlobal('fetch', mockFetch);
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData({ 'VM.Config.Network': true }));
  });

  afterEach(() => {
    state.fixtures = false;
    resetFixtureGuestRefs();
    resetFixtureClusterFirewall();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe('sub-nav and reads', () => {
    it('shows Rules | Aliases | IP Sets, Rules first', async () => {
      renderTab();
      const tabs = await screen.findAllByRole('tab');
      expect(tabs.map((t) => t.textContent)).toStrictEqual(['Rules', 'Aliases', 'IP Sets']);
      expect(screen.getByRole('tab', { name: 'Rules' })).toHaveAttribute('data-state', 'active');
      expect(await screen.findByRole('button', { name: 'Add rule' })).toBeInTheDocument();
    });

    it('reads the guest aliases, IP sets and one set through the guest proxy paths, never the datacenter ones', async () => {
      renderTab();
      await openSubTab('Aliases');
      expect(await screen.findByTestId('guest-fw-alias-web-net')).toHaveTextContent('10.20.0.0/24');
      expect(screen.getByTestId('guest-fw-alias-db-host')).toHaveTextContent('10.20.0.5');
      await openSubTab('IP Sets');
      expect(await screen.findByTestId('guest-fw-ipset-allowed')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Show entries of allowed' }));
      expect(await screen.findByTestId('guest-fw-ipset-entry-203.0.113.7')).toHaveTextContent('nomatch');

      const urls = readUrls();
      expect(urls).toContain(`${PROXY}/aliases`);
      expect(urls).toContain(`${PROXY}/ipset`);
      expect(urls).toContain(`${PROXY}/ipset/allowed`);
      expect(urls.some((u) => u.includes('cluster/firewall'))).toBe(false);
    });
  });

  describe('alias writes (exact request on the guest route)', () => {
    it('adds an alias: POST .../aliases with the typed body', async () => {
      renderTab();
      await openSubTab('Aliases');
      const dialog = await openDialog('Add alias');
      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'app-net' } });
      fireEvent.change(within(dialog).getByLabelText('IP/CIDR'), { target: { value: '10.30.0.0/24' } });
      fireEvent.change(within(dialog).getByLabelText('Comment'), { target: { value: 'App tier' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(writeCalls()).toHaveLength(1));
      expect(writeCalls()[0]).toStrictEqual({
        method: 'POST',
        url: `${ACTIONS}/aliases`,
        body: { name: 'app-net', cidr: '10.30.0.0/24', comment: 'App tier' },
      });
      // The guest's own list is re-read afterwards.
      await waitFor(() => expect(readUrls().filter((u) => u === `${PROXY}/aliases`).length).toBeGreaterThanOrEqual(2));
    });

    it('renames an alias: PUT .../aliases/{old} with cidr, comment, rename and the digest of the read', async () => {
      renderTab();
      await openSubTab('Aliases');
      fireEvent.click(await screen.findByRole('button', { name: 'Edit alias web-net' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'web-tier' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(writeCalls()).toHaveLength(1));
      expect(writeCalls()[0]).toStrictEqual({
        method: 'PUT',
        url: `${ACTIONS}/aliases/web-net`,
        body: { cidr: '10.20.0.0/24', comment: 'Web tier', rename: 'web-tier', digest: D },
      });
    });

    it('deletes an alias after the confirmation: DELETE .../aliases/{name}?digest=', async () => {
      renderTab();
      await openSubTab('Aliases');
      fireEvent.click(await screen.findByRole('button', { name: 'Delete alias db-host' }));
      const dialog = await screen.findByRole('alertdialog');
      expect(writeCalls()).toHaveLength(0);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete alias' }));

      await waitFor(() => expect(writeCalls()).toHaveLength(1));
      expect(writeCalls()[0]).toStrictEqual({
        method: 'DELETE',
        url: `${ACTIONS}/aliases/db-host?digest=${D}`,
        body: undefined,
      });
    });
  });

  describe('IP set writes (exact request on the guest route)', () => {
    it('creates a set: POST .../ipsets', async () => {
      renderTab();
      await openSubTab('IP Sets');
      const dialog = await openDialog('Create IP set');
      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'blocked' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(writeCalls()).toHaveLength(1));
      expect(writeCalls()[0]).toStrictEqual({ method: 'POST', url: `${ACTIONS}/ipsets`, body: { name: 'blocked' } });
    });

    it('adds an entry with nomatch: POST .../ipsets/{name}', async () => {
      renderTab();
      await openSubTab('IP Sets');
      fireEvent.click(await screen.findByRole('button', { name: 'Show entries of allowed' }));
      const dialog = await openDialog('Add entry');
      fireEvent.change(within(dialog).getByLabelText('IP/CIDR'), { target: { value: '10.31.0.0/24' } });
      fireEvent.click(within(dialog).getByRole('checkbox'));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(writeCalls()).toHaveLength(1));
      expect(writeCalls()[0]).toStrictEqual({
        method: 'POST',
        url: `${ACTIONS}/ipsets/allowed`,
        body: { cidr: '10.31.0.0/24', nomatch: true },
      });
    });

    it('removes an entry: DELETE .../ipsets/{name}/{cidr} with the slash URL-encoded and the digest', async () => {
      renderTab();
      await openSubTab('IP Sets');
      fireEvent.click(await screen.findByRole('button', { name: 'Show entries of allowed' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Remove entry 10.20.0.0/24' }));
      const dialog = await screen.findByRole('alertdialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove entry' }));

      await waitFor(() => expect(writeCalls()).toHaveLength(1));
      expect(writeCalls()[0]).toStrictEqual({
        method: 'DELETE',
        url: `${ACTIONS}/ipsets/allowed/10.20.0.0%2F24?digest=${D}`,
        body: undefined,
      });
    });

    it('deletes a set with force: DELETE .../ipsets/{name}?force=1', async () => {
      renderTab();
      await openSubTab('IP Sets');
      fireEvent.click(await screen.findByRole('button', { name: 'Delete IP set allowed' }));
      const dialog = await screen.findByRole('alertdialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete IP set' }));

      await waitFor(() => expect(writeCalls()).toHaveLength(1));
      expect(writeCalls()[0]).toStrictEqual({
        method: 'DELETE',
        url: `${ACTIONS}/ipsets/allowed?force=1`,
        body: undefined,
      });
    });
  });

  describe('gating', () => {
    it('token mode: every control is disabled with the read-only reason and nothing is sent', async () => {
      mockUseAuthMe.mockReturnValue(authData('token'));
      renderTab();
      await openSubTab('Aliases');
      const add = await screen.findByRole('button', { name: 'Add alias' });
      expect(add).toBeDisabled();
      expect(add).toHaveAttribute('title', TOKEN_REASON);
      expect(await screen.findByRole('button', { name: 'Edit alias web-net' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Delete alias web-net' })).toBeDisabled();
      await openSubTab('IP Sets');
      expect(await screen.findByRole('button', { name: 'Create IP set' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Create IP set' })).toHaveAttribute('title', TOKEN_REASON);
      expect(writeCalls()).toHaveLength(0);
    });

    it('without VM.Config.Network the controls are disabled and say so', async () => {
      mockUsePermissions.mockReturnValue(permissionsData({ 'VM.Config.CPU': true }));
      renderTab();
      await openSubTab('Aliases');
      const add = await screen.findByRole('button', { name: 'Add alias' });
      expect(add).toBeDisabled();
      expect(add).toHaveAttribute('title', PRIVILEGE_REASON);
      await openSubTab('IP Sets');
      expect(await screen.findByRole('button', { name: 'Create IP set' })).toHaveAttribute('title', PRIVILEGE_REASON);
      expect(writeCalls()).toHaveLength(0);
    });
  });

  describe('fixture mode', () => {
    beforeEach(() => {
      state.fixtures = true;
    });

    it('lists the guest fixtures and not the datacenter ones, per guest', async () => {
      renderTab();
      await openSubTab('Aliases');
      expect(await screen.findByTestId('guest-fw-alias-web-net')).toBeInTheDocument();
      expect(screen.getByTestId('guest-fw-alias-db-host')).toBeInTheDocument();
      expect(screen.queryByTestId('dc-fw-alias-office')).not.toBeInTheDocument();
      expect(screen.queryByText('jumphost')).not.toBeInTheDocument();
      expect(screen.queryByText('office')).not.toBeInTheDocument();
      await openSubTab('IP Sets');
      expect(await screen.findByTestId('guest-fw-ipset-allowed')).toBeInTheDocument();
      expect(screen.queryByText('trusted')).not.toBeInTheDocument();
      expect(calls).toHaveLength(0);
    });

    it('shows the container its own alias only', async () => {
      renderTab({ node: 'pve2', type: 'lxc', vmid: 200 });
      await openSubTab('Aliases');
      expect(await screen.findByTestId('guest-fw-alias-ct-net')).toHaveTextContent('172.16.0.0/16');
      expect(screen.queryByText('web-net')).not.toBeInTheDocument();
      await openSubTab('IP Sets');
      expect(await screen.findByText('No IP sets.')).toBeInTheDocument();
    });

    it('round trip: add, rename and delete an alias, then create a set and add and remove an entry', async () => {
      const clusterBefore = structuredClone(getFixtureClusterFirewall().aliases);
      renderTab();
      await openSubTab('Aliases');

      let dialog = await openDialog('Add alias');
      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'app-net' } });
      fireEvent.change(within(dialog).getByLabelText('IP/CIDR'), { target: { value: '10.30.0.0/24' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(await screen.findByTestId('guest-fw-alias-app-net')).toHaveTextContent('10.30.0.0/24');
      expect(getFixtureGuestRefs(100).aliases.map((a) => a.name)).toStrictEqual(['app-net', 'db-host', 'web-net']);

      fireEvent.click(screen.getByRole('button', { name: 'Edit alias app-net' }));
      dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'application' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(await screen.findByTestId('guest-fw-alias-application')).toBeInTheDocument();
      expect(screen.queryByTestId('guest-fw-alias-app-net')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Delete alias application' }));
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete alias' }));
      await waitFor(() => expect(screen.queryByTestId('guest-fw-alias-application')).not.toBeInTheDocument());

      await openSubTab('IP Sets');
      fireEvent.click(await screen.findByRole('button', { name: 'Show entries of allowed' }));
      expect(await screen.findByTestId('guest-fw-ipset-entry-203.0.113.7')).toBeInTheDocument();
      dialog = await openDialog('Add entry');
      fireEvent.change(within(dialog).getByLabelText('IP/CIDR'), { target: { value: '10.31.0.0/24' } });
      fireEvent.click(within(dialog).getByRole('checkbox'));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(await screen.findByTestId('guest-fw-ipset-entry-10.31.0.0/24')).toHaveTextContent('nomatch');

      fireEvent.click(screen.getByRole('button', { name: 'Remove entry 203.0.113.7' }));
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove entry' }));
      await waitFor(() => expect(screen.queryByTestId('guest-fw-ipset-entry-203.0.113.7')).not.toBeInTheDocument());

      // The datacenter firewall and the other guest were never touched.
      expect(getFixtureClusterFirewall().aliases).toStrictEqual(clusterBefore);
      expect(getFixtureGuestRefs(200).aliases.map((a) => a.name)).toStrictEqual(['ct-net']);
    });

    it('a stale digest on a guest delete is refused and the alias stays', async () => {
      renderTab();
      await openSubTab('Aliases');
      fireEvent.click(await screen.findByRole('button', { name: 'Delete alias db-host' }));
      const dialog = await screen.findByRole('alertdialog');
      // Someone else changes the guest's firewall after this page read it.
      addFixtureGuestAlias(100, { name: 'other', cidr: '10.99.0.1' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete alias' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('The firewall configuration changed');
      expect(getFixtureGuestRefs(100).aliases.map((a) => a.name)).toContain('db-host');
    });

    it('the rule dialog offers the guest refs next to the inherited datacenter ones', async () => {
      renderTab();
      fireEvent.click(await screen.findByRole('button', { name: 'Add rule' }));
      await screen.findByRole('dialog');
      await waitFor(() => {
        const values = Array.from(document.querySelectorAll('datalist option')).map((o) => o.getAttribute('value'));
        expect(values).toStrictEqual(
          expect.arrayContaining(['guest/web-net', 'guest/db-host', '+guest/allowed', 'dc/office', '+dc/trusted']),
        );
      });
    });
  });
});
