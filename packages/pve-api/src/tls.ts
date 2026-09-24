import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import * as https from 'node:https';
import * as tls from 'node:tls';
import type { Socket } from 'node:net';
import { Agent, buildConnector } from 'undici';
import { PveTlsError } from './errors.js';

/** TLS options accepted by `PveHttp`. */
export interface PveTlsOptions {
  /** Skip all certificate validation (hostname + chain of trust). Dangerous. */
  insecure?: boolean;
  /**
   * Pin the connection to a certificate by its SHA-256 fingerprint, in Proxmox
   * VE's `AA:BB:CC:...` colon-separated hex form (case-insensitive). When set,
   * the certificate's chain of trust and hostname are not checked -- only the
   * fingerprint must match, verified against the actual TLS peer certificate
   * *after* the handshake (see `createFingerprintConnector`/
   * `createPinnedHttpsAgent`), independent of whether Node's own chain
   * verification passed or failed.
   */
  fingerprint?: string;
}

/** Normalize a PVE-style `AA:BB:...` SHA-256 fingerprint to lowercase hex, no colons. */
export function normalizeFingerprint(fingerprint: string): string {
  const cleaned = fingerprint.trim().replace(/:/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(cleaned)) {
    throw new PveTlsError(
      `Invalid TLS fingerprint "${fingerprint}": expected 32 hex byte pairs (SHA-256), optionally colon-separated`,
    );
  }
  return cleaned;
}

/** SHA-256 hex digest of a DER-encoded certificate (`cert.raw`). */
export function sha256Hex(certRaw: Uint8Array): string {
  return createHash('sha256').update(certRaw).digest('hex');
}

/** Compare a (possibly colon-separated, mixed-case) expected fingerprint against a cert. */
export function fingerprintMatches(expectedFingerprint: string, certRaw: Uint8Array): boolean {
  return sha256Hex(certRaw) === normalizeFingerprint(expectedFingerprint);
}

function isTlsSocket(socket: Socket | tls.TLSSocket): socket is tls.TLSSocket {
  return typeof (socket as tls.TLSSocket).getPeerCertificate === 'function';
}

/** Extract the DER bytes of the peer certificate from a connected TLS socket, if any. */
function peerCertificateRaw(socket: Socket | tls.TLSSocket): Buffer | undefined {
  if (!isTlsSocket(socket)) return undefined;
  const cert = socket.getPeerCertificate(true);
  if (!cert || !cert.raw || cert.raw.length === 0) return undefined;
  return cert.raw;
}

function fingerprintMismatchError(hostname: string, expected: string, certRaw: Buffer | undefined): PveTlsError {
  const actual = certRaw ? sha256Hex(certRaw) : 'no certificate';
  return new PveTlsError(`TLS fingerprint mismatch for ${hostname}: expected ${expected}, got ${actual}`);
}

/**
 * Build a custom undici connector that completes the TCP+TLS handshake with
 * `rejectUnauthorized: false` (PVE's default cert is self-signed, so chain-of-
 * trust verification would always fail), then independently pins the
 * connection by comparing the SHA-256 of the peer certificate's DER bytes to
 * `expectedFingerprint` (already normalized: lowercase hex, no colons).
 *
 * This check runs *after* the handshake regardless of Node's own chain
 * verification outcome -- unlike a `checkServerIdentity` override, which Node
 * only invokes when the chain already verified successfully, and therefore
 * never fires for a self-signed certificate.
 */
export function createFingerprintConnector(expectedFingerprint: string): buildConnector.connector {
  // `maxCachedSessions: 0`: never resume a TLS session. Node reports an empty peer
  // certificate on a resumed TLS 1.3 session, so a resumed connection could not be
  // pinned; with caching off every connection performs a full handshake and presents
  // the certificate. Connections are pooled (keep-alive), so handshakes stay rare.
  const connect = buildConnector({ rejectUnauthorized: false, maxCachedSessions: 0 });

  return (options, callback) => {
    connect(options, (err, socket) => {
      if (err || !socket) {
        callback(err ?? new PveTlsError('TLS connector returned no socket'), null);
        return;
      }

      const certRaw = peerCertificateRaw(socket);
      if (!certRaw || !fingerprintMatches(expectedFingerprint, certRaw)) {
        const mismatch = fingerprintMismatchError(options.hostname, expectedFingerprint, certRaw);
        socket.destroy();
        callback(mismatch, null);
        return;
      }

      callback(null, socket);
    });
  };
}

/**
 * Build an undici `Agent` implementing `tls` options for a `PveHttp` client,
 * or `undefined` when the defaults (verify hostname + chain of trust) apply.
 */
export function createTlsAgent(options: PveTlsOptions | undefined): Agent | undefined {
  if (!options || (!options.insecure && !options.fingerprint)) return undefined;

  if (options.fingerprint) {
    const expected = normalizeFingerprint(options.fingerprint);
    return new Agent({ connect: createFingerprintConnector(expected) });
  }

  // `insecure` with no fingerprint: skip all verification.
  return new Agent({ connect: { rejectUnauthorized: false } });
}

/**
 * An `https.Agent` that pins connections by SHA-256 certificate fingerprint,
 * for callers that can't use undici's dispatcher (e.g. the `ws` library,
 * which drives its own `node:https`/`node:tls` connections for a websocket
 * bridge). Same pinning semantics as `createFingerprintConnector`: the
 * handshake completes with `rejectUnauthorized: false`, then the peer
 * certificate is checked against `fingerprint` and the socket is destroyed
 * with a `PveTlsError` on mismatch.
 */
export function createPinnedHttpsAgent(fingerprint: string, options: https.AgentOptions = {}): https.Agent {
  const expected = normalizeFingerprint(fingerprint);

  class PinnedHttpsAgent extends https.Agent {
    override createConnection(connectOptions: https.RequestOptions): Duplex {
      // Dialled directly (not via the base class), so `https.Agent`'s session cache is
      // never consulted and no session is resumed -- same rationale as the connector
      // above; the regression test in test/tls.test.ts guards both paths.
      const socket = tls.connect({
        ...(connectOptions as tls.ConnectionOptions),
        rejectUnauthorized: false,
      });

      socket.once('secureConnect', () => {
        const certRaw = peerCertificateRaw(socket);
        if (!certRaw || !fingerprintMatches(expected, certRaw)) {
          const hostname = String(connectOptions.host ?? connectOptions.hostname ?? '');
          socket.destroy(fingerprintMismatchError(hostname, expected, certRaw));
        }
      });

      return socket;
    }
  }

  return new PinnedHttpsAgent(options);
}
