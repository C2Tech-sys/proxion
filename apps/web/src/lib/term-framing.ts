/**
 * Wire framing for the Proxion term websocket (`/api/console/term/...`), as defined by the
 * Proxion server's console bridge README. Three frame kinds, all sent as UTF-8 text frames:
 *
 *   "0:<byteLength>:<data>"   -- input bytes typed into the terminal (byteLength counts the
 *                                UTF-8 encoding of `data`, not its UTF-16 `.length`)
 *   "1:<cols>:<rows>:"        -- (re)size the remote pty, sent once on open and again on
 *                                every terminal resize/fit
 *   "2"                       -- keepalive ping, sent on an interval
 *
 * The server writes raw pty bytes back as binary websocket frames (ArrayBuffer), which the
 * terminal writes directly -- see Terminal.tsx.
 */

/** Byte length of `text` when encoded as UTF-8 (multibyte-safe, unlike `.length`). */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Frames a chunk of terminal input (from `term.onData`) for the wire. */
export function encodeInputFrame(data: string): string {
  return `0:${utf8ByteLength(data)}:${data}`;
}

/** Frames a pty resize (cols/rows), sent on connect and on every subsequent resize. */
export function encodeResizeFrame(cols: number, rows: number): string {
  return `1:${cols}:${rows}:`;
}

/** Frames a keepalive ping. */
export function encodePingFrame(): string {
  return '2';
}
