import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// Route-level render tests (router + fixture data) can take several seconds when the whole
// suite runs in parallel; a 1 s default wait measures machine load, not correctness.
configure({ asyncUtilTimeout: 10_000 });

// `globals` is off in vitest.config.ts, so React Testing Library cannot self-register its
// auto-cleanup hook: without this, every `render()` leaves its DOM in document.body and later
// tests in the same file query a mix of their own output and earlier tests' leftovers.
// Captured before any test installs fake timers, so the flush below always uses the real clock.
const realSetTimeout = globalThis.setTimeout;

afterEach(async () => {
  cleanup();
  // Radix's FocusScope (dialogs, sheets, menus) finishes its unmount work in a `setTimeout(…, 0)`:
  // it builds a CustomEvent and dispatches it on the unmounted container. When the file's jsdom
  // window is torn down before that timer fires, the event comes from a different realm and jsdom
  // throws "parameter 1 is not of type 'Event'" as an unhandled error (seen on CI in
  // tasks-drawer.render.test.tsx). One real macrotask after cleanup lets that timer run while the
  // window is still alive.
  await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
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
