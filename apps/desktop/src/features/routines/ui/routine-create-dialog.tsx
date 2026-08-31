import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { AgentActorOption } from "@/features/actors";
import {
  CollectionCreateFlow,
  type CollectionCreateFlowFocusRequest,
  type CollectionCreateFlowFocusTarget,
} from "@/features/collection/core";
import * as m from "@/paraglide/messages.js";

import {
  areRoutineDefinitionsEqual,
  firstInvalidRoutineCreateStep,
  isRoutineCreateStepValid,
  ROUTINE_CREATE_STEPS,
  type RoutineCreateStep,
} from "../model/routine-create";
import {
  validateRoutineDraft,
  type RoutineDraftIssue,
} from "../model/routine-draft";
import type { RoutineDefinition } from "../model/types";
import { RoutineActionFields } from "./routine-action-fields";
import { RoutineContentField } from "./routine-content-field";
import { RoutineCreateReview } from "./routine-create-review";
import { RoutineIdentityFields } from "./routine-identity-fields";
import { RoutineTriggerFields } from "./routine-trigger-fields";

export function RoutineCreateDialog({
  collectionOwner,
  error,
  definition,
  initialDefinition,
  nameError = null,
  automaticAuthority,
  executorError,
  executorLoading,
  executors,
  ownerLabel,
  pending,
  readOnly = false,
  retryBlocked,
  onChange,
  onClose,
  onRetryExecutors,
  onSubmit,
}: {
  automaticAuthority: boolean | null;
  collectionOwner: boolean;
  definition: RoutineDefinition;
  error: string | null;
  executorError: string | null;
  executorLoading: boolean;
  executors: readonly AgentActorOption[];
  initialDefinition: RoutineDefinition;
  nameError?: string | null;
  ownerLabel: string;
  pending: boolean;
  readOnly?: boolean;
  retryBlocked: boolean;
  onChange(definition: RoutineDefinition): void;
  onClose(): void;
  onRetryExecutors(): void;
  onSubmit(): void;
}) {
  const submitRequestedRef = useRef(false);
  const [step, setStep] = useState<RoutineCreateStep>("basics");
  const [focusRequest, setFocusRequest] =
    useState<CollectionCreateFlowFocusRequest>({
      id: 0,
      target: "control",
    });
  const [attemptedSteps, setAttemptedSteps] = useState<
    ReadonlySet<RoutineCreateStep>
  >(new Set());
  const validationContext = useMemo(
    () => ({
      collectionOwner,
      executorError,
      executorLoading,
      executors,
      nameAvailable: !nameError,
    }),
    [collectionOwner, executorError, executorLoading, executors, nameError],
  );
  const issues = validateRoutineDraft(definition);
  const stepIndex = ROUTINE_CREATE_STEPS.indexOf(step);
  const stepLabel = createStepLabel(step);
  const progressLabel = m.routines_create_progress({
    current: stepIndex + 1,
    step: stepLabel,
    total: ROUTINE_CREATE_STEPS.length,
  });

  useEffect(() => {
    if (!pending) submitRequestedRef.current = false;
  }, [pending]);

  useEffect(() => {
    if (!nameError) return;
    const frame = window.requestAnimationFrame(() => {
      setFocusRequest((current) => ({
        id: current.id + 1,
        target: "control",
      }));
      if (step !== "basics") setStep("basics");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [nameError, step]);

  const markAttempted = (target: RoutineCreateStep) => {
    setAttemptedSteps((current) => new Set([...current, target]));
  };
  const requestFocus = (target: CollectionCreateFlowFocusTarget) => {
    setFocusRequest((current) => ({ id: current.id + 1, target }));
  };
  const moveTo = (
    target: RoutineCreateStep,
    focus: "control" | "heading" = "heading",
  ) => {
    requestFocus(focus);
    setStep(target);
  };
  const focusInvalid = (target: Exclude<RoutineCreateStep, "review">) => {
    markAttempted(target);
    if (target === step) {
      requestFocus("control");
      return;
    }
    moveTo(target, "control");
  };
  const continueFromStep = () => {
    markAttempted(step);
    if (!isRoutineCreateStepValid(step, definition, validationContext)) {
      if (step !== "review") focusInvalid(step);
      return;
    }
    const next = ROUTINE_CREATE_STEPS[stepIndex + 1];
    if (next) moveTo(next);
  };
  const submit = () => {
    if (readOnly || submitRequestedRef.current || retryBlocked) return;
    const invalidStep = firstInvalidRoutineCreateStep(
      definition,
      validationContext,
    );
    if (invalidStep) {
      focusInvalid(invalidStep);
      return;
    }
    submitRequestedRef.current = true;
    onSubmit();
  };
  const visibleIssues: ReadonlySet<RoutineDraftIssue> = attemptedSteps.has(step)
    ? issues
    : new Set<RoutineDraftIssue>();

  return (
    <CollectionCreateFlow
      backAction={
        stepIndex > 0
          ? {
              label: m.routines_create_back(),
              onClick: () => moveTo(ROUTINE_CREATE_STEPS[stepIndex - 1]!),
            }
          : undefined
      }
      cancelLabel={m.routines_cancel()}
      currentStep={stepIndex + 1}
      dirty={!areRoutineDefinitionsEqual(initialDefinition, definition)}
      discardConfirmation={{
        cancelLabel: m.routines_create_discard_keep_editing(),
        confirmLabel: m.routines_create_discard_action(),
        description: m.routines_create_discard_description(),
        title: m.routines_discard_confirm(),
      }}
      flowId="routine"
      focusRequest={focusRequest}
      getControlFocusTarget={getRoutineControlFocusTarget}
      locked={pending}
      modal={false}
      primaryAction={
        step === "review"
          ? {
              disabled: readOnly || retryBlocked,
              label: m.routines_create_confirm(),
              onClick: submit,
              pending,
              pendingLabel: m.routines_creating(),
            }
          : {
              disabled: readOnly,
              form: "routine-create-form",
              label: m.routines_create_continue(),
            }
      }
      progressLabel={progressLabel}
      stepKey={step}
      stepLabel={stepLabel}
      title={m.routines_create_title()}
      totalSteps={ROUTINE_CREATE_STEPS.length}
      onClose={onClose}
    >
      <fieldset disabled={readOnly} className="contents">
        {step === "review" ? (
          <div className="flex flex-col gap-4">
            <RoutineCreateReview
              automaticAuthority={automaticAuthority}
              definition={definition}
              executors={executors}
              ownerLabel={ownerLabel}
              onEdit={(target) => moveTo(target, "control")}
            />
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        ) : (
          <form
            id="routine-create-form"
            className="flex min-h-0 flex-col gap-6"
            onSubmit={(event) => {
              event.preventDefault();
              continueFromStep();
            }}
          >
            {step === "basics" ? (
              <div className="flex flex-col gap-5">
                <Field>
                  <FieldLabel htmlFor="routine-create-owner">
                    {m.routines_create_owner_label()}
                  </FieldLabel>
                  <Input
                    id="routine-create-owner"
                    readOnly
                    value={ownerLabel}
                  />
                  <FieldDescription>
                    {m.routines_create_owner_hint()}
                  </FieldDescription>
                </Field>
                <RoutineIdentityFields
                  definition={definition}
                  idPrefix="routine-create"
                  nameError={nameError}
                  showValidation={
                    attemptedSteps.has("basics") || Boolean(nameError)
                  }
                  onChange={onChange}
                />
              </div>
            ) : null}
            {step === "trigger" ? (
              <RoutineTriggerFields
                collectionOwner={collectionOwner}
                definition={definition}
                idPrefix="routine-create"
                issues={visibleIssues}
                onChange={onChange}
              />
            ) : null}
            {step === "action" ? (
              <>
                {executorLoading && definition.action.type === "run_agent" ? (
                  <Alert>
                    <LoaderCircle className="animate-spin" />
                    <AlertDescription>
                      {m.routines_create_executors_loading()}
                    </AlertDescription>
                  </Alert>
                ) : null}
                {executorError && definition.action.type === "run_agent" ? (
                  <Alert variant="destructive">
                    <AlertDescription className="flex flex-col items-start gap-2">
                      <span>{executorError}</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={onRetryExecutors}
                      >
                        {m.routines_retry()}
                      </Button>
                    </AlertDescription>
                  </Alert>
                ) : null}
                <RoutineActionFields
                  definition={definition}
                  executorError={executorError}
                  executors={executors}
                  idPrefix="routine-create"
                  issues={visibleIssues}
                  loading={executorLoading}
                  onChange={onChange}
                />
                <RoutineContentField
                  definition={definition}
                  editorKey="routine-create"
                  onChange={onChange}
                />
              </>
            ) : null}
          </form>
        )}
      </fieldset>
    </CollectionCreateFlow>
  );
}

function createStepLabel(step: RoutineCreateStep) {
  if (step === "basics") return m.routines_create_step_basics();
  if (step === "trigger") return m.routines_create_step_trigger();
  if (step === "action") return m.routines_create_step_action();
  return m.routines_create_step_review();
}

function getRoutineControlFocusTarget(content: HTMLDivElement, step: string) {
  if (step !== "review") {
    const invalid = content.querySelector<HTMLElement>(
      '[aria-invalid="true"]:not(:disabled), [data-routine-create-invalid="true"]:not(:disabled)',
    );
    const fallback = content.querySelector<HTMLElement>(
      `[data-routine-create-focus="${step}"]:not(:disabled)`,
    );
    return invalid ?? fallback;
  }
  return null;
}
