/**
 * Turns text into noVNC key events so the console's "Paste" can *type* into the guest.
 *
 * noVNC's `clipboardPasteFrom` only sends a VNC ClientCutText message, which QEMU's VNC server
 * forwards into the guest solely when the VM runs a clipboard agent (qemu-vdagent + spice-vdagent
 * inside the guest). Almost no Proxmox VM has that, so pasting that way silently does nothing.
 * Sending the characters as keystrokes works against any guest, at the cost of assuming a US
 * keyboard layout: X11 Latin-1 keysyms equal their code points, and QEMU's keymap applies Shift
 * itself for uppercase letters and symbols, so only the keysym is sent (`code` is null).
 */

/** Longest text the Paste dialog will type (typing is slow and cannot be interrupted in the guest). */
export const MAX_PASTE_CHARS = 4096;

export const XK_RETURN = 0xff0d;
export const XK_TAB = 0xff09;

export interface KeyEvent {
  /** X11 keysym. */
  keysym: number;
  /** Physical key code (DOM `KeyboardEvent.code`); null lets noVNC/QEMU derive it from the keysym. */
  code: string | null;
  down: boolean;
}

export interface TypingPlan {
  /** Down/up pairs, in order; `events.length === typed * 2`. */
  events: KeyEvent[];
  /** Characters that map to a key (a CRLF pair counts once). */
  typed: number;
  /** Characters with no keysym (control chars, emoji, CJK, ...). */
  skipped: number;
}

/** Keysym for one code point, or null when it cannot be typed. */
function keysymFor(codePoint: number): number | null {
  if (codePoint >= 0x20 && codePoint <= 0x7e) return codePoint;
  if (codePoint >= 0xa0 && codePoint <= 0xff) return codePoint;
  if (codePoint === 0x0a || codePoint === 0x0d) return XK_RETURN;
  if (codePoint === 0x09) return XK_TAB;
  return null;
}

/** Maps `text` to key events plus how many characters were typed/skipped. */
export function planTyping(text: string): TypingPlan {
  const events: KeyEvent[] = [];
  let typed = 0;
  let skipped = 0;
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i]!.codePointAt(0)!;
    if (cp === 0x0d && chars[i + 1] === '\n') i++; // CRLF is a single Return
    const keysym = keysymFor(cp);
    if (keysym === null) {
      skipped++;
      continue;
    }
    events.push({ keysym, code: null, down: true }, { keysym, code: null, down: false });
    typed++;
  }
  return { events, typed, skipped };
}

/** Each typable character as a key down then key up. Untypable characters are dropped. */
export function textToKeyEvents(text: string): KeyEvent[] {
  return planTyping(text).events;
}

/** The slice of noVNC's RFB that typing needs. */
export interface KeySender {
  sendKey(keysym: number, code: string | null, down?: boolean): void;
}

export interface TypeTextOptions {
  /** Pause after each key (down+up); QEMU drops keys that arrive back to back. Default 8. */
  delayMs?: number;
  signal?: AbortSignal;
  /** Called after each typed character with (typedSoFar, totalTypable). */
  onProgress?: (typed: number, total: number) => void;
}

export interface TypeTextResult {
  typed: number;
  skipped: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Types `text` into the guest through `rfb.sendKey`, pausing `delayMs` between keys. Resolves
 * with how many characters were typed before finishing or being aborted, and how many were
 * skipped as untypable (counted over the whole text, even after an abort).
 */
export async function typeText(
  rfb: KeySender,
  text: string,
  { delayMs = 8, signal, onProgress }: TypeTextOptions = {},
): Promise<TypeTextResult> {
  const plan = planTyping(text);
  let typed = 0;
  for (let i = 0; i < plan.events.length; i += 2) {
    if (signal?.aborted) break;
    const down = plan.events[i]!;
    const up = plan.events[i + 1]!;
    rfb.sendKey(down.keysym, down.code, true);
    rfb.sendKey(up.keysym, up.code, false);
    typed++;
    onProgress?.(typed, plan.typed);
    if (delayMs > 0 && typed < plan.typed) await sleep(delayMs, signal);
  }
  return { typed, skipped: plan.skipped };
}
