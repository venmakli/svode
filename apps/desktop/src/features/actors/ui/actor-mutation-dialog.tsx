import { useState, type FormEvent } from "react";
import { AlertTriangle, LoaderCircle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldTitle } from "@/components/ui/field";
import * as m from "@/paraglide/messages.js";

import type {
  ActorMutationAction,
  ActorMutationFailure,
  ActorMutationIntent,
  ActorMutationReview,
} from "../model/identity-mutation";
import type { ActorCatalogRow } from "../model/types";
import {
  ActorIdentityFields,
  type ActorIdentityDraft,
} from "./actor-identity-fields";
import { ActorMergePicker } from "./actor-merge-picker";
import { ActorMutationReviewStep } from "./actor-mutation-review";

export function ActorMutationDialog({
  duplicateEmail,
  failure,
  intent,
  pendingPhase,
  review,
  rows,
  onApply,
  onBack,
  onClose,
  onOpenDuplicate,
  onRequestPreview,
  onRetryReview,
}: {
  duplicateEmail: string | null;
  failure: ActorMutationFailure | null;
  intent: ActorMutationIntent | null;
  pendingPhase: "preview" | "apply" | null;
  review: ActorMutationReview | null;
  rows: readonly ActorCatalogRow[];
  onApply(): void;
  onBack(): void;
  onClose(): void;
  onOpenDuplicate(): void;
  onRequestPreview(action: ActorMutationAction): void;
  onRetryReview(): void;
}) {
  const [mergeTarget, setMergeTarget] = useState<{
    canonicalEmail: string;
    intentKey: string;
  } | null>(null);

  if (!intent) return null;
  const currentIntentKey = intentKey(intent);
  const mergeTargetEmail =
    mergeTarget?.intentKey === currentIntentKey
      ? mergeTarget.canonicalEmail
      : null;
  const pending = pendingPhase !== null;
  const retryable =
    failure?.reason === "stale_preview" ||
    failure?.reason === "current_identity_changed";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="w-[calc(100vw-2rem)] max-w-[480px] overflow-hidden sm:max-w-[480px]">
        <DialogHeader className="min-w-0">
          <DialogTitle>
            {dialogTitle(intent, review, duplicateEmail)}
          </DialogTitle>
          <DialogDescription>
            {dialogDescription(intent, review, duplicateEmail)}
          </DialogDescription>
        </DialogHeader>

        {duplicateEmail ? (
          <DuplicateIdentity canonicalEmail={duplicateEmail} />
        ) : review ? (
          <ActorMutationReviewStep review={review} />
        ) : (
          <ActorMutationInputStep
            key={intentKey(intent)}
            intent={intent}
            pending={pending}
            rows={rows}
            mergeTargetEmail={mergeTargetEmail}
            onMergeTargetChange={(canonicalEmail) =>
              setMergeTarget({ canonicalEmail, intentKey: currentIntentKey })
            }
            onSubmit={onRequestPreview}
          />
        )}

        {failure ? <MutationFailureAlert failure={failure} /> : null}

        <DialogFooter>
          {duplicateEmail ? (
            <>
              <Button type="button" variant="outline" onClick={onClose}>
                {m.actors_mutation_cancel()}
              </Button>
              <Button type="button" onClick={onOpenDuplicate}>
                {m.actors_mutation_open_existing()}
              </Button>
            </>
          ) : review ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={onBack}
              >
                {m.actors_mutation_back()}
              </Button>
              {retryable ? (
                <Button
                  type="button"
                  disabled={pending}
                  onClick={onRetryReview}
                >
                  {pending ? (
                    <LoaderCircle
                      data-icon="inline-start"
                      className="animate-spin"
                    />
                  ) : null}
                  {m.actors_mutation_review_again()}
                </Button>
              ) : (
                <Button type="button" disabled={pending} onClick={onApply}>
                  {pending ? (
                    <LoaderCircle
                      data-icon="inline-start"
                      className="animate-spin"
                    />
                  ) : null}
                  {pendingPhase === "apply"
                    ? m.actors_mutation_applying()
                    : m.actors_mutation_confirm()}
                </Button>
              )}
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={onClose}
              >
                {m.actors_mutation_cancel()}
              </Button>
              <Button
                type="submit"
                form="actor-mutation-form"
                disabled={
                  pending || (intent.kind === "merge" && !mergeTargetEmail)
                }
              >
                {pending ? (
                  <LoaderCircle
                    data-icon="inline-start"
                    className="animate-spin"
                  />
                ) : null}
                {m.actors_mutation_review_action()}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ActorMutationInputStep({
  intent,
  pending,
  rows,
  mergeTargetEmail,
  onMergeTargetChange,
  onSubmit,
}: {
  intent: ActorMutationIntent;
  pending: boolean;
  rows: readonly ActorCatalogRow[];
  mergeTargetEmail: string | null;
  onMergeTargetChange(canonicalEmail: string): void;
  onSubmit(action: ActorMutationAction): void;
}) {
  if (intent.kind === "add" || intent.kind === "edit") {
    const initialValue: ActorIdentityDraft =
      intent.kind === "edit"
        ? {
            canonicalEmail: intent.source.canonicalEmail,
            displayName: intent.source.displayName,
          }
        : { canonicalEmail: "", displayName: "" };
    return (
      <ActorIdentityFields
        initialValue={initialValue}
        pending={pending}
        onSubmit={(value) =>
          onSubmit(
            intent.kind === "add"
              ? { kind: "add", ...value }
              : {
                  kind: "edit",
                  sourceCanonicalEmail: intent.source.canonicalEmail,
                  ...value,
                },
          )
        }
      />
    );
  }

  return (
    <MergeInputStep
      intent={intent}
      pending={pending}
      rows={rows}
      targetEmail={mergeTargetEmail}
      onTargetChange={onMergeTargetChange}
      onSubmit={onSubmit}
    />
  );
}

function MergeInputStep({
  intent,
  pending,
  rows,
  targetEmail,
  onTargetChange,
  onSubmit,
}: {
  intent: Extract<ActorMutationIntent, { kind: "merge" }>;
  pending: boolean;
  rows: readonly ActorCatalogRow[];
  targetEmail: string | null;
  onTargetChange(canonicalEmail: string): void;
  onSubmit(action: ActorMutationAction): void;
}) {
  const targets = rows.filter(
    (row) => row.canonicalEmail !== intent.source.canonicalEmail,
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!targetEmail || pending) return;
    onSubmit({
      kind: "merge",
      sourceCanonicalEmail: intent.source.canonicalEmail,
      targetCanonicalEmail: targetEmail,
    });
  };

  return (
    <form
      id="actor-mutation-form"
      className="flex flex-col gap-4"
      onSubmit={submit}
    >
      <Field orientation="horizontal">
        <FieldTitle>{m.actors_mutation_merge_source_label()}</FieldTitle>
        <span className="min-w-0 truncate text-right">
          {intent.source.displayName}
        </span>
      </Field>
      <ActorMergePicker
        pending={pending}
        rows={targets}
        selectedEmail={targetEmail}
        onSelect={onTargetChange}
      />
    </form>
  );
}

function DuplicateIdentity({ canonicalEmail }: { canonicalEmail: string }) {
  return (
    <Alert>
      <AlertTitle>{m.actors_mutation_duplicate_title()}</AlertTitle>
      <AlertDescription>
        {m.actors_mutation_duplicate_description({ email: canonicalEmail })}
      </AlertDescription>
    </Alert>
  );
}

function MutationFailureAlert({ failure }: { failure: ActorMutationFailure }) {
  return (
    <Alert variant="destructive">
      <AlertTriangle />
      <AlertTitle>{m.actors_mutation_error_title()}</AlertTitle>
      <AlertDescription>{failureMessage(failure)}</AlertDescription>
    </Alert>
  );
}

function failureMessage(failure: ActorMutationFailure) {
  switch (failure.reason) {
    case "access_checking":
      return m.actors_mutation_error_access_checking();
    case "access_read_only":
      return m.actors_mutation_error_access_read_only();
    case "access_unknown":
      return m.actors_mutation_error_access_unknown();
    case "invalid_mailmap":
      return m.actors_mutation_error_invalid_mailmap();
    case "unsafe_mailmap":
      return m.actors_mutation_error_unsafe_mailmap();
    case "invalid_name":
      return m.actors_mutation_name_invalid();
    case "invalid_email":
      return m.actors_mutation_email_invalid();
    case "actor_not_found":
      return m.actors_mutation_error_actor_not_found();
    case "same_merge_target":
      return m.actors_mutation_error_same_target();
    case "no_merge_target":
      return m.actors_mutation_error_no_target();
    case "stale_preview":
      return m.actors_mutation_error_stale();
    case "current_identity_changed":
      return m.actors_mutation_error_current_changed();
    case "unexpected":
      return failure.message;
  }
}

function dialogTitle(
  intent: ActorMutationIntent,
  review: ActorMutationReview | null,
  duplicateEmail: string | null,
) {
  if (duplicateEmail) return m.actors_mutation_duplicate_title();
  if (review) return m.actors_mutation_review_title();
  if (intent.kind === "add") return m.actors_mutation_add_title();
  if (intent.kind === "merge") return m.actors_mutation_merge_title();
  return m.actors_mutation_edit_title();
}

function dialogDescription(
  intent: ActorMutationIntent,
  review: ActorMutationReview | null,
  duplicateEmail: string | null,
) {
  if (duplicateEmail) return m.actors_mutation_duplicate_dialog_description();
  if (review) return m.actors_mutation_review_description();
  if (intent.kind === "add") return m.actors_mutation_add_description();
  if (intent.kind === "merge") return m.actors_mutation_merge_description();
  return m.actors_mutation_edit_description();
}

function intentKey(intent: ActorMutationIntent) {
  return intent.kind === "add"
    ? "add"
    : `${intent.kind}:${intent.source.canonicalEmail}`;
}
