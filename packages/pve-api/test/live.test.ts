// Opt-in smoke test against a real Proxmox VE host. Skips cleanly unless the
// environment is configured -- this repo ships no `.env`, so by default this
// entire suite is skipped and never contacts a Proxmox host.
//
// To run it:
//   PVE_URL=https://pve.example.com:8006 \
//   PVE_TOKEN_ID='root@pam!proxion' \
//   PVE_TOKEN_SECRET='...' \
//   [PVE_TLS_INSECURE=1] [PVE_TLS_FINGERPRINT='AA:BB:...'] \
//   pnpm --filter @proxion/pve-api test -- live.test.ts
import { describe, it, expect } from 'vitest';
import { PveClient, PveHttp } from '../src/index.js';

const PVE_URL = process.env.PVE_URL;
const PVE_TOKEN_ID = process.env.PVE_TOKEN_ID;
const PVE_TOKEN_SECRET = process.env.PVE_TOKEN_SECRET;

const isConfigured = Boolean(PVE_URL && PVE_TOKEN_ID && PVE_TOKEN_SECRET);

describe('live Proxmox VE smoke test', () => {
  function makeClient(): PveClient {
    const insecure =
      process.env.PVE_TLS_INSECURE === '1' || process.env.PVE_TLS_INSECURE === 'true';
    const fingerprint = process.env.PVE_TLS_FINGERPRINT;

    const http = new PveHttp({
      baseUrl: PVE_URL as string,
      credentials: {
        type: 'token',
        tokenId: PVE_TOKEN_ID as string,
        tokenSecret: PVE_TOKEN_SECRET as string,
      },
      ...(insecure || fingerprint
        ? { tls: { ...(insecure ? { insecure } : {}), ...(fingerprint ? { fingerprint } : {}) } }
        : {}),
    });
    return new PveClient(http);
  }

  it.skipIf(!isConfigured)('GET /version returns version details', async () => {
    const client = makeClient();
    const version = await client.get('/version');
    expect(typeof version.version).toBe('string');
  });

  it.skipIf(!isConfigured)('GET /cluster/resources returns an array', async () => {
    const client = makeClient();
    const resources = await client.get('/cluster/resources');
    expect(Array.isArray(resources)).toBe(true);
  });

  it.skipIf(!isConfigured)('GET /cluster/tasks returns a task list', async () => {
    const client = makeClient();
    const tasks = await client.get('/cluster/tasks');
    expect(Array.isArray(tasks)).toBe(true);
  });
});
