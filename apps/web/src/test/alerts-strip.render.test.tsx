import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Alert } from '@proxion/core';

// Isolated unit test of `AlertsStrip`'s own rendering logic -- `useAlerts()` is mocked directly
// (its own live/fallback wiring is covered by hooks.live.test.tsx / hooks.test.ts), so this file
// only exercises the three visual states + the "Recently healed" disclosure.
const mockUseAlerts = vi.fn();

vi.mock('@/api/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/api/hooks')>('@/api/hooks');
  return { ...actual, useAlerts: () => mockUseAlerts() };
});

import { AlertsStrip } from '@/components/AlertsStrip';

function alert(overrides: Partial<Alert> & { id: string; severity: Alert['severity'] }): Alert {
  return {
    kind: 'backup',
    title: 'alert title',
    at: 1000,
    ...overrides,
  } as Alert;
}

describe('AlertsStrip', () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    mockUseAlerts.mockReset();
  });

  it('renders nothing when there are no alerts', () => {
    mockUseAlerts.mockReturnValue({ data: [] });
    const { container } = render(<AlertsStrip />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing while alerts are still loading (data undefined)', () => {
    mockUseAlerts.mockReturnValue({ data: undefined });
    const { container } = render(<AlertsStrip />);
    expect(container.firstChild).toBeNull();
  });

  it('renders an error-severity backup/task alert', () => {
    mockUseAlerts.mockReturnValue({
      data: [alert({ id: 'a1', severity: 'error', title: 'Backup of queue-worker-01 (304) failed 3 times tonight' })],
    });
    render(<AlertsStrip />);
    expect(screen.getByText('Backup of queue-worker-01 (304) failed 3 times tonight')).toBeInTheDocument();
  });

  it('renders a warning-severity alert with its detail suffix', () => {
    mockUseAlerts.mockReturnValue({
      data: [
        alert({
          id: 'a2',
          severity: 'warning',
          title: 'Backup of search-prod-01 (305) failed at 14:03 — waiting for a retry',
          detail: 'retry pending · window until 20:03',
        }),
      ],
    });
    render(<AlertsStrip />);
    expect(screen.getByText(/failed at 14:03/)).toBeInTheDocument();
    expect(screen.getByText('retry pending · window until 20:03')).toBeInTheDocument();
  });

  it('groups healed alerts under a collapsed-by-default "Recently healed" disclosure', () => {
    mockUseAlerts.mockReturnValue({
      data: [
        alert({ id: 'h1', severity: 'healed', title: 'Backup of app-prod-01 (300) failed at 14:18 · healed by retry at 14:23' }),
      ],
    });
    render(<AlertsStrip />);
    expect(screen.getByText('Recently healed (1)')).toBeInTheDocument();
    expect(screen.queryByText(/healed by retry at 14:23/)).toBeNull();

    fireEvent.click(screen.getByText('Recently healed (1)'));
    expect(screen.getByText(/healed by retry at 14:23/)).toBeInTheDocument();
  });

  it('remembers the disclosure open state across remounts (localStorage)', () => {
    mockUseAlerts.mockReturnValue({
      data: [alert({ id: 'h1', severity: 'healed', title: 'healed one' })],
    });
    const { unmount } = render(<AlertsStrip />);
    fireEvent.click(screen.getByText('Recently healed (1)'));
    expect(screen.getByText('healed one')).toBeInTheDocument();
    unmount();

    render(<AlertsStrip />);
    // Re-rendered fresh: still open, because the preference was persisted.
    expect(screen.getByText('healed one')).toBeInTheDocument();
  });

  it('shows all three states together, errors and warnings above the healed disclosure', () => {
    mockUseAlerts.mockReturnValue({
      data: [
        alert({ id: 'e1', severity: 'error', title: 'error title' }),
        alert({ id: 'w1', severity: 'warning', title: 'warning title' }),
        alert({ id: 'h1', severity: 'healed', title: 'healed title' }),
      ],
    });
    render(<AlertsStrip />);
    expect(screen.getByText('error title')).toBeInTheDocument();
    expect(screen.getByText('warning title')).toBeInTheDocument();
    expect(screen.getByText('Recently healed (1)')).toBeInTheDocument();
    expect(screen.queryByText('healed title')).toBeNull();
  });
});
