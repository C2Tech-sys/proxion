import { describe, expect, it } from 'vitest';
import type { PveClient } from '@proxion/pve-api';
import { SessionStore } from '../src/auth/sessionStore.js';
import { ConsoleTicketStore } from '../src/console/ticketStore.js';

// base64url alphabet only (no padding): A-Z a-z 0-9 - _
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * `randomBytes(32).toString('base64url')` is 256 bits of entropy encoded as
 * 43 base64url characters (32 bytes * 8 bits / 6 bits-per-char, rounded up,
 * no `=` padding). This is well above the >=128-bit floor a session/console
 * handle id must clear to be unguessable; a v4 UUID, by contrast, only has
 * 122 random bits.
 */
const MIN_LENGTH = 43;
const MIN_BITS = 128;

function dummyPveClient(): PveClient {
  return {} as unknown as PveClient;
}

describe('session id entropy (SessionStore)', () => {
  it('ids are base64url, at least 43 chars (>=256 random bits, well over the 128-bit floor)', () => {
    const store = new SessionStore();
    const session = store.create({
      username: 'root@pam',
      realm: 'pam',
      ticket: 't',
      csrfToken: 'c',
      capabilities: {},
      pveClient: dummyPveClient(),
      createdAt: Date.now(),
      lastRenewedAt: Date.now(),
    });

    expect(session.sid.length).toBeGreaterThanOrEqual(MIN_LENGTH);
    expect(session.sid).toMatch(BASE64URL_RE);
    // 6 bits per base64 char is the theoretical ceiling; assert we're not
    // silently down at something like a 122-bit UUID's ~22-char encoding.
    expect(session.sid.length * 6).toBeGreaterThanOrEqual(MIN_BITS);
  });

  it('1000 draws are all unique', () => {
    const store = new SessionStore();
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const session = store.create({
        username: 'root@pam',
        realm: 'pam',
        ticket: 't',
        csrfToken: 'c',
        capabilities: {},
        pveClient: dummyPveClient(),
        createdAt: Date.now(),
        lastRenewedAt: Date.now(),
      });
      ids.add(session.sid);
    }
    expect(ids.size).toBe(1000);
  });
});

describe('console handle id entropy (ConsoleTicketStore)', () => {
  it('ids are base64url, at least 43 chars (>=256 random bits, well over the 128-bit floor)', () => {
    const store = new ConsoleTicketStore();
    const id = store.create({
      kind: 'vnc',
      node: 'pve',
      type: 'qemu',
      vmid: 100,
      port: 5900,
      vncticket: 'VNCTICKET',
      credentials: { type: 'token', tokenId: 'root@pam!proxion', tokenSecret: 'secret' },
    });

    expect(id.length).toBeGreaterThanOrEqual(MIN_LENGTH);
    expect(id).toMatch(BASE64URL_RE);
    expect(id.length * 6).toBeGreaterThanOrEqual(MIN_BITS);
  });

  it('1000 draws are all unique', () => {
    const store = new ConsoleTicketStore();
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      ids.add(
        store.create({
          kind: 'vnc',
          node: 'pve',
          type: 'qemu',
          vmid: 100,
          port: 5900,
          vncticket: 'VNCTICKET',
          credentials: { type: 'token', tokenId: 'root@pam!proxion', tokenSecret: 'secret' },
        }),
      );
    }
    expect(ids.size).toBe(1000);
  });
});
