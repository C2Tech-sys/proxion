import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import { NotificationSettingsForm } from '@/components/notifications/NotificationSettingsForm';
import { createQueryClient } from '@/api/queryClient';
import { PREFS_DEFAULTS } from '@/api/prefs';
import { getFixtureNotifySettings, resetFixtureNotifySettings } from '@/api/fixtures';
import type { NotifySettingsPutBody, NotifySettingsView } from '@/api/notify';

/**
 * The Preferences "Notifications" settings form (T64): masked values, the gating on session mode +
 * `Sys.Modify` on `/`, the exact PUT bodies the form builds (secrets as `{ keep: true }` unless the
 * user touched them), the snooze buttons, and the server's 400 message inline. `useAuthMe` and
 * `useRootPermissions` are mocked so each test controls the gate, and the settings requests are
 * mocked so the exact request can be asserted; the fixture round trip flips `USE_FIXTURES` on and
 * runs the real fixture client instead. One full-page test checks the existing "Send test" button
 * next to the form.
 */
const FIND_TIMEOUT_MS = 5000;

const state = vi.hoisted(() => ({ fixtures: false, passthrough: false }));
const mockUseAuthMe = vi.fn();
const mockUseRootPermissions = vi.fn();
const mockGetSettings = vi.fn();
const mockPutSettings = vi.fn();
const mockMute = vi.fn();
const mockGetStatus = vi.fn();
const mockSendTest = vi.fn();
const mockGetPrefs = vi.fn();

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

vi.mock('@/api/rootPermissionHooks', () => ({ useRootPermissions: () => mockUseRootPermissions() }));

vi.mock('@/api/prefs', async () => {
  const actual = await vi.importActual<typeof import('@/api/prefs')>('@/api/prefs');
  return { ...actual, getPrefs: (...args: unknown[]) => mockGetPrefs(...args) };
});

vi.mock('@/api/notify', async () => {
  const actual = await vi.importActual<typeof import('@/api/notify')>('@/api/notify');
  return {
    ...actual,
    getNotifyStatus: (...args: unknown[]) => mockGetStatus(...args),
    sendTestNotification: (...args: unknown[]) => mockSendTest(...args),
    getNotifySettings: (...args: unknown[]) =>
      state.passthrough ? actual.getNotifySettings() : (mockGetSettings(...args) as Promise<NotifySettingsView>),
    putNotifySettings: (...args: unknown[]) =>
      state.passthrough
        ? actual.putNotifySettings(args[0] as NotifySettingsPutBody)
        : (mockPutSettings(...args) as Promise<NotifySettingsView>),
    muteNotifications: (...args: unknown[]) =>
      state.passthrough ? actual.muteNotifications(args[0] as never) : (mockMute(...args) as Promise<NotifySettingsView>),
  };
});

const SESSION_AUTH = {
  data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode: 'session' },
  isLoading: false,
  isFetching: false,
};
const TOKEN_AUTH = { ...SESSION_AUTH, data: { ...SESSION_AUTH.data, mode: 'token' } };

function permissions(privs: Record<string, boolean>) {
  return { data: { can: (p: string) => privs[p] === true } };
}

function view(overrides: Partial<NotifySettingsView> = {}): NotifySettingsView {
  return {
    source: 'env',
    enabled: true,
    mutedKinds: [],
    minSeverity: 'warning',
    includeResolved: true,
    debounceMs: 10_000,
    siteName: 'Proxion',
    publicUrl: 'https://proxion.example.com',
    webhook: { url: { host: 'ntfy.example.com', masked: true }, format: 'ntfy', token: { set: true } },
    channels: { webhook: true, email: false },
    ...overrides,
  };
}

const EMAIL: NonNullable<NotifySettingsView['email']> = {
  smtpUrl: { host: 'smtp.example.com', port: 465, secure: true, user: 'mailuser', set: true },
  from: 'proxion@example.com',
  to: ['a@example.com', 'b@example.com'],
};

function renderForm() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <NotificationSettingsForm />
    </QueryClientProvider>,
  );
}

async function renderEditableForm(settings: NotifySettingsView = view()) {
  mockGetSettings.mockResolvedValue(settings);
  renderForm();
  await screen.findByTestId('notify-status-line', {}, { timeout: FIND_TIMEOUT_MS });
}

function save(): HTMLElement {
  return screen.getByRole('button', { name: 'Save' });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.fixtures = false;
  state.passthrough = false;
  resetFixtureNotifySettings();
  mockUseAuthMe.mockReturnValue(SESSION_AUTH);
  mockUseRootPermissions.mockReturnValue(permissions({ 'Sys.Modify': true }));
  mockGetStatus.mockResolvedValue({
    configured: { webhook: true, email: false },
    minSeverity: 'warning',
    includeResolved: true,
  });
  mockGetPrefs.mockResolvedValue({ ...PREFS_DEFAULTS, readOnly: false });
});

describe('Preferences: notification settings form', () => {
  it('token mode: everything is read-only with the service-token tooltip', async () => {
    mockUseAuthMe.mockReturnValue(TOKEN_AUTH);
    await renderEditableForm(view({ email: EMAIL }));

    const tip = 'Read-only: signed in with a service token';
    for (const control of [
      screen.getByRole('switch', { name: 'Notifications enabled' }),
      screen.getByRole('checkbox', { name: 'Backups' }),
      screen.getByLabelText('Site name'),
      screen.getByLabelText('Address'),
      screen.getByLabelText('SMTP URL'),
      screen.getByRole('button', { name: '8 h' }),
      screen.getByRole('button', { name: 'Unmute' }),
      screen.getByRole('button', { name: 'Remove webhook' }),
      screen.getByRole('button', { name: 'Remove email' }),
      save(),
    ]) {
      expect(control).toBeDisabled();
    }
    expect(save()).toHaveAttribute('title', tip);
    expect(screen.getByRole('button', { name: '8 h' })).toHaveAttribute('title', tip);
  });

  it('a session without Sys.Modify on / is read-only with the privilege tooltip', async () => {
    mockUseRootPermissions.mockReturnValue(permissions({ 'Sys.Audit': true }));
    await renderEditableForm();

    expect(screen.getByLabelText('Site name')).toBeDisabled();
    expect(save()).toBeDisabled();
    expect(save()).toHaveAttribute('title', "You don't have Sys.Modify on /");
    expect(screen.getByRole('button', { name: '1 h' })).toHaveAttribute('title', "You don't have Sys.Modify on /");
  });

  it('renders the masked values: host only, "unchanged" placeholders, no secrets anywhere', async () => {
    await renderEditableForm(view({ email: EMAIL, channels: { webhook: true, email: true } }));

    expect(screen.getByTestId('notify-status-line')).toHaveTextContent('Notifications: On · Source: env');
    expect(screen.getByText(/Current: ntfy\.example\.com/)).toBeInTheDocument();
    expect(screen.getByLabelText('Address')).toHaveAttribute('placeholder', 'unchanged');
    expect(screen.getByLabelText('Address')).toHaveValue('');
    expect(screen.getByLabelText('Token')).toHaveAttribute('placeholder', 'unchanged');
    expect(screen.getByLabelText('Token')).toHaveValue('');
    expect(screen.getByText('Current: mailuser@smtp.example.com:465 (TLS)')).toBeInTheDocument();
    expect(screen.getByLabelText('SMTP URL')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('SMTP URL')).toHaveAttribute('placeholder', 'unchanged');
    expect(screen.getByLabelText('From')).toHaveValue('proxion@example.com');
    expect(screen.getByLabelText('To')).toHaveValue('a@example.com, b@example.com');
    expect(screen.getByLabelText('Batching delay (seconds)')).toHaveValue(10);
    expect(screen.getByLabelText('Site name')).toHaveValue('Proxion');
    expect(screen.getByRole('checkbox', { name: 'Backups' })).toBeChecked();
    expect(screen.getByText('Tests always send, even while muted.')).toBeInTheDocument();
  });

  it('Save is disabled until something changes, and Discard puts the form back', async () => {
    await renderEditableForm();
    expect(save()).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Site name'), { target: { value: 'Rack 4' } });
    expect(save()).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByLabelText('Site name')).toHaveValue('Proxion');
    expect(save()).toBeDisabled();
  });

  it('unchecking Backups and saving sends mutedKinds: ["backup"] with the secrets as keep sentinels', async () => {
    await renderEditableForm();
    mockPutSettings.mockResolvedValue(view({ source: 'file', mutedKinds: ['backup'] }));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Backups' }));
    fireEvent.click(save());

    await waitFor(() => expect(mockPutSettings).toHaveBeenCalledTimes(1));
    expect(mockPutSettings.mock.calls[0]![0]).toStrictEqual({
      enabled: true,
      mutedKinds: ['backup'],
      minSeverity: 'warning',
      includeResolved: true,
      debounceMs: 10_000,
      siteName: 'Proxion',
      publicUrl: 'https://proxion.example.com',
      webhook: { url: { keep: true }, format: 'ntfy', token: { keep: true } },
    });
  });

  it('the master switch off is saved as enabled: false', async () => {
    await renderEditableForm();
    mockPutSettings.mockResolvedValue(view({ source: 'file', enabled: false }));

    fireEvent.click(screen.getByRole('switch', { name: 'Notifications enabled' }));
    fireEvent.click(save());

    await waitFor(() => expect(mockPutSettings).toHaveBeenCalledTimes(1));
    expect((mockPutSettings.mock.calls[0]![0] as NotifySettingsPutBody).enabled).toBe(false);
  });

  it('Clear on the token sends token: null and leaves the address as keep', async () => {
    await renderEditableForm();
    mockPutSettings.mockResolvedValue(view({ source: 'file' }));

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByLabelText('Token')).toHaveAttribute('placeholder', 'none');
    fireEvent.click(save());

    await waitFor(() => expect(mockPutSettings).toHaveBeenCalledTimes(1));
    expect((mockPutSettings.mock.calls[0]![0] as NotifySettingsPutBody).webhook).toStrictEqual({
      url: { keep: true },
      format: 'ntfy',
      token: null,
    });
  });

  it('typing a new address and token replaces them', async () => {
    await renderEditableForm();
    mockPutSettings.mockResolvedValue(view({ source: 'file' }));

    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'https://hooks.example.org/abc' } });
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'fresh-token' } });
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'gotify' } });
    fireEvent.click(save());

    await waitFor(() => expect(mockPutSettings).toHaveBeenCalledTimes(1));
    expect((mockPutSettings.mock.calls[0]![0] as NotifySettingsPutBody).webhook).toStrictEqual({
      url: 'https://hooks.example.org/abc',
      format: 'gotify',
      token: 'fresh-token',
    });
  });

  it('an SMTP URL left untouched is sent as { keep: true }; To is split on commas', async () => {
    await renderEditableForm(view({ email: EMAIL, channels: { webhook: true, email: true } }));
    mockPutSettings.mockResolvedValue(view({ source: 'file', email: EMAIL }));

    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'a@example.com,  c@example.com ,' } });
    fireEvent.click(save());

    await waitFor(() => expect(mockPutSettings).toHaveBeenCalledTimes(1));
    expect((mockPutSettings.mock.calls[0]![0] as NotifySettingsPutBody).email).toStrictEqual({
      smtpUrl: { keep: true },
      from: 'proxion@example.com',
      to: ['a@example.com', 'c@example.com'],
    });
  });

  it('Remove webhook saves without a webhook key', async () => {
    await renderEditableForm();
    const { webhook: _removed, ...withoutWebhook } = view();
    void _removed;
    mockPutSettings.mockResolvedValue({ ...withoutWebhook, source: 'file', channels: { webhook: false, email: false } });

    fireEvent.click(screen.getByRole('button', { name: 'Remove webhook' }));
    expect(screen.getByText('The webhook is removed when you save.')).toBeInTheDocument();
    fireEvent.click(save());

    await waitFor(() => expect(mockPutSettings).toHaveBeenCalledTimes(1));
    expect(mockPutSettings.mock.calls[0]![0]).not.toHaveProperty('webhook');
  });

  it('Snooze 8 h calls the mute request for 8h; Unmute clears it', async () => {
    const until = new Date(Date.now() + 8 * 3_600_000).toISOString();
    await renderEditableForm();
    mockMute.mockResolvedValue(view({ source: 'file', muteUntil: until }));

    fireEvent.click(screen.getByRole('button', { name: '8 h' }));
    await waitFor(() => expect(mockMute).toHaveBeenCalledWith('8h'));

    await waitFor(() => expect(screen.getByTestId('notify-status-line')).toHaveTextContent(/Muted until .+ \(8h \d+m left\) · Source: file/));
    mockMute.mockResolvedValue(view({ source: 'file' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unmute' }));
    await waitFor(() => expect(mockMute).toHaveBeenLastCalledWith(null));
    await waitFor(() => expect(screen.getByTestId('notify-status-line')).not.toHaveTextContent('Muted until'));
  });

  it("shows the server's 400 message inline and keeps the edit", async () => {
    await renderEditableForm();
    mockPutSettings.mockRejectedValue(new Error('webhook.url: must be an absolute http(s) URL'));

    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'nope' } });
    fireEvent.click(save());

    const alert = await screen.findByRole('alert', {}, { timeout: FIND_TIMEOUT_MS });
    expect(alert).toHaveTextContent('webhook.url: must be an absolute http(s) URL');
    expect(screen.getByLabelText('Address')).toHaveValue('nope');
    expect(save()).toBeEnabled();
  });

  it('the requests carry the documented bodies (PUT body as given, mute as { for })', async () => {
    const actual = await vi.importActual<typeof import('@/api/notify')>('@/api/notify');
    const responses: NotifySettingsView[] = [view({ source: 'file' }), view({ source: 'file' })];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const body: NotifySettingsPutBody = {
        enabled: true,
        mutedKinds: ['task'],
        minSeverity: 'error',
        includeResolved: false,
        debounceMs: 5000,
        siteName: 'Lab',
      };
      await actual.putNotifySettings(body);
      await actual.muteNotifications('8h');
    } finally {
      vi.unstubAllGlobals();
    }
    const [putUrl, putInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(putUrl).toBe('/api/notify/settings');
    expect(putInit.method).toBe('PUT');
    expect(JSON.parse(putInit.body as string)).toStrictEqual({
      enabled: true,
      mutedKinds: ['task'],
      minSeverity: 'error',
      includeResolved: false,
      debounceMs: 5000,
      siteName: 'Lab',
    });
    const [muteUrl, muteInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(muteUrl).toBe('/api/notify/mute');
    expect(muteInit.method).toBe('POST');
    expect(JSON.parse(muteInit.body as string)).toStrictEqual({ for: '8h' });
  });

  it('fixture round trip: save, then the re-read settings show the new state', async () => {
    state.fixtures = true;
    state.passthrough = true;
    renderForm();
    await screen.findByTestId('notify-status-line', {}, { timeout: FIND_TIMEOUT_MS });
    expect(screen.getByTestId('notify-status-line')).toHaveTextContent('Source: env');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Storage usage' }));
    fireEvent.change(screen.getByLabelText('Site name'), { target: { value: 'Demo rack' } });
    fireEvent.click(save());

    await waitFor(() => expect(screen.getByTestId('notify-status-line')).toHaveTextContent('Source: file'));
    expect(screen.getByRole('checkbox', { name: 'Storage usage' })).not.toBeChecked();
    expect(screen.getByLabelText('Site name')).toHaveValue('Demo rack');
    expect(save()).toBeDisabled();
    expect(getFixtureNotifySettings()).toMatchObject({
      source: 'file',
      siteName: 'Demo rack',
      mutedKinds: ['storage'],
      webhook: { url: { host: 'ntfy.example.com' }, token: { set: true } },
    });

    // and the snooze, through the same fixture client
    fireEvent.click(screen.getByRole('button', { name: '24 h' }));
    await waitFor(() => expect(screen.getByTestId('notify-status-line')).toHaveTextContent('Muted until'));
    expect(getFixtureNotifySettings().muteUntil).toBeDefined();
  });
});

describe('Preferences page: the existing Send test button next to the form', () => {
  it('stays enabled while notifications are muted', async () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    mockGetSettings.mockResolvedValue(view({ source: 'file', muteUntil: until }));

    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/preferences'] }),
    });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await screen.findByRole('heading', { name: 'Preferences' }, { timeout: FIND_TIMEOUT_MS });
    await waitFor(() => expect(screen.getByTestId('notify-status-line')).toHaveTextContent('Muted until'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send test notification' })).toBeEnabled());
    expect(screen.getByText('Tests always send, even while muted.')).toBeInTheDocument();
  });
});
