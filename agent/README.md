# proxion-agent

A tiny host agent for Proxmox VE nodes that captures a running VM's console
as a PNG on request, without going through VNC.

## Why

Proxion's server can already capture console thumbnails by opening a short
VNC session to each running guest, but that creates a `vncproxy` entry in
the Proxmox task log for every single capture — noisy, and it shows up in
the UI's own task history. Proxmox has no screenshot API. QEMU does,
though: every running VM on a PVE node exposes a QMP (QEMU Machine
Protocol) control socket at `/var/run/qemu-server/<vmid>.qmp`, and QMP's
`screendump` command writes the current guest display to a file, with no
task log entry at all.

`proxion-agent` is a small process that runs on each PVE node, listens on a
private address, and on request opens that VM's QMP socket, issues
`screendump`, converts the result to a PNG, and returns it over HTTP. The
Proxion server calls this agent instead of opening a VNC session when it
wants a thumbnail.

## Why it runs as root

Proxmox creates `/var/run/qemu-server/<vmid>.qmp` owned by root, and QEMU
writes the screendump file itself (also as root) before the agent reads it
back. There's no supported way to reach that socket, or the file QEMU
writes, as a lower-privileged user. The systemd unit hardens what it can
(`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`,
a single writable scratch directory) but the process itself must be root.

## HTTP contract

Every request must carry `Authorization: Bearer <token>` — including
`/health` — compared with a constant-time comparison. A missing or wrong
token gets `401 {"error":"unauthorized"}`.

- `GET /health` -> `200 {"ok":true,"agent":"proxion-agent","version":"0.1.0","hostname":"<node hostname>"}`
- `GET /screenshot/<vmid>` — `<vmid>` must be 1-9 digits and >= 100.
  - `400 {"error":"bad-vmid"}` if the vmid doesn't match that shape.
  - `404 {"error":"not-running"}` if `<qmp-dir>/<vmid>.qmp` doesn't exist (the
    guest isn't running, or doesn't exist).
  - `200 image/png` on success, full guest resolution, with:
    - `X-Proxion-Agent-Captured-At`: UTC ISO 8601, e.g. `2026-09-23T14:03:11Z`
    - `X-Proxion-Agent-Width`, `X-Proxion-Agent-Height`
  - `503 {"error":"capture-failed","detail":"<short reason>"}` on a QMP
    error or timeout.
  - `503 {"error":"busy"}` if another request for the *same* vmid is
    already in flight and doesn't finish within 5s (QEMU only allows one
    QMP client at a time per VM).
- Anything else -> `404 {"error":"not-found"}`.
- Any non-`GET` method -> `405`.

Responses always include `Cache-Control: no-store`. Every request is logged
to stdout (journald) as one line: method, path, status, elapsed ms — the
token is never logged.

## Security posture

- **Bind to a private or mesh address only** — a WireGuard or Tailscale
  address, or another network the Proxion server alone can reach. Never
  bind `0.0.0.0` or a public interface (`install.sh` refuses `0.0.0.0`
  unless you pass `--allow-any-bind`, and you shouldn't).
- **Bearer token, compared with `hmac.compare_digest`.** Treat it like a
  root credential: it's read from a root-only file (`/etc/proxion-agent/token`,
  mode 0600) or from the `PROXION_AGENT_TOKEN` environment variable, and the
  agent refuses to start with no token or one shorter than 32 characters.
- **Plaintext HTTP.** There is no TLS in this version — that's a follow-up.
  Only run this over a network you already trust or that's itself
  encrypted (a WireGuard/Tailscale mesh, a private VLAN you control), never
  over the open internet or an untrusted LAN.
- Runs as root (see above), with systemd hardening applied around that.

## Install

Requires stock Python 3 (>= 3.11) on the PVE node — no `pip install`
needed, the agent is pure standard library.

```sh
sudo ./install.sh --bind <your-private-ip> --port 9420
```

Omit `--bind`/`--port` to be prompted interactively (default port 9420,
default bind `127.0.0.1` — change it to your mesh address so the Proxion
server can actually reach it). This is idempotent: re-running it upgrades
the binary and unit in place and leaves an existing token alone. It prints
the bearer token **once**, on first install only — save it immediately:

```
Generated a new bearer token (shown once now; it lives at /etc/proxion-agent/token):

    <64 hex chars>

Add this to Proxion as PROXION_AGENT_TOKEN.
```

## Upgrade

Re-run `install.sh` with the same `--bind`/`--port` (or none, to reuse
`/etc/proxion-agent/agent.env`'s existing values via the prompt defaults) —
it copies the new `proxion-agent.py`, reloads the unit, and restarts the
service. The token is untouched.

## Uninstall

```sh
sudo ./uninstall.sh            # stops/disables the service, removes the binary and unit, keeps the token
sudo ./uninstall.sh --purge    # also removes /etc/proxion-agent entirely, including the token
```

## Verify

```sh
TOKEN=$(sudo cat /etc/proxion-agent/token)
curl -H "Authorization: Bearer ${TOKEN}" http://<bind-ip>:9420/health

curl -H "Authorization: Bearer ${TOKEN}" \
     http://<bind-ip>:9420/screenshot/<vmid> -o shot.png
```

## Troubleshooting

- **`404 not-running`**: the VM isn't running, the vmid doesn't exist on
  this node, or you're pointed at the wrong node — the agent only sees
  `<qmp-dir>/<vmid>.qmp`, i.e. only guests running locally.
- **`503 capture-failed`**: the QMP socket exists but the handshake or
  `screendump` command failed or timed out — check `journalctl -u
  proxion-agent` for the logged exception type (never a path or the
  token). Transient busy conditions on the QMP socket are retried
  automatically; a persistent failure usually means QEMU itself is in a
  bad state for that guest.
- **`503 busy`**: another screenshot request for the same vmid was already
  in flight and didn't finish within 5 seconds; retry.
- **`401 unauthorized`**: check the `Authorization: Bearer <token>` header
  matches `/etc/proxion-agent/token` (or `PROXION_AGENT_TOKEN` if you're
  running the agent that way) exactly.
- General logs: `journalctl -u proxion-agent -f` — one line per request
  (method, path, status, ms), plus the exception type name on any 500.
