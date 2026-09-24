# @proxion/core

Pure, dependency-free TypeScript for domain logic shared between the server
and the web app -- currently, the dashboard alerts strip's backup-incident
rule (T23). No PVE client, no DOM, no Node built-ins: safe to import from
either side.

## Layout

- `src/tasks.ts` -- `TaskLike` (the minimal task shape every computation here
  needs) and `vmidOfTask`/`taskFinalState` helpers.
- `src/backupIncidents.ts` -- `computeBackupIncidents`: groups a task list's
  `vzdump` entries per `(node, vmid)` and turns each run of failures into a
  `BackupIncident` (`soft` / `hard` / `healed`). See its doc comment for the
  full healing rule.
- `src/alerts.ts` -- `computeAlerts`: the dashboard alerts strip's full
  contents (backup incidents + other failed tasks + storage-full warnings).

## The backup-incident rule, in short

A `vzdump` backup agent retries a failed VM a few minutes later; a
forced-full retry can take hours. Treating every failed attempt as a
standing alert (today's naive "any task that ended in error in the last
24h" rule) leaves healed failures showing as errors all day. Instead:

1. A failed attempt opens an incident (**soft**) for that `(node, vmid)`.
2. Further consecutive failures attach to it as attempts.
3. An `OK` that starts within 6h of the incident's most recent failure
   **heals** it -- kept (for history) with `healedAt`/`healedByUpid`.
4. Absent a healing `OK`, the incident goes **hard** once it has 3 distinct
   failures, or once 6h have passed since the most recent failure --
   whichever comes first.

Because this is recomputed from the raw task history on every call (never
stored), it's retroactive by construction: an incident that looked hard an
hour ago quietly becomes `healed` the moment a later `OK` for that guest
enters the look-back window.

## Usage

```ts
import { computeAlerts } from '@proxion/core';

const alerts = computeAlerts({ resources, tasks, now: Date.now() });
```

`now` is Unix epoch **milliseconds** (`Date.now()`'s convention); every task
timestamp (`starttime`/`endtime`) is Unix epoch **seconds**, matching PVE's
own task fields -- see `computeBackupIncidents`'s doc comment.

## Testing

`pnpm --filter @proxion/core test` runs the unit suite (table-driven; no
network, no fixtures).
