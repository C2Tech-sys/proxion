# Deploying Proxion

Proxion is a single stateless-ish process (in-memory sessions and console
tickets, no database; the only thing it persists to disk is per-user
preferences -- see `PROXION_DATA_DIR` below) that talks to your Proxmox VE
cluster over its existing HTTPS API. This doc covers running it with Docker,
the environment variables it reads, reverse-proxy requirements (websockets!),
and the recommended read-only service token setup.

## Quick start (Docker Compose)

```bash
cp docker-compose.example.yml docker-compose.yml
# edit docker-compose.yml: PVE_URL, PVE_TLS_FINGERPRINT, SESSION_SECRET, ...
docker compose up -d
```

Proxion listens on `:3080` inside the container. Put a reverse proxy in
front of it for TLS (see below); do not expose it directly to the internet.

## Environment variables

| Variable                   | Required              | Default                                | Notes                                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | --------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                     | no                    | `3080`                                 |                                                                                                                                                                                                                                                                                                                                             |
| `HOST`                     | no                    | `0.0.0.0`                              |                                                                                                                                                                                                                                                                                                                                             |
| `NODE_ENV`                 | no                    | `development`                          | Set to `production` in deployment; the Docker image sets this for you.                                                                                                                                                                                                                                                                      |
| `PVE_URL`                  | **yes**               |                                        | e.g. `https://pve.example.com:8006`. No trailing slash, no `/api2/json`.                                                                                                                                                                                                                                                                        |
| `PVE_TLS_FINGERPRINT`      | no                    |                                        | Pin to PVE's cert by SHA-256 fingerprint. **Recommended** -- PVE's default cert is self-signed. See "Get the certificate fingerprint" below.                                                                                                                                                                                                |
| `PVE_TLS_INSECURE`         | no                    | `false`                                | Skip all TLS verification. Only use this if you can't pin a fingerprint (e.g. the cert rotates) and understand the risk -- prefer `PVE_TLS_FINGERPRINT` instead.                                                                                                                                                                            |
| `PVE_TOKEN_ID`             | no                    |                                        | Optional read-only service token (`user@realm!tokenname`), used for the live cluster poller / SSE feed and, if `PROXION_ALLOW_TOKEN_MODE=true`, as a fallback identity. Must be set together with `PVE_TOKEN_SECRET`, or not at all. See "Recommended read-only role" below.                                                                |
| `PVE_TOKEN_SECRET`         | no                    |                                        | Service token secret.                                                                                                                                                                                                                                                                                                                       |
| `SESSION_SECRET`           | **yes in production** | auto-generated outside production      | Signs the `proxion.sid` session cookie. Generate one with `openssl rand -hex 32`.                                                                                                                                                                                                                                                           |
| `PROXION_ALLOW_TOKEN_MODE` | no                    | `false`                                | When `true` _and_ a service token is configured, unauthenticated requests are treated as that token's identity -- a single shared identity, useful for a homelab/single-user box, unsuitable for a multi-user deployment (everyone would share one PVE identity with no per-user audit trail). Leave off unless you specifically want that. |
| `PROXION_COOKIE_SECURE`    | no                    | `NODE_ENV === 'production'`            | Whether the session cookie gets `Secure`. Override to `false` only if Proxion itself is served over plain HTTP (e.g. a private mesh network with no TLS-terminating reverse proxy) -- otherwise the browser silently drops the cookie and login appears to do nothing.                                                                      |
| `PROXION_WEB_DIST`         | no                    | resolved relative to the server module | Where the built web app is served from. The Docker image sets this itself (`/app/web/dist`); you shouldn't need to touch it.                                                                                                                                                                                                                |
| `PROXION_AGENTS`           | no                    |                                        | Optional per-node host agent, for console thumbnails without a `vncproxy` task per capture. `node=url` pairs, comma-separated. See [`agent/README.md`](../agent/README.md) and "Console thumbnails" in `apps/server/README.md`.                                                                                                             |
| `PROXION_AGENT_TOKEN`      | **yes, if `PROXION_AGENTS` is set** |                            | Bearer token sent to every configured agent.                                                                                                                                                                                                                                                                                                  |
| `PROXION_DATA_DIR`         | no                    | `./data`                              | Where per-user preferences are persisted (one JSON file per user). The Docker image sets this to `/app/data` and creates it owned by uid 1000 -- mount a named volume there (see `docker-compose.example.yml`'s `proxion_data` volume) so preferences survive container recreates. |

`PVE_URL` + login credentials (pass-through auth) are enough to run Proxion
with no service token at all -- the token is only needed for the
always-on dashboard/task feed and for the optional shared "token mode".

In token mode, the web app itself treats the shared token identity as
signed in: it skips the `/login` redirect, shows the token id in the
user menu, and disables Logout there (there is no session to end).
Visiting with neither a session nor an eligible token still redirects
to `/login`, and a successful login returns to whatever page was
originally requested.

### Get the certificate fingerprint

Run this on the Proxmox host (or any node in the cluster) and copy the
`Fingerprint (sha256)` line into `PVE_TLS_FINGERPRINT`:

```bash
pvenode cert info
```

## Reverse proxy: websockets must be proxied

Proxion's embedded console (noVNC) and terminal (xterm.js) run over
websockets at `/ws/vnc/*` and `/ws/term/*`. A reverse proxy that doesn't
forward the `Upgrade`/`Connection` headers will break both silently (the
rest of the UI keeps working). The rest of the app (`/` and `/api/*`) is
plain HTTP(S).

### nginx

```nginx
server {
    listen 443 ssl;
    server_name proxion.example.com;

    # ... ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:3080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:3080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }
}
```

### Caddy

Caddy proxies websockets by default (no special config needed for the
`Upgrade` header), so a single block covers everything:

```caddyfile
proxion.example.com {
    reverse_proxy 127.0.0.1:3080
}
```

If you're fronting Proxion with something that strips headers by default
(some CDNs, older proxies), confirm `Upgrade`/`Connection: upgrade` reach
`/ws/*` unmodified.

### Mesh-only production deployment (Caddy + Azure DNS)

For a host with no inbound public ports -- reachable only over a private
mesh (Tailscale, WireGuard, etc.) -- see
[`deploy/caddy-azure-dns/`](../deploy/caddy-azure-dns/README.md): a
ready-to-run Docker Compose kit that fronts Proxion with Caddy and gets a
real Let's Encrypt certificate via the ACME DNS-01 challenge against Azure
DNS, so nothing needs to accept inbound traffic from the public internet.

## Recommended read-only role for the service token

Phase 1 is read-only end to end -- the service token below only ever
needs audit (read) privileges, plus console access for the embedded
VNC/terminal bridges. Run these on a PVE node as root (or an equivalently
privileged user):

```bash
pveum role add ProxionReadOnly --privs "Datastore.Audit,Mapping.Audit,Pool.Audit,SDN.Audit,Sys.Audit,VM.Audit,VM.Console"
pveum user add proxion@pve
pveum acl modify / --users proxion@pve --roles ProxionReadOnly
pveum user token add proxion@pve svc --privsep 0
```

The last command prints the token's secret once -- copy it into
`PVE_TOKEN_SECRET` immediately (`PVE_TOKEN_ID` is `proxion@pve!svc`). Add
`--privsep 0` so the token inherits the user's full ACLs (a privilege-
separated token gets none by default).

## Security model

See the [README's Security model section](../README.md#security-model)
for the full picture: pass-through login, no stored PVE secrets besides
the optional service token, TLS fingerprint pinning, signed httpOnly
session cookies, and the read-only phase's write-blocking proxy.

## Local dev without a Proxmox host

`VITE_USE_FIXTURES=1 pnpm --filter @proxion/web dev` runs the web app
against static fixtures (`apps/web/src/fixtures/`) that mirror real PVE API
shapes, so the UI can be demoed or worked on with no cluster at all.
