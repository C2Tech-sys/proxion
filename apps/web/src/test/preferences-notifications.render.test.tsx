import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import { createQueryClient } from '@/api/queryClient';
import { PREFS_DEFAULTS } from '@/api/prefs';
import type { NotifyStatus, NotifyTestResults } from '@/api/notify';

/** Generous on purpose -- same rationale as `preferences-page.render.test.tsx`. */
const FIND_TIMEOUT_MS = 5000;

const { getPrefsMock, getNotifyStatusMock, sendTestNotificationMock } = vi.hoisted(() => ({
  getPrefsMock: vi.fn(),
  getNotifyStatusMock: vi.fn(),
  sendTestNotificationMock: vi.fn(),
}));

vi.mock('@/api/prefs', async () => {
  const actual = await vi.importActual<typeof import('@/api/prefs')>('@/api/prefs');
  return { ...actual, getPrefs: getPrefsMock };
});

vi.mock('@/api/notify', async () => {
  const actual = await vi.importActual<typeof import('@/api/notify')>('@/api/notify');
  return { ...actual, getNotifyStatus: getNotifyStatusMock, sendTestNotification: sendTestNotificationMock };
});

function prefs(readOnly: boolean) {
  return { ...PREFS_DEFAULTS, readOnly };
}

function notifyStatus(overrides: Partial<NotifyStatus> = {}): NotifyStatus {
  return {
    configured: { webhook: false, email: false },
    minSeverity: 'warning',
    includeResolved: true,
    ...overrides,
  };
}

function renderPreferences() {
  const queryClient = createQueryClient();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/preferences'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('Preferences page: Notifications section', () => {
  it('renders the configured channels and enables the test button', async () => {
    getPrefsMock.mockResolvedValue(prefs(false));
    getNotifyStatusMock.mockResolvedValue(notifyStatus({ configured: { webhook: true, email: true } }));

    renderPreferences();
    await screen.findByRole('heading', { name: 'Preferences' }, { timeout: FIND_TIMEOUT_MS });

    expect(screen.getByText('Notifications')).toBeInTheDocument();
    expect(await screen.findByText('Configured: Webhook, Email')).toBeInTheDocument();

    // Both `usePrefs()` (readOnly) and `useNotifyStatus()` (configured channels) resolve
    // asynchronously -- the button can render in its default (disabled) state on the very first
    // paint, so wait for the settled state rather than asserting on whatever paint `findByRole`
    // happened to catch.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send test notification' })).toBeEnabled(),
    );
  });

  it('shows a hint naming the env vars when nothing is configured, and disables the button', async () => {
    getPrefsMock.mockResolvedValue(prefs(false));
    getNotifyStatusMock.mockResolvedValue(notifyStatus());

    renderPreferences();
    await screen.findByRole('heading', { name: 'Preferences' }, { timeout: FIND_TIMEOUT_MS });

    expect(await screen.findByText(/PROXION_NOTIFY_WEBHOOK_URL/)).toBeInTheDocument();
    expect(screen.getByText(/PROXION_NOTIFY_SMTP_URL/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send test notification' })).toBeDisabled();
  });

  it('clicking the button calls the mocked send and shows a success toast', async () => {
    getPrefsMock.mockResolvedValue(prefs(false));
    getNotifyStatusMock.mockResolvedValue(notifyStatus({ configured: { webhook: true, email: false } }));
    const results: NotifyTestResults = { webhook: 'ok' };
    sendTestNotificationMock.mockResolvedValue(results);

    renderPreferences();
    await screen.findByRole('heading', { name: 'Preferences' }, { timeout: FIND_TIMEOUT_MS });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send test notification' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send test notification' }));

    await waitFor(() => expect(sendTestNotificationMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Test notification sent (webhook)', {}, { timeout: FIND_TIMEOUT_MS })).toBeInTheDocument();
  });

  it('shows a failure toast when a channel fails', async () => {
    getPrefsMock.mockResolvedValue(prefs(false));
    getNotifyStatusMock.mockResolvedValue(notifyStatus({ configured: { webhook: true, email: false } }));
    sendTestNotificationMock.mockResolvedValue({ webhook: 'connection refused' } satisfies NotifyTestResults);

    renderPreferences();
    await screen.findByRole('heading', { name: 'Preferences' }, { timeout: FIND_TIMEOUT_MS });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send test notification' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send test notification' }));

    expect(
      await screen.findByText('Test notification failed -- webhook: connection refused', {}, { timeout: FIND_TIMEOUT_MS }),
    ).toBeInTheDocument();
  });

  it('token mode: the test button is disabled with the standard read-only tooltip', async () => {
    getPrefsMock.mockResolvedValue(prefs(true));
    getNotifyStatusMock.mockResolvedValue(notifyStatus({ configured: { webhook: true, email: false } }));

    renderPreferences();
    await screen.findByRole('heading', { name: 'Preferences' }, { timeout: FIND_TIMEOUT_MS });

    await waitFor(() => {
      const button = screen.getByRole('button', { name: 'Send test notification' });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'Read-only: signed in with a service token');
    });
  });
});
