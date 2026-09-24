import { describe, expect, it } from 'vitest';

import { consolePopoutHref, consolePopoutWindowName } from './thumbnails';

// `import.meta.env.BASE_URL` mirrors vite.config.ts's `base` (default '/', '/proxion/' for the
// GitHub Pages demo build -- see VITE_BASE_PATH). It's a build-time constant baked in per module
// by Vite/Vitest's own transform, not something a single test file can flip at runtime, so these
// assertions pin the helper's output to whatever BASE_URL this test run was built with -- proving
// the href is *derived from* BASE_URL (never a bare hard-coded leading slash) rather than proving
// one specific base value.
describe('consolePopoutHref', () => {
  it('is prefixed with the current BASE_URL, not a hard-coded leading slash', () => {
    expect(consolePopoutHref('pve1', 'qemu', 100)).toBe(
      `${import.meta.env.BASE_URL}console/pve1/qemu/100`,
    );
  });

  it('URL-encodes the node name', () => {
    expect(consolePopoutHref('my node', 'lxc', 200)).toBe(
      `${import.meta.env.BASE_URL}console/my%20node/lxc/200`,
    );
  });
});

describe('consolePopoutWindowName', () => {
  it('is stable for the same guest (so a second pop-out focuses the first window)', () => {
    expect(consolePopoutWindowName('pve1', 'qemu', 100)).toBe(
      consolePopoutWindowName('pve1', 'qemu', 100),
    );
  });

  it('is not base-path-prefixed (window names are not URLs)', () => {
    expect(consolePopoutWindowName('pve1', 'qemu', 100)).toBe('proxion-console-pve1-qemu-100');
  });
});
