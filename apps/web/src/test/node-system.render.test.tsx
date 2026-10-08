import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import { SystemTab } from '@/pages/node/tabs/SystemTab';
import { NODE_TAB_ORDER, NODE_TAB_REGISTRY } from '@/pages/node/tabs';
import { Toaster } from '@/components/ui/sonner';
import { createQueryClient } from '@/api/queryClient';
import { GuestActionError } from '@/api/actions';
import {
  getFixtureNodeCertificates,
  getFixtureNodeConfig,
  getFixtureNodeDns,
  getFixtureNodeHosts,
  getFixtureNodeTime,
  resetFixtureNodeSystem,
} from '@/api/fixtures';
import {
  parseNodeCertificates,
  parseNodeDns,
  parseNodeHosts,
  parseNodeOptions,
  parseNodeTime,
} from '@/api/nodeSystem';
import type { AuthIdentity } from '@/api/client-types';
import type { GuestPermissions } from '@/api/actionHooks';

/**
 * The node System tab (T71): DNS / Time / Options / Hosts / Certificates sub-tabs, the exact
 * request each editor builds, the typed confirmations for uploading and removing a custom
 * certificate, and the gating on session mode + `Sys.Modify`. `useAuthMe` / `useNodePermissions`
 * are mocked so each test controls the gate; outside the fixture round trips the `@/api/nodeSystem`
 * request functions are mocked so the exact request can be asserted. The fixture tests flip
 * `USE_FIXTURES` on and run the real fixture client.
 */
const mockUseAuthMe = vi.fn();
const mockUseNodePermissions = vi.fn();
const mockGetDns = vi.fn();
const mockGetTime = vi.fn();
const mockGetOptions = vi.fn();
const mockGetHosts = vi.fn();
const mockGetCerts = vi.fn();
const mockUpdateDns = vi.fn();
const mockUpdateTime = vi.fn();
const mockUpdateOptions = vi.fn();
const mockSaveHosts = vi.fn();
const mockUpload = vi.fn();
const mockRemove = vi.fn();

const state = vi.hoisted(() => ({ fixtures: false }));

// A getter, so the fixture round-trip tests can flip it per test (`USE_FIXTURES` is true by default
// in this test env, which would short-circuit the session gate to "always enabled").
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
  return { ...actual, useNodePermissions: (node: string) => mockUseNodePermissions(node) };
});

vi.mock('@/api/nodeSystem', async () => {
  const actual = await vi.importActual<typeof import('@/api/nodeSystem')>('@/api/nodeSystem');
  return {
    ...actual,
    getNodeDns: (...args: Parameters<typeof actual.getNodeDns>) =>
      state.fixtures ? actual.getNodeDns(...args) : mockGetDns(...args),
    getNodeTime: (...args: Parameters<typeof actual.getNodeTime>) =>
      state.fixtures ? actual.getNodeTime(...args) : mockGetTime(...args),
    getNodeOptions: (...args: Parameters<typeof actual.getNodeOptions>) =>
      state.fixtures ? actual.getNodeOptions(...args) : mockGetOptions(...args),
    getNodeHosts: (...args: Parameters<typeof actual.getNodeHosts>) =>
      state.fixtures ? actual.getNodeHosts(...args) : mockGetHosts(...args),
    getNodeCertificates: (...args: Parameters<typeof actual.getNodeCertificates>) =>
      state.fixtures ? actual.getNodeCertificates(...args) : mockGetCerts(...args),
    updateNodeDns: (...args: Parameters<typeof actual.updateNodeDns>) =>
      state.fixtures ? actual.updateNodeDns(...args) : mockUpdateDns(...args),
    updateNodeTime: (...args: Parameters<typeof actual.updateNodeTime>) =>
      state.fixtures ? actual.updateNodeTime(...args) : mockUpdateTime(...args),
    updateNodeOptions: (...args: Parameters<typeof actual.updateNodeOptions>) =>
      state.fixtures ? actual.updateNodeOptions(...args) : mockUpdateOptions(...args),
    saveNodeHosts: (...args: Parameters<typeof actual.saveNodeHosts>) =>
      state.fixtures ? actual.saveNodeHosts(...args) : mockSaveHosts(...args),
    uploadNodeCertificate: (...args: Parameters<typeof actual.uploadNodeCertificate>) =>
      state.fixtures ? actual.uploadNodeCertificate(...args) : mockUpload(...args),
    removeNodeCertificate: (...args: Parameters<typeof actual.removeNodeCertificate>) =>
      state.fixtures ? actual.removeNodeCertificate(...args) : mockRemove(...args),
  };
});

function authData(mode: AuthIdentity['mode']) {
  return { data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode } };
}

function permissionsData(privs: Record<string, boolean> | true) {
  const value: GuestPermissions = { can: (p: string) => privs === true || privs[p] === true };
  return { data: value };
}

const CERT_CHAIN = '-----BEGIN CERTIFICATE-----\nMIIBFAKECERTIFICATE\n-----END CERTIFICATE-----\n';
const KEY_BODY = 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgTOPSECRETKEYMATERIAL0123456789';
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${KEY_BODY}\n-----END PRIVATE KEY-----\n`;

function renderTab() {
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <SystemTab node="pve1" />
      <Toaster />
    </QueryClientProvider>,
  );
}

/** Radix's TabsTrigger switches tabs on `mousedown`, not `click`. */
function openSubTab(name: string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 });
}

async function openDialogFrom(buttonName: string) {
  fireEvent.click(await screen.findByRole('button', { name: buttonName }));
  return screen.findByRole('dialog');
}

describe('Node System tab', () => {
  beforeEach(() => {
    state.fixtures = false;
    // jsdom doesn't implement what Radix's overlays rely on.
    if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
    if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
    if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUseNodePermissions.mockReturnValue(permissionsData(true));
    mockGetDns.mockImplementation(() => Promise.resolve(parseNodeDns(getFixtureNodeDns('pve1'))));
    mockGetTime.mockImplementation(() => Promise.resolve(parseNodeTime(getFixtureNodeTime('pve1'))));
    mockGetOptions.mockImplementation(() => Promise.resolve(parseNodeOptions(getFixtureNodeConfig('pve1'))));
    mockGetHosts.mockImplementation(() => Promise.resolve(parseNodeHosts(getFixtureNodeHosts('pve1'))));
    mockGetCerts.mockImplementation(() => Promise.resolve(parseNodeCertificates(getFixtureNodeCertificates('pve1'))));
    for (const mock of [mockUpdateDns, mockUpdateTime, mockUpdateOptions, mockSaveHosts, mockUpload, mockRemove]) {
      mock.mockResolvedValue(undefined);
    }
  });

  afterEach(() => {
    state.fixtures = false;
    resetFixtureNodeSystem();
    vi.clearAllMocks();
  });

  it('(a) is registered after Network and renders the five sub-tabs', async () => {
    expect(NODE_TAB_ORDER.indexOf('system')).toBe(NODE_TAB_ORDER.indexOf('network') + 1);
    expect(NODE_TAB_REGISTRY.system.label).toBe('System');

    renderTab();
    const names = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(names).toStrictEqual(['DNS', 'Time', 'Options', 'Hosts', 'Certificates']);

    // DNS is the default sub-tab.
    const dns = await screen.findByTestId('node-system-dns');
    expect(await within(dns).findByText('lab.local')).toBeInTheDocument();
    expect(within(dns).getByText('10.0.0.1')).toBeInTheDocument();
    expect(within(dns).getByText('1.1.1.1')).toBeInTheDocument();
    expect(within(dns).getByText('9.9.9.9')).toBeInTheDocument();
  });

  it('(b) editing DNS and clearing server 3 sends dns3: null with the other values', async () => {
    renderTab();
    const dialog = await openDialogFrom('Edit DNS');

    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled(); // nothing changed yet
    expect(within(dialog).getByLabelText('Search domain')).toHaveValue('lab.local');
    fireEvent.change(within(dialog).getByLabelText('DNS server 3'), { target: { value: '' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() =>
      expect(mockUpdateDns).toHaveBeenCalledWith('pve1', {
        search: 'lab.local',
        dns1: '10.0.0.1',
        dns2: '1.1.1.1',
        dns3: null,
      }),
    );
    expect(mockUpdateDns).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('DNS settings saved')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('(c) the DNS dialog refuses a bad address or domain and shows a server error inline', async () => {
    renderTab();
    const dialog = await openDialogFrom('Edit DNS');
    const save = within(dialog).getByRole('button', { name: 'Save' });

    fireEvent.change(within(dialog).getByLabelText('DNS server 1'), { target: { value: '10.0.0.999' } });
    expect(within(dialog).getByText('Enter a valid IPv4 or IPv6 address.')).toBeInTheDocument();
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('DNS server 1'), { target: { value: '2606:4700:4700::1111' } });
    expect(save).toBeEnabled();
    fireEvent.change(within(dialog).getByLabelText('Search domain'), { target: { value: 'not a domain' } });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Search domain'), { target: { value: 'lab.example' } });
    expect(save).toBeEnabled();

    mockUpdateDns.mockRejectedValueOnce(new GuestActionError(400, 'Parameter verification failed. dns1: invalid'));
    fireEvent.click(save);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Parameter verification failed. dns1: invalid');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('(d) Time shows the zone with absolute server and UTC times, and a zone change sends the exact body', async () => {
    renderTab();
    openSubTab('Time');
    const card = await screen.findByTestId('node-system-time');

    expect(await within(card).findByText('America/Chicago')).toBeInTheDocument();
    expect(within(card).getByText('2025-10-09 03:53:20')).toBeInTheDocument();
    expect(within(card).getByText('2025-10-09 08:53:20 UTC')).toBeInTheDocument();

    const dialog = await openDialogFrom('Edit time zone');
    const select = within(dialog).getByLabelText('Time zone');
    // The current zone is always offered and selected.
    expect(select).toHaveValue('America/Chicago');
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(select, { target: { value: 'Europe/Berlin' } });
    fireEvent.click(save);

    await waitFor(() => expect(mockUpdateTime).toHaveBeenCalledWith('pve1', { timezone: 'Europe/Berlin' }));
    expect(mockUpdateTime).toHaveBeenCalledTimes(1);
  });

  it('(e) Options shows the values; clearing the MAC sends wakeonlan: null with the digest (only what changed)', async () => {
    renderTab();
    openSubTab('Options');
    const card = await screen.findByTestId('node-system-options');
    expect(await within(card).findByText('Rack 2, top shelf')).toBeInTheDocument();
    expect(within(card).getByText('30')).toBeInTheDocument();
    expect(within(card).getByText('aa:bb:cc:dd:ee:ff')).toBeInTheDocument();

    const dialog = await openDialogFrom('Edit options');
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    expect(within(dialog).getByLabelText('Wake-on-LAN MAC')).toHaveValue('aa:bb:cc:dd:ee:ff');
    fireEvent.change(within(dialog).getByLabelText('Wake-on-LAN MAC'), { target: { value: '' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() =>
      expect(mockUpdateOptions).toHaveBeenCalledWith('pve1', { wakeonlan: null, digest: 'cfg-digest-1' }),
    );
    expect(mockUpdateOptions).toHaveBeenCalledTimes(1);
  });

  it('(f) Options sends the changed numbers and description, and refuses out-of-range or malformed input', async () => {
    renderTab();
    openSubTab('Options');
    const dialog = await openDialogFrom('Edit options');
    await screen.findByDisplayValue('Rack 2, top shelf');
    const save = within(dialog).getByRole('button', { name: 'Save' });

    fireEvent.change(within(dialog).getByLabelText('Start all on boot delay (s)'), { target: { value: '301' } });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Start all on boot delay (s)'), { target: { value: '45' } });
    fireEvent.change(within(dialog).getByLabelText('Wake-on-LAN MAC'), { target: { value: 'aa:bb:cc' } });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Wake-on-LAN MAC'), { target: { value: 'aa:bb:cc:dd:ee:ff' } });
    fireEvent.change(within(dialog).getByLabelText('Ballooning target (%)'), { target: { value: '101' } });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Ballooning target (%)'), { target: { value: '80' } });
    fireEvent.change(within(dialog).getByLabelText('Description'), { target: { value: '' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() =>
      expect(mockUpdateOptions).toHaveBeenCalledWith('pve1', {
        description: null,
        startallOnbootDelay: 45,
        ballooningTarget: 80,
        digest: 'cfg-digest-1',
      }),
    );
  });

  it('(g) Hosts edits /etc/hosts and saves the exact { data, digest }', async () => {
    renderTab();
    openSubTab('Hosts');
    const editor = await screen.findByLabelText('/etc/hosts on pve1');
    await waitFor(() => expect(editor).toHaveValue(getFixtureNodeHosts('pve1').data));
    expect(editor).toHaveClass('font-mono');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    const next = `${getFixtureNodeHosts('pve1').data}10.0.0.20 nas.lab.local nas\n`;
    fireEvent.change(editor, { target: { value: next } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(mockSaveHosts).toHaveBeenCalledWith('pve1', { data: next, digest: 'hosts-digest-1' }));
    expect(mockSaveHosts).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Hosts file saved')).toBeInTheDocument();
  });

  it('(h) Hosts shows a refused save inline and can discard the draft', async () => {
    renderTab();
    openSubTab('Hosts');
    const editor = await screen.findByLabelText('/etc/hosts on pve1');
    await waitFor(() => expect(editor).toHaveValue(getFixtureNodeHosts('pve1').data));

    fireEvent.change(editor, { target: { value: '10.0.0.1 gw\n' } });
    mockSaveHosts.mockRejectedValueOnce(new GuestActionError(400, 'detected modified configuration'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('detected modified configuration');

    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(editor).toHaveValue(getFixtureNodeHosts('pve1').data);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('(i) Certificates lists both files with dates, key info and the amber "expires in" warning', async () => {
    renderTab();
    openSubTab('Certificates');

    const self = await screen.findByTestId('node-cert-row-pve-ssl.pem');
    const custom = screen.getByTestId('node-cert-row-pveproxy-ssl.pem');
    expect(within(self).getByText('rsaEncryption (2048)')).toBeInTheDocument();
    expect(within(self).getByText('pve1.lab.local, 10.0.0.11')).toBeInTheDocument();
    expect(within(custom).getByText('id-ecPublicKey (256)')).toBeInTheDocument();
    expect(within(custom).getByText("/C=US/O=Let's Encrypt/CN=R11")).toBeInTheDocument();

    const warning = screen.getByTestId('node-cert-expiry-pveproxy-ssl.pem');
    expect(warning).toHaveTextContent('expires in 20 days');
    expect(warning).toHaveAttribute('data-level', 'warning');
    expect(screen.getByTestId('node-cert-expiry-pve-ssl.pem')).toHaveAttribute('data-level', 'ok');
  });

  it('(j) an expired certificate is flagged red, and Remove is hidden when there is no custom certificate', async () => {
    const rows = getFixtureNodeCertificates('pve1').filter((c) => c.filename === 'pve-ssl.pem');
    rows[0] = { ...rows[0]!, notafter: Math.floor(Date.now() / 1000) - 3 * 86_400 - 60 };
    mockGetCerts.mockImplementation(() => Promise.resolve(parseNodeCertificates(rows)));
    renderTab();
    openSubTab('Certificates');

    const expired = await screen.findByTestId('node-cert-expiry-pve-ssl.pem');
    expect(expired).toHaveTextContent('expired 3 days ago');
    expect(expired).toHaveAttribute('data-level', 'expired');
    expect(screen.queryByRole('button', { name: 'Remove custom certificate' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload custom certificate' })).toBeEnabled();
  });

  it('(k) uploading needs the typed word, states the lock-out risk and sends the exact body', async () => {
    renderTab();
    openSubTab('Certificates');
    const dialog = await openDialogFrom('Upload custom certificate');

    // The consequence sentence, naming the pinned-fingerprint variable.
    expect(
      within(dialog).getByText(
        "Proxmox restarts its web proxy with the new certificate; a wrong certificate or key makes the Proxmox web UI, and Proxion's connection to it, unreachable until fixed from the console. If Proxion pins this node's certificate fingerprint (PVE_TLS_FINGERPRINT), update that pin afterwards.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Restart pveproxy')).toBeChecked();
    expect(within(dialog).getByLabelText("Force (skip Proxmox's validation)")).not.toBeChecked();

    const upload = within(dialog).getByRole('button', { name: 'Upload certificate' });
    expect(upload).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Certificate chain (PEM)'), { target: { value: CERT_CHAIN } });
    fireEvent.change(within(dialog).getByLabelText('Private key (PEM)'), { target: { value: PRIVATE_KEY } });
    expect(upload).toBeDisabled(); // still needs the typed word
    const confirm = within(dialog).getByLabelText('Type UPLOAD to confirm');
    fireEvent.change(confirm, { target: { value: 'upload' } });
    expect(upload).toBeDisabled();
    fireEvent.change(confirm, { target: { value: 'UPLOAD' } });
    expect(upload).toBeEnabled();
    fireEvent.click(upload);

    await waitFor(() =>
      expect(mockUpload).toHaveBeenCalledWith('pve1', { certificates: CERT_CHAIN, key: PRIVATE_KEY, restart: true }),
    );
    expect(mockUpload).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Custom certificate installed; the Proxmox web proxy is restarting')).toBeInTheDocument();
  });

  it('(l) force and restart-off are sent when chosen; a malformed PEM keeps Upload disabled', async () => {
    renderTab();
    openSubTab('Certificates');
    const dialog = await openDialogFrom('Upload custom certificate');
    const upload = within(dialog).getByRole('button', { name: 'Upload certificate' });

    fireEvent.change(within(dialog).getByLabelText('Type UPLOAD to confirm'), { target: { value: 'UPLOAD' } });
    fireEvent.change(within(dialog).getByLabelText('Certificate chain (PEM)'), { target: { value: 'not a pem' } });
    expect(within(dialog).getByText(/no BEGIN CERTIFICATE line/)).toBeInTheDocument();
    expect(upload).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Certificate chain (PEM)'), { target: { value: CERT_CHAIN } });
    fireEvent.change(within(dialog).getByLabelText('Private key (PEM)'), { target: { value: 'nope' } });
    expect(within(dialog).getByText(/no BEGIN PRIVATE KEY line/)).toBeInTheDocument();
    expect(upload).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Private key (PEM)'), { target: { value: '' } });
    fireEvent.click(within(dialog).getByLabelText("Force (skip Proxmox's validation)"));
    fireEvent.click(within(dialog).getByLabelText('Restart pveproxy'));
    expect(upload).toBeEnabled();
    fireEvent.click(upload);

    await waitFor(() =>
      expect(mockUpload).toHaveBeenCalledWith('pve1', { certificates: CERT_CHAIN, force: true, restart: false }),
    );
  });

  it('(m) a failed upload shows the server message, stays open, and the private key field is empty', async () => {
    mockUpload.mockRejectedValueOnce(new GuestActionError(400, 'unable to parse private key'));
    renderTab();
    openSubTab('Certificates');
    const dialog = await openDialogFrom('Upload custom certificate');

    fireEvent.change(within(dialog).getByLabelText('Certificate chain (PEM)'), { target: { value: CERT_CHAIN } });
    fireEvent.change(within(dialog).getByLabelText('Private key (PEM)'), { target: { value: PRIVATE_KEY } });
    fireEvent.change(within(dialog).getByLabelText('Type UPLOAD to confirm'), { target: { value: 'UPLOAD' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Upload certificate' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('unable to parse private key');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // The key is never kept after a submit, even a failed one.
    expect(within(dialog).getByLabelText('Private key (PEM)')).toHaveValue('');
    expect(dialog.textContent).not.toContain(KEY_BODY);
  });

  it('(n) removing needs the typed word, states the consequence and makes the exact call', async () => {
    renderTab();
    openSubTab('Certificates');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove custom certificate' }));
    const dialog = await screen.findByRole('alertdialog');

    expect(
      within(dialog).getByText('Proxmox goes back to its self-signed certificate and restarts its web proxy.'),
    ).toBeInTheDocument();
    const remove = within(dialog).getByRole('button', { name: 'Remove custom certificate' });
    expect(remove).toBeDisabled();
    const input = within(dialog).getByLabelText('Type REMOVE to confirm');
    fireEvent.change(input, { target: { value: 'remove' } });
    expect(remove).toBeDisabled();
    fireEvent.change(input, { target: { value: 'REMOVE' } });
    expect(remove).toBeEnabled();
    fireEvent.click(remove);

    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith('pve1', { restart: true }));
    expect(mockRemove).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('(o) token mode: every write control on every sub-tab is disabled with the read-only tooltip', async () => {
    mockUseAuthMe.mockReturnValue(authData('token'));
    const readOnly = 'Read-only: signed in with a service token';
    renderTab();

    const edit = await screen.findByRole('button', { name: 'Edit DNS' });
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute('title', readOnly);

    openSubTab('Time');
    expect(await screen.findByRole('button', { name: 'Edit time zone' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit time zone' })).toHaveAttribute('title', readOnly);

    openSubTab('Options');
    expect(await screen.findByRole('button', { name: 'Edit options' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit options' })).toHaveAttribute('title', readOnly);

    openSubTab('Hosts');
    const editor = await screen.findByLabelText('/etc/hosts on pve1');
    expect(editor).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('title', readOnly);

    openSubTab('Certificates');
    for (const name of ['Upload custom certificate', 'Remove custom certificate']) {
      const button = await screen.findByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', readOnly);
    }
  });

  it('(p) a session without Sys.Modify gets the privilege tooltip on every write control', async () => {
    mockUseNodePermissions.mockReturnValue(permissionsData({ 'Sys.Audit': true }));
    const missing = "You don't have Sys.Modify on this node";
    renderTab();

    const edit = await screen.findByRole('button', { name: 'Edit DNS' });
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute('title', missing);

    openSubTab('Options');
    expect(await screen.findByRole('button', { name: 'Edit options' })).toHaveAttribute('title', missing);

    openSubTab('Certificates');
    const upload = await screen.findByRole('button', { name: 'Upload custom certificate' });
    expect(upload).toBeDisabled();
    expect(upload).toHaveAttribute('title', missing);
    expect(await screen.findByRole('button', { name: 'Remove custom certificate' })).toHaveAttribute('title', missing);
  });

  it('(q) fixture round trip: edit DNS and the options, then upload and remove a certificate; the key is never stored', async () => {
    state.fixtures = true;
    renderTab();

    // DNS: drop server 3.
    let dialog = await openDialogFrom('Edit DNS');
    fireEvent.change(within(dialog).getByLabelText('DNS server 3'), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(getFixtureNodeDns('pve1')).toStrictEqual({ search: 'lab.local', dns1: '10.0.0.1', dns2: '1.1.1.1' });
    await waitFor(() => expect(screen.queryByText('9.9.9.9')).not.toBeInTheDocument());

    // Options: the digest moves on after a save.
    openSubTab('Options');
    dialog = await openDialogFrom('Edit options');
    await screen.findByDisplayValue('Rack 2, top shelf');
    fireEvent.change(within(dialog).getByLabelText('Wake-on-LAN MAC'), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(getFixtureNodeConfig('pve1')).toStrictEqual({
      description: 'Rack 2, top shelf',
      'startall-onboot-delay': 30,
      digest: 'cfg-digest-2',
    });

    // Certificates: upload replaces the custom certificate; the key is gone from every record.
    openSubTab('Certificates');
    dialog = await openDialogFrom('Upload custom certificate');
    fireEvent.change(within(dialog).getByLabelText('Certificate chain (PEM)'), { target: { value: CERT_CHAIN } });
    fireEvent.change(within(dialog).getByLabelText('Private key (PEM)'), { target: { value: PRIVATE_KEY } });
    fireEvent.change(within(dialog).getByLabelText('Type UPLOAD to confirm'), { target: { value: 'UPLOAD' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Upload certificate' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('/CN=Lab Internal CA')).toBeInTheDocument();
    expect(await screen.findByText('expires in 365 days')).toBeInTheDocument();
    const everything = JSON.stringify([
      getFixtureNodeDns('pve1'),
      getFixtureNodeTime('pve1'),
      getFixtureNodeConfig('pve1'),
      getFixtureNodeHosts('pve1'),
      getFixtureNodeCertificates('pve1'),
    ]);
    expect(everything).not.toContain(KEY_BODY);
    expect(everything).not.toContain('PRIVATE KEY');
    expect(getFixtureNodeCertificates('pve1').find((c) => c.filename === 'pveproxy-ssl.pem')?.pem).toBe(CERT_CHAIN);

    // Remove it again: back to the self-signed certificate only.
    fireEvent.click(await screen.findByRole('button', { name: 'Remove custom certificate' }));
    const alert = await screen.findByRole('alertdialog');
    fireEvent.change(within(alert).getByLabelText('Type REMOVE to confirm'), { target: { value: 'REMOVE' } });
    fireEvent.click(within(alert).getByRole('button', { name: 'Remove custom certificate' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(getFixtureNodeCertificates('pve1').map((c) => c.filename)).toStrictEqual(['pve-ssl.pem']);
    await waitFor(() => expect(screen.queryByTestId('node-cert-row-pveproxy-ssl.pem')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Remove custom certificate' })).not.toBeInTheDocument();
  });

  it('(r) fixture round trip: saving the hosts file re-reads the new digest', async () => {
    state.fixtures = true;
    renderTab();
    openSubTab('Hosts');
    const editor = await screen.findByLabelText('/etc/hosts on pve1');
    await waitFor(() => expect(editor).toHaveValue(getFixtureNodeHosts('pve1').data));

    fireEvent.change(editor, { target: { value: '10.0.0.5 only-entry\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(getFixtureNodeHosts('pve1')).toStrictEqual({ data: '10.0.0.5 only-entry\n', digest: 'hosts-digest-2' }));
    await waitFor(() => expect(editor).toHaveValue('10.0.0.5 only-entry\n'));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
