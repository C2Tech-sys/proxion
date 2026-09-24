/**
 * Fixture-mode console "screenshots": deterministic SVG data URIs standing in for a real
 * `GET /api/console/thumbnail/:node/:type/:vmid.png` capture, so the demo has something
 * plausible to show for every running guest without a server or any real screenshot asset.
 * No external images -- everything here is generated markup.
 */

const MONO_FONT_STACK =
  "ui-monospace, SFMono-Regular, 'Cascadia Code', Menlo, Consolas, 'Liberation Mono', monospace";

export interface ThumbnailFixtureGuest {
  vmid: number;
  /** Guest name/hostname, used to vary the generated boot/login text. */
  name?: string | undefined;
  /** PVE `ostype` (e.g. `l26`, `win11`, `debian`); `win*` renders the Windows lock screen. */
  ostype?: string | undefined;
  status: string;
  template?: boolean | undefined;
}

/** A small stable hash of the vmid (plus a salt) used to deterministically pick text/positions. */
function seed(vmid: number, salt: number): number {
  return Math.abs((vmid * 2654435761 + salt * 40503) % 2147483647);
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toDataUri(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const LINUX_DISTROS = ['Debian GNU/Linux 12', 'Ubuntu 24.04.1 LTS', 'Arch Linux'] as const;

/** A black 800x600 "tty" with a few boot/login lines and a blinking-cursor rectangle. */
function linuxTtyDataUri(guest: ThumbnailFixtureGuest): string {
  const hostname = (guest.name ?? `vm${guest.vmid}`).toLowerCase();
  const distro = LINUX_DISTROS[seed(guest.vmid, 1) % LINUX_DISTROS.length]!;
  const uptimeMinutes = 1 + (seed(guest.vmid, 2) % 9000);
  const lines = [
    `${distro} ${hostname} tty1`,
    '',
    `${hostname} login: root`,
    'Password: ',
    '',
    `Last login: up ${uptimeMinutes} min from 10.0.0.4`,
    `root@${hostname}:~# _`,
  ];
  const startY = 64;
  const lineHeight = 26;
  const textEls = lines
    .map(
      (line, i) =>
        `<text x="24" y="${startY + i * lineHeight}" fill="#c9c9c9" font-family="${MONO_FONT_STACK}" font-size="18">${escapeXml(line)}</text>`,
    )
    .join('');
  const cursorY = startY + (lines.length - 1) * lineHeight - 15;
  const cursorX = 24 + `root@${hostname}:~# `.length * 10.8;
  const cursor = `<rect x="${cursorX.toFixed(1)}" y="${cursorY}" width="10" height="18" fill="#c9c9c9"><animate attributeName="opacity" values="1;1;0;0;1" keyTimes="0;0.45;0.5;0.95;1" dur="1.2s" repeatCount="indefinite"/></rect>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect width="800" height="600" fill="#0a0a0a"/>${textEls}${cursor}</svg>`;
  return toDataUri(svg);
}

/** A solid blue Windows-style lock screen with a fixture clock and the Ctrl+Alt+Del hint. */
function windowsLockScreenDataUri(guest: ThumbnailFixtureGuest): string {
  const hour = seed(guest.vmid, 3) % 12 || 12;
  const minute = seed(guest.vmid, 4) % 60;
  const time = `${hour}:${String(minute).padStart(2, '0')}`;
  const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
    seed(guest.vmid, 5) % 7
  ]!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
    <rect width="800" height="600" fill="#0078d4"/>
    <text x="48" y="200" fill="#ffffff" font-family="Segoe UI, ${MONO_FONT_STACK}" font-size="96" font-weight="200">${escapeXml(time)}</text>
    <text x="48" y="240" fill="#ffffff" font-family="Segoe UI, ${MONO_FONT_STACK}" font-size="24" font-weight="400">${escapeXml(day)}</text>
    <circle cx="400" cy="420" r="28" fill="none" stroke="#ffffff" stroke-width="4"/>
    <rect x="386" y="416" width="28" height="22" rx="3" fill="none" stroke="#ffffff" stroke-width="4"/>
    <text x="400" y="500" fill="#ffffff" font-family="Segoe UI, ${MONO_FONT_STACK}" font-size="16" text-anchor="middle">Press Ctrl+Alt+Del to unlock</text>
  </svg>`;
  return toDataUri(svg);
}

/** The stopped/template placeholder: a near-black screen with a power glyph. Used for the rare
 * case something asks this generator for a guest that isn't running. */
function poweredOffDataUri(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
    <rect width="800" height="600" fill="#050505"/>
    <circle cx="400" cy="270" r="34" fill="none" stroke="#52525b" stroke-width="6"/>
    <line x1="400" y1="230" x2="400" y2="270" stroke="#52525b" stroke-width="6" stroke-linecap="round"/>
    <text x="400" y="350" fill="#52525b" font-family="${MONO_FONT_STACK}" font-size="20" text-anchor="middle">Powered off</text>
  </svg>`;
  return toDataUri(svg);
}

function isWindows(ostype: string | undefined): boolean {
  return ostype !== undefined && ostype.toLowerCase().startsWith('win');
}

/**
 * Deterministic fixture "screenshot" for a guest: same input always produces the same data
 * URI. Linux guests render a tty login prompt, Windows guests (`ostype` starting with `win`)
 * a lock screen, and anything not running (or a template) the "Powered off" placeholder.
 */
export function generateThumbnailPlaceholder(guest: ThumbnailFixtureGuest): string {
  if (guest.status !== 'running' || guest.template) return poweredOffDataUri();
  return isWindows(guest.ostype) ? windowsLockScreenDataUri(guest) : linuxTtyDataUri(guest);
}
