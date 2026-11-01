import { useEffect, useRef, useState } from "react";

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

import {
  areAgentActorDraftsEqual,
  cloneBinding,
  firstInvalidAgentActorCreateStep,
  validateAgentActorDraft,
  type AgentActorCreateStep,
} from "../model/agent-actor-draft";
import type {
  AgentActorAdapterDiagnostic,
  AgentActorAgentOption,
  AgentActorDraft,
  AgentAdapterId,
} from "../model/agent-actor-types";
import { AgentActorCreateReview } from "./agent-actor-create-review";
import { AgentActorForm, type AgentActorFormSection } from "./agent-actor-form";

const CREATE_STEPS: readonly AgentActorCreateStep[] = [
  "identity",
  "adapters",
  "review",
];

interface AgentActorEditorDialogProps {
  accessRecovery: RepositoryAccessPreflightController;
  agents: readonly AgentActorAgentOption[];
  diagnostics: Readonly<
    Partial<Record<AgentAdapterId, AgentActorAdapterDiagnostic>>
  >;
  draft: AgentActorDraft | null;
  failure: string | null;
  pending: boolean;
  pendingAdapter: AgentAdapterId | null;
  readOnly?: boolean;
  requesting: boolean;
  onChange(draft: AgentActorDraft): void;
  onCheck(adapter: AgentAdapterId): void;
  onClose(): void;
  onSave(): void;
}

export function AgentActorEditorDialog(props: AgentActorEditorDialogProps) {
  if (!props.draft) return null;
  return <AgentActorCreateJourney {...props} draft={props.draft} />;
}

function AgentActorCreateJourney({
  accessRecovery,
  agents,
  diagnostics,
  draft,
  failure,
  pending,
  pendingAdapter,
  readOnly = false,
  requesting,
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
  const [attemptedSteps, setAttemptedSteps] = useState<
    ReadonlySet<AgentActorCreateStep>
  >(new Set());

  const validation = validateAgentActorDraft(draft);
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
    if (step === "adapters" && validation.binding) {
      focusInvalid("adapters");
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
            agents={agents}
            draft={draft}
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
          agents={agents}
          diagnostics={diagnostics}
          draft={draft}
          formId="agent-actor-create-form"
          pendingAdapter={pendingAdapter}
          readOnly={readOnly}
          sections={[step as AgentActorFormSection]}
          showValidation={attemptedSteps.has(step)}
          validation={validation}
          validateOnSubmit={false}
          onChange={onChange}
          onCheck={onCheck}
          onSubmit={continueFromStep}
        />
      )}
    </CollectionCreateFlow>
  );
}

function createStepLabel(step: AgentActorCreateStep) {
  if (step === "identity") return m.agent_actors_step_identity();
  if (step === "adapters") return m.agent_actors_agent_label();
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
    binding: cloneBinding(draft.binding),
    mode: draft.mode ? { ...draft.mode } : null,
  };
}
