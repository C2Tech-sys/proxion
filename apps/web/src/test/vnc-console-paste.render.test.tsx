import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { VncConsole } from '@/components/console/VncConsole';
import { MAX_PASTE_CHARS } from '@/lib/vncTyping';

/**
 * The console's "Paste" button opens a dialog that types the text into the guest as keystrokes
 * (`sendKey`), because VNC's clipboard message does nothing on guests without a clipboard agent.
 * RFB is faked the same way `VncConsole.test.tsx` fakes it; `navigator.clipboard` and sonner's
 * `toast` are mocked so the dialog's behaviour is asserted directly.
 */
const vncMock = vi.fn();
const toastSuccess = vi.fn();
const toastInfo = vi.fn();
const toastError = vi.fn();

vi.mock('@/api/client', () => ({
  USE_FIXTURES: false,
  api: { console: { vnc: (...args: unknown[]) => vncMock(...args), term: vi.fn() } },
}));

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    info: (...args: unknown[]) => toastInfo(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

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
    sendKey = vi.fn();
    focus = vi.fn();
    constructor() {
      super();
      FakeRFB.instances.push(this);
    }
  }
  return { FakeRFB };
});

vi.mock('@novnc/novnc', () => ({ default: FakeRFB }));

function setClipboard(readText: (() => Promise<string>) | undefined) {
  Object.defineProperty(navigator, 'clipboard', {
    value: readText ? { readText } : undefined,
    configurable: true,
  });
}

async function connectedConsole() {
  render(<VncConsole node="pve1" type="qemu" vmid={100} />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const rfb = FakeRFB.instances.at(-1);
  if (!rfb) throw new Error('no RFB instance was constructed');
  act(() => {
    rfb.dispatchEvent(new CustomEvent('connect'));
  });
  await screen.findByText('Connected');
  return rfb;
}

function openPaste() {
  fireEvent.click(screen.getByRole('button', { name: 'Paste clipboard' }));
}

describe('VncConsole paste dialog', () => {
  beforeEach(() => {
    FakeRFB.instances.length = 0;
    vncMock.mockReset();
    vncMock.mockResolvedValue({ wsPath: '/api/console/vnc/ws/tok', password: 'pw' });
    toastSuccess.mockReset();
    toastInfo.mockReset();
    toastError.mockReset();
  });

  afterEach(() => {
    cleanup();
    setClipboard(undefined);
  });

  it('opens pre-filled from the clipboard and types the text as keystrokes', async () => {
    setClipboard(() => Promise.resolve('ab\n'));
    const rfb = await connectedConsole();

    openPaste();
    const textarea = await screen.findByRole('textbox', { name: 'Text to type' });
    await waitFor(() => expect(textarea).toHaveValue('ab\n'));
    expect(textarea).toHaveFocus();
    expect(screen.getByText(/US keyboard layout/)).toBeInTheDocument();
    expect(screen.getByText('3 characters')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Type into console' }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Typed 3 characters'));
    expect(rfb.sendKey.mock.calls).toEqual([
      [0x61, null, true],
      [0x61, null, false],
      [0x62, null, true],
      [0x62, null, false],
      [0xff0d, null, true],
      [0xff0d, null, false],
    ]);
    // noVNC's own clipboard path is still tried, but never relied on.
    expect(rfb.clipboardPasteFrom).toHaveBeenCalledWith('ab\n');
    // Dialog closes and focus returns to the console canvas.
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Text to type' })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(rfb.focus).toHaveBeenCalled());
  });

  it('mentions skipped characters in the toast', async () => {
    setClipboard(() => Promise.resolve('a\u{1F600}\u{1F600}'));
    const rfb = await connectedConsole();

    openPaste();
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Text to type' })).not.toHaveValue(''),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Type into console' }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Typed 1 character; 2 skipped'));
    expect(rfb.sendKey).toHaveBeenCalledTimes(2);
  });

  it('leaves the textarea empty with a hint when the clipboard cannot be read', async () => {
    setClipboard(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));
    const rfb = await connectedConsole();

    openPaste();
    const textarea = await screen.findByRole('textbox', { name: 'Text to type' });
    expect(await screen.findByText('Paste into the box with Ctrl+V')).toBeInTheDocument();
    expect(textarea).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Type into console' })).toBeDisabled();

    // The user can paste by hand and type it.
    fireEvent.change(textarea, { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Type into console' }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Typed 1 character'));
    expect(rfb.sendKey).toHaveBeenCalledWith(0x78, null, true);
  });

  it('shows the same hint when there is no clipboard API at all (insecure context)', async () => {
    setClipboard(undefined);
    await connectedConsole();

    openPaste();
    expect(await screen.findByText('Paste into the box with Ctrl+V')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Text to type' })).toHaveValue('');
  });

  it('warns and disables the button when the text is over the limit', async () => {
    setClipboard(() => Promise.resolve('a'.repeat(MAX_PASTE_CHARS + 1)));
    const rfb = await connectedConsole();

    openPaste();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(`${MAX_PASTE_CHARS + 1} of ${MAX_PASTE_CHARS}`);
    const button = screen.getByRole('button', { name: 'Type into console' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(rfb.sendKey).not.toHaveBeenCalled();

    // Exactly at the limit is fine.
    fireEvent.change(screen.getByRole('textbox', { name: 'Text to type' }), {
      target: { value: 'a'.repeat(MAX_PASTE_CHARS) },
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(button).toBeEnabled();
  });

  it('shows progress while typing and Cancel aborts', async () => {
    setClipboard(() => Promise.resolve('a'.repeat(400)));
    const rfb = await connectedConsole();

    openPaste();
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Text to type' })).not.toHaveValue(''),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Type into console' }));

    expect(await screen.findByText(/of 400 characters/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(toastInfo).toHaveBeenCalled());
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(rfb.sendKey.mock.calls.length).toBeLessThan(800);
  });

  it('keeps the Paste button disabled until connected', async () => {
    setClipboard(() => Promise.resolve('a'));
    render(<VncConsole node="pve1" type="qemu" vmid={100} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Paste clipboard' })).toBeDisabled();
  });
});
