# Architecture

One page. For deployment details see [deploy.md](deploy.md); for the
server's exact request/response shapes see
[`apps/server/README.md`](../apps/server/README.md).

## The packages

```
apps/web        @proxion/web     React (Vite, Tailwind v4, shadcn/ui, TanStack Router/Query)
apps/server     @proxion/server  Fastify: auth, proxy, actions, pollers, console bridges
packages/pve-api @proxion/pve-api  Generated Proxmox VE API client + TLS helpers
packages/core    @proxion/core     Pure, dependency-free domain logic shared by web + server
```

`apps/web` never talks to Proxmox directly. Everything goes through
`apps/server`, which is the only thing that holds PVE credentials, and
which itself is built on `@proxion/pve-api` for the actual HTTP calls
and TLS handling.

```
 Browser                    Proxion server (Fastify)                Proxmox VE
+--------+   HTTPS/JSON    +---------------------------+    HTTPS   +----------+
| web app| --------------> | /api/pve/*   (read-only)   | ---------> | REST API |
| (Vite/ | <-------------- | /api/actions/* (allow-list)| <--------- | /api2/   |
| React) |   SSE /events   | /api/auth/*  /api/prefs/*  |            | json     |
|        | --------------> | cluster poller             |            +----------+
|        |   websocket     +---------------------------+
|        | <-------------> | /ws/vnc/*  /ws/term/*      |  websocket
+--------+                 +---------------------------+  ------------> vncwebsocket
```

## `@proxion/core`: the backup-incident rule

The dashboard alerts strip used to treat any task that ended in error in the last 24h as a
standing alert -- naive for `vzdump`: the owner's backup agent retries a failed VM a few minutes
later (a forced-full retry can take hours), so a failure that was healed by a later `OK` kept
showing as an error all day. `packages/core`'s `computeBackupIncidents` fixes this by grouping a
task list's `vzdump` entries per `(node, vmid)` and turning each run of failures into an
incident: **soft** on the first failure, **healed** once a later run completes `OK` (at the time
that retry finished), and **hard** once it has 3 distinct failures or 6h pass after the latest
failure with no completed retry and none running -- a retry that lands later still heals it. It's recomputed from
raw task history on every call rather than stored, so it's retroactive by construction: an
incident that looked hard a moment ago quietly becomes `healed` the instant a later `OK` for that
guest enters the look-back window. `computeAlerts` wraps this (plus the unchanged
other-task-failure and storage-full rules) into the `Alert[]` both the server's poller
(`snapshot.alerts`, merging the fast cluster task list with a slower per-node vzdump-history poll
by UPID) and the web app's fixture mode compute, so the exact same rule and wording run on both
sides.

## Auth model

- **Pass-through login**: `POST /api/auth/login` calls PVE's own
  `POST /access/ticket` with the credentials the user typed; Proxion never
  stores a password. Only the resulting PVE ticket is kept.
- **Session cookie**: the ticket lives server-side, in memory, keyed by an
  opaque session id. The browser only ever holds `proxion.sid` -- a signed,
  httpOnly, `SameSite=Lax` cookie (`Secure` by default in production). PVE
  tickets never reach the browser.
- **Ticket renewal**: a session older than an hour is transparently
  renewed on next use. PVE rejecting the renewal logs the session out; PVE
  merely being unreachable leaves the session as-is and retries later.
- **Token mode** (`PROXION_ALLOW_TOKEN_MODE`, **off by default, off in
  production**): when a service token is configured and this is `true`,
  an unauthenticated request is treated as that token's identity -- one
  shared identity, meant for a homelab/single-user box. A real session
  always wins over it. The service token itself is also what drives the
  always-on cluster poller regardless of this setting.

## Read-only proxy + allow-listed actions

Two very different routes, on purpose:

- **`GET /api/pve/*`** -- a thin, permanently read-only proxy. It forwards
  to `${PVE_URL}/api2/json/*` with the resolved caller's credentials and
  returns PVE's response verbatim. Any non-`GET` method is `405`
  unconditionally; this is not a feature flag anyone flips.
- **`POST /api/actions/guest/:node/:type/:vmid/:action`** -- the one write
  path, and it is deliberately narrow: a fixed allow-list of guest power
  actions (`start`/`shutdown`/`stop`/`reboot`/`reset`/`suspend`/`resume`),
  never an arbitrary write. It requires a **session** identity (token mode
  is refused, `403`), re-checks the caller's own `VM.PowerMgmt` permission
  against PVE directly, and only then issues one explicit
  `POST /nodes/{node}/{type}/{vmid}/status/{action}` call. Future writes
  (migrate, snapshots -- see the README's roadmap) follow the same shape:
  their own route, their own permission check, their own allow-list.

## Console bridges

Interactive VNC (`/ws/vnc/*`) and terminal (`/ws/term/*`) both start with a
`POST` that opens the upstream PVE `vncproxy`/`termproxy` session and
returns an **opaque, single-use, 60-second-TTL** id -- never a PVE ticket --
which the server maps to the real upstream connection when the browser
opens the matching websocket. If the upstream side closes or errors first,
the browser gets a real close frame instead of silently hanging.

## Console thumbnails: VNC vs. host agent

A dashboard/summary preview needs one still frame, not a live session:

- **Default (VNC)**: the server drives a minimal, pure-TypeScript RFB
  client over the same `vncproxy` path as the interactive console, for one
  frame, then closes it. Simple, works everywhere, but logs a `vncproxy`
  task in PVE per capture.
- **Optional host agent** (`agent/`, per node, via `PROXION_AGENTS`): a
  small process on the PVE node itself that reads a QEMU guest's
  screendump straight off its QMP socket and serves it over HTTP. No PVE
  API call, no task-log entry. The server tries the agent first for `qemu`
  guests on a configured node and falls back to VNC if the agent is
  missing or fails; `lxc` always uses VNC (the agent only covers QEMU).

Either path's result is cached in memory per guest (60s success / 15s
failure) and capture is coalesced/rate-limited so a dashboard full of
guests doesn't open dozens of simultaneous VNC sessions.

## Preferences store

Per-user settings (theme, density, default Monitor range, thumbnail
on/off + refresh interval, inventory rail width) follow a signed-in user
across browsers via `GET`/`PUT`/`PATCH /api/prefs`. Storage is one JSON
file per (sanitised) username under `<PROXION_DATA_DIR>/prefs/` -- not a
database -- with atomic writes and per-user write serialization. A shared
service token isn't a person: in token mode, `GET` returns defaults and
`PUT`/`PATCH` are `403`.
