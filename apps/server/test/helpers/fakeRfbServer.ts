import { randomBytes } from 'node:crypto';
import type { WebSocket as WsWebSocket } from 'ws';
import type { RawData } from 'ws';
import { vncAuthResponse } from '../../src/console/des.js';

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function u32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

/** BGRX bytes for one pixel under the SetPixelFormat the real client always sends (32bpp, little-endian, R shift16/G shift8/B shift0). */
function pixelBytes(r: number, g: number, b: number): [number, number, number, number] {
  return [b, g, r, 0];
}

export interface FakeRfbOptions {
  width: number;
  height: number;
  /** The password the client is expected to authenticate with (PVE's vncticket). */
  password: string;
  /** When set, VNC Authentication always fails (a wrong-password/handshake-failure scenario), regardless of what the client sends. */
  forceAuthFailure?: boolean;
  /** Called with the client's 16-byte VNC auth response once received. */
  onAuthResponse?: (response: Buffer) => void;
  /** Never sends anything after ServerInit -- simulates a server that hangs mid-capture. */
  hangAfterServerInit?: boolean;
}

/**
 * A scripted stand-in for a Proxmox `vncwebsocket` endpoint speaking RFB
 * 3.8 with VNC Authentication: full ProtocolVersion/Security/ClientInit
 * handshake, then one `FramebufferUpdate` split across **two** rects (to
 * exercise `rfbSnapshot`'s accumulation) painting the framebuffer in four
 * solid quadrant colours (top-left red, top-right green, bottom-left blue,
 * bottom-right yellow) -- so a downscaled thumbnail's four corners have
 * known, distinct expected colours.
 */
export function scriptedRfbServer(options: FakeRfbOptions): {
  onConnection: (ws: WsWebSocket) => void;
} {
  const onConnection = (ws: WsWebSocket) => {
    let step = 0;
    let challenge = Buffer.alloc(16);

    ws.send(Buffer.from('RFB 003.008\n', 'ascii'));

    ws.on('message', (data: RawData) => {
      const buf = toBuffer(data);

      switch (step) {
        case 0: {
          // Client's ProtocolVersion reply -- ignore the content, offer VNC Authentication.
          step = 1;
          ws.send(Buffer.from([1, 2]));
          break;
        }
        case 1: {
          // Client's chosen security type (expected: 2, VNC Authentication).
          challenge = randomBytes(16);
          step = 2;
          ws.send(challenge);
          break;
        }
        case 2: {
          // Client's 16-byte DES challenge response.
          options.onAuthResponse?.(buf);
          const expected = vncAuthResponse(options.password, challenge);
          const ok = !options.forceAuthFailure && buf.equals(expected);
          if (!ok) {
            const reason = Buffer.from('Authentication failure', 'utf8');
            ws.send(u32be(1));
            ws.send(Buffer.concat([u32be(reason.length), reason]));
            ws.close();
            return;
          }
          ws.send(u32be(0));
          step = 3;
          break;
        }
        case 3: {
          // ClientInit (1 byte, shared-flag) -- reply with ServerInit.
          const serverInit = Buffer.alloc(24);
          serverInit.writeUInt16BE(options.width, 0);
          serverInit.writeUInt16BE(options.height, 2);
          // Bytes 4..19 (PIXEL_FORMAT) are irrelevant -- the client always sends its own SetPixelFormat next.
          serverInit.writeUInt32BE(0, 20); // NAME-LENGTH = 0
          ws.send(serverInit);
          step = 4;
          if (options.hangAfterServerInit) step = -1; // stop reacting to anything further
          break;
        }
        case 4: {
          // SetPixelFormat (20 bytes) -- ignore; we already know what the client asked for.
          step = 5;
          break;
        }
        case 5: {
          // SetEncodings -- ignore (the client only ever offers Raw).
          step = 6;
          break;
        }
        case 6: {
          // FramebufferUpdateRequest -- reply with the whole framebuffer as two rects (top/bottom halves).
          sendFramebufferUpdate(ws, options.width, options.height);
          step = 7;
          break;
        }
        default:
          break;
      }
    });
  };

  return { onConnection };
}

function sendFramebufferUpdate(ws: WsWebSocket, width: number, height: number): void {
  const halfHeight = Math.floor(height / 2);
  const halfWidth = Math.floor(width / 2);

  const header = Buffer.alloc(4);
  header.writeUInt8(0, 0); // message type: FramebufferUpdate
  header.writeUInt16BE(2, 2); // number-of-rectangles
  ws.send(header);

  ws.send(rect(0, 0, width, halfHeight, (x) => (x < halfWidth ? pixelBytes(255, 0, 0) : pixelBytes(0, 255, 0))));
  ws.send(
    rect(0, halfHeight, width, height - halfHeight, (x) =>
      x < halfWidth ? pixelBytes(0, 0, 255) : pixelBytes(255, 255, 0),
    ),
  );
}

function rect(x: number, y: number, w: number, h: number, colourForX: (x: number) => number[]): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(x, 0);
  header.writeUInt16BE(y, 2);
  header.writeUInt16BE(w, 4);
  header.writeUInt16BE(h, 6);
  header.writeInt32BE(0, 8); // encoding: Raw

  const pixels = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const [b, g, r, pad] = colourForX(col);
      const off = (row * w + col) * 4;
      pixels[off] = b!;
      pixels[off + 1] = g!;
      pixels[off + 2] = r!;
      pixels[off + 3] = pad!;
    }
  }

  return Buffer.concat([header, pixels]);
}
