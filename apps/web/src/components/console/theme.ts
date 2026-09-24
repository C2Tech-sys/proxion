/**
 * Resolves a Proxion design-token CSS custom property (see index.css, e.g. "--background")
 * to a literal color string xterm.js can use in its `theme` option. Custom properties store
 * their raw text (often `oklch(...)`), so this applies the token to a detached element's
 * `color` and reads the browser-computed value back, which normalizes to `rgb(...)`.
 */
export function readCssColor(token: string, fallback = '#000000'): string {
  if (typeof document === 'undefined' || typeof window === 'undefined') return fallback;
  try {
    const probe = document.createElement('span');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.pointerEvents = 'none';
    probe.style.color = `var(${token})`;
    document.body.appendChild(probe);
    const resolved = window.getComputedStyle(probe).color;
    document.body.removeChild(probe);
    return resolved || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Same idea as `readCssColor`, but for a `font-family` token (e.g. `--font-mono`) -- xterm.js
 * takes a literal font stack, not a CSS variable, so this resolves Proxion's system monospace
 * stack (see index.css's plain `@theme` block; no shipped mono webfont as of T11) to a real
 * font-family string.
 */
export function readCssFontFamily(token: string, fallback = 'monospace'): string {
  if (typeof document === 'undefined' || typeof window === 'undefined') return fallback;
  try {
    const probe = document.createElement('span');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.pointerEvents = 'none';
    probe.style.fontFamily = `var(${token})`;
    document.body.appendChild(probe);
    const resolved = window.getComputedStyle(probe).fontFamily;
    document.body.removeChild(probe);
    return resolved || fallback;
  } catch {
    return fallback;
  }
}
