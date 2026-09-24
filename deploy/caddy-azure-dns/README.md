# Proxion + Caddy, mesh-only, Let's Encrypt via Azure DNS

Runs Proxion behind [Caddy](https://caddyserver.com/), with Caddy getting a
real Let's Encrypt certificate through the ACME **DNS-01** challenge against
**Azure DNS** -- no port 80/443 needs to be reachable from the public
internet. Caddy is published only on the host's private mesh address
(Tailscale, WireGuard, etc.), so the whole stack has zero inbound public
exposure while still serving a browser-trusted `https://` URL.

## How this differs from `docker-compose.example.yml`

The repo root's `docker-compose.example.yml` is a minimal single-service
example that assumes you already have a reverse proxy. This kit *is* that
reverse proxy, pre-wired for the mesh-only + Azure DNS case, plus the
scripts to build, ship, and run it on a real host.

## Prerequisites

- Docker Engine + the Compose plugin (`docker compose version`) on the
  target host.
- The host has a private mesh address (e.g. Tailscale `100.x.x.x`) that is
  NOT the same as its public/CGNAT address -- this is `BIND_ADDR`.
- An Azure subscription with a DNS zone that hosts (or delegates) the
  hostname you'll use for Proxion.
- An Azure **app registration** (service principal) with the
  **"DNS Zone Contributor"** role scoped to that DNS zone (not the whole
  subscription) -- it only ever needs to create/delete the ACME `_acme-
  challenge` TXT record.
- A DNS **A record** for the hostname pointing at the host's **mesh**
  address. Let's Encrypt's DNS-01 challenge only ever looks up a TXT
  record; the A record itself can point at a private/CGNAT address with no
  effect on issuance -- it's what your browser resolves when you visit the
  site over the mesh.
- Your Proxmox VE cluster reachable from the host (see the root
  [`docs/deploy.md`](../../docs/deploy.md) and
  [`apps/server/README.md`](../../apps/server/README.md) for `PVE_*`
  details).

## 1. Create the Azure app registration, secret, and role assignment

### Azure Portal

1. **Azure Active Directory / Microsoft Entra ID** -> **App registrations**
   -> **New registration**. Name it e.g. `proxion-dns01`, leave the
   defaults, register.
2. Open it -> **Certificates & secrets** -> **New client secret** -> copy
   the secret **value** immediately (it's shown once) -> `AZURE_CLIENT_SECRET`.
3. Copy **Application (client) ID** -> `AZURE_CLIENT_ID`, and
   **Directory (tenant) ID** -> `AZURE_TENANT_ID`.
4. Go to your **DNS zone** resource -> **Access control (IAM)** -> **Add
   role assignment** -> role **DNS Zone Contributor** -> assign to the app
   registration you just created. Scoping the role to the zone (not the
   subscription) limits the blast radius of the client secret to DNS
   records in that zone alone.
5. Note the zone's **resource group** -> `AZURE_RESOURCE_GROUP`, and your
   **subscription ID** -> `AZURE_SUBSCRIPTION_ID`.

### Equivalent `az` CLI

```bash
# 1-3: app registration + secret
az ad app create --display-name proxion-dns01
APP_ID=$(az ad app list --display-name proxion-dns01 --query '[0].appId' -o tsv)
az ad sp create --id "$APP_ID"                       # service principal for the app
az ad app credential reset --id "$APP_ID" --years 1  # prints the client secret ONCE

TENANT_ID=$(az account show --query tenantId -o tsv)
SUBSCRIPTION_ID=$(az account show --query id -o tsv)

# 4: role assignment scoped to the DNS zone only
ZONE_NAME=example.com          # the zone that holds PROXION_HOST
RESOURCE_GROUP=my-dns-rg
ZONE_ID=$(az network dns zone show --name "$ZONE_NAME" \
  --resource-group "$RESOURCE_GROUP" --query id -o tsv)

az role assignment create \
  --assignee "$APP_ID" \
  --role "DNS Zone Contributor" \
  --scope "$ZONE_ID"
```

Put the resulting values into `caddy.env` (`AZURE_TENANT_ID`,
`AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SUBSCRIPTION_ID`,
`AZURE_RESOURCE_GROUP`).

### Create the A record (pointing at the mesh address)

```bash
az network dns record-set a add-record \
  --resource-group "$RESOURCE_GROUP" \
  --zone-name "$ZONE_NAME" \
  --record-set-name proxion \
  --ipv4-address 100.64.0.2   # the host's BIND_ADDR
```

That creates/updates `proxion.example.com` -> `100.64.0.2`. Only clients on
the mesh will be able to actually connect; anyone else's DNS lookup
succeeds but the connection times out, which is fine.

## 2. Get the Proxmox VE certificate fingerprint

On any PVE node:

```bash
pvenode cert info
```

Copy the `Fingerprint (sha256)` line into `PVE_TLS_FINGERPRINT` in
`proxion.env`.

## 3. Get the kit onto the host

From a developer machine, inside the repo:

```bash
HOST=user@100.64.0.2 DIR=/opt/proxion ./deploy/caddy-azure-dns/sync.sh
```

This ships the current git tree (`git archive HEAD`) straight over ssh --
no rsync, no scp, no intermediate tarball on disk, and (since `*.env` files
are gitignored/untracked) no secrets ever leave your machine this way.

## 4. Create the env files (on the host)

```bash
cd /opt/proxion/deploy/caddy-azure-dns
cp .env.example .env                       # BIND_ADDR, PROXION_HOST
cp proxion.env.example proxion.env         # PVE_*, SESSION_SECRET, ...
cp caddy.env.example caddy.env             # PROXION_HOST, ACME_EMAIL, AZURE_*
$EDITOR .env proxion.env caddy.env
```

`proxion.env`'s variable names and defaults match
[`apps/server/README.md`](../../apps/server/README.md) exactly -- when in
doubt, that's the source of truth. Generate `SESSION_SECRET` with
`openssl rand -hex 32`.

## 5. First run

```bash
./deploy.sh up
```

This pulls the published `proxion` image named by `PROXION_IMAGE` in `.env`
(`ghcr.io/c2tech-sys/proxion:<version>`), builds the Caddy image with the
Azure DNS plugin, and starts both. Caddy then runs the DNS-01 challenge and obtains the certificate; watch progress with `./deploy.sh
logs`.

Other commands:

```bash
./deploy.sh status   # container/service status
./deploy.sh logs     # follow both services' logs
./deploy.sh down     # stop and remove containers (cert data volume kept)
./deploy.sh update   # pull the PROXION_IMAGE tag from .env and recreate proxion
./deploy.sh build    # (checkout-built variant) rebuild proxion from the tree instead
```

To change one variable in `proxion.env` without typing a secret into a nested
ssh/PowerShell quoting puzzle (the value is read from a hidden prompt, never
echoed, and never passed through a shell command line):

```sh
ssh -t user@host bash /opt/proxion/deploy/caddy-azure-dns/set-env.sh PROXION_AGENT_TOKEN
```

It rewrites (or appends) that line and runs `deploy.sh update`; add
`--no-update` to only edit the file.


`deploy.sh` refuses to run any command if `.env`, `proxion.env`, or
`caddy.env` is missing, or still contains an unfilled `example.com` /
`CHANGEME` placeholder.

## Renewal

Automatic. Caddy tracks certificate expiry itself and renews well before
it, re-running the same Azure DNS-01 challenge -- no cron job, no manual
step. The certificate and Caddy's ACME account state live in the
`caddy_data` named volume, so they survive `./deploy.sh down` / `up` and
container image rebuilds.

## Troubleshooting

- **DNS-01 challenge fails / `unauthorized` from Let's Encrypt**: double-
  check `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` /
  `AZURE_SUBSCRIPTION_ID` / `AZURE_RESOURCE_GROUP`, and that the app
  registration's role assignment is **DNS Zone Contributor** scoped to the
  zone that actually holds `PROXION_HOST`. Check `./deploy.sh logs`.
- **`context deadline exceeded` / propagation timeouts**: Azure DNS
  propagation is usually fast, but a retry (`./deploy.sh up` again) is
  harmless -- Caddy backs off and retries issuance on its own too.
- **Clock skew**: ACME is time-sensitive. If the host's clock is
  significantly off, issuance fails with a generic TLS/validation error;
  confirm with `date -u` and fix NTP first.
- **App reachable but console/terminal (VNC/xterm) don't work**: Caddy's
  `reverse_proxy` forwards `Upgrade`/`Connection` headers automatically, so
  this shouldn't need extra config (see `caddy/Caddyfile`'s comment) --
  if it's still broken, confirm nothing else (a corporate proxy, a VPN
  client's own filtering) is stripping those headers between the browser
  and Caddy.
- **Login "does nothing"**: usually a cookie problem. Confirm you're
  reaching Proxion over `https://` through Caddy (not `http://host:3080`
  directly) and that `PROXION_COOKIE_SECURE=true` in `proxion.env`.

## Security notes

- Caddy's 80/443 are published on `BIND_ADDR` (the mesh IP) only -- never
  `0.0.0.0` -- so nothing here is reachable from the public internet even
  though the certificate is a real, browser-trusted one.
- `proxion` itself is published on `127.0.0.1:3080` only, reached solely
  through the `caddy` service over the compose network; it is never
  reachable directly, from the mesh or otherwise.
- `PROXION_COOKIE_SECURE=true` is set because Caddy terminates real TLS in
  front of Proxion.
- The Azure client secret only grants **DNS Zone Contributor** on one zone
  -- it cannot read or modify anything else in the subscription. Rotate it
  by repeating the "New client secret" step and updating `caddy.env`.
- `*.env` files hold real secrets and are gitignored; they're created by
  hand on the host (`sync.sh` never ships them) and are never committed.
