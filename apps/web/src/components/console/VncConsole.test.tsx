import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

import { VncConsole } from './VncConsole';

const vncMock = vi.fn();

vi.mock('@/api/client', () => ({
  USE_FIXTURES: false,
  api: {
    console: {
      vnc: (...args: unknown[]) => vncMock(...args),
      term: vi.fn(),
    },
  },
}));

/** Minimal fake standing in for noVNC's RFB, which is a real EventTarget under the hood. */
const { FakeRFB } = vi.hoisted(() => {
  class FakeRFB extends EventTarget {
    static instances: FakeRFB[] = [];
    scaleViewport = false;
    resizeSession = false;
    clipViewport = false;
    focusOnClick = false;
    disconnect = vi.fn();
    sendCtrlAltDel = vi.fn();
    clipboardPasteFrom = vi.fn();
    target: HTMLElement;
    url: string;
    options: { credentials?: { password?: string }; wsProtocols?: string[] };
    constructor(
      target: HTMLElement,
      url: string,
      options: { credentials?: { password?: string }; wsProtocols?: string[] },
    ) {
      super();
      this.target = target;
      this.url = url;
      this.options = options;
      FakeRFB.instances.push(this);
    }
  }
  return { FakeRFB };
});

vi.mock('@novnc/novnc', () => ({ default: FakeRFB }));

type FakeRFBInstance = InstanceType<typeof FakeRFB>;

function lastInstance(): FakeRFBInstance {
  const instance = FakeRFB.instances.at(-1);
  if (!instance) throw new Error('no RFB instance was constructed');
  return instance;
}

describe('VncConsole', () => {
  beforeEach(() => {
    FakeRFB.instances.length = 0;
    vncMock.mockReset();
    vncMock.mockResolvedValue({ wsPath: '/api/console/vnc/ws/tok123', password: 's3cret' });
  });

  afterEach(() => {
    cleanup();
  });

  it('requests a ticket and opens an RFB session against the derived ws:// url', async () => {
    render(<VncConsole node="pve1" type="qemu" vmid={100} />);

    expect(await screen.findByText('Connecting…')).toBeInTheDocument();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(vncMock).toHaveBeenCalledWith('pve1', 'qemu', 100);

    const instance = lastInstance();
    expect(instance.url).toBe('ws://localhost:3000/api/console/vnc/ws/tok123');
    expect(instance.options.credentials).toEqual({ password: 's3cret' });
    expect(instance.options.wsProtocols).toEqual(['binary']);
    expect(instance.scaleViewport).toBe(true);
    expect(instance.resizeSession).toBe(false);
    expect(instance.clipViewport).toBe(false);
    expect(instance.focusOnClick).toBe(true);
  });

  it('shows Connected after RFB fires "connect", and Disconnected + reason after a dirty disconnect', async () => {
    render(<VncConsole node="pve1" type="qemu" vmid={100} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const instance = lastInstance();

    act(() => {
      instance.dispatchEvent(new CustomEvent('connect'));
    });
    expect(await screen.findByText('Connected')).toBeInTheDocument();

    act(() => {
      instance.dispatchEvent(new CustomEvent('disconnect', { detail: { clean: false } }));
    });
    expect(await screen.findByText('Disconnected')).toBeInTheDocument();
    expect(screen.getByText(/Connection lost/)).toBeInTheDocument();
  });

  it('wires the Ctrl+Alt+Del button to rfb.sendCtrlAltDel()', async () => {
    render(<VncConsole node="pve1" type="qemu" vmid={100} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const instance = lastInstance();
    act(() => {
      instance.dispatchEvent(new CustomEvent('connect'));
    });
    await screen.findByText('Connected');

    screen.getByRole('button', { name: 'Ctrl+Alt+Del' }).click();
    expect(instance.sendCtrlAltDel).toHaveBeenCalledTimes(1);
  });

  it('disconnects the RFB session on unmount', async () => {
    const { unmount } = render(<VncConsole node="pve1" type="qemu" vmid={100} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const instance = lastInstance();
    unmount();
    expect(instance.disconnect).toHaveBeenCalledTimes(1);
  });
});
