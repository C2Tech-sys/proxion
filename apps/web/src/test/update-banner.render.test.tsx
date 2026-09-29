import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// `USE_FIXTURES` is a build-time constant re-exported from `@/api/client`; mocked per-test the
// same way `demo-banner.render.test.tsx` does, so the "never in fixture mode" rule is exercised
// without actually flipping `VITE_USE_FIXTURES` and rebuilding.
let useFixtures = false;

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    get USE_FIXTURES() {
      return useFixtures;
    },
  };
});

// `useServerVersion` is mocked directly (same convention as `shell-auth-refetch.render.test.tsx`
// mocking `useAuthMe`) so each version scenario is driven independently of the real query
// lifecycle and its polling interval.
const mockUseServerVersion = vi.fn();

vi.mock('@/api/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/api/hooks')>('@/api/hooks');
  return { ...actual, useServerVersion: () => mockUseServerVersion() };
});

import { UpdateAvailableBanner } from '@/components/UpdateAvailableBanner';
import { APP_VERSION } from '@/version';

function health(version: string) {
  return { data: { ok: true, name: 'proxion', version } };
}

describe('UpdateAvailableBanner', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    useFixtures = false;
  });

  afterEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });

  it('renders nothing when the server version matches the running bundle', () => {
    mockUseServerVersion.mockReturnValue(health(APP_VERSION));
    const { container } = render(<UpdateAvailableBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('shows both versions and reloads the page when Reload is clicked', () => {
    mockUseServerVersion.mockReturnValue(health('9.9.9'));
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, reload },
      writable: true,
      configurable: true,
    });

    render(<UpdateAvailableBanner />);

    const status = screen.getByRole('status');
    expect(status.textContent).toContain('v9.9.9');
    expect(status.textContent).toContain(`v${APP_VERSION}`);

    fireEvent.click(screen.getByRole('button', { name: /reload/i }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('dismisses on click, hiding the banner for that server version', () => {
    mockUseServerVersion.mockReturnValue(health('9.9.9'));
    render(<UpdateAvailableBanner />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss update banner' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('never renders in fixture mode even when versions differ', () => {
    useFixtures = true;
    mockUseServerVersion.mockReturnValue(health('9.9.9'));
    const { container } = render(<UpdateAvailableBanner />);
    expect(container.firstChild).toBeNull();
  });
});
