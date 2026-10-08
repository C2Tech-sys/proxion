const DAY_MS = 86_400_000;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `YYYY-MM-DD` of an epoch-seconds value, read as UTC. Absolute, so it never depends on the
 * viewer's own clock or time zone. */
export function formatEpochDate(epochSeconds: number | undefined): string {
  if (epochSeconds === undefined) return '';
  const d = new Date(epochSeconds * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** `YYYY-MM-DD HH:mm:ss` of an epoch-seconds value, read as UTC (PVE's `localtime` is the server's
 * wall clock expressed as such an epoch, so this renders it as the server shows it). */
export function formatEpochDateTime(epochSeconds: number | undefined): string {
  if (epochSeconds === undefined) return '';
  const d = new Date(epochSeconds * 1000);
  return `${formatEpochDate(epochSeconds)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export type ExpiryLevel = 'ok' | 'warning' | 'expired';

/** Fewer days than this left on a certificate shows an amber warning. */
export const EXPIRY_WARNING_DAYS = 30;

export interface Expiry {
  level: ExpiryLevel;
  text: string;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** "expires in N days" / "expired N days ago", with the level that picks the colour. `now` is
 * injectable for tests. */
export function certificateExpiry(notafter: number | undefined, now: number = Date.now()): Expiry | undefined {
  if (notafter === undefined) return undefined;
  const remaining = (notafter * 1000 - now) / DAY_MS;
  if (remaining < 0) {
    const ago = Math.floor(-remaining);
    return { level: 'expired', text: ago === 0 ? 'expired today' : `expired ${plural(ago, 'day')} ago` };
  }
  const days = Math.ceil(remaining);
  return {
    level: days < EXPIRY_WARNING_DAYS ? 'warning' : 'ok',
    text: days === 0 ? 'expires today' : `expires in ${plural(days, 'day')}`,
  };
}

const TIMEZONE_RE = /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+){0,2}$/;

const FALLBACK_ZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
];

/** The time zones the picker offers: the browser's list when it has one (`Intl.supportedValuesOf`),
 * else a short built-in list; always `UTC` and the node's current zone; only names the server's
 * pattern accepts. */
export function timeZoneOptions(current: string): string[] {
  let zones: string[] = FALLBACK_ZONES;
  try {
    if (typeof Intl.supportedValuesOf === 'function') {
      const supported = Intl.supportedValuesOf('timeZone');
      if (supported.length > 0) zones = supported;
    }
  } catch {
    zones = FALLBACK_ZONES;
  }
  const all = new Set(['UTC', ...zones, current]);
  return [...all].filter((zone) => zone === current || TIMEZONE_RE.test(zone)).sort((a, b) => a.localeCompare(b));
}
