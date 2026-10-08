import { useEffect, useState } from 'react';
import { ListTree, Loader2, Pencil, Play, Plus, Trash2 } from 'lucide-react';

import { BackupJobDialog } from '@/components/backupjobs/BackupJobDialog';
import { DeleteBackupJobDialog } from '@/components/backupjobs/DeleteBackupJobDialog';
import { IncludedGuestsSheet } from '@/components/backupjobs/IncludedGuestsSheet';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { USE_FIXTURES } from '@/api/client';
import { useAuthMe } from '@/api/hooks';
import { useRootPermissions } from '@/api/rootPermissionHooks';
import { summarizeRetention, summarizeSelection, type BackupJob } from '@/api/backupJobs';
import { backupJobErrorMessage, useBackupJobs, useRunBackupJob, useToggleBackupJob } from '@/api/backupJobsHooks';
import { formatDateTime, formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';

const TOKEN_MODE_TOOLTIP = 'Read-only: signed in with a service token';
const NO_PRIVILEGE_TOOLTIP = "You don't have Sys.Modify on /";

const COMPRESSION_LABELS: Record<string, string> = {
  zstd: 'ZSTD',
  gzip: 'GZIP',
  '1': 'GZIP',
  lzo: 'LZO',
  '0': 'None',
};

const MODE_LABELS: Record<string, string> = { snapshot: 'Snapshot', suspend: 'Suspend', stop: 'Stop' };

/** "in 6h 0m" and the absolute local time; "-" for a job with no next run (disabled). */
function NextRun({ job, nowMs }: { job: BackupJob; nowMs: number }) {
  if (!job.enabled || job.nextRun === undefined) return <span className="text-muted-foreground">-</span>;
  const delta = job.nextRun - Math.floor(nowMs / 1000);
  return (
    <div className="flex flex-col">
      <span>{delta > 0 ? `in ${formatDuration(delta)}` : 'due now'}</span>
      <span className="text-xs text-muted-foreground">{formatDateTime(job.nextRun)}</span>
    </div>
  );
}

/** The inline Enabled toggle (`role="switch"`), one per row. */
function EnabledSwitch({
  jobId,
  checked,
  disabled,
  title,
  onToggle,
}: {
  jobId: string;
  checked: boolean;
  disabled: boolean;
  title: string | undefined;
  onToggle: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`Enable job ${jobId}`}
      disabled={disabled}
      title={disabled ? title : undefined}
      onClick={() => onToggle(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent outline-none transition-colors',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-input',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none block size-4 rounded-full bg-background shadow-xs transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

/**
 * Datacenter -> Backup Jobs: PVE's Datacenter -> Backup panel. Lists the cluster's vzdump jobs
 * (schedule, next run, storage, mode, selection, compression, retention, comment) with an inline
 * Enabled switch and per-row Edit, Run now, Show included guests and Delete, plus an "Add job"
 * button. Writes need a session (not a service token) and `Sys.Modify` on `/`; the server enforces
 * both on every request, so this only decides what to enable. Reading the included guests is a
 * plain read and stays available.
 */
export function BackupJobsTab() {
  const { data: auth } = useAuthMe();
  const permissions = useRootPermissions();
  const jobs = useBackupJobs();
  const toggle = useToggleBackupJob();
  const run = useRunBackupJob();

  const [editing, setEditing] = useState<BackupJob | 'new' | undefined>(undefined);
  const [deletingId, setDeletingId] = useState<string | undefined>(undefined);
  const [viewing, setViewing] = useState<BackupJob | undefined>(undefined);
  // Bumped per open so each dialog mounts with a clean form (the dialogs read their props once).
  const [openCount, setOpenCount] = useState(0);
  // The "Next run" countdown's clock, refreshed twice a minute.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const isSessionMode = USE_FIXTURES || auth?.mode === 'session';
  const permissionsKnown = permissions.data !== undefined;
  const canWrite = isSessionMode && Boolean(permissions.data?.can('Sys.Modify'));
  const lockedReason = !isSessionMode
    ? TOKEN_MODE_TOOLTIP
    : permissionsKnown && !canWrite
      ? NO_PRIVILEGE_TOOLTIP
      : undefined;
  const disabled = !canWrite;

  function openDialog(target: BackupJob | 'new') {
    setOpenCount((n) => n + 1);
    setEditing(target);
  }

  const addButton = (
    <Button size="sm" disabled={disabled} aria-disabled={disabled || undefined} title={lockedReason} onClick={() => openDialog('new')}>
      <Plus className="size-3.5" />
      Add job
    </Button>
  );

  let body;
  if (jobs.isLoading) {
    body = <EmptyState message="Loading backup jobs..." />;
  } else if (jobs.isError) {
    body = (
      <p role="alert" className="px-3 py-6 text-sm text-status-error">
        {backupJobErrorMessage(jobs.error, 'The backup jobs could not be loaded.')}
      </p>
    );
  } else if (!jobs.data || jobs.data.length === 0) {
    body = <EmptyState message="No backup jobs yet." />;
  } else {
    body = (
      <div className="overflow-x-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Enabled</TableHead>
              <TableHead>Job ID</TableHead>
              <TableHead>Schedule</TableHead>
              <TableHead>Next run</TableHead>
              <TableHead>Storage</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead>Selection</TableHead>
              <TableHead>Compression</TableHead>
              <TableHead>Retention</TableHead>
              <TableHead>Comment</TableHead>
              <TableHead className="w-28">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.data.map((job) => (
              <TableRow key={job.id} data-testid={`backup-job-${job.id}`}>
                <TableCell>
                  <EnabledSwitch
                    jobId={job.id}
                    checked={job.enabled}
                    disabled={disabled || toggle.isPending}
                    title={lockedReason}
                    onToggle={(enabled) => toggle.mutate({ id: job.id, enabled })}
                  />
                </TableCell>
                <TableCell className="font-mono text-xs">{job.id}</TableCell>
                <TableCell className="font-mono text-xs">{job.schedule}</TableCell>
                <TableCell>
                  <NextRun job={job} nowMs={nowMs} />
                </TableCell>
                <TableCell>{job.storage}</TableCell>
                <TableCell>{MODE_LABELS[job.mode] ?? job.mode}</TableCell>
                <TableCell>{summarizeSelection(job.selection)}</TableCell>
                <TableCell>{COMPRESSION_LABELS[job.compress] ?? job.compress}</TableCell>
                <TableCell>{summarizeRetention(job.retention)}</TableCell>
                <TableCell className="max-w-48 truncate" title={job.comment}>
                  {job.comment ?? ''}
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label={`Edit job ${job.id}`}
                      disabled={disabled}
                      title={lockedReason ?? 'Edit'}
                      onClick={() => openDialog(job)}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label={`Run job ${job.id} now`}
                      disabled={disabled || (run.isPending && run.variables === job.id)}
                      title={lockedReason ?? 'Run now'}
                      onClick={() => run.mutate(job.id)}
                    >
                      {run.isPending && run.variables === job.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Play className="size-3.5" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label={`Show included guests for job ${job.id}`}
                      title="Show included guests"
                      onClick={() => setViewing(job)}
                    >
                      <ListTree className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-destructive hover:text-destructive"
                      aria-label={`Delete job ${job.id}`}
                      disabled={disabled}
                      title={lockedReason ?? 'Delete'}
                      onClick={() => {
                        setOpenCount((n) => n + 1);
                        setDeletingId(job.id);
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <div data-testid="dc-backup-tab" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Scheduled vzdump backups across the cluster. Backups of a guest by hand live on its Backups tab.
        </p>
        {addButton}
      </div>

      {body}

      {editing !== undefined && (
        <BackupJobDialog
          key={`edit-${openCount}`}
          open
          onOpenChange={(open) => !open && setEditing(undefined)}
          job={editing === 'new' ? undefined : editing}
        />
      )}
      {deletingId !== undefined && (
        <DeleteBackupJobDialog
          key={`delete-${openCount}`}
          open
          onOpenChange={(open) => !open && setDeletingId(undefined)}
          jobId={deletingId}
        />
      )}
      <IncludedGuestsSheet job={viewing} onClose={() => setViewing(undefined)} />
    </div>
  );
}

export default BackupJobsTab;
