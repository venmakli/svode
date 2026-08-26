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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import type { AgentActorOption } from "@/features/actors";
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
  retryBlocked: boolean;
  onChange(definition: RoutineDefinition): void;
  onClose(): void;
  onRetryExecutors(): void;
  onSubmit(): void;
}) {
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document === "undefined"
      ? null
      : (document.activeElement as HTMLElement | null),
  );
  const contentRef = useRef<HTMLDivElement>(null);
  const focusTargetRef = useRef<"control" | "heading">("control");
  const submitRequestedRef = useRef(false);
  const [step, setStep] = useState<RoutineCreateStep>("basics");
  const [attemptedSteps, setAttemptedSteps] = useState<
    ReadonlySet<RoutineCreateStep>
  >(new Set());
  const [discardOpen, setDiscardOpen] = useState(false);
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
    focusCurrentStep(contentRef.current, step, focusTargetRef.current);
    focusTargetRef.current = "heading";
  }, [step]);

  useEffect(() => {
    if (!pending) submitRequestedRef.current = false;
  }, [pending]);

  useEffect(() => {
    if (!nameError) return;
    focusTargetRef.current = "control";
    const frame = window.requestAnimationFrame(() => {
      if (step === "basics") {
        focusCurrentStep(contentRef.current, "basics", "control");
      } else setStep("basics");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [nameError, step]);

  const markAttempted = (target: RoutineCreateStep) => {
    setAttemptedSteps((current) => new Set([...current, target]));
  };
  const moveTo = (
    target: RoutineCreateStep,
    focus: "control" | "heading" = "heading",
  ) => {
    focusTargetRef.current = focus;
    setStep(target);
  };
  const focusInvalid = (target: Exclude<RoutineCreateStep, "review">) => {
    markAttempted(target);
    if (target === step) {
      window.requestAnimationFrame(() =>
        focusCurrentStep(contentRef.current, target, "control"),
      );
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
    if (submitRequestedRef.current || retryBlocked) return;
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
  const close = () => {
    const returnFocusTarget = returnFocusRef.current;
    onClose();
    window.requestAnimationFrame(() => {
      if (returnFocusTarget?.isConnected) returnFocusTarget.focus();
    });
  };
  const requestClose = () => {
    if (pending) return;
    if (areRoutineDefinitionsEqual(initialDefinition, definition)) {
      close();
      return;
    }
    setDiscardOpen(true);
  };
  const visibleIssues: ReadonlySet<RoutineDraftIssue> = attemptedSteps.has(step)
    ? issues
    : new Set<RoutineDraftIssue>();

  return (
    <>
      <Dialog
        open
        modal={false}
        onOpenChange={(open) => !open && requestClose()}
      >
        <DialogContent
          ref={contentRef}
          className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden"
          data-routine-create-journey
          data-routine-create-step={step}
          showCloseButton={!pending}
        >
          <DialogHeader className="shrink-0 pr-8">
            <DialogTitle>{m.routines_create_title()}</DialogTitle>
            <DialogDescription>{progressLabel}</DialogDescription>
            <Progress
              value={((stepIndex + 1) / ROUTINE_CREATE_STEPS.length) * 100}
              aria-label={progressLabel}
            />
          </DialogHeader>
          <div
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 py-1"
            data-routine-create-scroll-owner
          >
            <h2
              className="mb-4 text-base font-medium outline-none"
              data-routine-create-step-heading
              tabIndex={-1}
            >
              {stepLabel}
            </h2>
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
                    {executorLoading &&
                    definition.action.type === "run_agent" ? (
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
          </div>
          <DialogFooter className="shrink-0">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={requestClose}
            >
              {m.routines_cancel()}
            </Button>
            {stepIndex > 0 ? (
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => moveTo(ROUTINE_CREATE_STEPS[stepIndex - 1]!)}
              >
                {m.routines_create_back()}
              </Button>
            ) : null}
            {step === "review" ? (
              <Button
                type="button"
                disabled={pending || retryBlocked}
                onClick={submit}
              >
                {pending ? (
                  <LoaderCircle
                    data-icon="inline-start"
                    className="animate-spin"
                  />
                ) : null}
                {pending ? m.routines_creating() : m.routines_create_confirm()}
              </Button>
            ) : (
              <Button
                type="submit"
                form="routine-create-form"
                disabled={pending}
              >
                {m.routines_create_continue()}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.routines_discard_confirm()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.routines_create_discard_description()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {m.routines_create_discard_keep_editing()}
            </AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={close}>
              {m.routines_create_discard_action()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function createStepLabel(step: RoutineCreateStep) {
  if (step === "basics") return m.routines_create_step_basics();
  if (step === "trigger") return m.routines_create_step_trigger();
  if (step === "action") return m.routines_create_step_action();
  return m.routines_create_step_review();
}

function focusCurrentStep(
  content: HTMLDivElement | null,
  step: RoutineCreateStep,
  target: "control" | "heading",
) {
  if (!content) return;
  if (target === "control" && step !== "review") {
    const invalid = content.querySelector<HTMLElement>(
      '[aria-invalid="true"]:not(:disabled), [data-routine-create-invalid="true"]:not(:disabled)',
    );
    const fallback = content.querySelector<HTMLElement>(
      `[data-routine-create-focus="${step}"]:not(:disabled)`,
    );
    (invalid ?? fallback)?.focus();
    if (invalid || fallback) return;
  }
  content
    .querySelector<HTMLElement>("[data-routine-create-step-heading]")
    ?.focus();
}
