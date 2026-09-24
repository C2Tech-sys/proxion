import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ConsoleThumbnail } from './ConsoleThumbnail';

const urlMock = vi.fn(
  (node: string, type: string, vmid: number) => `/api/console/thumbnail/${node}/${type}/${vmid}.png`,
);

vi.mock('@/api/client', () => ({
  api: { thumbnails: { url: (...args: unknown[]) => urlMock(...(args as [string, string, number])) } },
}));

const navigateMock = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigateMock }));

/** Minimal fake standing in for the browser's IntersectionObserver, which jsdom lacks. Every
 *  test that needs "visible" calls `lastObserver().trigger(true)`. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  callback: (entries: Pick<IntersectionObserverEntry, 'isIntersecting'>[]) => void;
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(callback: (entries: Pick<IntersectionObserverEntry, 'isIntersecting'>[]) => void) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }
  trigger(isIntersecting: boolean) {
    this.callback([{ isIntersecting }]);
  }
}

function lastObserver(): FakeIntersectionObserver {
  const instance = FakeIntersectionObserver.instances.at(-1);
  if (!instance) throw new Error('no IntersectionObserver was constructed');
  return instance;
}

function pngResponse(status: number, headers: Record<string, string> = {}) {
  return new Response(new Blob(['fake-png']), { status, headers });
}

describe('ConsoleThumbnail', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let openMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    FakeIntersectionObserver.instances.length = 0;
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    URL.revokeObjectURL = vi.fn();
    openMock = vi.fn();
    vi.stubGlobal('open', openMock);
    urlMock.mockClear();
    navigateMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('never fetches a stopped guest and shows the Powered off placeholder', () => {
    render(
      <ConsoleThumbnail node="pve1" type="qemu" vmid={103} name="db-prod-02" status="stopped" />,
    );

    expect(screen.getByText('Powered off')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a template as powered off even if its status string were "running"', () => {
    render(
      <ConsoleThumbnail node="pve1" type="qemu" vmid={110} name="tpl-ubuntu" status="running" template />,
    );

    expect(screen.getByText('Powered off')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not fetch until visible, then loads the image and shows freshness + source', async () => {
    const capturedAt = new Date(Date.now() - 34_000).toISOString();
    fetchMock.mockResolvedValue(pngResponse(200, { 'X-Proxion-Captured-At': capturedAt, 'X-Proxion-Source': 'live' }));

    render(<ConsoleThumbnail node="pve1" type="qemu" vmid={100} name="web-prod-01" status="running" />);

    expect(fetchMock).not.toHaveBeenCalled();

    act(() => lastObserver().trigger(true));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(urlMock).toHaveBeenCalledWith('pve1', 'qemu', 100, { w: 400, refresh: false });

    const img = await screen.findByRole('img', { name: 'Console preview for web-prod-01' });
    expect(img).toHaveAttribute('src', 'blob:mock-url');
    expect(screen.getByText(/captured \d+s ago/)).toBeInTheDocument();
  });

  it('shows "No console access" on 403 with no retry action', async () => {
    fetchMock.mockResolvedValue(pngResponse(403));

    render(<ConsoleThumbnail node="pve1" type="qemu" vmid={100} name="web-prod-01" status="running" />);
    act(() => lastObserver().trigger(true));

    await screen.findByText('No console access');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('treats 404 as "not running" and shows the Powered off placeholder', async () => {
    fetchMock.mockResolvedValue(pngResponse(404));

    render(<ConsoleThumbnail node="pve1" type="qemu" vmid={100} name="web-prod-01" status="running" />);
    act(() => lastObserver().trigger(true));

    await screen.findByText('Powered off');
  });

  it('shows "Preview unavailable" with a Retry button on a 503, and Retry re-fetches', async () => {
    fetchMock.mockResolvedValueOnce(pngResponse(503));

    render(<ConsoleThumbnail node="pve1" type="qemu" vmid={100} name="web-prod-01" status="running" />);
    act(() => lastObserver().trigger(true));

    const retryButton = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByText('Preview unavailable')).toBeInTheDocument();

    fetchMock.mockResolvedValueOnce(pngResponse(200, { 'X-Proxion-Captured-At': new Date().toISOString() }));
    act(() => retryButton.click());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(urlMock).toHaveBeenLastCalledWith('pve1', 'qemu', 100, { w: 400, refresh: true });
    await screen.findByRole('img', { name: 'Console preview for web-prod-01' });
  });

  it('treats 503 { error: "busy" } as still loading: keeps the skeleton and retries after 4s', async () => {
    vi.useFakeTimers();
    const capturedAt = new Date().toISOString();
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'busy' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(pngResponse(200, { 'X-Proxion-Captured-At': capturedAt }));

    render(<ConsoleThumbnail node="pve1" type="qemu" vmid={100} name="web-prod-01" status="running" />);
    act(() => lastObserver().trigger(true));

    // First response: busy. No error state, no retry button -- the busy body is read and a retry is scheduled.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Preview unavailable')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();

    // 4s later it asks again (a plain fetch, not refresh=1) and this time renders the image.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlMock).toHaveBeenLastCalledWith('pve1', 'qemu', 100, { w: 400, refresh: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(screen.getByRole('img', { name: 'Console preview for web-prod-01' })).toHaveAttribute(
      'src',
      'blob:mock-url',
    );
  });

  it('shows "Preview unavailable" on a network error/timeout', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    render(<ConsoleThumbnail node="pve1" type="qemu" vmid={100} name="web-prod-01" status="running" />);
    act(() => lastObserver().trigger(true));

    await screen.findByText('Preview unavailable');
  });

  it('re-fetches every 60s while visible, and stops once it becomes hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockResolvedValue(pngResponse(200, { 'X-Proxion-Captured-At': new Date().toISOString() }));

    render(<ConsoleThumbnail node="pve1" type="qemu" vmid={100} name="web-prod-01" status="running" />);

    act(() => lastObserver().trigger(true));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Scrolled out of view: the 60s poll must not keep firing.
    act(() => lastObserver().trigger(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('click / Enter / Space open the console pop-out window, one per guest', async () => {
    fetchMock.mockResolvedValue(pngResponse(200, { 'X-Proxion-Captured-At': new Date().toISOString() }));
    render(<ConsoleThumbnail node="pve1" type="qemu" vmid={100} name="web-prod-01" status="running" />);
    act(() => lastObserver().trigger(true));
    const tile = await screen.findByRole('button', { name: 'Open console for web-prod-01 in a new window' });

    fireEvent.click(tile);
    expect(openMock).toHaveBeenCalledWith(
      '/console/pve1/qemu/100',
      'proxion-console-pve1-qemu-100',
      'popup,width=1280,height=800',
    );

    fireEvent.keyDown(tile, { key: 'Enter' });
    fireEvent.keyDown(tile, { key: ' ' });
    expect(openMock).toHaveBeenCalledTimes(3);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('the refresh button always fetches with refresh=1 (no client-side throttle), spins while in flight, and does not open the console', async () => {
    let resolveSecond: ((r: Response) => void) | undefined;
    fetchMock
      .mockResolvedValueOnce(pngResponse(200, { 'X-Proxion-Captured-At': new Date().toISOString() }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveSecond = resolve; }));
    render(<ConsoleThumbnail node="pve1" type="qemu" vmid={100} name="web-prod-01" status="running" />);
    act(() => lastObserver().trigger(true));
    const refresh = await screen.findByRole('button', { name: 'Refresh console preview for web-prod-01' });

    fireEvent.click(refresh); // seconds after load: must not be silently dropped
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(urlMock).toHaveBeenLastCalledWith('pve1', 'qemu', 100, { w: 400, refresh: true });
    expect(refresh).toBeDisabled();
    expect(refresh.querySelector('svg')).toHaveClass('animate-spin');
    expect(openMock).not.toHaveBeenCalled();

    await act(async () => {
      resolveSecond!(pngResponse(200, { 'X-Proxion-Captured-At': new Date().toISOString(), 'X-Proxion-Source': 'live' }));
    });
    await waitFor(() => expect(refresh).not.toBeDisabled());
    expect(refresh.querySelector('svg')).not.toHaveClass('animate-spin');
  });

  it('says "already fresh" for a moment when the server throttled a manual refresh to its cache', async () => {
    vi.useFakeTimers();
    const capturedAt = new Date(Date.now() - 34_000).toISOString(); // old enough for an "Ns ago" label
    fetchMock
      .mockResolvedValueOnce(pngResponse(200, { 'X-Proxion-Captured-At': capturedAt, 'X-Proxion-Source': 'live' }))
      .mockResolvedValueOnce(pngResponse(200, { 'X-Proxion-Captured-At': capturedAt, 'X-Proxion-Source': 'cache' }));
    render(<ConsoleThumbnail node="pve1" type="qemu" vmid={100} name="web-prod-01" status="running" />);
    act(() => lastObserver().trigger(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(screen.getByText(/captured \d+s ago/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh console preview for web-prod-01' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(screen.getByText('already fresh')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(screen.queryByText('already fresh')).not.toBeInTheDocument();
    expect(screen.getByText(/captured \d+s ago/)).toBeInTheDocument();
  });

  it('a manual "refresh all" bump (refreshToken) forces a live re-capture even while hidden', async () => {
    fetchMock.mockResolvedValue(pngResponse(200, { 'X-Proxion-Captured-At': new Date().toISOString() }));

    const { rerender } = render(
      <ConsoleThumbnail node="pve1" type="qemu" vmid={100} name="web-prod-01" status="running" refreshToken={0} />,
    );
    expect(fetchMock).not.toHaveBeenCalled();

    rerender(
      <ConsoleThumbnail node="pve1" type="qemu" vmid={100} name="web-prod-01" status="running" refreshToken={1} />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(urlMock).toHaveBeenCalledWith('pve1', 'qemu', 100, { w: 400, refresh: true });
  });
});
