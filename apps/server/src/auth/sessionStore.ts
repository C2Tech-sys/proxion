import { randomBytes } from 'node:crypto';
import type { PveClient } from '@proxion/pve-api';

/** 256 bits of entropy, base64url-encoded (43 chars, no padding) -- well above the 128-bit minimum for an unguessable session id. */
function generateId(): string {
  return randomBytes(32).toString('base64url');
}

/** Server-side session record, keyed by an opaque id carried in the signed `proxion.sid` cookie. */
export interface SessionData {
  sid: string;
  /** `user@realm`, as returned by PVE's ticket endpoint. */
  username: string;
  realm: string;
  ticket: string;
  csrfToken: string;
  capabilities: unknown;
  /** Cached client for this session's credentials -- never rebuild per request (see `pve/dispatcher.ts`). */
  pveClient: PveClient;
  createdAt: number;
  lastRenewedAt: number;
}

/** In-memory session store. No database: sessions are lost on restart, by design for this phase. */
export class SessionStore {
  private readonly sessions = new Map<string, SessionData>();

  create(data: Omit<SessionData, 'sid'>): SessionData {
    const sid = generateId();
    const session: SessionData = { ...data, sid };
    this.sessions.set(sid, session);
    return session;
  }

  get(sid: string): SessionData | undefined {
    return this.sessions.get(sid);
  }

  set(sid: string, session: SessionData): void {
    this.sessions.set(sid, session);
  }

  delete(sid: string): void {
    this.sessions.delete(sid);
  }

  get size(): number {
    return this.sessions.size;
  }

  values(): IterableIterator<SessionData> {
    return this.sessions.values();
  }
}
