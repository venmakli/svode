import { useEffect, useMemo, useRef, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  CollectionCreateFlow,
  type CollectionCreateFlowFocusRequest,
  type CollectionCreateFlowFocusTarget,
} from "@/features/collection";
import {
  RepositoryAccessInlineRecovery,
  repositoryAccessPrimaryActionLabel,
  type RepositoryAccessPreflightController,
} from "@/features/git";
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
import { AgentActorCreateReview } from "./agent-actor-create-review";
import { AgentActorForm, type AgentActorFormSection } from "./agent-actor-form";

const CREATE_STEPS: readonly AgentActorCreateStep[] = [
  "identity",
  "adapters",
  "permissions",
  "review",
];

interface AgentActorEditorDialogProps {
  accessRecovery: RepositoryAccessPreflightController;
  descriptors: readonly AgentActorAdapterDescriptor[];
  diagnostics: Readonly<
    Partial<Record<AgentActorBinding["adapter"], AgentActorAdapterDiagnostic>>
  >;
  draft: AgentActorDraft | null;
  failure: string | null;
  pending: boolean;
  pendingAdapter: AgentActorBinding["adapter"] | null;
  readOnly?: boolean;
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
  readOnly = false,
  requesting,
  runtime,
  onChange,
  onCheck,
  onClose,
  onSave,
}: Omit<AgentActorEditorDialogProps, "draft"> & { draft: AgentActorDraft }) {
  const [initialDraft] = useState(() => cloneDraft(draft));
  const submitRequestedRef = useRef(false);
  const [step, setStep] = useState<AgentActorCreateStep>("identity");
  const [focusRequest, setFocusRequest] =
    useState<CollectionCreateFlowFocusRequest>({
      id: 0,
      target: "control",
    });
  const [expandedAdapter, setExpandedAdapter] = useState<
    AgentActorBinding["adapter"] | null
  >(draft.adapters[0]?.adapter ?? null);
  const [attemptedSteps, setAttemptedSteps] = useState<
    ReadonlySet<AgentActorCreateStep>
  >(new Set());

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
  const activeAccessRecovery =
    accessRecovery.open &&
    accessRecovery.pending?.placement === "inline" &&
    (accessRecovery.pending.intentKey === "add-agent" ||
      accessRecovery.pending.intentKey === "agent-actor-create-apply");
  const busy =
    pending ||
    (requesting && !activeAccessRecovery) ||
    (activeAccessRecovery && accessRecovery.busy);

  useEffect(() => {
    if (requesting || pending || activeAccessRecovery || failure) {
      submitRequestedRef.current = false;
    }
  }, [activeAccessRecovery, failure, pending, requesting]);

  const markAttempted = (target: AgentActorCreateStep) => {
    setAttemptedSteps((current) => new Set([...current, target]));
  };
  const requestFocus = (target: CollectionCreateFlowFocusTarget) => {
    setFocusRequest((current) => ({ id: current.id + 1, target }));
  };
  const moveTo = (
    target: AgentActorCreateStep,
    focus: "control" | "heading" = "heading",
  ) => {
    accessRecovery.close();
    requestFocus(focus);
    setStep(target);
  };
  const focusInvalid = (target: AgentActorCreateStep) => {
    markAttempted(target);
    if (target === step) {
      requestFocus("control");
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
    if (readOnly || submitRequestedRef.current) return;
    const invalidStep = firstInvalidAgentActorCreateStep(validation);
    if (invalidStep) {
      focusInvalid(invalidStep);
      return;
    }
    submitRequestedRef.current = true;
    onSave();
  };

  return (
    <CollectionCreateFlow
      backAction={
        stepIndex > 0
          ? {
              label: m.agent_actors_create_back(),
              onClick: () => moveTo(CREATE_STEPS[stepIndex - 1]!),
            }
          : undefined
      }
      cancelLabel={
        activeAccessRecovery
          ? m.git_access_preflight_cancel()
          : m.agent_actors_cancel()
      }
      currentStep={stepIndex + 1}
      dirty={
        !activeAccessRecovery && !areAgentActorDraftsEqual(initialDraft, draft)
      }
      discardConfirmation={{
        cancelLabel: m.agent_actors_discard_keep_editing(),
        confirmLabel: m.agent_actors_discard_action(),
        description: m.agent_actors_discard_description(),
        title: m.agent_actors_discard_confirm(),
      }}
      flowId="agent-actor"
      focusRequest={focusRequest}
      getControlFocusTarget={getAgentActorControlFocusTarget}
      locked={busy}
      primaryAction={
        step === "review"
          ? {
              disabled: readOnly,
              label: activeAccessRecovery
                ? repositoryAccessPrimaryActionLabel(accessRecovery)
                : m.agent_actors_create_confirm(),
              onClick: activeAccessRecovery
                ? accessRecovery.runPrimaryAction
                : submit,
              pending: pending || (activeAccessRecovery && accessRecovery.busy),
              pendingLabel: pending
                ? m.agent_actors_saving()
                : activeAccessRecovery
                  ? (repositoryAccessPrimaryActionLabel(accessRecovery) ??
                    m.git_access_action_checking())
                  : m.agent_actors_create_confirm(),
            }
          : {
              disabled: readOnly,
              form: "agent-actor-create-form",
              label: m.agent_actors_create_continue(),
            }
      }
      progressLabel={progressLabel}
      stepKey={step}
      stepLabel={stepLabel}
      title={m.agent_actors_create_title()}
      totalSteps={CREATE_STEPS.length}
      onClose={() => {
        if (activeAccessRecovery) {
          accessRecovery.close();
          return;
        }
        accessRecovery.close();
        onClose();
      }}
    >
      {step === "review" ? (
        <div className="flex flex-col gap-4">
          <AgentActorCreateReview
            descriptors={descriptors}
            draft={draft}
            runtime={runtime.runtime}
            onEdit={(target) => moveTo(target, "control")}
          />
          {activeAccessRecovery ? (
            <RepositoryAccessInlineRecovery recovery={accessRecovery} />
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
          readOnly={readOnly}
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
    </CollectionCreateFlow>
  );
}

function createStepLabel(step: AgentActorCreateStep) {
  if (step === "identity") return m.agent_actors_step_identity();
  if (step === "adapters") return m.agent_actors_step_adapters();
  if (step === "permissions") return m.agent_actors_step_permissions();
  return m.agent_actors_step_review();
}

function getAgentActorControlFocusTarget(
  content: HTMLDivElement,
  step: string,
) {
  return step === "review"
    ? null
    : content.querySelector<HTMLElement>(`[data-agent-actor-focus="${step}"]`);
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
