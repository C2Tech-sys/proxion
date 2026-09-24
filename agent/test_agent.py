#!/usr/bin/env python3
"""Unit and integration tests for proxion-agent. Stdlib only.

Run with: python agent/test_agent.py
"""

from __future__ import annotations

import http.client
import importlib.util
import json
import os
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest
import zlib

AGENT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "proxion-agent.py")
_spec = importlib.util.spec_from_file_location("proxion_agent", AGENT_PATH)
agent = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(agent)

HAS_UNIX_SOCKETS = hasattr(socket, "AF_UNIX") and sys.platform != "win32"


def build_ppm(width: int, height: int, pixels: bytes, comment: bool = False) -> bytes:
    """Build a raw P6 PPM from width/height/RGB bytes, optionally with a
    header comment to exercise the tolerant parser."""
    if comment:
        header = f"P6\n# proxion test image\n{width} {height}\n255\n".encode("ascii")
    else:
        header = f"P6 {width} {height} 255\n".encode("ascii")
    return header + pixels


def decode_png_rows(png_bytes: bytes, width: int, height: int) -> bytes:
    """Pull the raw (unfiltered) scanline bytes back out of a PNG produced by
    ppm_to_png, for round-trip verification."""
    assert png_bytes[:8] == agent.PNG_SIGNATURE
    pos = 8
    idat = b""
    ihdr = None
    while pos < len(png_bytes):
        (length,) = struct.unpack(">I", png_bytes[pos:pos + 4])
        tag = png_bytes[pos + 4:pos + 8]
        payload = png_bytes[pos + 8:pos + 8 + length]
        crc_expected = zlib.crc32(tag + payload) & 0xFFFFFFFF
        (crc_actual,) = struct.unpack(">I", png_bytes[pos + 8 + length:pos + 12 + length])
        if crc_actual != crc_expected:
            raise AssertionError(f"bad CRC on {tag!r} chunk")
        if tag == b"IHDR":
            ihdr = payload
        elif tag == b"IDAT":
            idat += payload
        pos += 12 + length
        if tag == b"IEND":
            break
    assert ihdr is not None
    w, h, bitdepth, colortype, comp, filt, interlace = struct.unpack(">IIBBBBB", ihdr)
    assert (w, h, bitdepth, colortype, comp, filt, interlace) == (width, height, 8, 2, 0, 0, 0)
    raw = zlib.decompress(idat)
    row_bytes = width * 3
    out = bytearray()
    for y in range(height):
        start = y * (row_bytes + 1)
        assert raw[start] == 0, "expected filter type 0 (None)"
        out += raw[start + 1:start + 1 + row_bytes]
    return bytes(out)


class TestPpmToPng(unittest.TestCase):
    def test_round_trip_3x2(self) -> None:
        # 3x2 image, one distinct color per pixel.
        pixels = bytes(
            [
                255, 0, 0, 0, 255, 0, 0, 0, 255,
                10, 20, 30, 40, 50, 60, 70, 80, 90,
            ]
        )
        ppm = build_ppm(3, 2, pixels)
        width, height, rgb = agent.parse_ppm(ppm)
        self.assertEqual((width, height), (3, 2))
        self.assertEqual(rgb, pixels)
        png_bytes = agent.ppm_to_png(width, height, rgb)
        self.assertTrue(png_bytes.startswith(agent.PNG_SIGNATURE))
        self.assertEqual(decode_png_rows(png_bytes, width, height), pixels)

    def test_header_with_comment(self) -> None:
        pixels = bytes([1, 2, 3] * 4)
        ppm = build_ppm(2, 2, pixels, comment=True)
        width, height, rgb = agent.parse_ppm(ppm)
        self.assertEqual((width, height), (2, 2))
        self.assertEqual(rgb, pixels)

    def test_truncated_data_raises(self) -> None:
        ppm = b"P6\n2 2\n255\n" + bytes([1, 2, 3])  # far too short
        with self.assertRaises(agent.CaptureError):
            agent.parse_ppm(ppm)

    def test_bad_magic_raises(self) -> None:
        with self.assertRaises(agent.CaptureError):
            agent.parse_ppm(b"P5\n2 2\n255\n" + bytes(12))

    def test_unsupported_maxval_raises(self) -> None:
        with self.assertRaises(agent.CaptureError):
            agent.parse_ppm(b"P6\n1 1\n65535\n" + bytes(3))


class TestValidateVmid(unittest.TestCase):
    def test_valid(self) -> None:
        self.assertEqual(agent.validate_vmid("100"), 100)
        self.assertEqual(agent.validate_vmid("123456789"), 123456789)

    def test_below_minimum(self) -> None:
        self.assertIsNone(agent.validate_vmid("99"))
        self.assertIsNone(agent.validate_vmid("1"))
        self.assertIsNone(agent.validate_vmid("0"))

    def test_non_numeric(self) -> None:
        self.assertIsNone(agent.validate_vmid("abc"))
        self.assertIsNone(agent.validate_vmid(""))
        self.assertIsNone(agent.validate_vmid("100.5"))
        self.assertIsNone(agent.validate_vmid("-100"))

    def test_too_long(self) -> None:
        self.assertIsNone(agent.validate_vmid("1234567890"))  # 10 digits


class TestTokenAuth(unittest.TestCase):
    def test_extract_bearer_token(self) -> None:
        self.assertEqual(agent.extract_bearer_token("Bearer abc123"), "abc123")
        self.assertIsNone(agent.extract_bearer_token(""))
        self.assertIsNone(agent.extract_bearer_token("Basic abc123"))
        self.assertIsNone(agent.extract_bearer_token("Bearer"))

    def test_compare_digest_matches_only_equal_tokens(self) -> None:
        token = "a" * 40
        self.assertTrue(__import__("hmac").compare_digest(token, "a" * 40))
        self.assertFalse(__import__("hmac").compare_digest(token, "b" * 40))


class FakeQmpServer:
    """A minimal fake QMP endpoint over a unix socket: speaks the greeting /
    qmp_capabilities / screendump handshake, interleaves one event line, and
    either writes a PPM to the requested filename or replies with an error.
    """

    def __init__(self, sock_path: str, ppm_bytes: bytes = b"", fail: bool = False) -> None:
        self.sock_path = sock_path
        self.ppm_bytes = ppm_bytes
        self.fail = fail
        self._srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._srv.bind(sock_path)
        self._srv.listen(1)
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> "FakeQmpServer":
        self._thread.start()
        return self

    @staticmethod
    def _read_line(conn: socket.socket) -> bytes:
        buf = b""
        while b"\n" not in buf:
            chunk = conn.recv(4096)
            if not chunk:
                break
            buf += chunk
        return buf.split(b"\n", 1)[0]

    def _run(self) -> None:
        try:
            conn, _ = self._srv.accept()
        except OSError:
            return
        with conn:
            conn.sendall(b'{"QMP": {"version": {}, "capabilities": []}}\n')
            self._read_line(conn)  # qmp_capabilities request
            conn.sendall(b'{"event": "STOP", "data": {}}\n')  # interleaved event, must be skipped
            conn.sendall(b'{"return": {}}\n')
            req = self._read_line(conn)  # screendump request
            if self.fail:
                conn.sendall(b'{"error": {"class": "GenericError", "desc": "boom"}}\n')
                return
            obj = json.loads(req)
            filename = obj["arguments"]["filename"]
            with open(filename, "wb") as fh:
                fh.write(self.ppm_bytes)
            conn.sendall(b'{"return": {}}\n')

    def join(self, timeout: float = 5.0) -> None:
        self._thread.join(timeout)

    def close(self) -> None:
        try:
            self._srv.close()
        except OSError:
            pass


@unittest.skipUnless(HAS_UNIX_SOCKETS, "requires AF_UNIX (not available on Windows)")
class TestHttpIntegration(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.qmp_dir = self.tmpdir.name
        self.work_dir = os.path.join(self.tmpdir.name, "work")
        os.makedirs(self.work_dir, exist_ok=True)
        self.token = "t" * 40
        self.server = agent.AgentHTTPServer(
            ("127.0.0.1", 0), agent.Handler, token=self.token, qmp_dir=self.qmp_dir, work_dir=self.work_dir
        )
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self._fakes: list = []

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        for fake in self._fakes:
            fake.close()
        self.tmpdir.cleanup()

    def _conn(self) -> http.client.HTTPConnection:
        return http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)

    def _get(self, path: str, auth: bool = True):
        conn = self._conn()
        headers = {"Authorization": f"Bearer {self.token}"} if auth else {}
        conn.request("GET", path, headers=headers)
        resp = conn.getresponse()
        body = resp.read()
        conn.close()
        return resp, body

    def test_health_requires_auth(self) -> None:
        resp, body = self._get("/health", auth=False)
        self.assertEqual(resp.status, 401)
        self.assertEqual(json.loads(body), {"error": "unauthorized"})

    def test_health_ok(self) -> None:
        resp, body = self._get("/health")
        self.assertEqual(resp.status, 200)
        payload = json.loads(body)
        self.assertEqual(payload["agent"], "proxion-agent")
        self.assertEqual(payload["version"], agent.VERSION)
        self.assertTrue(payload["ok"])
        self.assertIn("hostname", payload)

    def test_screenshot_success(self) -> None:
        vmid = 101
        pixels = bytes([i % 256 for i in range(3 * 3)])  # 3x1 image
        ppm = build_ppm(3, 1, pixels)
        fake = FakeQmpServer(os.path.join(self.qmp_dir, f"{vmid}.qmp"), ppm_bytes=ppm).start()
        self._fakes.append(fake)
        resp, body = self._get(f"/screenshot/{vmid}")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.getheader("Content-Type"), "image/png")
        self.assertEqual(resp.getheader("X-Proxion-Agent-Width"), "3")
        self.assertEqual(resp.getheader("X-Proxion-Agent-Height"), "1")
        captured_at = resp.getheader("X-Proxion-Agent-Captured-At")
        self.assertTrue(captured_at and captured_at.endswith("Z"))
        self.assertEqual(decode_png_rows(body, 3, 1), pixels)
        fake.join()

    def test_screenshot_not_running(self) -> None:
        resp, body = self._get("/screenshot/59999")
        self.assertEqual(resp.status, 404)
        self.assertEqual(json.loads(body), {"error": "not-running"})

    def test_screenshot_bad_vmid(self) -> None:
        resp, body = self._get("/screenshot/12")
        self.assertEqual(resp.status, 400)
        self.assertEqual(json.loads(body), {"error": "bad-vmid"})

    def test_screenshot_capture_failed(self) -> None:
        vmid = 102
        fake = FakeQmpServer(os.path.join(self.qmp_dir, f"{vmid}.qmp"), fail=True).start()
        self._fakes.append(fake)
        resp, body = self._get(f"/screenshot/{vmid}")
        self.assertEqual(resp.status, 503)
        payload = json.loads(body)
        self.assertEqual(payload["error"], "capture-failed")
        self.assertIn("boom", payload["detail"])
        fake.join()

    def test_unknown_path(self) -> None:
        resp, _ = self._get("/nope")
        self.assertEqual(resp.status, 404)


if __name__ == "__main__":
    unittest.main(verbosity=2)
