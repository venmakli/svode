import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import type { RepositoryAccessSnapshot } from "@/features/git";
import * as m from "@/paraglide/messages.js";

import type { AgentActorDraftRuntimeState } from "../hooks/use-agent-actor-draft-runtime";
import {
  areAgentActorDraftsEqual,
  firstInvalidAgentActorCreateStep,
  validateAgentActorCreateDraft,
  type AgentActorCreateStep,
} from "../model/agent-actor-draft";
import type {
  AgentActorAdapterDescriptor,
  AgentActorAdapterDiagnostic,
  AgentActorBinding,
  AgentActorBindingRuntime,
  AgentActorDraft,
} from "../model/agent-actor-types";
import { actorAccessPreflightActionLabel } from "./actor-access-preflight-copy";
import { ActorAccessPreflightAlert } from "./actor-access-preflight-dialog";
import { AgentActorCreateReview } from "./agent-actor-create-review";
import { AgentActorForm, type AgentActorFormSection } from "./agent-actor-form";

const CREATE_STEPS: readonly AgentActorCreateStep[] = [
  "identity",
  "adapters",
  "permissions",
  "review",
];

export interface AgentActorCreateAccessRecovery {
  error: string | null;
  snapshot: RepositoryAccessSnapshot | null;
  verifying: boolean;
  onCancel(): void;
  onVerify(): void;
}

interface AgentActorEditorDialogProps {
  accessRecovery: AgentActorCreateAccessRecovery | null;
  descriptors: readonly AgentActorAdapterDescriptor[];
  diagnostics: Readonly<
    Partial<Record<AgentActorBinding["adapter"], AgentActorAdapterDiagnostic>>
  >;
  draft: AgentActorDraft | null;
  failure: string | null;
  pending: boolean;
  pendingAdapter: AgentActorBinding["adapter"] | null;
  requesting: boolean;
  runtime: AgentActorDraftRuntimeState;
  onChange(draft: AgentActorDraft): void;
  onCheck(adapter: AgentActorBinding["adapter"]): void;
  onClose(): void;
  onSave(): void;
}

export function AgentActorEditorDialog(props: AgentActorEditorDialogProps) {
  if (!props.draft) return null;
  return <AgentActorCreateJourney {...props} draft={props.draft} />;
}

function AgentActorCreateJourney({
  accessRecovery,
  descriptors,
  diagnostics,
  draft,
  failure,
  pending,
  pendingAdapter,
  requesting,
  runtime,
  onChange,
  onCheck,
  onClose,
  onSave,
}: Omit<AgentActorEditorDialogProps, "draft"> & { draft: AgentActorDraft }) {
  const initialDraftRef = useRef(cloneDraft(draft));
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document === "undefined"
      ? null
      : (document.activeElement as HTMLElement | null),
  );
  const contentRef = useRef<HTMLDivElement>(null);
  const focusTargetRef = useRef<"control" | "heading">("control");
  const submitRequestedRef = useRef(false);
  const [step, setStep] = useState<AgentActorCreateStep>("identity");
  const [expandedAdapter, setExpandedAdapter] = useState<
    AgentActorBinding["adapter"] | null
  >(draft.adapters[0]?.adapter ?? null);
  const [attemptedSteps, setAttemptedSteps] = useState<
    ReadonlySet<AgentActorCreateStep>
  >(new Set());
  const [discardOpen, setDiscardOpen] = useState(false);

  const approvalMappings = useMemo(
    () => mapRuntime(runtime.runtime, "approval"),
    [runtime.runtime],
  );
  const effortOptions = useMemo(
    () => mapRuntime(runtime.runtime, "effortOptions"),
    [runtime.runtime],
  );
  const validations = useMemo(
    () => mapRuntime(runtime.runtime, "validation"),
    [runtime.runtime],
  );
  const validation = validateAgentActorCreateDraft({
    draft,
    runtimePhase: runtime.phase,
    validations,
  });
  const stepIndex = CREATE_STEPS.indexOf(step);
  const stepLabel = createStepLabel(step);
  const progressLabel = m.agent_actors_create_progress({
    current: stepIndex + 1,
    step: stepLabel,
    total: CREATE_STEPS.length,
  });
  const busy =
    pending ||
    (requesting && !accessRecovery) ||
    Boolean(accessRecovery?.verifying);

  useEffect(() => {
    focusCurrentStep(contentRef.current, step, focusTargetRef.current);
    focusTargetRef.current = "heading";
  }, [step]);

  useEffect(() => {
    if (requesting || pending || accessRecovery || failure) {
      submitRequestedRef.current = false;
    }
  }, [accessRecovery, failure, pending, requesting]);

  const markAttempted = (target: AgentActorCreateStep) => {
    setAttemptedSteps((current) => new Set([...current, target]));
  };
  const moveTo = (
    target: AgentActorCreateStep,
    focus: "control" | "heading" = "heading",
  ) => {
    accessRecovery?.onCancel();
    focusTargetRef.current = focus;
    setStep(target);
  };
  const focusInvalid = (target: AgentActorCreateStep) => {
    markAttempted(target);
    if (target === step) {
      focusCurrentStep(contentRef.current, target, "control");
      return;
    }
    moveTo(target, "control");
  };
  const continueFromStep = () => {
    markAttempted(step);
    if (step === "identity" && validation.name) {
      focusInvalid("identity");
      return;
    }
    if (step === "adapters" && validation.adapters) {
      focusInvalid("adapters");
      return;
    }
    if (step === "permissions" && validation.adapters) {
      if (
        validation.adapters === "binding_inspection_pending" ||
        validation.adapters === "binding_inspection_failed"
      ) {
        focusInvalid("permissions");
      } else {
        focusInvalid("adapters");
      }
      return;
    }
    const next = CREATE_STEPS[stepIndex + 1];
    if (next) moveTo(next);
  };
  const submit = () => {
    if (submitRequestedRef.current) return;
    const invalidStep = firstInvalidAgentActorCreateStep(validation);
    if (invalidStep) {
      focusInvalid(invalidStep);
      return;
    }
    submitRequestedRef.current = true;
    onSave();
  };
  const close = () => {
    const returnFocusTarget = returnFocusRef.current;
    accessRecovery?.onCancel();
    onClose();
    if (typeof window !== "undefined") {
      window.requestAnimationFrame(() => {
        if (returnFocusTarget?.isConnected) returnFocusTarget.focus();
      });
    }
  };
  const requestClose = () => {
    if (busy) return;
    if (areAgentActorDraftsEqual(initialDraftRef.current, draft)) {
      close();
      return;
    }
    setDiscardOpen(true);
  };

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && requestClose()}>
        <DialogContent
          ref={contentRef}
          className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden"
          data-agent-actor-create-journey
          data-agent-actor-create-step={step}
          showCloseButton={!busy}
        >
          <DialogHeader className="shrink-0 pr-8">
            <DialogTitle>{m.agent_actors_create_title()}</DialogTitle>
            <DialogDescription>{progressLabel}</DialogDescription>
            <Progress
              value={((stepIndex + 1) / CREATE_STEPS.length) * 100}
              aria-label={progressLabel}
              aria-valuemax={CREATE_STEPS.length}
              aria-valuemin={1}
              aria-valuenow={stepIndex + 1}
            />
          </DialogHeader>

          <div
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 py-1"
            data-agent-actor-create-scroll-owner
          >
            <h2
              className="mb-4 text-base font-medium outline-none"
              data-agent-actor-step-heading
              tabIndex={-1}
            >
              {stepLabel}
            </h2>

            {step === "review" ? (
              <div className="flex flex-col gap-4">
                <AgentActorCreateReview
                  descriptors={descriptors}
                  draft={draft}
                  runtime={runtime.runtime}
                  onEdit={(target) => moveTo(target, "control")}
                />
                {accessRecovery ? (
                  <ActorAccessPreflightAlert
                    error={accessRecovery.error}
                    snapshot={accessRecovery.snapshot}
                    verifying={accessRecovery.verifying}
                  />
                ) : null}
                {failure ? (
                  <Alert variant="destructive">
                    <AlertDescription>{failure}</AlertDescription>
                  </Alert>
                ) : null}
              </div>
            ) : (
              <AgentActorForm
                approvalMappings={approvalMappings}
                descriptors={descriptors}
                diagnostics={diagnostics}
                draft={draft}
                effortOptions={effortOptions}
                expandedAdapter={expandedAdapter}
                formId="agent-actor-create-form"
                pendingAdapter={pendingAdapter}
                sections={[step as AgentActorFormSection]}
                showValidation={attemptedSteps.has(step)}
                validation={validation}
                validations={validations}
                validateOnSubmit={false}
                onChange={onChange}
                onCheck={onCheck}
                onExpandedAdapterChange={setExpandedAdapter}
                onSubmit={continueFromStep}
              />
            )}
          </div>

          <DialogFooter className="shrink-0">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={requestClose}
            >
              {m.agent_actors_cancel()}
            </Button>
            {stepIndex > 0 ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => moveTo(CREATE_STEPS[stepIndex - 1]!)}
              >
                {m.agent_actors_create_back()}
              </Button>
            ) : null}
            {step === "review" ? (
              <Button
                type="button"
                disabled={busy}
                onClick={accessRecovery ? accessRecovery.onVerify : submit}
              >
                {pending || accessRecovery?.verifying ? (
                  <LoaderCircle
                    data-icon="inline-start"
                    className="animate-spin"
                  />
                ) : null}
                {pending
                  ? m.agent_actors_saving()
                  : accessRecovery
                    ? actorAccessPreflightActionLabel(accessRecovery)
                    : m.agent_actors_create_confirm()}
              </Button>
            ) : (
              <Button
                type="submit"
                form="agent-actor-create-form"
                disabled={busy}
              >
                {m.agent_actors_create_continue()}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {m.agent_actors_discard_confirm()}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {m.agent_actors_discard_description()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {m.agent_actors_discard_keep_editing()}
            </AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={close}>
              {m.agent_actors_discard_action()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function createStepLabel(step: AgentActorCreateStep) {
  if (step === "identity") return m.agent_actors_step_identity();
  if (step === "adapters") return m.agent_actors_step_adapters();
  if (step === "permissions") return m.agent_actors_step_permissions();
  return m.agent_actors_step_review();
}

function focusCurrentStep(
  content: HTMLDivElement | null,
  step: AgentActorCreateStep,
  target: "control" | "heading",
) {
  const selector =
    target === "control" && step !== "review"
      ? `[data-agent-actor-focus="${step}"]`
      : "[data-agent-actor-step-heading]";
  content?.querySelector<HTMLElement>(selector)?.focus();
}

function cloneDraft(draft: AgentActorDraft): AgentActorDraft {
  return {
    ...draft,
    adapters: draft.adapters.map((binding) => ({ ...binding })),
  };
}

function mapRuntime<Key extends keyof AgentActorBindingRuntime>(
  runtime: Partial<
    Record<AgentActorBinding["adapter"], AgentActorBindingRuntime>
  >,
  key: Key,
): Partial<
  Record<AgentActorBinding["adapter"], AgentActorBindingRuntime[Key]>
> {
  return Object.fromEntries(
    Object.entries(runtime).map(([adapter, value]) => [adapter, value?.[key]]),
  );
}
