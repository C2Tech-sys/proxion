import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// `globals` is off in vitest.config.ts, so React Testing Library cannot self-register its
// auto-cleanup hook: without this, every `render()` leaves its DOM in document.body and later
// tests in the same file query a mix of their own output and earlier tests' leftovers.
afterEach(() => {
  cleanup();
});
