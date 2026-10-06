import { useCallback, useId, useState, type KeyboardEvent } from 'react';
import { Check, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  ConfirmStep,
  CpuStep,
  DisksStep,
  DnsStep,
  GeneralStep,
  MemoryStep,
  NetworkStep,
  TemplateStep,
  type StepProps,
} from '@/components/create/ct/CtSteps';
import {
  STEPS,
  allStepsOk,
  buildCreateCtBody,
  checkStep,
  defaultCtForm,
  parseVmid,
  type CtForm,
} from '@/components/create/ct/ctForm';
import { USE_FIXTURES } from '@/api/client';
import { useAuthMe } from '@/api/hooks';
import { usePermissions, useStoragePermissions } from '@/api/actionHooks';
import { createCtErrorMessage, useCreateCt, useCreateNextId } from '@/api/createCtHooks';
import { cn } from '@/lib/utils';

export interface CtWizardProps {
  /** The node the wizard was launched from, if any. */
  initialNode: string | undefined;
  onClose: () => void;
}

const TOKEN_REASON = 'Read-only: signed in with a service token';

/**
 * The Create CT wizard body (mounted fresh each time the dialog opens, so a cancelled attempt never
 * leaks its fields -- the root password included -- into the next one): a step rail on the left,
 * the current step's fields on the right, Back / Next underneath and Create on the last step. Each
 * step validates before Next. Creating is session sign-in only and needs `VM.Allocate` on the new id
 * plus `Datastore.AllocateSpace` on the root disk's storage; the server enforces both, this only
 * explains a disabled button.
 */
export function CtWizard({ initialNode, onClose }: CtWizardProps) {
  const id = useId();
  const [typedForm, setForm] = useState<CtForm>(() => defaultCtForm(initialNode ?? ''));
  // The CT ID shows the next free id until the user types their own.
  const [vmidEdited, setVmidEdited] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const mutation = useCreateCt();
  const nextId = useCreateNextId();
  const auth = useAuthMe();

  const set = useCallback(<K extends keyof CtForm>(key: K, value: CtForm[K]) => {
    if (key === 'vmidText') setVmidEdited(true);
    setForm((f) => ({ ...f, [key]: value }));
  }, []);

  // Changing the node invalidates everything read from it: storages, templates and bridges.
  const setNode = useCallback((node: string) => {
    setForm((f) =>
      f.node === node ? f : { ...f, node, templateStorage: '', templateVolid: '', rootStorage: '', bridge: '' },
    );
  }, []);

  const form: CtForm = vmidEdited || nextId.data === undefined ? typedForm : { ...typedForm, vmidText: String(nextId.data) };

  const step = STEPS[stepIndex]!;
  const isLast = stepIndex === STEPS.length - 1;
  const check = checkStep(step, form);
  const busy = mutation.isPending;

  const isSessionMode = USE_FIXTURES || auth.data?.mode === 'session';
  const vmid = parseVmid(form.vmidText) ?? 0;
  const permissions = usePermissions(vmid);
  const storagePermissions = useStoragePermissions(form.rootStorage);
  const createBlockedReason = !isSessionMode
    ? TOKEN_REASON
    : permissions.data?.can('VM.Allocate') !== true
      ? "You don't have VM.Allocate on this guest"
      : storagePermissions.data?.can('Datastore.AllocateSpace') !== true
        ? `You don't have Datastore.AllocateSpace on ${form.rootStorage}`
        : undefined;
  const canCreate = createBlockedReason === undefined && allStepsOk(form) && !busy;

  const serverError = mutation.isError
    ? createCtErrorMessage(mutation.error, 'The container could not be created.')
    : undefined;

  function canGoTo(index: number): boolean {
    return index <= stepIndex || STEPS.slice(0, index).every((s) => checkStep(s, form).ok);
  }

  function next() {
    if (check.ok && !isLast) setStepIndex(stepIndex + 1);
  }

  function create() {
    if (!canCreate) return;
    mutation.mutate({ node: form.node, body: buildCreateCtBody(form) }, { onSuccess: onClose });
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      next();
    }
  }

  const stepProps: StepProps = { form, set, errors: check.errors, busy, id };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Create container</DialogTitle>
        <DialogDescription>{form.node !== '' ? `Node: ${form.node}` : 'No node selected yet.'}</DialogDescription>
      </DialogHeader>

      <div className="grid gap-6 md:grid-cols-[9rem_1fr]" onKeyDown={onKeyDown}>
        <nav aria-label="Steps">
          <ol className="flex flex-row flex-wrap gap-1 md:flex-col">
            {STEPS.map((name, index) => {
              const done = index < stepIndex && checkStep(name, form).ok;
              const reachable = canGoTo(index);
              return (
                <li key={name}>
                  <button
                    type="button"
                    disabled={busy || !reachable}
                    aria-current={index === stepIndex ? 'step' : undefined}
                    onClick={() => setStepIndex(index)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none',
                      'focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
                      index === stepIndex ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50',
                    )}
                  >
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border text-xs">
                      {done ? <Check className="size-3" /> : index + 1}
                    </span>
                    {name}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <div className="flex min-w-0 flex-col gap-4" data-testid={`ct-step-${step.toLowerCase()}`}>
          <h3 className="text-sm font-semibold">{step}</h3>
          {step === 'General' && <GeneralStep {...stepProps} onNodeChange={setNode} />}
          {step === 'Template' && <TemplateStep {...stepProps} />}
          {step === 'Disks' && <DisksStep {...stepProps} />}
          {step === 'CPU' && <CpuStep {...stepProps} />}
          {step === 'Memory' && <MemoryStep {...stepProps} />}
          {step === 'Network' && <NetworkStep {...stepProps} />}
          {step === 'DNS' && <DnsStep {...stepProps} />}
          {step === 'Confirm' && (
            <>
              <ConfirmStep form={form} />
              {createBlockedReason !== undefined && (
                <p role="status" className="text-xs text-muted-foreground">
                  {createBlockedReason}
                </p>
              )}
              {serverError !== undefined && (
                <p role="alert" className="text-xs text-status-error">
                  {serverError}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button variant="outline" disabled={busy || stepIndex === 0} onClick={() => setStepIndex(stepIndex - 1)}>
          Back
        </Button>
        {isLast ? (
          <Button
            disabled={!canCreate}
            aria-disabled={!canCreate || undefined}
            title={createBlockedReason}
            onClick={create}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            Create
          </Button>
        ) : (
          <Button disabled={!check.ok || busy} onClick={next}>
            Next
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
