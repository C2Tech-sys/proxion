# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Guests page (`/guests`): a vSphere-style "VMs and Templates" view -- every guest across the
  cluster in one cluster-wide, sortable, filterable table (search by name/VMID/tag/node, plus
  status/type/node segmented filters), with URL-backed state so a search/filter/sort combination
  is bookmarkable. A "Columns" dropdown persists which optional columns show per user
  (`prefs.guestList.columns`). Right-click on a row offers the exact same actions as the
  inventory rail's own context menu, now extracted into a shared `GuestContextMenu` component so
  both surfaces stay identical. A new "Guests" entry sits above the rail's Datacenter tree, the
  dashboard's "Virtual machines"/"Containers" tiles link straight into it pre-filtered, and it has
  its own command-palette and breadcrumb entries.

### Fixed

- A page no longer opens two (or three) `/api/events` SSE connections. Every live hook
  (`useClusterResources`/`useTasks`/`useAlerts`, each via `useLiveMode`) now shares one
  reference-counted `EventSource` per page; the first subscriber opens it, later ones attach to
  it, and the last unsubscribe closes it after a short grace period (so React StrictMode's
  subscribe/unsubscribe/subscribe double-invoke reuses the same connection instead of tearing it
  down and reopening it).
- The resizable left rail no longer drifts from its saved pixel width when the browser window is
  resized: it used to keep its on-mount percentage, so its on-screen pixel width grew or shrank
  with the window. The rail's persisted pixel width is re-derived to a percentage and reapplied
  on every (debounced) window resize, without fighting an in-progress drag or the collapsed state.
- The Hardware tab now formats disk, EFI disk, and TPM state drive sizes the same way the Summary
  tab does (e.g. `32.0 GiB`) instead of showing PVE's raw config-file suffix (`32G`) verbatim; the
  raw value is still available as a tooltip.
- Snapshot create, delete and rollback. The Snapshots tab gets a "Take snapshot" button
  (name, optional description, "Include RAM" for a running qemu guest) and a per-row "…" menu
  with "Roll back…" and "Delete…", each behind its own confirmation. Goes through three new
  allow-listed server routes (`VM.Snapshot` for create/delete, `VM.Snapshot.Rollback` for
  rollback -- a different, stricter privilege), same session-sign-in-only pattern as the
  existing power actions and rename/notes.

## [0.1.2] - 2026-09-25

### Fixed

- Password managers now recognise the login form. Keeper skipped the fields
  because their class attribute contained `disabled:opacity-50` (it reads class
  names, not styles, and treats "opacity" as a faded or hidden field). The
  disabled look for inputs and textareas moved to a stylesheet rule on the
  real `:disabled` state, and a test forbids such tokens on the login fields.

## [0.1.1] - 2026-09-24

Launch polish: a public demo, a password-manager-friendly login form, and
the fixes found in the first day of real use.

### Added

- A public, install-free GitHub Pages demo (https://c2tech-sys.github.io/proxion/): a new
  `.github/workflows/pages.yml` builds the web app in fixture mode under a `/proxion/` base path
  and deploys it on every push to `main`. The base path is now configurable end-to-end
  (`VITE_BASE_PATH`, the router's `basepath`, `index.html`'s icon/manifest links, and the
  console/shell pop-out hrefs), and a slim, dismissible "Demo -- sample data, nothing here is
  real" banner shows under the top bar whenever the app is running against fixtures (never
  against a real server). A short animated tour GIF (`docs/media/proxion-tour.gif`) now sits at
  the top of the README, above a new "Try it in your browser" line.

- A "Buy me a coffee" link in the user menu and a Support section in the README.

- Re-arrange Summary tab panels: an "Arrange" toggle above the VM/CT Summary grid enters arrange
  mode, showing a drag handle plus keyboard "Move up"/"Move down" buttons in every visible
  panel's header; drag-and-drop (native HTML5, no library) or the buttons reorder the panels, and
  the order saves immediately, per guest type (VM vs. container), to the signed-in user's
  preferences (`summaryLayout.qemu`/`.lxc`). "Reset to default" and "Done" sit next to the
  toggle; the Preferences page's Layout panel gets matching "Reset (VMs)"/"Reset (containers)"
  buttons. Outside arrange mode the tab looks exactly as before.

- Guest rename and notes editing: rename a VM/CT from its object header's "More" menu or the
  inventory tree's context menu (a plain dialog, inline dns-name validation, Enter/Escape), and
  edit its notes (PVE's `description` field) inline from the Summary tab's Notes panel (a
  character counter past 7,000, Ctrl/Cmd+Enter to save, Escape to cancel). Enabled only for a
  signed-in session holding `VM.Config.Options` on that guest -- a different privilege than the
  power actions, checked independently; the shared service token stays read-only. Server side,
  this is one new allow-listed route (`PATCH /api/actions/guest/:node/:type/:vmid/config`) next
  to the power-action route, sharing its 30/minute rate-limit bucket, that validates the name/
  description, re-checks the permission itself, and maps PVE's own errors the same way.

### Fixed

- Dashboard backup failure alerts heal when a retry succeeds: a `vzdump`
  failure used to sit in the alerts strip as a standing error for a full 24h
  even after the backup agent's automatic retry (minutes to hours later)
  succeeded. Failed `vzdump` attempts for the same guest are now grouped into
  a backup incident that's healed the moment a later run completes `OK`
  (healed "at" the time that retry finished, since a forced-full retry can
  run for hours), recomputed from task history on every evaluation so a heal
  shows up within seconds; an incident only goes hard (still shown as an
  error) after 3 failed attempts, or after 6h with no completed retry and
  none running. New `@proxion/core` package
  (shared by the server's poller and the web app's fixture mode); the
  dashboard alerts strip now shows three states (error, warning, muted
  "healed", the latter grouped under a collapsible disclosure), and the VM
  Summary "Last backup" panel shows the same incident state for that guest.

## [0.1.0] - 2026-09-23

First public release. Phase 1: the full read-only console, plus guest power
actions, console thumbnails (VNC and an optional host agent), per-user
preferences, and the Proxion brand -- all folded into this first tag since
none of it had shipped under a released version yet.

### Fixed

- Intermittent `502` on ordinary requests ("TLS fingerprint mismatch ... got no
  certificate"): Node reports an empty peer certificate on a resumed TLS 1.3
  session, so any connection that resumed a cached session failed the
  certificate pin check. The pinned transports no longer cache or resume TLS
  sessions; every connection performs a full handshake and presents the
  certificate. Connections are pooled, so this costs nothing in practice.

### Added

- Guest power actions: Start/Shut down/Reboot/Pause/Resume from the VM/CT
  Summary header, Stop/Reset in its "More" menu, and the same set in the
  inventory tree's right-click menu -- every action behind a confirmation
  dialog (shutdown/reboot offer a force-stop timeout), sharing one dialog
  component and flow across both surfaces. Enabled only for a signed-in
  session holding `VM.PowerMgmt` on that guest; the shared service token
  stays read-only, same as the raw `/api/pve/*` proxy. Server side, this is
  one new allow-listed route (`POST /api/actions/guest/:node/:type/:vmid/:action`)
  that validates the action, re-checks the permission itself, and maps PVE's
  own errors instead of relaying them -- the read-only proxy is untouched.
- Console thumbnails: a "Consoles" panel on the dashboard shows a live-ish
  screenshot of every running guest's display, and the VM/CT Summary tab leads
  with a larger one; click either to open the Console tab. Thumbnails load only
  while visible and the tab is focused, refresh every 60 s, and have a manual
  refresh. The server captures one frame over a short VNC session through the
  same `vncproxy` path the console uses (no host-side agent), checks the caller
  holds `VM.Console`, caches for 60 s and throttles refreshes to one per VM per
  15 s. Each live capture shows up as a `vncproxy` task in PVE's task log.
- Host agent for console thumbnails (`agent/`): an optional, single-file,
  standard-library Python service for each PVE node that returns a QEMU
  screendump as PNG over HTTP behind a bearer token. With `PROXION_AGENTS`
  and `PROXION_AGENT_TOKEN` set, the server captures QEMU guests through the
  agent (no Proxmox API call, no task-log entry) and falls back to VNC when
  an agent is missing or failing; containers always use VNC. Responses say
  which path produced the image (`X-Proxion-Capture: agent|vnc`) and the
  thumbnail status endpoint reports each agent's health. Ships with a
  hardened systemd unit and install/uninstall scripts.
- Per-user preferences (theme, default Monitor range, console thumbnails
  on/off and refresh interval, inventory rail width, density) stored
  server-side, one JSON file per user, so they follow a signed-in user across
  browsers; read-only and defaulted for the shared service token.
- Brand: the Proxion mark (a hexagonal node with an ion in orbit), a favicon set
  (SVG, ICO, Apple touch icon, web manifest icons), the mark in the top bar and
  on the login card, and README lockups. `pnpm icons` regenerates the set from
  `apps/web/src/brand/mark.ts`.
- `GET /api/health` reports the running server's version (`apps/server/package.json`);
  the web app shows it in Preferences -> Account.
- Web app shell: top bar with global search, cluster health pill, running-task
  indicator and theme toggle; resizable/collapsible inventory rail; tabbed object
  pages; command palette (Cmd/Ctrl-K) searching nodes/VMs/CTs by name, VMID, IP or
  tag; right-click context menus on inventory rows (open, console, shell, copy
  VMID/IP); a live Recent Tasks drawer.
- Dashboard: cluster-wide totals, cluster nodes table, top CPU/memory consumers,
  per-storage usage panels, and an alerts strip (tasks that failed in the last 24h,
  storage over 85% full).
- VM/CT Summary tab: guest info (OS, hostname, agent status, IPv4/IPv6 with copy),
  hardware summary (cores/sockets/memory/ballooning, disks with size, NICs, boot
  order), resource gauges with sparkline history, notes, related-object links, and
  last-backup status.
- VM/CT Monitor and node Monitor tabs: CPU/memory/disk/network (plus node
  load/swap/root-fs) graphs over PVE's RRD timeframes (hour/day/week/month/year,
  plus decade for nodes), with time-range chips and a unified hover tooltip.
- VM/CT Hardware tab: full device breakdown -- disks (with discard/ssd/iothread
  flags), EFI disk, TPM state, NICs (VLAN tag, rate limit, firewall), CD-ROM,
  cloud-init drive, boot order, serial/USB/PCI passthrough.
- VM/CT Snapshots tab (tree view) and Backups tab (every backup volume across
  backup-capable storages, with verification status); VM/CT and node Tasks tabs.
- Node Summary, Storage and Tasks tabs.
- Embedded VNC console (noVNC-protocol) and xterm.js terminal, each with a
  Ctrl+Alt+Del/scale-to-fit/reconnect toolbar and a dedicated pop-out window
  (`/console/:node/:type/:vmid`, `/shell/:node`).
- Fastify server: pass-through PVE login, signed httpOnly session cookies,
  optional read-only service-token mode, ticket auto-renewal.
- Read-only PVE API proxy (`/api/pve/*`) with path/method restrictions.
- Cluster resource/task poller and `/api/state` + `/api/events` (SSE) feed.
- Embedded console (noVNC-protocol VNC bridge) and terminal (xterm.js framing)
  websocket bridges, with opaque single-use console tickets.
- TLS fingerprint pinning and insecure-mode opt-out for the PVE connection.
- `@proxion/pve-api`: generated Proxmox VE API client and schema.
- Fixture-backed demo mode (`VITE_USE_FIXTURES=1`) with no server or PVE host
  needed.
- Multi-stage Docker image, `docker-compose.example.yml`, GitHub Actions CI
  (build/typecheck/lint/test + Docker build), and the public documentation
  set (README, deploy guide, security policy, contributing guide, code of
  conduct, issue/PR templates).
- Typography: Josefin Sans (display) + Open Sans (UI and identifiers/code), self-hosted (OFL).

### Notes

Phase 1 is read-only end to end: no VM/CT/node actions (start, stop,
migrate, snapshot, etc.) are wired up yet. See the README's feature status
table and roadmap.

Renamed from Atrium to Proxion before first release.

[Unreleased]: https://github.com/C2Tech-sys/proxion/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/C2Tech-sys/proxion/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/C2Tech-sys/proxion/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/C2Tech-sys/proxion/releases/tag/v0.1.0
