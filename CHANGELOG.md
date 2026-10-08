# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Datacenter > Firewall: the cluster-wide firewall in five inner tabs -- the datacenter's rules
  (add, edit, delete, enable or disable, reorder, reusing the guest firewall's rule dialog), the
  options (a master Enable switch that asks you to type `ENABLE` first because an inbound DROP
  policy can lock you out of every node, input and output policy, ebtables, the log rate limit),
  security groups and the rules inside them, aliases, and IP sets with their entries (including the
  `nomatch` exclusion flag). Needs a signed-in session and `Sys.Modify` on `/`; changes forward
  PVE's digest where it accepts one. New routes under `/api/actions/datacenter/firewall/*`.
- Datacenter -> Backup Jobs: the Datacenter page's Backup Jobs tab manages the cluster's scheduled
  vzdump jobs like PVE's Datacenter -> Backup panel. The table shows each job's schedule, next run,
  storage, mode, which guests it covers, compression, retention and comment, with an inline
  Enabled switch; add and edit a job (schedule presets or a custom calendar event, all guests with
  an exclude list, a pool or chosen guests, keep-* retention, email notification, advanced
  options), "Run now", a "Show included guests" sheet with each guest's volumes (a drive with
  `backup=0` is marked), and delete behind a typed-job-id confirmation. Needs a signed-in session
  and `Sys.Modify` on `/` (Run now: `VM.Backup` on each guest and `Datastore.AllocateSpace` on the
  storage).
- Datacenter -> Users & Permissions (T68): manage users, groups, ACL entries and API tokens, view roles, and change passwords from
  the Datacenter page. Writes go through new `/api/actions/datacenter/access/*` routes (session sign-in only, one privilege checked per
  call, PVE's own refusals relayed); a password is never logged or echoed and a new API token's secret is shown once, never stored.
- Datacenter -> Storage and Datacenter -> Pools. The Storage tab lists every storage definition with
  its usage and adds, edits and removes them (Directory, NFS, SMB/CIFS, LVM, LVM-Thin, ZFS and
  Proxmox Backup Server, with scan helpers, node selection and keep-* retention); removing one drops
  the definition only, never the data, and `local` cannot be removed. The Pools tab creates, comments
  and deletes pools and adds or removes guests and storages. New routes under
  `/api/actions/datacenter/storage` and `/api/actions/datacenter/pools` need a session sign-in and
  `Datastore.Allocate` / `Pool.Allocate`; CIFS and PBS passwords are sent to PVE once and are never
  logged, echoed or stored.
- Node → Network: the node's Network tab now lists every interface and lets you create a Linux
  bridge, bond or VLAN, edit an interface (a physical one only its addressing, autostart, MTU and
  comment) and delete a bridge, bond or VLAN. Proxmox only stages these changes, so a pending
  banner shows the diff with **Apply configuration** (typed `APPLY` confirmation; applying can
  disconnect the node from the network if the configuration is wrong) and **Revert**. Needs a
  signed-in session and `Sys.Modify` on the node; deleting the interface that carries the address
  Proxion reaches Proxmox at is refused.

## [0.11.1] - 2026-10-08

### Security

- Notification webhooks never follow redirects, and "Send test notification" now reports a failed
  channel only as `request failed (HTTP <status>)`, `(timeout)` or `(network)` (email: also
  `authentication failed`) instead of the upstream's error text, so the button cannot be used to
  probe hosts or ports reachable from the server. New optional `PROXION_NOTIFY_ALLOWED_HOSTS`
  restricts the webhook and SMTP hosts that settings (saved in the app or set in the environment)
  may use; unset keeps today's behaviour, and an unparseable value fails closed (nothing is sent
  or saved until it is fixed). The channel status shown in Preferences now reflects what was
  actually built, not just what is stored. Email sender and recipient addresses are validated as
  bare addresses, and a kept webhook token is only reused while the scheme, host and port are
  unchanged.

### Added

- Notification settings in the app: the Preferences page can now switch notifications on or off,
  snooze them (1 h, 8 h, 24 h, 7 days), mute individual alert kinds (backups, failed tasks, storage
  usage), and edit the delivery options and the webhook / email channel details, with no command
  line. Needs a signed-in session and `Sys.Modify` on `/`. The `PROXION_NOTIFY_*` variables stay the
  defaults; saving writes `notify-settings.json` (mode 0600) into the data directory, which then
  takes over and is applied immediately, without a restart. Secrets are never sent back to the
  browser. New routes: `GET`/`PUT /api/notify/settings` and `POST /api/notify/mute`.

## [0.11.0] - 2026-10-06

### Added

- Convert to template: a stopped VM or container can be turned into a template from the object
  header's "More" menu or the inventory tree's context menu, behind a typed-VMID confirmation
  (the change is permanent). `POST /api/actions/guest/:node/:type/:vmid/template` needs a signed-in
  session and `VM.Allocate` on the guest, and refuses a running/paused guest (`guest-running`) or one
  that is already a template (`already-template`).
- Create container wizard: General, Template, Disks, CPU, Memory, Network, DNS and Confirm steps
  (opened from the node context menu or the top bar's Create menu), validated per step, ending in
  one new allow-listed `POST /api/actions/guest/:node/lxc/create` that follows the task and opens
  the new container. Needs a signed-in session, `VM.Allocate` on the new CT ID and
  `Datastore.AllocateSpace` on the root disk's storage (409 `vmid-taken` for an id in use). The root
  password is never logged, echoed or stored; SSH public keys travel newline-separated, as PVE's
  `ssh-public-keys` expects.
- Create VM wizard: eight steps (General, OS, System, Disks, CPU, Memory, Network, Confirm) that
  mirror PVE's, opened from the top bar's Create menu or a node's context menu. One request to a
  new allow-listed route, `POST /api/actions/guest/:node/qemu/create`, composes the whole VM (ISO
  or no media, q35/OVMF with an EFI disk, optional TPM 2.0, one disk, CPU, memory, one NIC, boot
  order) from a strict typed body, then Proxion follows the task and opens the new VM. Needs a
  signed-in session, `VM.Allocate` on the new VMID and `Datastore.AllocateSpace` on every storage a
  new volume goes on (`Datastore.Audit` or `Datastore.AllocateSpace` on the ISO's storage); a VMID
  already in use is refused with 409 before PVE is called. The shared service token stays
  read-only.

### Changed

- An invalid `PROXION_NOTIFY_*` / `PROXION_PUBLIC_URL` value no longer crash-loops the server at
  boot: notifications are disabled with one startup warning (`Notifications disabled: <key and
  allowed values>`, never echoing webhook/SMTP URLs or tokens), `GET /api/notify/status` reports
  the `error`, and the Preferences page shows it and disables "Send test notification". Core
  settings (PVE URL, token, session secret, ports, TLS pin, agents) still fail hard.

## [0.10.3] - 2026-10-06

### Fixed

- Notification emails: the Outlook button label sat below the button edge (Word's engine
  pushes text down when a line-height is forced inside VML); the label now relies on
  `v-text-anchor:middle` alone.

## [0.10.2] - 2026-10-06

### Fixed

- Notification emails: the "Open in Proxion" button no longer clips its label in Outlook desktop
  (96-DPI Office block, VML namespaces, a wider fixed-height VML button with exact line height).

## [0.10.1] - 2026-10-06

### Changed

- Alert notifications are formatted per channel instead of plain text: email is an HTML message
  with a card per alert and an "Open in Proxion" button (plain-text alternative kept), Discord
  gets embeds, Slack gets blocks, ntfy and Gotify get Markdown with a click action, and the
  generic webhook gains `headline`, `highestSeverity`, `sentAt` and per-event
  `guestName`/`guestType`/`label`/`color`. Events now carry the guest's name and type, the email
  subject is `[site] headline — first alert`, and "Send test" sends two realistic sample alerts.
  No env variable, channel selection or route changes.

### Fixed

- Deploy kit: `set-env.sh` writes values single-quoted so Docker Compose never interpolates a
  `$` inside a secret (an SMTP password containing `$abc` used to be silently truncated).

## [0.10.0] - 2026-10-05

### Added

- A guest Options tab (VM and container), modelled on PVE's Options panel: start at boot,
  start/shutdown order, protection (with a confirmation), tags, plus the VM's OS type, QEMU
  guest agent, local-time RTC, tablet pointer, ACPI, KVM and hotplug, and the container's DNS
  servers and search domain (unprivileged and architecture are shown read-only). Name/hostname
  reuses the existing rename dialog. Backed by one new allow-listed
  `PATCH /api/actions/guest/:node/:type/:vmid/options` route that checks `VM.Config.Options`,
  `VM.Config.HWType` (VM tablet/ACPI/KVM/hotplug) or `VM.Config.Network` (container
  hostname/DNS) per field; session sign-in only. Editing the guest agent keeps its
  `type` / `freeze-fs-on-backup` sub-options.
- A Cloud-Init tab on VMs: view and edit user, password, DNS domain and servers, SSH public
  keys, package upgrade, type and each network device's IP config (DHCP or static with gateway,
  IPv4 and IPv6), see the changes PVE holds back as pending, and regenerate the cloud-init
  image. Session sign-in only, gated on `VM.Config.Cloudinit`; the password is sent to Proxmox
  to hash and is never logged or shown back. A VM without a Cloud-Init drive gets a hint to add
  one on the Hardware tab.
- Add, edit and remove a VM's USB devices, PCI passthrough devices and serial ports from its
  Hardware tab ("Add device" menu in a new Devices row, plus a pencil and a remove button on each
  device row; serial ports are add/remove only). USB: Spice port, host vendor:device ID, host
  port or a mapped device, with USB 3; PCI: a host device (picked from the node's list grouped by
  IOMMU group, or typed) or a mapped device, with All functions, PCI-Express, ROM-Bar, Primary
  GPU and MDev type; serial: a socket. Session sign-in only, gated on `VM.Config.HWType`; raw
  USB/PCI devices still need root@pam in Proxmox, whose error is shown as-is. The host and mapping
  pickers fall back to typing when the account lacks `Sys.Modify` / `Mapping.Audit`. Options the
  dialogs don't show (a PCI ROM file, vendor overrides, ...) are kept on edit. Containers are
  unchanged.
- A Firewall tab on VMs and containers: the guest's firewall options (enable, input/output
  policy, DHCP, NDP, router advertisement, MAC and IP filter, log levels) and its rule list with
  add, edit, delete, enable/disable and move up/down, including security-group rules. Enabling the
  firewall with a DROP input policy asks first, and edits, deletes, moves and option changes
  forward PVE's digest of the last read so a concurrent edit is refused. Session sign-in only, gated on `VM.Config.Network`.

### Fixed

- The Boot Order row of a VM with no `boot` order now reads "Default order (disks, then
  CD/DVD, then network)" instead of "No boot device", since PVE still boots using its default.
- Detaching a container bind mount no longer promises an `unused` volume: the confirmation says
  a bind mount has no volume and the mount point is simply removed.
- Editing a network device kept in the legacy `<model>,macaddr=<MAC>` form no longer duplicates
  the MAC (PVE rejected the repeated key); the MAC is kept once as `<model>=<MAC>`.

## [0.9.0] - 2026-09-30

### Added

- Edit a VM's boot order from its Hardware tab: the Boot Order row shows the order as
  chips (or "No boot device") and a pencil opens a dialog listing every bootable device
  (disks, CD/DVD drives, network devices) with an "enabled" checkbox and Up/Down buttons.
  Legacy `boot: cdn` + `bootdisk` configs are read and rewritten as `order=...`. Session
  sign-in only, gated on `VM.Config.Options`; containers have no boot order.
- Add, detach and remove disks from a guest's Hardware tab. "Add disk" (VM) / "Add mount
  point" (container) creates a new volume on an image-capable storage of the node -- bus,
  size, a format limited to what the storage supports, cache / discard / SSD / IO thread and
  backup for a VM; path, backup, read-only and ACL for a container -- and shows each
  storage's free space. "Detach" keeps the volume as an unused disk; "Remove" on an unused
  disk destroys the volume and needs its slot name typed to confirm. Session sign-in only;
  adding needs `VM.Config.Disk` on the guest plus `Datastore.AllocateSpace` on the storage,
  detaching and removing need `VM.Config.Disk`.
- Add, edit and remove network devices from a guest's Hardware tab: an "Add network
  device" button and an edit/remove action on each NIC row. A VM picks model, bridge
  (from the node's bridges), VLAN tag, firewall, rate limit, disconnect and MTU; a
  container picks its interface name, bridge, IPv4 (DHCP / static + gateway /
  manual), IPv6 (SLAAC / DHCP / static + gateway / manual), VLAN tag, firewall, rate
  limit and MTU (`1` = the bridge MTU on a VM). A new device gets a Proxmox-generated MAC
  (or an override); editing never changes an existing MAC and keeps options the dialog
  doesn't show (queues, trunks, ...). Session sign-in only, gated on `VM.Config.Network`
  -- the shared service token stays read-only here too.

### Changed

- Web test suite: 30 s test/hook timeouts, 10 s element-wait budgets in the heavy
  route-level tests, and an opt-in `PROXION_VITEST_WORKERS=<n>` cap so parallel suites
  on a busy machine stop timing out.

## [0.8.0] - 2026-09-30

### Added

- Edit a guest's hardware from its Hardware tab (first cut): processors (sockets,
  cores, CPU type grouped by vendor; a container's cores), memory (MiB with a GiB
  helper, plus the balloon minimum for a VM and swap for a container), the ISO in
  each CD/DVD drive (or "No media"), and growing a disk (add N GiB -- never a
  shrink). Changes PVE holds back until the guest restarts are listed in a
  "Changes pending a restart" banner with the affected rows badged "pending".
  Session sign-in only, gated on `VM.Config.CPU`/`VM.Config.Memory`/
  `VM.Config.CDROM`/`VM.Config.Disk` -- the shared service token stays read-only
  here too.

## [0.7.0] - 2026-09-30

### Fixed

- The VNC console's "Paste" button now actually types into the guest. It used to send only
  VNC's clipboard message, which QEMU forwards into the guest only when a clipboard agent
  (qemu-vdagent / spice-vdagent) is running -- so on almost every VM nothing arrived. Paste now
  opens a box (pre-filled from the clipboard where the browser allows) and types the text as
  keystrokes (US keyboard layout assumed, up to 4096 characters, with progress and Cancel;
  characters with no key, such as emoji, are skipped and counted).
### Added

- "Delete…" on a guest's object header "More" menu or its context menu: permanently destroy a
  stopped VM/CT behind a typed-VMID confirmation, with optional "purge" (also remove it from
  backup jobs, replication and HA; off by default) and "destroy unreferenced disks" (on by
  default) checkboxes. A running guest must be stopped first. Session sign-in only, gated on
  `VM.Allocate` -- the shared service token stays read-only here too.

## [0.6.0] - 2026-09-30

### Added

- "Backup now" and "Restore from backup" on a guest's Backups tab: start a
  vzdump backup (storage, mode, compression, protected, notes, optional
  retention pruning), and restore a backup over an existing guest (with a
  typed-VMID confirm and a running-guest guard) or onto a fresh VMID
  (with a "use next free ID" button), plus a per-row Delete. Session
  sign-in only, gated on `VM.Backup`/`VM.Allocate`/`Datastore.AllocateSpace`/
  `Datastore.Allocate` as appropriate -- the shared service token stays
  read-only here too.
- The Guests list now supports multi-select bulk power actions: a checkbox column (with a
  select-all-in-view header checkbox) selects guests across the current filtered view, and a
  bulk actions bar starts/shuts down/reboots/stops the whole selection at once, confirming in a
  dialog that lists what applies, skips what doesn't (wrong power state, or a template) with a
  reason, and runs the applicable guests with a concurrency limit of 3.
- Hovering (or keyboard-focusing) a running guest's row in the inventory tree now shows a
  floating console-preview card, matching the dashboard and VM/CT Summary previews; off when
  "Console thumbnails" is disabled in Preferences, and only on fine-pointer (mouse) devices.
- Alert notifications: the server can now announce opened/escalated/resolved/cleared alerts over
  a webhook (generic JSON, Discord, Slack, ntfy or Gotify) and/or email, batched within a short
  debounce window into one message per channel. Configure via `PROXION_NOTIFY_*` env vars (see
  the README's "Notifications" section); Preferences shows which channels are configured and has
  a "Send test notification" button.
- "Clone…" on a guest's object header "More" menu or its context menu: clone a VM/CT to a new
  VMID (with a "use next free ID" button), full or linked (linked only from a template), an
  optional target node/storage, an optional source snapshot, and a description. Session sign-in
  only, gated on `VM.Clone` (source) and `VM.Allocate` (new VMID), plus `Datastore.AllocateSpace`
  on the target storage when one is given -- the shared service token stays read-only here too.

## [0.5.0] - 2026-09-29

### Added

- The running build's version now shows in the user menu (and on the login
  page), and an already-open tab that falls behind a newer server build
  shows an update banner offering a reload.

### Changed

- Storage uploads are now tracked app-wide instead of in the upload dialog's own state: closing
  the dialog ("Continue in background"), navigating away, or a shell remount no longer loses
  track of an in-progress upload -- a compact indicator next to the storage page's Upload button
  keeps showing its progress, with Cancel and Dismiss, until it finishes.

## [0.4.3] - 2026-09-29

### Fixed

- The app no longer unmounts and remounts the whole page during a background session check (for
  example when the window regains focus after 30 s). Open dialogs, in-progress uploads and page
  state survive.

## [0.4.2] - 2026-09-29

### Fixed

- Storage upload never reached Proxmox's storage: pveproxy expects the file part to be named
  `filename`; the browser sent it as `file`. Fixed, with a strict fake-PVE test.
- Storage upload: an early reply from Proxmox (for example an authentication or size error) was
  reported as "Proxmox VE is unreachable" because the route aborted its own request when Proxmox
  stopped reading; the real status and message are now returned.

## [0.4.1] - 2026-09-28

### Fixed

- Storage upload / download-from-URL now validate the filename's extension against the chosen
  content type (iso -> `.iso`/`.img`, vztmpl -> `.tar.gz`/`.tar.xz`/`.tar.zst`, import ->
  `.ova`/`.qcow2`/`.raw`/`.vmdk`) before ever contacting Proxmox, and any Proxmox-side parameter
  rejection now surfaces its per-field detail (e.g. `filename: value does not match the regex
  pattern`) instead of just "Parameter verification failed."
- A storage upload that never reaches Proxion (an unreadable file, or a proxy/browser upload
  limit) no longer shows a misleading "Proxmox VE is unreachable" toast -- the message now says
  the upload never left the browser.
- Uploads to a Proxmox host with a self-signed certificate failed with 502: the new streaming path
  did not use the fingerprint-pinned connector the rest of the client uses. It does now, with a
  regression test against a local HTTPS server.

## [0.4.0] - 2026-09-28

### Added

- Storage browser: upload an ISO image, container template, or import file from your browser
  onto a storage, have Proxmox itself download one from a URL, and delete a volume from its own
  row menu. Uploads stream straight through to PVE with a progress bar; needs a signed-in session
  and `Datastore.AllocateTemplate` (upload/download-from-URL) or `Datastore.Allocate` /
  `Datastore.AllocateSpace` + `VM.Backup` (delete) on the storage, same allow-listed-write-route
  pattern as power actions, rename/notes, snapshots, migrate and node power.

## [0.3.0] - 2026-09-25

### Added

- Migrate a VM/CT to another cluster node from the object header's "More"
  menu or the inventory tree's context menu: a target-node picker with a
  live precheck (running state, local disks, local resources), online/
  local-disks options for qemu, and automatic restart-mode migration for a
  running lxc. Needs a signed-in session and `VM.Migrate` on the guest, same
  allow-listed-write-route pattern as power actions, rename/notes and
  snapshots.
- Storage browser (`/storage/$node/$storage`): a vSphere-style datastore object page --
  summary strip plus a searchable, sortable content browser -- with every existing storage
  entry point (inventory tree, command palette, dashboard, node Storage tab) now linking to it.
- Reboot/Shut down a cluster node from a "Power" dropdown on the node page header, behind a
  confirmation dialog showing the node's running guests and requiring the node name to be typed
  to confirm. Needs a signed-in session and `Sys.PowerMgmt` on the node, same allow-listed-write-
  route pattern as power actions, rename/notes, snapshots and migrate.

### Changed

- The browser demo's sample cluster now has two nodes (`pve1`, `pve2`) with a
  few guests on each, so Migrate can be tried end to end without a real host.

## [0.2.2] - 2026-09-25

### Fixed

- Snapshots tab: a snapshot taken without RAM showed a stray "0" after its
  name (PVE reports `vmstate` as `0`/`1`, and the RAM badge check rendered
  the zero). The italic "NOW" row no longer clips its last letter.

### Changed

- README: new "How it's built" section, and the feature status and roadmap
  now reflect 0.2 (rename/notes and snapshots are shipped writes).

## [0.2.1] - 2026-09-25

### Fixed

- The Summary tab's Snapshots panel was still the read-only placeholder ("0
  snapshots" and a permanently disabled button). It now shows the guest's real
  snapshots, links to the Snapshots tab, and its "Take snapshot" opens the same
  create dialog as the tab, under the same permission gate.

## [0.2.0] - 2026-09-25

The first feature release after launch: a cluster-wide Guests list, snapshot
management, and the polish items from the v0.1 backlog.

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

[Unreleased]: https://github.com/C2Tech-sys/proxion/compare/v0.11.1...HEAD
[0.11.1]: https://github.com/C2Tech-sys/proxion/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/C2Tech-sys/proxion/compare/v0.10.3...v0.11.0
[0.10.3]: https://github.com/C2Tech-sys/proxion/compare/v0.10.2...v0.10.3
[0.10.2]: https://github.com/C2Tech-sys/proxion/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/C2Tech-sys/proxion/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/C2Tech-sys/proxion/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/C2Tech-sys/proxion/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/C2Tech-sys/proxion/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/C2Tech-sys/proxion/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/C2Tech-sys/proxion/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/C2Tech-sys/proxion/compare/v0.4.3...v0.5.0
[0.4.3]: https://github.com/C2Tech-sys/proxion/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/C2Tech-sys/proxion/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/C2Tech-sys/proxion/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/C2Tech-sys/proxion/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/C2Tech-sys/proxion/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/C2Tech-sys/proxion/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/C2Tech-sys/proxion/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/C2Tech-sys/proxion/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/C2Tech-sys/proxion/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/C2Tech-sys/proxion/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/C2Tech-sys/proxion/releases/tag/v0.1.0
