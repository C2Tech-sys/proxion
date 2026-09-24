import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// `globals` is off in vitest.config.ts, so React Testing Library cannot self-register its
// auto-cleanup hook: without this, every `render()` leaves its DOM in document.body and later
// tests in the same file query a mix of their own output and earlier tests' leftovers.
afterEach(() => {
  cleanup();
});

// jsdom has no `matchMedia`; uPlot (charts) and the theme sync consult it. A quiet default so
// components that touch it after a test's teardown never throw -- tests that care about the
// media query install their own mock over this.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
