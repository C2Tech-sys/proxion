import { describe, expect, it } from 'vitest';
import { isValidDnsName, isValidGuestName, maxNameLength } from './guestName';

describe('isValidDnsName', () => {
  const valid: Array<[string, number]> = [
    ['web-01', 253],
    ['web-01.lab', 253],
    ['a', 253],
    ['a'.repeat(63), 253],
    ['0-9-a', 253],
  ];

  const invalid: Array<[string, number]> = [
    ['', 253],
    ['bad_name!', 253],
    ['-leading', 253],
    ['trailing-', 253],
    ['a'.repeat(64), 253],
    ['double..dot', 253],
    ['a'.repeat(254), 253],
  ];

  it.each(valid)('accepts %j (max %i)', (value, max) => {
    expect(isValidDnsName(value, max)).toBe(true);
  });

  it.each(invalid)('rejects %j (max %i)', (value, max) => {
    expect(isValidDnsName(value, max)).toBe(false);
  });

  it('enforces the total-length cap independent of label validity', () => {
    // 253 labels of "a." would blow past 253 total chars even though every label is valid.
    const longName = Array.from({ length: 130 }, () => 'ab').join('.');
    expect(longName.length).toBeGreaterThan(253);
    expect(isValidDnsName(longName, 253)).toBe(false);
  });
});

describe('maxNameLength / isValidGuestName', () => {
  it('caps qemu names at 253 and lxc hostnames at 255', () => {
    expect(maxNameLength('qemu')).toBe(253);
    expect(maxNameLength('lxc')).toBe(255);
  });

  it('a 254-char name (valid labels, over qemu\'s 253 cap) is invalid for qemu but valid for lxc', () => {
    // Four labels, each <=63 chars (so every label is individually valid), totalling 254 chars
    // with their joining dots -- isolates the *total-length* cap from the per-label length cap.
    const name = ['a'.repeat(63), 'a'.repeat(63), 'a'.repeat(63), 'a'.repeat(62)].join('.');
    expect(name.length).toBe(254);
    expect(isValidGuestName(name, 'qemu')).toBe(false);
    expect(isValidGuestName(name, 'lxc')).toBe(true);
  });
});
