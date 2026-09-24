import { describe, expect, it } from 'vitest';

import { isHotkeyScopeSuppressed } from './hotkeys';

describe('isHotkeyScopeSuppressed', () => {
  it('is false for an element outside any console scope', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    expect(isHotkeyScopeSuppressed(el)).toBe(false);
    el.remove();
  });

  it('is true for the scoped element itself', () => {
    const el = document.createElement('div');
    el.setAttribute('data-hotkey-scope', 'console');
    document.body.appendChild(el);
    expect(isHotkeyScopeSuppressed(el)).toBe(true);
    el.remove();
  });

  it('is true for a descendant of a scoped element (e.g. the xterm textarea)', () => {
    const scope = document.createElement('div');
    scope.setAttribute('data-hotkey-scope', 'console');
    const child = document.createElement('textarea');
    scope.appendChild(child);
    document.body.appendChild(scope);
    expect(isHotkeyScopeSuppressed(child)).toBe(true);
    scope.remove();
  });

  it('falls back to the active element when no target is given', () => {
    const scope = document.createElement('div');
    scope.setAttribute('data-hotkey-scope', 'console');
    const child = document.createElement('button');
    child.tabIndex = 0;
    scope.appendChild(child);
    document.body.appendChild(scope);
    child.focus();
    expect(isHotkeyScopeSuppressed()).toBe(true);
    scope.remove();
  });

  it('is false when target is not an Element (e.g. window)', () => {
    expect(isHotkeyScopeSuppressed(window)).toBe(false);
  });
});
