import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatDriveSize,
  formatDuration,
  formatPercent,
  formatUptime,
  parsePveSize,
  parseTags,
} from './format';

describe('formatBytes', () => {
  it('formats zero', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats bytes below 1 KiB', () => {
    expect(formatBytes(512)).toBe('512 B');
  });

  it('formats KiB/MiB/GiB using binary units', () => {
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(4 * 1024 * 1024)).toBe('4.0 MiB');
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.0 GiB');
  });
});

describe('parsePveSize', () => {
  it('returns null for undefined or an unparsable string', () => {
    expect(parsePveSize(undefined)).toBeNull();
    expect(parsePveSize('not-a-size')).toBeNull();
    expect(parsePveSize('')).toBeNull();
  });

  it('parses a bare byte count (no suffix)', () => {
    expect(parsePveSize('4194304')).toBe(4194304);
  });

  it('parses K/M/G/T suffixes as binary (1024-based) multipliers', () => {
    expect(parsePveSize('512K')).toBe(512 * 1024);
    expect(parsePveSize('4M')).toBe(4 * 1024 ** 2);
    expect(parsePveSize('32G')).toBe(32 * 1024 ** 3);
    expect(parsePveSize('2T')).toBe(2 * 1024 ** 4);
  });

  it('is case-insensitive on the suffix', () => {
    expect(parsePveSize('32g')).toBe(32 * 1024 ** 3);
  });

  it('parses a fractional value', () => {
    expect(parsePveSize('1.5G')).toBe(1.5 * 1024 ** 3);
  });
});

describe('formatDriveSize', () => {
  it('formats a PVE size string through formatBytes, e.g. "32G" -> "32.0 GiB"', () => {
    expect(formatDriveSize('32G')).toBe('32.0 GiB');
    expect(formatDriveSize('16G')).toBe('16.0 GiB');
    expect(formatDriveSize('4M')).toBe('4.0 MiB');
  });

  it('returns "-" for undefined/empty', () => {
    expect(formatDriveSize(undefined)).toBe('-');
    expect(formatDriveSize('')).toBe('-');
  });

  it('falls back to the raw string for a shape it cannot parse', () => {
    expect(formatDriveSize('weird-value')).toBe('weird-value');
  });
});

describe('formatUptime', () => {
  it('returns a dash for zero or negative', () => {
    expect(formatUptime(0)).toBe('-');
    expect(formatUptime(-5)).toBe('-');
  });

  it('formats sub-day uptime as HH:MM:SS', () => {
    expect(formatUptime(3661)).toBe('01:01:01');
  });

  it('formats multi-day uptime with a day count', () => {
    expect(formatUptime(2 * 86400 + 3661)).toBe('2d 01:01:01');
  });
});

describe('formatDuration', () => {
  it('returns a dash for negative or non-finite values', () => {
    expect(formatDuration(-1)).toBe('-');
    expect(formatDuration(Number.NaN)).toBe('-');
  });

  it('formats sub-minute durations as seconds', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(12)).toBe('12s');
    expect(formatDuration(59)).toBe('59s');
  });

  it('formats sub-hour durations as minutes and seconds', () => {
    expect(formatDuration(60)).toBe('1m 0s');
    expect(formatDuration(252)).toBe('4m 12s');
  });

  it('formats sub-day durations as hours and minutes, not triple-digit minutes', () => {
    // 841m19s worth of seconds must roll up to hours, e.g. "14h 1m" not "841m 19s".
    expect(formatDuration(841 * 60 + 19)).toBe('14h 1m');
    expect(formatDuration(3600)).toBe('1h 0m');
  });

  it('formats multi-day durations as days and hours', () => {
    expect(formatDuration(2 * 86400 + 3 * 3600)).toBe('2d 3h');
    expect(formatDuration(86400)).toBe('1d 0h');
  });
});

describe('formatPercent', () => {
  it('rounds to the nearest whole percent by default', () => {
    expect(formatPercent(0.5123)).toBe('51%');
  });
});

describe('parseTags', () => {
  it('splits a semicolon-joined tag string', () => {
    expect(parseTags('prod;web')).toEqual(['prod', 'web']);
  });

  it('returns an empty array for undefined or empty input', () => {
    expect(parseTags(undefined)).toEqual([]);
    expect(parseTags('')).toEqual([]);
  });
});
