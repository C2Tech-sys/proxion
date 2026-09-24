import { randomBytes } from 'node:crypto';
import type { Credentials } from '@proxion/pve-api';

const TTL_MS = 60_000;

/** 256 bits of entropy, base64url-encoded (43 chars, no padding) -- well above the 128-bit minimum for an unguessable handle id. */
function generateId(): string {
  return randomBytes(32).toString('base64url');
}

interface PendingConsoleBase {
  node: string;
  port: number;
  /** PVE's `vncproxy`/`termproxy` ticket -- the `vncticket` query param, and (for VNC) the RFB auth password. */
  vncticket: string;
  credentials: Credentials;
  expiresAt: number;
}

export type PendingConsole =
  | (PendingConsoleBase & { kind: 'vnc'; type: 'qemu' | 'lxc'; vmid: number })
  | (PendingConsoleBase & { kind: 'term'; type: 'qemu' | 'lxc'; vmid: number; user: string })
  | (PendingConsoleBase & { kind: 'term'; type: 'node'; user: string });

/** `Omit`, but distributed over each member of a union (plain `Omit` of a union collapses it to shared keys only). */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/**
 * Opaque, single-use, short-lived (60s) handles that map a browser-facing
 * `/ws/vnc/<id>` or `/ws/term/<id>` path to the upstream PVE console details
 * (node/type/vmid/port/ticket/credentials) -- so the PVE ticket itself never
 * reaches the browser.
 */
export class ConsoleTicketStore {
  private readonly entries = new Map<string, PendingConsole>();

  create(data: DistributiveOmit<PendingConsole, 'expiresAt'>): string {
    const id = generateId();
    const entry = { ...data, expiresAt: Date.now() + TTL_MS } as PendingConsole;
    this.entries.set(id, entry);
    return id;
  }

  /** Single-use: consuming an id removes it, whether or not it was still valid. */
  consume(id: string): PendingConsole | undefined {
    const entry = this.entries.get(id);
    this.entries.delete(id);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) return undefined;
    return entry;
  }

  get size(): number {
    return this.entries.size;
  }
}
