import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { backupJobErrorMessage, useIncludedVolumes } from '@/api/backupJobsHooks';
import { summarizeSelection, type BackupJob, type IncludedVolume } from '@/api/backupJobs';

export interface IncludedGuestsSheetProps {
  job: BackupJob | undefined;
  onClose: () => void;
}

/** "backup=0" for a drive PVE leaves out because the guest config says so; otherwise PVE's reason. */
function excludedLabel(volume: IncludedVolume): string {
  if (/disabled|backup=0/i.test(volume.reason)) return 'Excluded (backup=0)';
  return volume.reason !== '' ? `Excluded: ${volume.reason}` : 'Excluded';
}

/**
 * A side sheet listing the guests a backup job covers and each guest's volumes, with a
 * "backup=0" marker on a drive the job skips (`GET /cluster/backup/{id}/included_volumes`).
 */
export function IncludedGuestsSheet({ job, onClose }: IncludedGuestsSheetProps) {
  const volumes = useIncludedVolumes(job?.id);

  return (
    <Sheet open={job !== undefined} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" aria-describedby={undefined}>
        <SheetHeader>
          <SheetTitle>Included guests: {job?.id}</SheetTitle>
          <SheetDescription>{job ? summarizeSelection(job.selection) : ''}</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {volumes.isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
          {volumes.isError && (
            <p role="alert" className="text-sm text-status-error">
              {backupJobErrorMessage(volumes.error, 'The included guests could not be loaded.')}
            </p>
          )}
          {volumes.data && volumes.data.length === 0 && (
            <p className="text-sm text-muted-foreground">This job does not currently cover any guests.</p>
          )}
          {volumes.data && volumes.data.length > 0 && (
            <ul className="flex flex-col gap-3" aria-label="Included guests">
              {volumes.data.map((guest) => (
                <li key={guest.vmid} className="rounded-md border border-border p-2">
                  <div className="text-sm font-medium">
                    {guest.vmid} <span className="font-normal text-muted-foreground">{guest.name ?? ''}</span>{' '}
                    <span className="text-xs text-muted-foreground uppercase">{guest.type}</span>
                  </div>
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {guest.volumes.map((vol) => (
                      <li key={vol.id} className="flex items-baseline justify-between gap-3 text-xs">
                        <span className="min-w-0 truncate">
                          <span className="font-medium">{vol.id}</span>{' '}
                          <span className="text-muted-foreground">{vol.name}</span>
                        </span>
                        <span className={vol.included ? 'text-muted-foreground' : 'text-status-paused'}>
                          {vol.included ? 'Included' : excludedLabel(vol)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
