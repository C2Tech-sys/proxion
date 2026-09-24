import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// `USE_FIXTURES` is a build-time constant re-exported from `@/api/client`; mocked per-test so
// both the fixture-mode-only visibility rule and the "never in real mode" rule are exercised
// without actually flipping `VITE_USE_FIXTURES` and rebuilding.
let useFixtures = true;

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    get USE_FIXTURES() {
      return useFixtures;
    },
  };
});

import { DemoBanner } from '@/components/DemoBanner';

const DISMISSED_KEY = 'proxion.demoBanner.dismissed';

describe('DemoBanner', () => {
  beforeEach(() => {
    useFixtures = true;
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the demo copy and Install link in fixture mode', () => {
    render(<DemoBanner />);
    expect(screen.getByText(/sample data, nothing here is real/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Install Proxion/ });
    expect(link).toHaveAttribute('href', 'https://github.com/C2Tech-sys/proxion#quickstart');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('renders nothing when not in fixture mode', () => {
    useFixtures = false;
    const { container } = render(<DemoBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('dismisses on click and stays dismissed across remounts (localStorage)', () => {
    const { unmount } = render(<DemoBanner />);
    expect(screen.getByText(/sample data, nothing here is real/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss demo banner' }));
    expect(screen.queryByText(/sample data, nothing here is real/)).toBeNull();
    unmount();

    render(<DemoBanner />);
    expect(screen.queryByText(/sample data, nothing here is real/)).toBeNull();
    expect(localStorage.getItem(DISMISSED_KEY)).toBe('1');
  });

  it('never renders when not in fixture mode, even if previously dismissed in fixture mode', () => {
    localStorage.setItem(DISMISSED_KEY, '1');
    useFixtures = false;
    const { container } = render(<DemoBanner />);
    expect(container.firstChild).toBeNull();
  });
});
