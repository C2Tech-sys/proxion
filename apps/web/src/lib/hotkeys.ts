/**
 * Global-hotkey scoping. A console (VncConsole) or terminal (Terminal) grabs raw keyboard
 * input for the guest -- Ctrl/Cmd-K, Tab, arrow keys and friends must reach the guest, not
 * trigger the app's command palette or other shortcuts. Any such surface marks itself with
 * `data-hotkey-scope="console"` (see VncConsole.tsx / Terminal.tsx); global handlers call
 * `isHotkeyScopeSuppressed` before acting on a keydown.
 */
const SUPPRESSING_SCOPE_SELECTOR = '[data-hotkey-scope="console"]';

/**
 * True when `target` (or the currently focused element, if omitted) is inside a surface that
 * owns its own keyboard input. Global app hotkeys should no-op in that case.
 */
export function isHotkeyScopeSuppressed(target?: EventTarget | null): boolean {
  const el = resolveElement(target);
  if (!el) return false;
  return el.closest(SUPPRESSING_SCOPE_SELECTOR) !== null;
}

function resolveElement(target?: EventTarget | null): Element | null {
  const node = target ?? (typeof document !== 'undefined' ? document.activeElement : null);
  return node instanceof Element ? node : null;
}
