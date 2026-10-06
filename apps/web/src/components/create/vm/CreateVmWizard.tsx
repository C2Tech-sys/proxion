import { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { StepGeneral } from '@/components/create/vm/StepGeneral';
import { StepOs } from '@/components/create/vm/StepOs';
import { StepSystem } from '@/components/create/vm/StepSystem';
import { StepDisks } from '@/components/create/vm/StepDisks';
import { StepCpu, StepMemory } from '@/components/create/vm/StepCpuMemory';
import { StepNetwork } from '@/components/create/vm/StepNetwork';
import { StepConfirm } from '@/components/create/vm/StepConfirm';
import type { StepProps, WizardData } from '@/components/create/vm/fields';
import {
  STEPS,
  buildCreateVmBody,
  initialForm,
  isLinuxOs,
  resolveForm,
  stepErrors,
  stepValid,
  type VmForm,
} from '@/components/create/vm/wizardState';
import { USE_FIXTURES } from '@/api/client';
import { useAuthMe } from '@/api/hooks';
import { FALLBACK_CPU_MODELS } from '@/api/hardware';
import { hardwareErrorMessage, useCpuModels } from '@/api/hardwareHooks';
import { useStorageFormats } from '@/api/diskHooks';
import { useBridges } from '@/api/networkHooks';
import {
  useCreateNodes,
  useIsoImages,
  useNextVmId,
  useNodeStorages,
  type CreateVmVars,
} from '@/api/createVmHooks';
import type { CreateVmResult } from '@/api/createVm';
import type { UseMutationResult } from '@tanstack/react-query';

export interface CreateVmWizardProps {
  /** The node the wizard was launched from, when it was launched from a node's menu. */
  initialNode: string | undefined;
  mutation: UseMutationResult<CreateVmResult, Error, CreateVmVars>;
  onClose: () => void;
}

const READ_ONLY_REASON = 'Read-only: signed in with a service token';

/**
 * The eight-step Create VM wizard (General, OS, System, Disks, CPU, Memory, Network, Confirm). The
 * form lives here; each step validates before "Next" (`stepErrors`), and "Create" on the last step
 * sends one request (`useCreateVm`, mounted by the dialog so it outlives this component). A server
 * error shows inline and keeps the wizard open. Mount it fresh per open.
 */
export function CreateVmWizard({ initialNode, mutation, onClose }: CreateVmWizardProps) {
  const auth = useAuthMe();
  const isSessionMode = USE_FIXTURES || auth.data?.mode === 'session';

  // `raw` holds only what the user chose; `form` (below) is `raw` with the lookups' defaults filled in.
  const [raw, setRaw] = useState<VmForm>(() => initialForm(initialNode ?? ''));
  const [stepIndex, setStepIndex] = useState(0);

  function patch(changes: Partial<VmForm>) {
    setRaw((prev) => {
      const next = { ...prev, ...changes };
      if (changes.node !== undefined && changes.node !== prev.node) {
        // Everything fetched per node starts over; `resolveForm` refills the defaults.
        next.isoStorage = '';
        next.isoVolid = '';
        next.diskStorage = '';
        next.efiStorage = '';
        next.tpmStorage = '';
        next.bridge = '';
        next.format = '';
      }
      if (changes.ostype !== undefined && changes.ostype !== prev.ostype) {
        if (!next.agentTouched) next.agent = isLinuxOs(next.ostype);
        if (!next.tpmTouched) next.tpm = next.ostype === 'win11';
      }
      return next;
    });
  }

  // --- lookups ---------------------------------------------------------------------------------
  const nextId = useNextVmId(true);
  const nodes = useCreateNodes(true);
  // The node the per-node lookups run against: the user's choice, else the first online node.
  const node = resolveForm(raw, {
    nextVmid: undefined,
    nodes: nodes.data,
    isoStorageIds: undefined,
    imageStorageIds: undefined,
    bridgeIds: undefined,
  }).node;
  const isoStorages = useNodeStorages(node, 'iso');
  const imageStorages = useNodeStorages(node, 'images');
  const formats = useStorageFormats(node);
  const bridges = useBridges(node);
  const cpuModels = useCpuModels(node);

  const form = resolveForm(raw, {
    nextVmid: nextId.data,
    nodes: nodes.data,
    isoStorageIds: isoStorages.data?.map((s) => s.id),
    imageStorageIds: imageStorages.data?.map((s) => s.id),
    bridgeIds: bridges.data?.map((b) => b.iface),
  });
  const isos = useIsoImages(node, form.mediaKind === 'iso' ? form.isoStorage : '');

  const data: WizardData = {
    nodes: nodes.data ?? [],
    isoStorages: isoStorages.data ?? [],
    isos: isos.data,
    imageStorages: imageStorages.data ?? [],
    formats: formats.data,
    bridges: bridges.data ?? (bridges.isError ? [] : undefined),
    cpuModels: cpuModels.data && cpuModels.data.length > 0 ? cpuModels.data : FALLBACK_CPU_MODELS,
  };

  // --- navigation ----------------------------------------------------------------------------------
  const step = STEPS[stepIndex]!;
  const errors = stepErrors(step.id, form);
  const currentValid = Object.keys(errors).length === 0;
  const isLast = stepIndex === STEPS.length - 1;
  const allValid = STEPS.every((s) => stepValid(s.id, form));
  /** A step can be jumped to once every step before it is valid. */
  const reachable = (index: number) => STEPS.slice(0, index).every((s) => stepValid(s.id, form));

  const pending = mutation.isPending;
  const serverError = mutation.isError ? hardwareErrorMessage(mutation.error, 'The VM could not be created.') : undefined;

  function create() {
    if (!isSessionMode || pending) return;
    const body = buildCreateVmBody(form);
    if (!body) return;
    mutation.mutate({ node: form.node, body }, { onSuccess: onClose });
  }

  const stepProps: StepProps = { form, patch, errors, data, disabled: pending };

  return (
    <div className="flex min-h-0 flex-col gap-4">
      {!isSessionMode && (
        <p role="status" className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
          {READ_ONLY_REASON}. Creating a VM needs a signed-in session.
        </p>
      )}

      <div className="grid min-h-0 gap-4 md:grid-cols-[10rem_minmax(0,1fr)]">
        <nav aria-label="Create VM steps">
          <ol className="flex flex-row flex-wrap gap-1 md:flex-col">
            {STEPS.map((s, index) => {
              const done = index < stepIndex && stepValid(s.id, form);
              const current = index === stepIndex;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-current={current ? 'step' : undefined}
                    disabled={pending || (!current && !reachable(index))}
                    onClick={() => setStepIndex(index)}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 ${
                      current ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50'
                    }`}
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center text-xs">
                      {done ? <Check className="size-3.5" aria-hidden /> : index + 1}
                    </span>
                    {s.label}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <section aria-label={step.label} className="max-h-[60vh] min-w-0 overflow-y-auto px-0.5 py-0.5">
          <h3 className="mb-3 text-sm font-semibold">{step.label}</h3>
          {step.id === 'general' && <StepGeneral {...stepProps} />}
          {step.id === 'os' && <StepOs {...stepProps} />}
          {step.id === 'system' && <StepSystem {...stepProps} />}
          {step.id === 'disks' && <StepDisks {...stepProps} />}
          {step.id === 'cpu' && <StepCpu {...stepProps} />}
          {step.id === 'memory' && <StepMemory {...stepProps} />}
          {step.id === 'network' && <StepNetwork {...stepProps} />}
          {step.id === 'confirm' && <StepConfirm form={form} />}
        </section>
      </div>

      {serverError && (
        <p role="alert" className="text-xs text-status-error">
          {serverError}
        </p>
      )}

      <DialogFooter>
        <Button variant="outline" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
        <Button variant="outline" disabled={pending || stepIndex === 0} onClick={() => setStepIndex(stepIndex - 1)}>
          Back
        </Button>
        {isLast ? (
          <Button
            disabled={!isSessionMode || pending || !allValid}
            title={!isSessionMode ? READ_ONLY_REASON : undefined}
            onClick={create}
          >
            {pending && <Loader2 className="size-4 animate-spin" />}
            Create
          </Button>
        ) : (
          <Button disabled={pending || !currentValid} onClick={() => setStepIndex(stepIndex + 1)}>
            Next
          </Button>
        )}
      </DialogFooter>
    </div>
  );
}
