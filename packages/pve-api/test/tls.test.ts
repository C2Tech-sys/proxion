import { createHash, X509Certificate } from 'node:crypto';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { generate } from 'selfsigned';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeFingerprint, fingerprintMatches, sha256Hex, createPinnedHttpsAgent } from '../src/tls.js';
import { PveTlsError } from '../src/errors.js';
import { PveHttp } from '../src/http.js';

const CERT_RAW = Buffer.from('a fake certificate, DER-encoded in spirit only', 'utf8');
const CERT_FINGERPRINT_HEX = createHash('sha256').update(CERT_RAW).digest('hex');
const CERT_FINGERPRINT_PVE = CERT_FINGERPRINT_HEX.match(/.{2}/g)!.join(':').toUpperCase();

describe('normalizeFingerprint', () => {
  it('accepts PVE-style AA:BB:... colon-separated uppercase hex', () => {
    expect(normalizeFingerprint(CERT_FINGERPRINT_PVE)).toBe(CERT_FINGERPRINT_HEX);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(normalizeFingerprint(`  ${CERT_FINGERPRINT_PVE.toLowerCase()}  `)).toBe(CERT_FINGERPRINT_HEX);
  });

  it('accepts a bare hex string with no colons', () => {
    expect(normalizeFingerprint(CERT_FINGERPRINT_HEX.toUpperCase())).toBe(CERT_FINGERPRINT_HEX);
  });

  it('rejects a malformed fingerprint', () => {
    expect(() => normalizeFingerprint('not-a-fingerprint')).toThrow(PveTlsError);
    expect(() => normalizeFingerprint('AA:BB')).toThrow(PveTlsError);
  });
});

describe('sha256Hex', () => {
  it('matches Node crypto for the same bytes', () => {
    expect(sha256Hex(CERT_RAW)).toBe(CERT_FINGERPRINT_HEX);
  });
});

describe('fingerprintMatches', () => {
  it('returns true when the cert bytes hash to the expected fingerprint', () => {
    expect(fingerprintMatches(CERT_FINGERPRINT_PVE, CERT_RAW)).toBe(true);
  });

  it('returns false for a different cert', () => {
    expect(fingerprintMatches(CERT_FINGERPRINT_PVE, Buffer.from('a different certificate'))).toBe(false);
  });
});

/**
 * End-to-end pinning tests against a real local HTTPS server with a generated
 * self-signed certificate. This is the only way to actually exercise the
 * post-handshake fingerprint check: a fake `PeerCertificate` object (as a
 * previous version of this test used) never proves that Node's TLS client
 * actually invokes our check for a self-signed cert -- and for a
 * `checkServerIdentity` callback, it turns out Node *never* calls it for a
 * self-signed cert, because that callback only runs once the chain of trust
 * already verified successfully (see `src/tls.ts` for why the connector-based
 * approach is used instead).
 */
describe('TLS fingerprint pinning (local self-signed HTTPS server)', () => {
  let server: https.Server;
  let port: number;
  let fingerprintHex: string;
  let fingerprintPve: string;
  let wrongFingerprintHex: string;
  let requestCount = 0;
  let pems: Awaited<ReturnType<typeof generate>>;

  beforeAll(async () => {
    pems = await generate([{ name: 'commonName', value: '127.0.0.1' }], {
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }],
    });

    // Derive the fingerprint independently of anything `src/tls.ts` does, from
    // the actual DER bytes of the certificate (same bytes `cert.raw` exposes
    // at TLS-handshake time), via Node's own X509Certificate.
    const x509 = new X509Certificate(pems.cert);
    fingerprintHex = createHash('sha256').update(x509.raw).digest('hex');
    fingerprintPve = fingerprintHex.match(/.{2}/g)!.join(':').toUpperCase();
    wrongFingerprintHex = fingerprintHex.startsWith('ff')
      ? `00${fingerprintHex.slice(2)}`
      : `ff${fingerprintHex.slice(2)}`;

    server = https.createServer({ key: pems.private, cert: pems.cert }, (_req, res) => {
      requestCount += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { version: '9.0' } }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  function makeHttp(tlsOptions?: { insecure?: boolean; fingerprint?: string }): PveHttp {
    return new PveHttp({
      baseUrl: `https://127.0.0.1:${port}`,
      credentials: { type: 'token', tokenId: 'root@pam!test', tokenSecret: 'secret' },
      ...(tlsOptions ? { tls: tlsOptions } : {}),
    });
  }

  it('accepts the connection when the fingerprint matches (colon-separated, mixed case)', async () => {
    requestCount = 0;
    const http = makeHttp({ fingerprint: fingerprintPve });
    await expect(http.request('GET', '/version', {})).resolves.toEqual({ version: '9.0' });
    expect(requestCount).toBe(1);
  });

  it('rejects with PveTlsError on a fingerprint mismatch, and the server never saw the request', async () => {
    requestCount = 0;
    const http = makeHttp({ fingerprint: wrongFingerprintHex });
    await expect(http.request('GET', '/version', {})).rejects.toBeInstanceOf(PveTlsError);
    expect(requestCount).toBe(0);
  });

  it('accepts any certificate with `insecure: true`', async () => {
    requestCount = 0;
    const http = makeHttp({ insecure: true });
    await expect(http.request('GET', '/version', {})).resolves.toEqual({ version: '9.0' });
    expect(requestCount).toBe(1);
  });

  it('rejects with a chain-of-trust error when no tls options are given', async () => {
    requestCount = 0;
    const http = makeHttp();
    await expect(http.request('GET', '/version', {})).rejects.toThrow();
    expect(requestCount).toBe(0);
  });

  it('createPinnedHttpsAgent accepts a matching fingerprint over node:https', async () => {
    requestCount = 0;
    const agent = createPinnedHttpsAgent(fingerprintPve);
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = https.request(
          { hostname: '127.0.0.1', port, path: '/api2/json/version', method: 'GET', agent },
          (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => {
              data += chunk.toString('utf8');
            });
            res.on('end', () => resolve(data));
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(JSON.parse(body)).toEqual({ data: { version: '9.0' } });
      expect(requestCount).toBe(1);
    } finally {
      agent.destroy();
    }
  });

  /**
   * Regression: Node reports an empty peer certificate on a *resumed* TLS 1.3 session, so a
   * second connection that resumed the first one's session used to fail the pin check with
   * "got no certificate" (seen in production as intermittent 502s on ordinary requests).
   * Pinned transports must therefore never resume sessions: every connection performs a
   * full handshake and presents the certificate. A `Connection: close` server forces each
   * request onto a fresh TCP connection, which is where resumption would kick in.
   */
  describe('does not resume TLS sessions (every connection presents the certificate)', () => {
    let closingServer: https.Server;
    let closingPort: number;
    let handshakes: { reused: boolean }[] = [];

    beforeAll(async () => {
      closingServer = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
        handshakes.push({ reused: (req.socket as import('node:tls').TLSSocket).isSessionReused() });
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ data: { version: '9.0' } }));
      });
      await new Promise<void>((resolve) => closingServer.listen(0, '127.0.0.1', resolve));
      closingPort = (closingServer.address() as AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) => {
        closingServer.close((err) => (err ? reject(err) : resolve()));
      });
    });

    it('PveHttp (undici connector): three sequential requests on fresh connections all pass the pin check', async () => {
      handshakes = [];
      const http = new PveHttp({
        baseUrl: `https://127.0.0.1:${closingPort}`,
        credentials: { type: 'token', tokenId: 'root@pam!test', tokenSecret: 'secret' },
        tls: { fingerprint: fingerprintPve },
      });
      for (let i = 0; i < 3; i++) {
        await expect(http.request('GET', '/version', {})).resolves.toEqual({ version: '9.0' });
      }
      expect(handshakes).toHaveLength(3);
      expect(handshakes.map((h) => h.reused)).toEqual([false, false, false]);
    });

    it('createPinnedHttpsAgent (node:https): three sequential requests on fresh connections all pass the pin check', async () => {
      handshakes = [];
      const agent = createPinnedHttpsAgent(fingerprintPve);
      try {
        for (let i = 0; i < 3; i++) {
          const body = await new Promise<string>((resolve, reject) => {
            const req = https.request(
              { hostname: '127.0.0.1', port: closingPort, path: '/api2/json/version', method: 'GET', agent },
              (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => {
                  data += chunk.toString('utf8');
                });
                res.on('end', () => resolve(data));
              },
            );
            req.on('error', reject);
            req.end();
          });
          expect(JSON.parse(body)).toEqual({ data: { version: '9.0' } });
        }
        expect(handshakes).toHaveLength(3);
        expect(handshakes.map((h) => h.reused)).toEqual([false, false, false]);
      } finally {
        agent.destroy();
      }
    });
  });

  it('createPinnedHttpsAgent rejects a mismatched fingerprint over node:https', async () => {
    requestCount = 0;
    const agent = createPinnedHttpsAgent(wrongFingerprintHex);
    try {
      await expect(
        new Promise<void>((resolve, reject) => {
          const req = https.request(
            { hostname: '127.0.0.1', port, path: '/api2/json/version', method: 'GET', agent },
            () => resolve(),
          );
          req.on('error', reject);
          req.end();
        }),
      ).rejects.toBeInstanceOf(PveTlsError);
      expect(requestCount).toBe(0);
    } finally {
      agent.destroy();
    }
  });
});
