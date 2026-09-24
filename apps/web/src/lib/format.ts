const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

/** Formats a byte count using binary (1024) units, e.g. `1536` -> `"1.5 KiB"`. */
export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  const unit = BYTE_UNITS[exponent] ?? 'B';
  return `${value.toFixed(exponent === 0 ? 0 : digits)} ${unit}`;
}

/** Binary (1024-based) multiplier for each suffix a PVE size string can end in. */
const PVE_SIZE_SUFFIX_MULTIPLIER: Record<string, number> = {
  '': 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};

/**
 * Parses a PVE config `size=` value (e.g. a disk/EFI-disk/TPM-state drive's size, as found in
 * `scsiN`/`efidiskN`/`tpmstateN`, ... -- see `lib/pve-config.ts`'s `ParsedDrive.size`) into a
 * byte count. These are decimal numbers with an optional single-letter binary-unit suffix
 * (`K`/`M`/`G`/`T`, case-insensitive; no suffix means bytes) -- e.g. `"32G"`, `"512M"`,
 * `"4194304"`. Returns `null` for `undefined` or anything that doesn't match that shape, so a
 * caller can fall back to showing the raw string (or `-`) instead of a wrong number.
 */
export function parsePveSize(raw: string | undefined): number | null {
  if (!raw) return null;
  const match = /^(\d+(?:\.\d+)?)\s*([KMGT])?$/i.exec(raw.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const multiplier = PVE_SIZE_SUFFIX_MULTIPLIER[(match[2] ?? '').toUpperCase()];
  return multiplier === undefined ? null : value * multiplier;
}

/**
 * Formats a PVE drive's `size=` value the same way every other byte count in the UI reads
 * (`formatBytes`), e.g. `"32G"` -> `"32.0 GiB"`, instead of printing PVE's raw config-file
 * suffix. Falls back to the raw string for a shape `parsePveSize` doesn't recognize (better
 * than silently showing nothing), and `-` when there's no size at all.
 */
export function formatDriveSize(raw: string | undefined): string {
  if (!raw) return '-';
  const bytes = parsePveSize(raw);
  return bytes === null ? raw : formatBytes(bytes);
}

/** Formats a byte-rate as a per-second throughput, e.g. `"4.2 MiB/s"`. */
export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** Formats an uptime in seconds as a compact duration, e.g. `"3d 04:12:09"` or `"00:04:12"`. */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '-';
  const totalSeconds = Math.floor(seconds);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  return days > 0 ? `${days}d ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
}

/** Formats a 0..1 fraction as a percentage string, e.g. `0.5123` -> `"51%"`. */
export function formatPercent(fraction: number, digits = 0): string {
  if (!Number.isFinite(fraction)) return '-';
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Formats a unix timestamp (seconds) as a short local date+time string. */
export function formatDateTime(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return '-';
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Formats a duration in seconds as a short human string, escalating units so it never
 * shows an awkwardly large minute count: <60s -> "12s", <1h -> "4m 12s", <24h -> "14h 1m",
 * >=24h -> "2d 3h".
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '-';
  const total = Math.round(seconds);

  if (total < 60) return `${total}s`;

  if (total < 3600) {
    const minutes = Math.floor(total / 60);
    const secs = total % 60;
    return `${minutes}m ${secs}s`;
  }

  if (total < 86400) {
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }

  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  return `${days}d ${hours}h`;
}

/** Formats a used/total byte pair for a gauge detail line, e.g. `"1.2 GiB / 4.0 GiB"`. */
export function formatMemDetail(used: number, total: number): string {
  return `${formatBytes(used)} / ${formatBytes(total)}`;
}

/** Splits a PVE semicolon-joined tag string into a clean array, e.g. `"prod;web"` -> `["prod", "web"]`. */
export function parseTags(tags: string | undefined): string[] {
  if (!tags) return [];
  return tags
    .split(';')
    .map((t) => t.trim())
    .filter(Boolean);
}
