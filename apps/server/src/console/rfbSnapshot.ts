import type WebSocket from 'ws';
import type { RawData } from 'ws';
import { vncAuthResponse } from './des.js';

/** A captured, decoded RGBA framebuffer (top-left origin, row-major, 4 bytes/pixel). */
export interface RfbFrame {
  width: number;
  height: number;
  /** RGBA8888, `width * height * 4` bytes. */
  data: Buffer;
}

export interface CaptureOptions {
  /** How long to wait for `FramebufferUpdate` rects to arrive before giving up on the rest. Default 6000ms. */
  updateTimeoutMs?: number;
  /** Fraction of the framebuffer's pixels that must have arrived by the timeout to accept a partial frame. Default 0.9. */
  minCoverage?: number;
}

/** Thrown for any handshake/protocol/timeout failure -- callers map this to a `503`. */
export class RfbCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RfbCaptureError';
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/**
 * Turns a websocket's `message` events into an ordered byte stream a
 * protocol implementation can `read(n)` from -- binary VNC frames don't
 * necessarily arrive one-per-websocket-message, so incoming bytes are
 * buffered and handed out only once enough have accumulated. Only one
 * `read()` may be outstanding at a time (true for this sequential protocol).
 */
class ByteReader {
  private buf: Buffer = Buffer.alloc(0);
  private waiter: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | undefined;
  private closeError: Error | undefined;

  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    this.tryResolve();
  }

  /** Marks the stream ended (upstream closed/errored). Any read already waiting rejects immediately; later reads reject too, unless already-buffered bytes satisfy them. */
  close(err: Error): void {
    if (!this.closeError) this.closeError = err;
    if (this.waiter && this.buf.length < this.waiter.n) {
      const { reject } = this.waiter;
      this.waiter = undefined;
      reject(err);
    }
  }

  private tryResolve(): void {
    if (!this.waiter || this.buf.length < this.waiter.n) return;
    const { n, resolve } = this.waiter;
    this.waiter = undefined;
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    resolve(Buffer.from(out));
  }

  /** Bytes already buffered, without consuming them -- used to check framebuffer coverage without blocking. */
  get bufferedLength(): number {
    return this.buf.length;
  }

  read(n: number): Promise<Buffer> {
    if (this.buf.length >= n) {
      const out = this.buf.subarray(0, n);
      this.buf = this.buf.subarray(n);
      return Promise.resolve(Buffer.from(out));
    }
    if (this.closeError) return Promise.reject(this.closeError);
    return new Promise((resolve, reject) => {
      this.waiter = { n, resolve, reject };
    });
  }
}

const TIMED_OUT = Symbol('rfb-read-timeout');

/** Races a read against a deadline without leaking an unhandled rejection if the read later settles after we've moved on. */
function readWithDeadline(
  reader: ByteReader,
  n: number,
  deadlineAt: number,
): Promise<Buffer | typeof TIMED_OUT> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return Promise.resolve(TIMED_OUT);
  const readPromise = reader.read(n);
  readPromise.catch(() => {
    /* handled via the race below; swallow so an abandoned read never surfaces as unhandled. */
  });
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), remaining);
    readPromise.then(
      (buf) => {
        clearTimeout(timer);
        resolve(buf);
      },
      () => {
        clearTimeout(timer);
        resolve(TIMED_OUT);
      },
    );
  });
}

async function readExact(reader: ByteReader, n: number): Promise<Buffer> {
  try {
    return await reader.read(n);
  } catch (err) {
    throw new RfbCaptureError(`RFB stream ended: ${(err as Error).message}`);
  }
}

const SECURITY_TYPE_VNC_AUTH = 2;
const ENCODING_RAW = 0;

/**
 * Drives a minimal RFB 3.8 client handshake over an already-connecting
 * upstream websocket (binary frames = raw RFB bytes, per PVE's
 * `vncwebsocket`), authenticates with `password` (PVE's own vncticket, per
 * VNC Authentication), requests one full-framebuffer update in Raw
 * encoding, and returns the decoded RGBA frame. Always closes `ws` before
 * returning (success or failure) -- this is a one-shot capture, not a live
 * session.
 */
export async function captureRfbFrame(
  ws: WebSocket,
  password: string,
  options: CaptureOptions = {},
): Promise<RfbFrame> {
  const updateTimeoutMs = options.updateTimeoutMs ?? 6000;
  const minCoverage = options.minCoverage ?? 0.9;

  const reader = new ByteReader();
  const onMessage = (data: RawData) => reader.push(toBuffer(data));
  const onEnd = (err: Error) => reader.close(err);
  const onClose = () => onEnd(new Error('upstream connection closed'));
  const onError = (err: Error) => onEnd(err);

  ws.on('message', onMessage);
  ws.on('close', onClose);
  ws.on('error', onError);

  try {
    await waitForOpen(ws);
    return await runProtocol(ws, reader, password, updateTimeoutMs, minCoverage);
  } finally {
    ws.off('message', onMessage);
    ws.off('close', onClose);
    ws.off('error', onError);
    try {
      ws.terminate();
    } catch {
      /* already closed */
    }
  }
}

function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === ws.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onErr = (err: Error) => {
      cleanup();
      reject(new RfbCaptureError(`upstream socket failed to open: ${err.message}`));
    };
    const onCloseBeforeOpen = () => {
      cleanup();
      reject(new RfbCaptureError('upstream socket closed before opening'));
    };
    function cleanup() {
      ws.off('open', onOpen);
      ws.off('error', onErr);
      ws.off('close', onCloseBeforeOpen);
    }
    ws.on('open', onOpen);
    ws.on('error', onErr);
    ws.on('close', onCloseBeforeOpen);
  });
}

async function runProtocol(
  ws: WebSocket,
  reader: ByteReader,
  password: string,
  updateTimeoutMs: number,
  minCoverage: number,
): Promise<RfbFrame> {
  // --- ProtocolVersion handshake ---
  const serverVersion = await readExact(reader, 12);
  if (!/^RFB 0\d\d\.0\d\d\n$/.test(serverVersion.toString('latin1'))) {
    throw new RfbCaptureError('unexpected RFB version handshake from server');
  }
  ws.send(Buffer.from('RFB 003.008\n', 'ascii'));

  // --- Security handshake: pick VNC Authentication (type 2) ---
  const numTypes = (await readExact(reader, 1)).readUInt8(0);
  if (numTypes === 0) {
    // Server sends a u32 length + reason string instead of any security types.
    const reasonLen = (await readExact(reader, 4)).readUInt32BE(0);
    const reason = (await readExact(reader, reasonLen)).toString('utf8');
    throw new RfbCaptureError(`server refused connection: ${reason}`);
  }
  const types = await readExact(reader, numTypes);
  if (!types.includes(SECURITY_TYPE_VNC_AUTH)) {
    throw new RfbCaptureError(
      `server does not offer VNC Authentication (offered: ${Array.from(types).join(',')})`,
    );
  }
  ws.send(Buffer.from([SECURITY_TYPE_VNC_AUTH]));

  // --- VNC Authentication ---
  const challenge = await readExact(reader, 16);
  const response = vncAuthResponse(password, challenge);
  ws.send(response);

  const securityResult = (await readExact(reader, 4)).readUInt32BE(0);
  if (securityResult !== 0) {
    // RFB 3.8: a failure reason string follows (u32 length + text).
    let reason = 'authentication failed';
    try {
      const reasonLen = (await readExact(reader, 4)).readUInt32BE(0);
      reason = (await readExact(reader, reasonLen)).toString('utf8');
    } catch {
      /* some servers omit the reason; keep the generic message */
    }
    throw new RfbCaptureError(`VNC authentication failed: ${reason}`);
  }

  // --- ClientInit / ServerInit ---
  ws.send(Buffer.from([1])); // shared-flag = 1 (don't disconnect other clients)

  const serverInitHeader = await readExact(reader, 24);
  const width = serverInitHeader.readUInt16BE(0);
  const height = serverInitHeader.readUInt16BE(2);
  // Bytes 4..19 are PIXEL_FORMAT (unused -- we override it below); bytes 20..23 are the name length.
  const nameLength = serverInitHeader.readUInt32BE(20);
  if (nameLength > 0) await readExact(reader, nameLength); // discard the server/desktop name

  if (width === 0 || height === 0) {
    throw new RfbCaptureError(`server reported an empty framebuffer (${width}x${height})`);
  }

  // --- SetPixelFormat: 32bpp, depth 24, big-endian, true-colour, 8-bit R/G/B at byte offsets 2/1/0 ---
  const setPixelFormat = Buffer.alloc(20);
  setPixelFormat.writeUInt8(0, 0); // message type
  // bytes 1-3 padding (already zero)
  setPixelFormat.writeUInt8(32, 4); // bits-per-pixel
  setPixelFormat.writeUInt8(24, 5); // depth
  setPixelFormat.writeUInt8(0, 6); // big-endian-flag
  setPixelFormat.writeUInt8(1, 7); // true-colour-flag
  setPixelFormat.writeUInt16BE(255, 8); // red-max
  setPixelFormat.writeUInt16BE(255, 10); // green-max
  setPixelFormat.writeUInt16BE(255, 12); // blue-max
  setPixelFormat.writeUInt8(16, 14); // red-shift
  setPixelFormat.writeUInt8(8, 15); // green-shift
  setPixelFormat.writeUInt8(0, 16); // blue-shift
  // bytes 17-19 padding (already zero)
  ws.send(setPixelFormat);

  // --- SetEncodings: Raw only ---
  const setEncodings = Buffer.alloc(4 + 4);
  setEncodings.writeUInt8(2, 0); // message type
  setEncodings.writeUInt8(0, 1); // padding
  setEncodings.writeUInt16BE(1, 2); // number-of-encodings
  setEncodings.writeInt32BE(ENCODING_RAW, 4);
  ws.send(setEncodings);

  // --- FramebufferUpdateRequest: full framebuffer, non-incremental ---
  const request = Buffer.alloc(10);
  request.writeUInt8(3, 0); // message type
  request.writeUInt8(0, 1); // incremental = 0
  request.writeUInt16BE(0, 2); // x
  request.writeUInt16BE(0, 4); // y
  request.writeUInt16BE(width, 6);
  request.writeUInt16BE(height, 8);
  ws.send(request);

  // --- Accumulate FramebufferUpdate rects until fully covered or the deadline passes ---
  const frame = Buffer.alloc(width * height * 4);
  let coveredPixels = 0;
  const totalPixels = width * height;
  const deadlineAt = Date.now() + updateTimeoutMs;
  let timedOut = false;

  while (!timedOut && coveredPixels < totalPixels) {
    const messageType = await readWithDeadline(reader, 1, deadlineAt);
    if (messageType === TIMED_OUT) break;

    switch (messageType.readUInt8(0)) {
      case 0: {
        // FramebufferUpdate
        const header = await readExact(reader, 3); // padding(1) + number-of-rectangles(2)
        const numRects = header.readUInt16BE(1);
        for (let i = 0; i < numRects && !timedOut; i++) {
          const rectHeader = await readWithDeadline(reader, 12, deadlineAt);
          if (rectHeader === TIMED_OUT) {
            timedOut = true; // deadline hit mid-rect-list -- stop, keep what we have
            break;
          }
          const x = rectHeader.readUInt16BE(0);
          const y = rectHeader.readUInt16BE(2);
          const w = rectHeader.readUInt16BE(4);
          const h = rectHeader.readUInt16BE(6);
          const encoding = rectHeader.readInt32BE(8);

          if (encoding !== ENCODING_RAW) {
            throw new RfbCaptureError(`server used an unrequested encoding (${encoding})`);
          }

          const pixelBytes = w * h * 4;
          const pixels = await readWithDeadline(reader, pixelBytes, deadlineAt);
          if (pixels === TIMED_OUT) {
            timedOut = true;
            break;
          }

          blitRect(frame, width, height, x, y, w, h, pixels);
          coveredPixels += w * h;
        }
        break;
      }
      case 1: {
        // SetColourMapEntries: padding(1) + first-colour(2) + number-of-colours(2), then 3*u16 per colour.
        const header = await readExact(reader, 5);
        const numColours = header.readUInt16BE(3);
        if (numColours > 0) await readExact(reader, numColours * 6);
        break;
      }
      case 2:
        // Bell: no payload.
        break;
      case 3: {
        // ServerCutText: padding(3) + length(4) + text.
        const header = await readExact(reader, 7);
        const len = header.readUInt32BE(3);
        if (len > 0) await readExact(reader, len);
        break;
      }
      default:
        throw new RfbCaptureError(`unexpected server message type (${messageType.readUInt8(0)})`);
    }
  }

  const coverage = coveredPixels / totalPixels;
  if (coverage < minCoverage) {
    throw new RfbCaptureError(
      `incomplete framebuffer capture (${Math.round(coverage * 100)}% covered, need ${Math.round(minCoverage * 100)}%)`,
    );
  }

  return { width, height, data: frame };
}

/** Copies one Raw-encoded rect (BGRA-in-memory per our SetPixelFormat: R at byte offset 2, G at 1, B at 0) into the RGBA destination framebuffer. */
function blitRect(
  dest: Buffer,
  frameWidth: number,
  frameHeight: number,
  x: number,
  y: number,
  w: number,
  h: number,
  pixels: Buffer,
): void {
  for (let row = 0; row < h; row++) {
    const destY = y + row;
    if (destY >= frameHeight) continue;
    for (let col = 0; col < w; col++) {
      const destX = x + col;
      if (destX >= frameWidth) continue;
      const srcOff = (row * w + col) * 4;
      const destOff = (destY * frameWidth + destX) * 4;
      // Our SetPixelFormat put red at shift 16 (byte offset 2), green at shift 8 (byte offset 1),
      // blue at shift 0 (byte offset 0), big-endian-flag 0 (little-endian on the wire) --
      // i.e. the wire bytes are [B, G, R, X]. Re-order to RGBA.
      dest[destOff] = pixels[srcOff + 2]!; // R
      dest[destOff + 1] = pixels[srcOff + 1]!; // G
      dest[destOff + 2] = pixels[srcOff]!; // B
      dest[destOff + 3] = 255; // A
    }
  }
}
