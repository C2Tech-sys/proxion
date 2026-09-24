import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

import { Terminal } from './Terminal';

const termMock = vi.fn();

vi.mock('@/api/client', () => ({
  USE_FIXTURES: false,
  api: {
    console: {
      vnc: vi.fn(),
      term: (...args: unknown[]) => termMock(...args),
    },
  },
}));

const { FakeXTerm, FakeFitAddon } = vi.hoisted(() => {
  class FakeXTerm {
    static instances: FakeXTerm[] = [];
    cols = 80;
    rows = 24;
    dataCb: ((data: string) => void) | null = null;
    resizeCb: (() => void) | null = null;
    open = vi.fn();
    loadAddon = vi.fn();
    write = vi.fn();
    dispose = vi.fn();
    options: unknown;
    constructor(options: unknown) {
      this.options = options;
      FakeXTerm.instances.push(this);
    }
    onData(cb: (data: string) => void) {
      this.dataCb = cb;
      return { dispose: vi.fn() };
    }
    onResize(cb: () => void) {
      this.resizeCb = cb;
      return { dispose: vi.fn() };
    }
  }

  class FakeFitAddon {
    fit = vi.fn();
  }

  return { FakeXTerm, FakeFitAddon };
});

vi.mock('@xterm/xterm', () => ({ Terminal: FakeXTerm }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: FakeFitAddon }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  binaryType = '';
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    public url: string,
    public protocols?: string[],
  ) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  triggerOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
}

type FakeXTermInstance = InstanceType<typeof FakeXTerm>;

function lastXTerm(): FakeXTermInstance {
  const instance = FakeXTerm.instances.at(-1);
  if (!instance) throw new Error('no Terminal instance was constructed');
  return instance;
}

function lastSocket(): FakeWebSocket {
  const instance = FakeWebSocket.instances.at(-1);
  if (!instance) throw new Error('no WebSocket was constructed');
  return instance;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Terminal', () => {
  beforeEach(() => {
    FakeXTerm.instances.length = 0;
    FakeWebSocket.instances.length = 0;
    termMock.mockReset();
    termMock.mockResolvedValue({ wsPath: '/api/console/term/ws/tok456' });
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('requests a term ticket for a node shell (no type/vmid) and opens the derived ws:// url', async () => {
    render(<Terminal node="pve1" />);
    await flush();

    expect(termMock).toHaveBeenCalledWith('pve1', undefined, undefined);
    const ws = lastSocket();
    expect(ws.url).toBe('ws://localhost:3000/api/console/term/ws/tok456');
    expect(ws.protocols).toEqual(['binary']);
    expect(ws.binaryType).toBe('arraybuffer');
  });

  it('requests a term ticket for a guest console when type/vmid are given', async () => {
    render(<Terminal node="pve1" type="lxc" vmid={200} />);
    await flush();
    expect(termMock).toHaveBeenCalledWith('pve1', 'lxc', 200);
  });

  it('sends the resize frame on open, then an input frame on term.onData, then a ping on the interval', async () => {
    vi.useFakeTimers();
    render(<Terminal node="pve1" />);
    await flush();

    const ws = lastSocket();
    act(() => ws.triggerOpen());
    expect(screen.getByText('Connected')).toBeInTheDocument();

    // First frame sent must be the resize frame, using the terminal's cols/rows.
    expect(ws.sent[0]).toBe('1:80:24:');

    const term = lastXTerm();
    act(() => term.dataCb?.('ls\r'));
    expect(ws.sent.at(-1)).toBe('0:3:ls\r');

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(ws.sent.at(-1)).toBe('2');
  });

  it('writes incoming binary frames to the terminal', async () => {
    render(<Terminal node="pve1" />);
    await flush();
    const ws = lastSocket();
    act(() => ws.triggerOpen());
    await screen.findByText('Connected');

    const term = lastXTerm();
    const bytes = new TextEncoder().encode('hello');
    act(() => ws.onmessage?.({ data: bytes.buffer }));
    expect(term.write).toHaveBeenCalledWith(expect.any(Uint8Array));
  });

  it('shows a Disconnected banner with a reconnect action when the socket closes', async () => {
    render(<Terminal node="pve1" />);
    await flush();
    const ws = lastSocket();
    act(() => ws.triggerOpen());
    await screen.findByText('Connected');

    act(() => ws.close());
    expect(await screen.findByText('Disconnected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('pop-out href is prefixed with BASE_URL for a node shell (no type/vmid)', async () => {
    const { container } = render(<Terminal node="pve1" />);
    await flush();
    const popoutLink = container.querySelector('a[href*="shell/"]');
    expect(popoutLink).toHaveAttribute('href', `${import.meta.env.BASE_URL}shell/pve1`);
  });

  it('pop-out href is prefixed with BASE_URL for a guest console (type + vmid set)', async () => {
    const { container } = render(<Terminal node="pve1" type="lxc" vmid={200} />);
    await flush();
    const popoutLink = container.querySelector('a[href*="console/"]');
    expect(popoutLink).toHaveAttribute(
      'href',
      `${import.meta.env.BASE_URL}console/pve1/lxc/200`,
    );
  });
});
