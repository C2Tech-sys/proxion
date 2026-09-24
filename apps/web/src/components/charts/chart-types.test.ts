import { describe, expect, it } from 'vitest';

import { axisTimeBucket, formatAxisTime } from './chart-types';

// A fixed, known instant so output is deterministic regardless of when the suite runs.
// Expectations below read the clock/weekday back off `new Date(T * 1000)` in local time
// (like `formatAxisTime` itself) rather than hardcoding a timezone-dependent string.
const T = Date.UTC(2026, 8, 16, 14, 5, 0) / 1000;
const localDate = new Date(T * 1000);
const clock = `${String(localDate.getHours()).padStart(2, '0')}:${String(localDate.getMinutes()).padStart(2, '0')}`;
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(localDate);
const hourOnly = new Intl.DateTimeFormat(undefined, { hour: 'numeric', hour12: false }).format(localDate);
const month = new Intl.DateTimeFormat(undefined, { month: 'short' }).format(localDate);
const day = String(localDate.getDate());
const year = String(localDate.getFullYear());

describe('axisTimeBucket', () => {
  it('buckets the hour (60s) and day (1800s) steps as a clock', () => {
    expect(axisTimeBucket(60)).toBe('clock');
    expect(axisTimeBucket(1800)).toBe('clock');
  });

  it('buckets the week step (10800s) as weekday+clock', () => {
    expect(axisTimeBucket(10800)).toBe('weekday-clock');
  });

  it('buckets the month step (43200s) as month+day', () => {
    expect(axisTimeBucket(43200)).toBe('month-day');
  });

  it('buckets the year (604800s) and decade (6048000s) steps as month+year', () => {
    expect(axisTimeBucket(604800)).toBe('month-year');
    expect(axisTimeBucket(6048000)).toBe('month-year');
    expect(axisTimeBucket(50_000_000)).toBe('month-year');
  });
});

describe('formatAxisTime', () => {
  it('formats hour/day ticks as a 24-hour clock with no date', () => {
    expect(formatAxisTime(60, T)).toBe(clock);
    expect(formatAxisTime(1800, T)).toBe(clock);
  });

  it('formats week ticks with a short weekday and hour, no minutes', () => {
    // No minutes: at the week timeframe's tick density, "Wed 00:00" next to "Thu 00:00" ran
    // together with no pixel gap between adjacent ticks. Week-tick spacing is always in whole
    // hours, so dropping the minutes loses no information while staying well short of that gap.
    const label = formatAxisTime(10800, T);
    expect(label).toContain(weekday);
    expect(label).toContain(hourOnly);
    expect(label).not.toContain(':');
  });

  it('formats month ticks as short month + day, with no time or year', () => {
    const label = formatAxisTime(43200, T);
    expect(label).toContain(month);
    expect(label).toContain(day);
    expect(label).not.toContain(year);
    expect(label).not.toContain(':');
  });

  it('formats year/decade ticks as short month + year, with no day or time', () => {
    const label = formatAxisTime(604800, T);
    expect(label).toContain(month);
    expect(label).toContain(year);
    expect(label).not.toContain(':');

    const decadeLabel = formatAxisTime(6048000, T);
    expect(decadeLabel).toContain(month);
    expect(decadeLabel).toContain(year);
  });
});
