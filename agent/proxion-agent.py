#!/usr/bin/env python3
"""proxion-agent: a tiny host agent that captures a QEMU console screendump via
the per-VM QMP unix socket on a Proxmox VE node and serves it as a PNG over
HTTP, so the Proxion server does not need to open a noisy VNC session per
thumbnail capture.

Standard library only (Python >= 3.11). Must run as root: only root can open
the QMP unix sockets Proxmox creates at ``<qmp-dir>/<vmid>.qmp``.

See agent/README.md for the full HTTP contract, install instructions and
security posture.
"""

from __future__ import annotations

import argparse
import errno
import hmac
import json
import os
import random
import re
import secrets
import socket
import struct
import sys
import threading
import time
import zlib
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional, Tuple

VERSION = "0.1.0"
VMID_RE = re.compile(r"^[0-9]{1,9}$")
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class CaptureError(Exception):
    """Raised for any QMP/screendump failure; always maps to HTTP 503."""


# --------------------------------------------------------------------------
# vmid / auth helpers
# --------------------------------------------------------------------------

def validate_vmid(raw: str) -> Optional[int]:
    """Validate a ``/screenshot/<vmid>`` path segment.

    Must be 1-9 ASCII digits and numerically >= 100. Returns the parsed int,
    or None if invalid.
    """
    if not VMID_RE.match(raw):
        return None
    value = int(raw)
    if value < 100:
        return None
    return value


def extract_bearer_token(header_value: str) -> Optional[str]:
    """Pull the token out of an ``Authorization: Bearer <token>`` header."""
    prefix = "Bearer "
    if not header_value or not header_value.startswith(prefix):
        return None
    return header_value[len(prefix):].strip()


# --------------------------------------------------------------------------
# PPM -> PNG
# --------------------------------------------------------------------------

def _skip_ws_and_comments(data: bytes, pos: int) -> int:
    """Advance past PPM header whitespace and ``#`` comment lines."""
    while pos < len(data):
        char = data[pos:pos + 1]
        if char.isspace():
            pos += 1
            continue
        if char == b"#":
            while pos < len(data) and data[pos:pos + 1] != b"\n":
                pos += 1
            continue
        break
    return pos


def parse_ppm(data: bytes) -> Tuple[int, int, bytes]:
    """Parse a binary PPM (P6, maxval 255) image.

    Tolerant of whitespace and ``#`` comments anywhere between header
    tokens, per the PPM spec. Returns (width, height, raw RGB bytes).
    Raises CaptureError on any malformed input.
    """
    if data[:2] != b"P6":
        raise CaptureError("not a P6 ppm")
    pos = 2
    values = []
    for _ in range(3):
        pos = _skip_ws_and_comments(data, pos)
        start = pos
        while pos < len(data) and not data[pos:pos + 1].isspace():
            pos += 1
        if start == pos:
            raise CaptureError("malformed ppm header")
        values.append(int(data[start:pos]))
    width, height, maxval = values
    if maxval != 255:
        raise CaptureError("unsupported ppm maxval")
    pos += 1  # exactly one whitespace byte terminates the header
    pixel_bytes = width * height * 3
    rgb = data[pos:pos + pixel_bytes]
    if len(rgb) != pixel_bytes:
        raise CaptureError("truncated ppm data")
    return width, height, rgb


def _png_chunk(tag: bytes, payload: bytes) -> bytes:
    """Build one length-prefixed, CRC-suffixed PNG chunk."""
    return (
        struct.pack(">I", len(payload))
        + tag
        + payload
        + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    )


def ppm_to_png(width: int, height: int, rgb: bytes) -> bytes:
    """Encode raw 8-bit RGB pixel data as an 8-bit truecolour PNG.

    Each scanline is prefixed with filter type 0 (None); rows are sliced in
    bulk so the only Python-level loop is per scanline, not per pixel.
    """
    row_bytes = width * 3
    raw = bytearray((row_bytes + 1) * height)
    for y in range(height):
        dst = y * (row_bytes + 1)
        raw[dst] = 0
        src = y * row_bytes
        raw[dst + 1:dst + 1 + row_bytes] = rgb[src:src + row_bytes]
    compressed = zlib.compress(bytes(raw), 6)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"".join(
        [
            PNG_SIGNATURE,
            _png_chunk(b"IHDR", ihdr),
            _png_chunk(b"IDAT", compressed),
            _png_chunk(b"IEND", b""),
        ]
    )


# --------------------------------------------------------------------------
# QMP client
# --------------------------------------------------------------------------

class _LineReader:
    """Buffers newline-delimited QMP JSON messages, skipping events."""

    def __init__(self, sock: socket.socket) -> None:
        self._sock = sock
        self._buf = b""

    def read_json(self) -> dict:
        """Read and decode the next non-event QMP JSON object."""
        while True:
            while b"\n" not in self._buf:
                chunk = self._sock.recv(4096)
                if not chunk:
                    raise CaptureError("qmp connection closed")
                self._buf += chunk
            line, self._buf = self._buf.split(b"\n", 1)
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line.decode("utf-8", "replace"))
            if isinstance(obj, dict) and "event" in obj:
                continue
            return obj


def _send_json(sock: socket.socket, obj: dict) -> None:
    sock.sendall((json.dumps(obj) + "\n").encode("utf-8"))


def _connect_qmp(qmp_path: str, timeout: float) -> socket.socket:
    """Connect to a QMP unix socket, retrying transient busy conditions.

    QEMU allows only one QMP client at a time, so a refused/blocking connect
    is retried up to 5 times with a short randomized backoff. Any other
    OSError (e.g. missing socket, permission) fails immediately.
    """
    last_exc: Optional[BaseException] = None
    for _ in range(5):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        try:
            sock.connect(qmp_path)
            return sock
        except (ConnectionRefusedError, BlockingIOError) as exc:
            last_exc = exc
        except OSError as exc:
            if getattr(exc, "errno", None) == errno.EAGAIN:
                last_exc = exc
            else:
                sock.close()
                raise CaptureError(f"qmp connect failed: {type(exc).__name__}") from exc
        sock.close()
        time.sleep(random.uniform(0.1, 0.3))
    kind = type(last_exc).__name__ if last_exc else "unknown"
    raise CaptureError(f"qmp connect failed after retries: {kind}")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def capture_screendump(
    qmp_path: str, work_dir: str, vmid: str, timeout: float = 3.0
) -> Tuple[bytes, int, int, str]:
    """Take a QMP screendump for ``vmid`` and return it as a PNG.

    Connects to the VM's QMP socket, negotiates capabilities, requests a
    screendump to a private PPM file, reads and deletes that file (always,
    even on error), and converts it to PNG. Returns
    (png_bytes, width, height, captured_at_iso). Raises CaptureError on any
    failure; never leaks filesystem paths in the message.
    """
    fname = f"{vmid}-{secrets.token_hex(8)}.ppm"
    out_path = os.path.join(work_dir, fname)
    sock = _connect_qmp(qmp_path, timeout)
    captured_at: Optional[str] = None
    try:
        reader = _LineReader(sock)
        greeting = reader.read_json()
        if "QMP" not in greeting:
            raise CaptureError("unexpected qmp greeting")
        _send_json(sock, {"execute": "qmp_capabilities"})
        resp = reader.read_json()
        if "error" in resp:
            raise CaptureError(str(resp["error"].get("desc", "qmp_capabilities failed")))
        _send_json(sock, {"execute": "screendump", "arguments": {"filename": out_path}})
        resp = reader.read_json()
        if "error" in resp:
            raise CaptureError(str(resp["error"].get("desc", "screendump failed")))
        captured_at = _utc_now_iso()
    except CaptureError:
        raise
    except socket.timeout as exc:
        raise CaptureError("qmp timeout") from exc
    except (OSError, ValueError, KeyError) as exc:
        raise CaptureError(f"qmp protocol error: {type(exc).__name__}") from exc
    finally:
        try:
            sock.close()
        except OSError:
            pass

    try:
        with open(out_path, "rb") as fh:
            ppm_bytes = fh.read()
    except OSError as exc:
        raise CaptureError(f"could not read screendump output: {type(exc).__name__}") from exc
    finally:
        try:
            os.remove(out_path)
        except OSError:
            pass

    try:
        width, height, rgb = parse_ppm(ppm_bytes)
        png_bytes = ppm_to_png(width, height, rgb)
    except CaptureError:
        raise
    except Exception as exc:  # noqa: BLE001 - any decode issue is a capture failure
        raise CaptureError(f"ppm decode failed: {type(exc).__name__}") from exc

    assert captured_at is not None
    return png_bytes, width, height, captured_at


# --------------------------------------------------------------------------
# HTTP server
# --------------------------------------------------------------------------

class VmidLocks:
    """Per-vmid locks so concurrent captures of the same guest serialize
    instead of racing on the same QMP socket / work-dir file."""

    def __init__(self) -> None:
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def acquire(self, vmid: str, timeout: float) -> Optional[threading.Lock]:
        """Acquire the lock for ``vmid``, waiting up to ``timeout`` seconds."""
        with self._guard:
            lock = self._locks.setdefault(vmid, threading.Lock())
        return lock if lock.acquire(timeout=timeout) else None

    @staticmethod
    def release(lock: threading.Lock) -> None:
        lock.release()


class AgentHTTPServer(ThreadingHTTPServer):
    """ThreadingHTTPServer carrying the agent's config and vmid locks."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        addr: Tuple[str, int],
        handler_cls: type,
        *,
        token: str,
        qmp_dir: str,
        work_dir: str,
    ) -> None:
        super().__init__(addr, handler_cls)
        self.token = token
        self.qmp_dir = qmp_dir
        self.work_dir = work_dir
        self.vmid_locks = VmidLocks()


class Handler(BaseHTTPRequestHandler):
    """Implements the proxion-agent HTTP contract (see agent/README.md)."""

    server_version = f"proxion-agent/{VERSION}"
    protocol_version = "HTTP/1.0"
    # Socket read timeout: a client that opens a connection and never finishes sending
    # its request line/headers is dropped instead of holding a handler thread forever.
    timeout = 10

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003 - stdlib name
        pass  # replaced by the structured line printed in _dispatch()

    def _check_auth(self) -> bool:
        supplied = extract_bearer_token(self.headers.get("Authorization", ""))
        if supplied is None:
            return False
        return hmac.compare_digest(supplied, self.server.token)  # type: ignore[attr-defined]

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _route(self) -> int:
        if not self._check_auth():
            self._send_json(401, {"error": "unauthorized"})
            return 401
        if self.path == "/health":
            self._send_json(
                200,
                {
                    "ok": True,
                    "agent": "proxion-agent",
                    "version": VERSION,
                    "hostname": socket.gethostname(),
                },
            )
            return 200
        match = re.match(r"^/screenshot/([^/]+)$", self.path)
        if match:
            return self._handle_screenshot(match.group(1))
        self._send_json(404, {"error": "not-found"})
        return 404

    def _handle_screenshot(self, raw_vmid: str) -> int:
        server: AgentHTTPServer = self.server  # type: ignore[assignment]
        vmid = validate_vmid(raw_vmid)
        if vmid is None:
            self._send_json(400, {"error": "bad-vmid"})
            return 400
        qmp_path = os.path.join(server.qmp_dir, f"{vmid}.qmp")
        if not os.path.exists(qmp_path):
            self._send_json(404, {"error": "not-running"})
            return 404
        lock = server.vmid_locks.acquire(str(vmid), timeout=5.0)
        if lock is None:
            self._send_json(503, {"error": "busy"})
            return 503
        try:
            png_bytes, width, height, captured_at = capture_screendump(
                qmp_path, server.work_dir, str(vmid)
            )
        except CaptureError as exc:
            # QEMU's own error text may echo the screendump filename; never reveal the
            # private work directory to the client.
            detail = str(exc).replace(server.work_dir, "<work-dir>")[:200]
            self._send_json(503, {"error": "capture-failed", "detail": detail})
            return 503
        finally:
            VmidLocks.release(lock)
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(png_bytes)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.send_header("X-Proxion-Agent-Captured-At", captured_at)
        self.send_header("X-Proxion-Agent-Width", str(width))
        self.send_header("X-Proxion-Agent-Height", str(height))
        self.end_headers()
        self.wfile.write(png_bytes)
        return 200

    def _dispatch(self, allowed: bool) -> None:
        start = time.monotonic()
        status = 0
        try:
            if not allowed:
                self._send_json(405, {"error": "method-not-allowed"})
                status = 405
            else:
                status = self._route()
        except BrokenPipeError:
            status = 0
        except Exception as exc:  # noqa: BLE001 - never leak a traceback to the client
            print(f"proxion-agent: internal error: {type(exc).__name__}", file=sys.stderr, flush=True)
            try:
                self._send_json(500, {"error": "internal"})
                status = 500
            except BrokenPipeError:
                status = 0
        elapsed_ms = (time.monotonic() - start) * 1000
        print(f"{self.command} {self.path} {status} {elapsed_ms:.1f}ms", flush=True)

    def do_GET(self) -> None:
        self._dispatch(allowed=True)

    def do_POST(self) -> None:
        self._dispatch(allowed=False)

    def do_PUT(self) -> None:
        self._dispatch(allowed=False)

    def do_DELETE(self) -> None:
        self._dispatch(allowed=False)

    def do_PATCH(self) -> None:
        self._dispatch(allowed=False)

    def do_HEAD(self) -> None:
        self._dispatch(allowed=False)


# --------------------------------------------------------------------------
# config / entrypoint
# --------------------------------------------------------------------------

def parse_args(argv: list) -> argparse.Namespace:
    """Parse proxion-agent's command line arguments."""
    parser = argparse.ArgumentParser(prog="proxion-agent", description="Proxion console screenshot agent")
    parser.add_argument("--bind", default="127.0.0.1", help="address to listen on (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=9420, help="port to listen on (default 9420)")
    parser.add_argument("--qmp-dir", default="/var/run/qemu-server", help="directory holding <vmid>.qmp sockets")
    parser.add_argument("--work-dir", default="/run/proxion-agent", help="private scratch dir for screendumps")
    parser.add_argument("--token-file", default="/etc/proxion-agent/token", help="file holding the bearer token")
    parser.add_argument("--version", action="store_true", help="print the version and exit")
    return parser.parse_args(argv)


def load_token(token_file: str) -> str:
    """Resolve the bearer token: PROXION_AGENT_TOKEN env wins over --token-file.

    Exits the process with status 2 if no usable (>=32 char) token is found.
    """
    env_token = os.environ.get("PROXION_AGENT_TOKEN")
    if env_token:
        token = env_token.strip()
    else:
        try:
            with open(token_file, "r", encoding="utf-8") as fh:
                token = fh.read().strip()
        except OSError:
            token = ""
    if len(token) < 32:
        print(
            "proxion-agent: no usable token (set PROXION_AGENT_TOKEN or provide a "
            "--token-file of at least 32 characters); refusing to start",
            file=sys.stderr,
        )
        sys.exit(2)
    return token


def ensure_work_dir(path: str) -> None:
    """Create the private work directory (mode 0700) if it doesn't exist."""
    os.makedirs(path, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass


def main(argv: Optional[list] = None) -> int:
    """proxion-agent entrypoint."""
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.version:
        print(f"proxion-agent {VERSION}")
        return 0
    token = load_token(args.token_file)
    ensure_work_dir(args.work_dir)
    server = AgentHTTPServer(
        (args.bind, args.port), Handler, token=token, qmp_dir=args.qmp_dir, work_dir=args.work_dir
    )
    print(f"proxion-agent {VERSION} listening on {args.bind}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
