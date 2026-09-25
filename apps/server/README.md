# @proxion/server

The Proxion server: PVE pass-through auth, a read-only proxy to the Proxmox
VE API, a shared resource/task poller with an SSE stream, and websocket
bridges for the noVNC console and the xterm.js terminal. No database --
sessions and console tickets are held in memory and are lost on restart.

## Configuration

Validated at startup (`src/config.ts`, zod). Startup fails fast with a
readable message when a required variable is missing or malformed.

| Variable                   | Required              | Default                                | Notes                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | --------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                     | no                    | `3080`                                 |                                                                                                                                                                                                                                                                                                                                                 |
| `HOST`                     | no                    | `0.0.0.0`                              |                                                                                                                                                                                                                                                                                                                                                 |
| `NODE_ENV`                 | no                    | `development`                          | `development` \| `production` \| `test`                                                                                                                                                                                                                                                                                                         |
| `PVE_URL`                  | **yes**               |                                        | e.g. `https://pve.example.com:8006`. No trailing slash, no `/api2/json`.                                                                                                                                                                                                                                                                            |
| `PVE_TLS_INSECURE`         | no                    | `false`                                | Skip all TLS verification. Dangerous; prefer the fingerprint.                                                                                                                                                                                                                                                                                   |
| `PVE_TLS_FINGERPRINT`      | no                    |                                        | Pin to PVE's cert by SHA-256 fingerprint (`AA:BB:...`, case-insensitive).                                                                                                                                                                                                                                                                       |
| `PVE_TOKEN_ID`             | no                    |                                        | Service token id (`user@realm!tokenname`). Must be set together with `PVE_TOKEN_SECRET`, or not at all.                                                                                                                                                                                                                                         |
| `PVE_TOKEN_SECRET`         | no                    |                                        | Service token secret.                                                                                                                                                                                                                                                                                                                           |
| `SESSION_SECRET`           | **yes in production** | auto-generated                         | Signs the `proxion.sid` cookie. Outside production, an ephemeral secret is generated with a logged warning if unset (sessions won't survive a restart or be shared across instances).                                                                                                                                                           |
| `PROXION_ALLOW_TOKEN_MODE` | no                    | `false`                                | See "Token mode" below.                                                                                                                                                                                                                                                                                                                         |
| `PROXION_COOKIE_SECURE`    | no                    | `NODE_ENV === 'production'`            | Whether the `proxion.sid` cookie gets `Secure`. Override to `false` for a production deployment served over plain HTTP (e.g. behind a mesh/reverse proxy that doesn't itself terminate TLS) -- otherwise the browser silently drops the cookie and login appears to do nothing. Override to `true` outside production to test with `Secure` on. |
| `PROXION_WEB_DIST`         | no                    | resolved relative to the server module | Overrides the directory the built web app (`apps/web/dist`) is served from in production. Set this when that directory isn't in its default location relative to the server -- e.g. the Docker image sets it to `/app/web/dist` after `pnpm deploy` relocates the server package.                                                               |
| `PROXION_AGENTS`           | no                    |                                        | Per-node [proxion-agent](../../agent/README.md) hosts, `node=url` pairs comma-separated, e.g. `pve1=http://100.64.0.10:9420,pve2=http://100.64.0.11:9420`. See "Host agent" below. A node not listed here (or this unset entirely) always uses the existing VNC capture.                                                                     |
| `PROXION_AGENT_TOKEN`      | **yes, if `PROXION_AGENTS` is set** |                            | Bearer token sent to every configured agent (one shared token for all of them).                                                                                                                                                                                                                                                                 |
| `PROXION_AGENT_TIMEOUT_MS` | no                    | `8000`                                | How long to wait for an agent's `/screenshot/<vmid>` or `/health` before treating it as unreachable/timed out.                                                                                                                                                                                                                                  |
| `PROXION_DATA_DIR`         | no                    | `./data`                              | Where per-user data (currently: preferences) is persisted. Relative to the process cwd; the Docker image sets this to `/app/data`. Created on startup (mode `0700` where the platform honors a directory mode); startup fails with a clear message if the path exists but isn't writable. See 'Preferences' below. |

Boolean env vars (`PVE_TLS_INSECURE`, `PROXION_ALLOW_TOKEN_MODE`) accept an
explicit `true`/`1`/`yes`/`on` or `false`/`0`/`no`/`off`/empty spelling
(via zod 4's `z.stringbool()`) -- unlike a naive `Boolean(str)` coercion,
`"false"` and `"0"` both correctly parse as `false`.

## Auth

- **`POST /api/auth/login`** `{ username, password, realm? }` -- calls PVE's
  `POST /access/ticket` (username sent as `user@realm`; `realm` defaults to
  `pam` when not embedded in `username` or passed separately). On success,
  stores `{ ticket, csrfToken, username, capabilities }` in an in-memory
  session keyed by an opaque id, and sets it as an httpOnly, `SameSite=Lax`,
  **signed** cookie named `proxion.sid` (`Secure` per `PROXION_COOKIE_SECURE`,
  above).
  Returns `{ username, realm, capabilities }`. PVE actually rejecting the
  credentials (401) -> `401 { error: 'Invalid credentials' }` (PVE's own
  error detail is never echoed back). PVE being unreachable -- network/TLS
  failure, timeout, or any other non-2xx/unusable response -- is a _different_
  failure and is never reported as bad credentials: `502 { error: 'Proxmox
VE unreachable' }`. Rate-limited to 10 requests/minute/IP.
- **`GET /api/auth/me`** -- the current session's `{ username, realm,
capabilities, mode: 'session' }`; with no session but token mode eligible
(see "Token mode" below), `{ username: <PVE_TOKEN_ID>, realm: 'token',
capabilities: {}, mode: 'token' }`; otherwise `401`.
- **`POST /api/auth/logout`** -- deletes the session and clears the cookie.
- **Ticket renewal**: a session older than 1 hour is transparently renewed
  (`POST /access/ticket` with `password=<current ticket>`) the next time it's
  used. Renewal failure is split the same way as login: PVE actually
  rejecting the ticket logs the session out (deleted; the next request sees
  `401`); PVE merely being unreachable keeps the session as-is (same ticket,
  `lastRenewedAt` untouched) and simply retries renewal on the next request,
  rather than logging a user out over a network blip.
- **Token mode**: when `PROXION_ALLOW_TOKEN_MODE=true` _and_ a service token
  is configured, any request with **no** session is treated as that token's
  identity (a single shared identity -- intended for homelabs/dev, not
  multi-user deployments). Off by default. This is also what `/api/auth/me`
  reports (`mode: 'token'`, above) when there's no session -- the web client's
  auth gate treats that the same as a real session (signed in, no `/login`
  redirect), just with Logout disabled (there's no session to end). A real
  session always takes priority over the token identity when both apply.
- Every downstream PVE call is made through `pveForRequest`
  (`src/pve/identity.ts`'s `resolveIdentity`), the single place that decides
  whether a request uses the caller's session ticket or the service token.

## Read-only PVE proxy

**`GET /api/pve/*`** forwards to `${PVE_URL}/api2/json/*` with the resolved
caller's credentials, passing the query string through unchanged, and
returns PVE's JSON response body and status **verbatim** (the envelope is
_not_ unwrapped), minus hop-by-hop headers. The browser's own cookies are
never forwarded upstream -- headers sent to PVE are always built fresh from
the resolved identity (a ticket credential is sent URL-encoded, matching the
stock UI; PVE URI-unescapes it).

The requested suffix is resolved against `${PVE_URL}/api2/json/` and the
result must still be inside `/api2/json/` (`buildUpstreamUrl` in
`src/proxy/pveProxy.ts`) -- a `400` is returned for a suffix that would
escape it via `..` segments (plain or percent-encoded) or a protocol-relative
(`//host/...`) prefix, before anything is sent to PVE.

Non-`GET` methods (`POST`/`PUT`/`DELETE`/`PATCH`) to `/api/pve/*` return
`405` unconditionally -- this proxy is permanently read-only.
`WRITE_ENABLED` (`src/proxy/pveProxy.ts`) documents that; it is not a
feature flag anyone flips. The only writes this server performs go through
the allow-listed route below instead of a generic write pass-through.

## Guest actions

**`POST /api/actions/guest/:node/:type/:vmid/:action`** is the one write
this server performs against PVE: a single guest power action, from a fixed
allow-list, never an arbitrary write. `type` is `qemu` or `lxc`; `action` is
one of `start`, `shutdown`, `stop`, `reboot`, `reset`, `suspend`, `resume` --
`reset`/`suspend`/`resume` are qemu-only (PVE either has no lxc equivalent,
or it's out of scope here). An optional JSON body carries `timeout` (seconds,
`1..3600`, for `shutdown`/`reboot`) and `forceStop` (boolean, `shutdown`
only, sent to PVE as `forceStop=1`). The body is validated strictly: an
unrecognised field -- most importantly `skiplock`, which this route never
accepts or forwards -- is a `400`, not a silently-ignored extra.

Request flow, in order:

1. `node`/`type`/`vmid`/`action` and the body are validated; a bad value or
   an lxc-only-invalid action is `400`.
2. The caller's identity is resolved the same way every other endpoint does
   (`resolveIdentity`) -- no identity is `401`.
3. A **session** identity is required: the shared service token
   (`PROXION_ALLOW_TOKEN_MODE`) is read-only, same as the raw proxy, and a
   token-mode caller gets `403 { error: "writes-disabled-in-token-mode" }`
   here regardless of what the token itself could do against PVE directly.
4. The caller's own `VM.PowerMgmt` permission on `/vms/{vmid}` is checked
   via `GET /access/permissions` (their own credentials, not this server's) --
   missing it is `403 { error: "forbidden", missing: "VM.PowerMgmt" }`.
5. The action is sent to PVE as one explicit, generated-endpoint-checked
   `POST /nodes/{node}/{type}/{vmid}/status/{action}` call (never a path
   built from the raw `action` string) and, on success, this route responds
   `202 { upid }` with the task's UPID.

Errors from PVE are re-mapped, never relayed verbatim: a `5xx` or a
transport/network failure is `502 { error: "pve-unreachable" }`; a PVE
`4xx` (e.g. "already running") is passed through at the same status as
`{ error: "pve-rejected", message }`, with `message` sanitised (control
characters stripped, capped at 300 characters). Each successful action logs
one `info` line (username, node, type, vmid, action, upid) -- never the
session ticket. Requests are rate-limited to 30/minute per session (per
caller IP with no session, which cannot happen here since token-mode is
already refused), a bucket shared with the config route below.

**`PATCH /api/actions/guest/:node/:type/:vmid/config`** is the other write
this server performs against PVE: renaming a guest and/or replacing its
notes (the PVE `description` config field), never any other config key. The
JSON body is `{ name?: string; description?: string }`, strictly validated
-- an unknown key or an empty body (neither key present) is `400`.

- `name` must be a valid dns-name: dot-separated labels of letters, digits
  and inner hyphens (1-63 characters each), the whole string capped at 253
  characters for qemu (`name`) or 255 for lxc (`hostname`) -- anything else
  is `400 { error: "invalid-name", message }`.
- `description` is capped at 8192 characters (PVE's own limit) and may be
  empty (clears the notes); its line endings are normalised to `\n` and
  every control character other than `\n`/`\t` is stripped before it's sent
  to PVE.

Identity, token-mode and rate-limit handling are exactly as the power-action
route above, and the two share one 30/minute bucket. The permission checked
is `VM.Config.Options` on `/vms/{vmid}` (missing it is
`403 { error: "forbidden", missing: "VM.Config.Options" }` -- a caller with
only `VM.PowerMgmt` is still refused, since these are different privileges).
The update goes out as one `PUT /nodes/{node}/{type}/{vmid}/config` call
(qemu: `name`/`description`; lxc: `hostname`/`description`) -- PVE's config
PUT is synchronous, so a success responds `200 { ok: true, changed }` with
the list of keys that were actually sent, not a UPID. Errors from PVE are
mapped the same way as the power-action route. Each successful update logs
one `info` line (username, node, type, vmid, changed) -- never the name or
description text itself.

**`POST /api/actions/guest/:node/:type/:vmid/snapshots`** creates a snapshot.
The JSON body is `{ snapname: string; description?: string; vmstate?: boolean }`,
strictly validated -- an unknown key is `400`. `snapname` must start with a
letter, then letters/digits/underscores/hyphens, 2-40 characters total, and
must not be `current` (PVE's reserved live-state sentinel); a bad name is
`400 { error: "invalid-snapname", message }`. `description` is capped at
8192 characters and sanitised exactly like the config route's own
`description` (line endings normalised, control characters stripped, never
logged). `vmstate` (include RAM) only applies to qemu guests -- sending it
for an lxc guest is `400`. The permission checked is `VM.Snapshot` on
`/vms/{vmid}` (missing it is `403 { error: "forbidden", missing:
"VM.Snapshot" }`). The create goes out as one `POST
/nodes/{node}/{type}/{vmid}/snapshot` call (qemu accepts `vmstate`; lxc's
endpoint has no such parameter) -- PVE's snapshot create is asynchronous, so
a success responds `202 { upid }`, same as the power-action route.

**`DELETE /api/actions/guest/:node/:type/:vmid/snapshots/:snapname`** deletes
a snapshot -- the same name rule applies (`current` is `400`). An optional
`?force=1` query param is forwarded to PVE as `force`. Permission, identity,
token-mode and error-mapping are exactly as the create route above, checking
`VM.Snapshot` again, and it goes out as `DELETE
/nodes/{node}/{type}/{vmid}/snapshot/{snapname}`, responding `202 { upid }`.

**`POST /api/actions/guest/:node/:type/:vmid/snapshots/:snapname/rollback`**
rolls a guest back to a snapshot -- the same name rule applies. The JSON body
is `{ start?: boolean }`; `start` (start the guest after rolling back) is
qemu-only -- sending it for an lxc guest is `400`, since lxc's rollback
endpoint has no such parameter. This is the one snapshot route with its own,
stricter permission: `VM.Snapshot.Rollback` on `/vms/{vmid}` (missing it is
`403 { error: "forbidden", missing: "VM.Snapshot.Rollback" }` -- `VM.Snapshot`
alone is not enough, since a rollback discards data a plain snapshot
operation never does). It goes out as `POST
/nodes/{node}/{type}/{vmid}/snapshot/{snapname}/rollback`, responding
`202 { upid }`.

All three snapshot routes share the same 30/minute rate-limit bucket as the
power-action and config routes above, and log one `info` line per request
(username, node, type, vmid, snapname, upid) -- never the description.

## Live state: poller + SSE

Only active when a service token (`PVE_TOKEN_ID` + `PVE_TOKEN_SECRET`) is
configured, independent of `PROXION_ALLOW_TOKEN_MODE` -- this is the shared,
cluster-wide feed, not a per-user one.

- Polls `GET /cluster/resources` every 2s and `GET /cluster/tasks` every 3s
  using one cached `PveClient` for the service token, keeping the latest
  snapshot of each.
- On its own, slower (60s) timer, also fetches each node's `vzdump` task
  history (`GET /nodes/{node}/tasks?typefilter=vzdump&since=<now-24h>&
  limit=500&source=all`, nodes taken from the latest resources snapshot) --
  a failed fetch logs a warning and keeps that node's last known history
  rather than dropping it. That history is merged with the fast cluster
  task list by UPID and fed to `@proxion/core`'s `computeAlerts` (see
  `docs/architecture.md` for the backup-incident rule this implements) to
  produce `snapshot.alerts`, recomputed on every cluster-task poll too (not
  just the slow history one) so a healed backup shows up within seconds.
- **`GET /api/state`** -- the latest `{ resources, tasks, alerts }`
  snapshot, or `503` when the poller is disabled (the client should fall
  back to polling `/api/pve/cluster/resources` etc. per-user through the
  proxy).
- **`GET /api/events`** -- an SSE stream (`text/event-stream`). Sends a
  `snapshot` event with `{ resources, tasks, alerts }` on connect, then a
  `resources`, `tasks` or `alerts` event (payload only) whenever that poll's
  result actually changed (deep-compared against the previous one) -- not on
  every poll. A `:heartbeat` comment is sent every 15s. `503` when the
  poller is disabled.

## TLS policy (to PVE)

Every HTTP call to PVE shares **one** undici `Agent` built once at boot
(`src/pve/dispatcher.ts`); every upstream console websocket shares **one**
`https.Agent`, also built once. Neither is rebuilt per request or per
session -- only the credentials passed to `PveHttp`/`ws` vary.

- Default: normal certificate verification (hostname + chain of trust).
- `PVE_TLS_FINGERPRINT` set: pin to that SHA-256 fingerprint (via
  `@proxion/pve-api`'s `createTlsAgent`/`createPinnedHttpsAgent`); chain and
  hostname checks are skipped in favor of the pin, since PVE's default cert
  is self-signed.
- `PVE_TLS_INSECURE=true` (and no fingerprint): skip all verification.
  Dangerous; prefer the fingerprint.

`checkServerIdentity` is deliberately not used for pinning -- Node skips it
once the chain fails, which would silently accept _any_ self-signed cert.

## Console bridges

PVE tickets never reach the browser. Starting a console session returns an
**opaque, single-use, 60-second-TTL** id that maps (server-side only) to the
node/type/vmid/port/ticket/credentials needed to open the real upstream
connection. Session ids (`proxion.sid`) and these console handle ids are both
`randomBytes(32).toString('base64url')` -- 256 bits of entropy, comfortably
over the 128-bit floor for an unguessable id (a v4 UUID, by contrast, only
has 122 random bits).

### VNC (noVNC)

- **`POST /api/console/vnc/:node/:type/:vmid`** (`type` = `qemu` \| `lxc`)
  calls PVE's `vncproxy` (`websocket=1`, and `generate-password=0` for
  `qemu`) and returns `{ wsPath: "/ws/vnc/<id>", password: "<vncticket>" }`
  -- `password` is PVE's own VNC ticket, which doubles as the RFB auth
  password the noVNC client sends.
- **`GET /ws/vnc/:id`** (websocket): opens an upstream connection to
  `wss://<pve host>/api2/json/nodes/{node}/{type}/{vmid}/vncwebsocket?port=<port>&vncticket=<urlencoded>`
  with the caller's credentials as headers (`Cookie:
PVEAuthCookie=<urlencoded ticket>` or `Authorization:
PVEAPIToken=<id>=<secret>`), subprotocol `binary`, and the same TLS policy
  as above. Binary frames are piped both ways. If the _browser_ closes or
  errors first, the upstream connection is simply torn down; if the
  _upstream_ closes or errors first, the browser is sent a real close frame
  (code `4502`, reason `"Upstream PVE connection failed"`) instead of
  dropping silently.

### Terminal (xterm.js)

- **`POST /api/console/term/:node`** (node shell), **`POST
/api/console/term/:node/:type/:vmid`** (`lxc` console; `qemu` serial0)
  call the matching `termproxy` endpoint and return `{ wsPath:
"/ws/term/<id>" }` -- no ticket in the response body.
- **`GET /ws/term/:id`** (websocket): opens an upstream connection to the
  _same endpoint family as VNC_ (`.../vncwebsocket?port=&vncticket=`; a node
  shell uses `/nodes/{node}/vncwebsocket`), subprotocol `binary`. Immediately
  sends `${user}:${ticket}\n` upstream (never logged) and waits for the
  literal `OK` reply before relaying anything further -- **including any
  frame the browser already sent**: browser->upstream frames are buffered
  (not just delayed) until `OK` actually arrives, since PVE is still reading
  the auth line up to that point and anything sent early can corrupt it or
  be silently dropped. If PVE replies with anything other than `OK`, or
  closes the connection before replying at all, the browser socket is closed
  with code `4502` and reason `"PVE terminal handshake failed"` rather than
  hanging.

  **Browser-facing framing** (for the web client to implement; the server
  forwards these unchanged upstream once the handshake above completes, and
  relays raw upstream output straight back to the browser):
  - Keystrokes: text frame `0:<byteLength>:<data>`
  - Resize: text frame `1:<cols>:<rows>:`
  - Ping (every 30s, keeps the connection alive): text frame `2`

### Console thumbnails

A server-rendered PNG screenshot of a guest's display, for a dashboard/list
view -- no browser-side noVNC session needed just to show a preview. Built
from a minimal, pure-TypeScript RFB 3.8 client (`src/console/rfbSnapshot.ts`,
`src/console/des.ts`) that drives the *same* `vncproxy`/`vncwebsocket` path
and TLS policy as the interactive VNC bridge above (`openUpstreamConsoleSocket`),
just headlessly and for one frame. Node's OpenSSL 3 build doesn't ship
single-DES in its default provider, so VNC Authentication's DES step is
implemented directly rather than pulled in as a native dependency.

- **`GET /api/console/thumbnail/:node/:type/:vmid.png?w=<px>&refresh=0|1`**
  (`type` = `qemu` \| `lxc`) -- requires an identity (`401` otherwise, same
  as every other console/PVE route).
  - **Permission**: calls `GET /access/permissions?path=/vms/{vmid}` with the
    caller's identity and requires `VM.Console` truthy in the response
    (`403` otherwise) -- a token-mode identity is checked the same way, as
    the token's own permissions.
  - **Running check**: calls `status/current` for the guest; if it isn't
    `running`, responds `404 { error: 'not-running' }` with
    `Cache-Control: no-store` (no capture is attempted).
  - **Success**: `image/png` body, `Cache-Control: private, max-age=30`,
    `X-Proxion-Captured-At: <ISO 8601>`, and `X-Proxion-Source: cache` or
    `live` depending on whether this response came from the in-memory cache
    or a fresh capture.
  - **`w`** (default `400`, max `800`): target thumbnail width in px. The
    captured frame is downscaled to `w` with a simple box filter, preserving
    aspect ratio -- never upscaled (a guest whose actual display is narrower
    than `w` is returned at its native width).
  - **Cache**: in-memory, one entry per guest, keyed by `(node, type, vmid)`.
    A capture is stored once at 800px (the `w` maximum) and every narrower
    `w` is derived from it and memoised, so the dashboard tile (400) and the
    VM page (800) share one VNC session per guest. A successful capture is
    cached for 60s; a *failed* capture is also cached, but only for 15s (so a
    broken/booting VM doesn't get hammered with a fresh handshake attempt on
    every request, but also doesn't stay marked broken for long).
    `refresh=1` bypasses a cache **hit** to force a fresh capture, but is
    itself throttled to one live capture per VM per 15s over VNC (2s when the
    node has a host agent: a local screendump is cheap and leaves no
    task-log entry) -- a throttled
    `refresh=1` request serves the cached PNG instead, still with
    `X-Proxion-Source: cache`. (If nothing is cached yet, a throttled
    `refresh=1` captures anyway -- there's nothing to fall back to.)
  - **Coalescing**: requests for a guest whose capture is already running or
    queued (any `w`, any caller) join that capture instead of starting
    another; they all get the same frame with `X-Proxion-Source: live`.
  - **Concurrency**: at most 3 live captures in flight globally (across all
    VMs/callers). A request that arrives while all 3 slots are busy queues
    for up to 30s -- long enough for the tail of a dashboard burst of 15-20
    guests; if no slot frees up in that time, `503 { error: 'busy' }`. The
    web client treats `busy` as "still loading" and retries a few seconds
    later rather than showing an error.
  - **Failures** -- a failed handshake, a timeout, or a decode error --
    respond `503 { error: 'capture-failed' }` with `Cache-Control: no-store`.
    VNC tickets are never logged, only a generic failure message.
  - **LXC**: the same `vncwebsocket` path is attempted (Proxmox renders a
    container's tty over VNC too); a failure is just another `capture-failed`.
- **`GET /api/console/thumbnail/status`** -- requires an identity (`401`
  otherwise). Returns `{ inFlight: <0-3>, cached: [{ node, type, vmid,
capturedAt, capturePath }], agents: [{ node, url, ok, version?, checkedAt }]
}` -- the current live-capture count, one row per VM with a cached
  (successful) thumbnail (`capturePath`: `'agent'` or `'vnc'`, see "Host
  agent" below), and one row per configured agent's last-known health, for a
  UI's freshness/health display.

### Host agent

An optional per-node "proxion-agent" process (see
[`agent/README.md`](../../agent/README.md)) returns a QEMU screendump as PNG
directly from the host, without going through the PVE API -- so it leaves no
`vncproxy` task in the task log. Configure it with `PROXION_AGENTS` (see the
table above); a node not listed there always uses the VNC capture described
above.

- **Strategy** (`thumbnailService.ts`'s `captureFrame`): for a `qemu` guest
  whose node has a configured agent, the agent is tried first
  (`GET /screenshot/<vmid>` on the agent, via `agentClient.ts`). LXC always
  uses VNC -- the agent only covers `qemuscreendump`.
  - **Agent success**: the frame is used as the cached master, same as a VNC
    capture, but tagged `capturePath: 'agent'`.
  - **Agent reports `not-running`** (`404`): the guest's status can have
    changed between the route's own `status/current` check and the capture
    itself -- the agent's view is authoritative at capture time, so this is
    reported as `404 { error: 'not-running' }`, same as the route's own
    check, rather than a `503`.
  - **Agent failure** (timeout, unreachable, `busy`/`capture-failed`, a bad
    image, ...): logged as a warning (reason, node, vmid) and the request
    **falls back to VNC** for that capture -- a stopped or broken agent
    degrades to today's VNC-only behaviour rather than failing outright.
  - **`401` (`agent-unauthorized`)**: the one exception -- a misconfigured
    `PROXION_AGENT_TOKEN` is loud rather than silently degrading every
    request to the slower VNC path. The capture is reported as
    `capture-failed` with **no VNC fallback**, and a warning is logged once
    per process (not once per request).
- **Response header**: a successful capture's response carries
  `X-Proxion-Capture: agent` or `vnc` alongside the existing
  `X-Proxion-Source` (`cache`/`live`) -- the two are independent: a cache hit
  can be serving a master that was originally captured via either path.
- **Health** (`/api/console/thumbnail/status`'s `agents` array): each
  configured agent's `GET /health` is probed at most once every 60s and
  cached; a request for `status` never waits on a slow/dead agent longer
  than 2s -- past that it returns the last known state (or `ok: false` if
  there is none yet), while the probe keeps running in the background for
  the next call to pick up.

**Capture protocol** (`rfbSnapshot.ts`, driven over the upstream websocket's
binary frames as raw RFB bytes): ProtocolVersion handshake (`RFB 003.008\n`
both ways) -> Security handshake, selecting VNC Authentication (type 2) ->
16-byte challenge, answered with VNC Authentication's classic (if
undocumented) DES response: the vncticket's first 8 bytes, zero-padded/
truncated to 8, each byte *bit-reversed*, used as the DES key to encrypt the
challenge as two independent 8-byte ECB blocks -> SecurityResult -> ClientInit
(shared) / ServerInit (framebuffer size) -> `SetPixelFormat` (32bpp, 24-depth,
little-endian, R/G/B at byte shifts 16/8/0) -> `SetEncodings` (Raw only) ->
one non-incremental, full-framebuffer `FramebufferUpdateRequest`. Rects are
accumulated (handling `FramebufferUpdate` split across any number of Raw
rects, plus `SetColourMapEntries`/`Bell`/`ServerCutText` skipped correctly)
until the whole framebuffer has arrived or 6s elapse; a partial frame is
still accepted if at least 90% of pixels arrived, otherwise the capture
fails. The upstream socket is always closed afterward -- this is a one-shot
capture, not a kept-open session.

## Preferences

Per-user settings (theme, default Monitor range, console thumbnail on/off and
refresh interval, rail width, density) that follow the signed-in user across
browsers -- one JSON file per user under `<PROXION_DATA_DIR>/prefs/`, not a
database. See `src/prefs/schema.ts` for the exact fields/defaults.

- **`GET /api/prefs`** -- requires an identity (`401` otherwise). Returns the
  caller's stored document merged over defaults (a field missing from an
  older stored document, or never saved at all, just reads back as its
  default -- there's no separate "has this user saved anything yet?" state),
  plus `readOnly: boolean`.
- **`PUT /api/prefs`** (full document) / **`PATCH /api/prefs`** (partial) --
  validated against the same schema (unknown keys dropped, an invalid value
  `400`s); rate-limited to 20 writes/minute per session (bucketed by the
  session cookie, so one signed-in user's writes never eat into another
  user's quota behind the same NAT/proxy). Both respond with the document
  actually stored, same shape as `GET`.
- **Token mode**: a shared service token is not a person. `GET` returns
  `{ ...defaults, readOnly: true }` rather than reading/creating a file for
  the token id, and `PUT`/`PATCH` both `403 { error:
  'prefs-read-only-in-token-mode' }` without writing anything.
- **Storage**: `src/prefs/store.ts`'s `PrefsStore` -- the username is
  sanitised into a filename (lower-cased, anything outside `[a-z0-9@._-]`
  including `/` and `\` becomes `_`, truncated to 128 chars, never empty) so
  neither a crafted username nor a token id containing unusual characters
  can escape `<dir>/prefs/`. Writes are atomic (temp file + rename) and
  serialised per user (concurrent `PATCH`es for the same user merge onto
  each other in order rather than racing); reads are cached in memory,
  revalidated by the file's mtime.
- **`PROXION_DATA_DIR`** is created on startup (`0700` where the platform
  honors a directory mode) and startup fails with a clear message if it
  exists but isn't writable -- see the config table above. Never logs a
  document's contents, only paths.

## Testing

`pnpm --filter @proxion/server test` runs the full suite against local fixtures
only -- no real Proxmox host is contacted:

- `test/config.test.ts` -- env validation, including the boolean-coercion
  cases (`"false"`/`"0"`/`""` -> `false`, `"true"`/`"1"` -> `true`) and
  `PROXION_COOKIE_SECURE`'s NODE_ENV-derived default.
- `test/idEntropy.test.ts` -- session and console handle ids are base64url,
  > =128 bits, and unique over 1000 draws.
- `test/auth.test.ts`, `test/proxy.test.ts` -- login/session/renewal/logout
  and the read-only proxy, against a tiny local Fastify server standing in
  for PVE (`test/helpers/fakePve.ts`); the 401-vs-502 split for both login
  and renewal (PVE rejecting vs. PVE being unreachable); `GET /api/auth/me`'s
  token-mode identity across every `PROXION_ALLOW_TOKEN_MODE`/token-configured
  combination, and that a real session still wins over it; also proves the
  shared PVE dispatcher
  is built once at boot and reused (not rebuilt per request/session).
- `test/poller.test.ts` -- the poller's diff-and-emit behavior, with fake
  timers; also the vzdump-history merge (a failed-then-healed backup
  recomputing `snapshot.alerts` to `healed`) and a failed history fetch
  keeping the last known per-node history.
- `test/events.test.ts` -- `/api/state` and `/api/events` (503 when
  disabled; snapshot then change-only events end-to-end; a failed vzdump
  then an OK, via `test/helpers/fakePve.ts`'s `/nodes/:node/tasks` stub,
  producing a `healed` alert in both `/api/state` and the SSE stream).
- `test/spaFallback.test.ts` -- the production SPA fallback (GET/HEAD only;
  missing assets 404; non-GET never serves `index.html`).
- `test/console.test.ts` -- the VNC and terminal bridges (including the
  `user:ticket` / `OK` handshake) against a local `ws.WebSocketServer`
  standing in for PVE.
- `test/console.tls.test.ts` -- proves a wrong `PVE_TLS_FINGERPRINT` refuses
  the _upstream_ console connection (and closes the browser socket), and
  that a matching fingerprint works, against a real local self-signed HTTPS
  server (same technique as `packages/pve-api/test/tls.test.ts`).
- `test/des.test.ts` -- the pure-TS DES implementation against the classic
  FIPS/textbook known-answer vector (key `133457799BBCDFF1`, plaintext
  `0123456789ABCDEF` -> ciphertext `85E813540F0AB405`) plus a second
  independent vector, key sensitivity, and the VNC-specific bit-reversed-key
  derivation (`vncDesKey`/`vncAuthResponse`).
- `test/thumbnail.test.ts` -- the full `GET /api/console/thumbnail/...`
  endpoint end-to-end against `test/helpers/fakeRfbServer.ts` (a scripted
  RFB 3.8 + VNC Authentication server that verifies the client's DES
  response and delivers a `FramebufferUpdate` as **two** rects in four
  solid quadrant colours): a live capture decodes to a correctly downscaled
  PNG with the expected corner colours; never-upscale; `401`/`403`
  (`fakePve`'s `/access/permissions` without `VM.Console`)/`404
not-running`; cache hit vs. live (`X-Proxion-Source`); per-width cache
  keys; the `refresh=1` throttle falling back to cache; the `status`
  endpoint; a VNC-auth handshake failure mapping to `503 capture-failed`;
  and the route's mapping of a `busy` outcome to `503`.
- `test/thumbnailService.test.ts` -- `ConsoleThumbnailService`'s
  cache/concurrency/throttle logic in isolation, with an injectable
  `captureImpl` and small injected TTLs/timeouts (real captures aren't
  involved) -- the concurrency limiter queuing a request behind a full set
  of in-flight captures and running it once a slot frees, `busy` once a
  queued request waits longer than its wait budget, a capture rejection
  still releasing its slot, per-`(node,type,vmid,w)` cache keys, the
  refresh throttle, and the short-lived failure cache expiring on its own
  schedule.

- `test/prefs.test.ts` -- `PrefsStore` in isolation: username sanitisation
  (including `../`/`..\` and other separators never surviving into the
  filename), atomic writes, defaults-merge for a missing/partial/corrupt
  document, and serialised concurrent writes for one user.
- `test/prefsRoutes.test.ts` -- the `/api/prefs` endpoints end-to-end: `401`
  with no identity, a session's `GET`/`PUT`/`PATCH` round-trip, `400` on an
  invalid document, token mode's read-only `GET` and `403` writes, and the
  write rate limit.

No live-PVE test exists in this package; none of `PVE_URL` etc. are set on
this machine by default.
