import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_PASTE_CHARS,
  XK_RETURN,
  XK_TAB,
  planTyping,
  textToKeyEvents,
  typeText,
  type KeyEvent,
} from './vncTyping';

/** Collapses events to `[keysym, down]` for compact assertions. */
function simple(events: KeyEvent[]): Array<[number, boolean]> {
  return events.map((e) => [e.keysym, e.down]);
}

describe('textToKeyEvents', () => {
  it('maps printable ASCII to its char code as a down/up pair with a null code', () => {
    expect(textToKeyEvents('a')).toEqual([
      { keysym: 0x61, code: null, down: true },
      { keysym: 0x61, code: null, down: false },
    ]);
  });

  it('sends only the keysym for uppercase letters and symbols (no explicit Shift)', () => {
    expect(simple(textToKeyEvents('A!~ '))).toEqual([
      [0x41, true],
      [0x41, false],
      [0x21, true],
      [0x21, false],
      [0x7e, true],
      [0x7e, false],
      [0x20, true],
      [0x20, false],
    ]);
  });

  it('maps \\n, \\r\\n and a lone \\r to a single Return, and \\t to Tab', () => {
    const ret = [
      [XK_RETURN, true],
      [XK_RETURN, false],
    ];
    expect(simple(textToKeyEvents('\n'))).toEqual(ret);
    expect(simple(textToKeyEvents('\r\n'))).toEqual(ret);
    expect(simple(textToKeyEvents('\r'))).toEqual(ret);
    expect(simple(textToKeyEvents('\r\r'))).toEqual([...ret, ...ret]);
    expect(simple(textToKeyEvents('\t'))).toEqual([
      [XK_TAB, true],
      [XK_TAB, false],
    ]);
    expect(XK_RETURN).toBe(0xff0d);
    expect(XK_TAB).toBe(0xff09);
  });

  it('maps Latin-1 characters to their Latin-1 keysym', () => {
    expect(simple(textToKeyEvents('é£ ÿ')).filter(([, down]) => down)).toEqual([
      [0xe9, true],
      [0xa3, true],
      [0xa0, true],
      [0xff, true],
    ]);
  });

  it('skips other control characters, emoji and CJK, and counts them', () => {
    const plan = planTyping('a\u0007b\u{1F600}c漢\u007f');
    expect(plan.typed).toBe(3);
    expect(plan.skipped).toBe(4); // BEL, emoji (one code point), CJK, DEL
    expect(simple(plan.events).filter(([, down]) => down)).toEqual([
      [0x61, true],
      [0x62, true],
      [0x63, true],
    ]);
  });

  it('counts a CRLF as one typed character', () => {
    const plan = planTyping('a\r\nb');
    expect(plan.typed).toBe(3);
    expect(plan.skipped).toBe(0);
  });

  it('returns nothing for empty text', () => {
    expect(planTyping('')).toEqual({ events: [], typed: 0, skipped: 0 });
  });

  it('exposes the max paste length', () => {
    expect(MAX_PASTE_CHARS).toBe(4096);
  });
});

describe('typeText', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits down/up pairs in order and resolves typed/skipped', async () => {
    const sendKey = vi.fn();
    const result = await typeText({ sendKey }, 'aB\n\u{1F600}', { delayMs: 0 });
    expect(result).toEqual({ typed: 3, skipped: 1 });
    expect(sendKey.mock.calls).toEqual([
      [0x61, null, true],
      [0x61, null, false],
      [0x42, null, true],
      [0x42, null, false],
      [XK_RETURN, null, true],
      [XK_RETURN, null, false],
    ]);
  });

  it('waits delayMs between keys (fake timers)', async () => {
    vi.useFakeTimers();
    const sendKey = vi.fn();
    const promise = typeText({ sendKey }, 'abc', { delayMs: 10 });

    // First key goes out immediately, the next only after the delay.
    expect(sendKey).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9);
    expect(sendKey).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sendKey).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(10);
    expect(sendKey).toHaveBeenCalledTimes(6);

    await expect(promise).resolves.toEqual({ typed: 3, skipped: 0 });
  });

  it('defaults to an 8 ms delay', async () => {
    vi.useFakeTimers();
    const sendKey = vi.fn();
    const promise = typeText({ sendKey }, 'ab');
    expect(sendKey).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(7);
    expect(sendKey).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sendKey).toHaveBeenCalledTimes(4);
    await promise;
  });

  it('aborts mid-way and resolves with what was typed', async () => {
    vi.useFakeTimers();
    const sendKey = vi.fn();
    const controller = new AbortController();
    const promise = typeText({ sendKey }, 'abcd\u{1F600}', { delayMs: 10, signal: controller.signal });

    await vi.advanceTimersByTimeAsync(10); // 'a' and 'b' sent
    expect(sendKey).toHaveBeenCalledTimes(4);
    controller.abort();
    await expect(promise).resolves.toEqual({ typed: 2, skipped: 1 });
    await vi.advanceTimersByTimeAsync(100);
    expect(sendKey).toHaveBeenCalledTimes(4);
  });

  it('types nothing when already aborted', async () => {
    const sendKey = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(typeText({ sendKey }, 'abc', { signal: controller.signal })).resolves.toEqual({
      typed: 0,
      skipped: 0,
    });
    expect(sendKey).not.toHaveBeenCalled();
  });

  it('reports progress per character', async () => {
    const onProgress = vi.fn();
    await typeText({ sendKey: vi.fn() }, 'ab', { delayMs: 0, onProgress });
    expect(onProgress.mock.calls).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});
