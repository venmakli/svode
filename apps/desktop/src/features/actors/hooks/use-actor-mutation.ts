import { useCallback, useState } from "react";

import { applyActorMutation, previewActorMutation } from "../api/actors-api";
import type {
  ActorMutationAction,
  ActorCommitExpectation,
  ActorMutationFailure,
  ActorMutationIntent,
  ActorMutationReview,
  AppliedActorMutationResult,
} from "../model/identity-mutation";
import type { ActorCatalogRow } from "../model/types";

type ActorMutationPendingPhase = "preview" | "apply" | null;

interface UseActorMutationOptions {
  projectPath: string;
  spacePath: string;
  onApplied(result: AppliedActorMutationResult): void;
  onDuplicate(canonicalEmail: string): void;
}

export function useActorMutation({
  projectPath,
  spacePath,
  onApplied,
  onDuplicate,
}: UseActorMutationOptions) {
  const [intent, setIntent] = useState<ActorMutationIntent | null>(null);
  const [review, setReview] = useState<ActorMutationReview | null>(null);
  const [commitExpectation, setCommitExpectation] =
    useState<ActorCommitExpectation | null>(null);
  const [rootPointerCommitExpectation, setRootPointerCommitExpectation] =
    useState<ActorCommitExpectation | null>(null);
  const [duplicateEmail, setDuplicateEmail] = useState<string | null>(null);
  const [failure, setFailure] = useState<ActorMutationFailure | null>(null);
  const [pendingPhase, setPendingPhase] =
    useState<ActorMutationPendingPhase>(null);
  const [sessionId, setSessionId] = useState(0);

  const reset = useCallback(() => {
    setIntent(null);
    setReview(null);
    setCommitExpectation(null);
    setRootPointerCommitExpectation(null);
    setDuplicateEmail(null);
    setFailure(null);
    setPendingPhase(null);
  }, []);

  const open = useCallback((nextIntent: ActorMutationIntent) => {
    setSessionId((current) => current + 1);
    setIntent(nextIntent);
    setReview(null);
    setCommitExpectation(null);
    setRootPointerCommitExpectation(null);
    setDuplicateEmail(null);
    setFailure(null);
    setPendingPhase(null);
  }, []);
  const openAdd = useCallback(() => open({ kind: "add" }), [open]);
  const openEdit = useCallback(
    (source: ActorCatalogRow) => open({ kind: "edit", source }),
    [open],
  );
  const openMerge = useCallback(
    (source: ActorCatalogRow) => open({ kind: "merge", source }),
    [open],
  );

  const close = useCallback(() => {
    if (pendingPhase) return;
    reset();
  }, [pendingPhase, reset]);

  const requestPreview = useCallback(
    async (action: ActorMutationAction) => {
      setPendingPhase("preview");
      setFailure(null);
      setDuplicateEmail(null);
      try {
        const result = await previewActorMutation(
          projectPath,
          spacePath,
          action,
        );
        if (result.status === "ready") {
          setReview(result.review);
          setCommitExpectation(result.commitExpectation);
          setRootPointerCommitExpectation(result.rootPointerCommitExpectation);
        } else if (result.status === "duplicate") {
          setDuplicateEmail(result.canonicalEmail);
        } else {
          setFailure({ message: result.message, reason: result.reason });
        }
      } catch (error) {
        setFailure({ message: errorMessage(error), reason: "unexpected" });
      } finally {
        setPendingPhase(null);
      }
    },
    [projectPath, spacePath],
  );

  const apply = useCallback(async () => {
    if (!review || pendingPhase) return;
    setPendingPhase("apply");
    setFailure(null);
    try {
      const result = await applyActorMutation(projectPath, spacePath, review);
      if (result.status === "applied") {
        onApplied(result);
        reset();
      } else if (result.status === "duplicate") {
        setDuplicateEmail(result.canonicalEmail);
      } else {
        setFailure({ message: result.message, reason: result.reason });
      }
    } catch (error) {
      setFailure({ message: errorMessage(error), reason: "unexpected" });
    } finally {
      setPendingPhase(null);
    }
  }, [onApplied, pendingPhase, projectPath, reset, review, spacePath]);

  const back = useCallback(() => {
    if (pendingPhase) return;
    setReview(null);
    setCommitExpectation(null);
    setRootPointerCommitExpectation(null);
    setDuplicateEmail(null);
    setFailure(null);
  }, [pendingPhase]);

  const retryReview = useCallback(() => {
    if (review) void requestPreview(review.action);
  }, [requestPreview, review]);

  const openDuplicate = useCallback(() => {
    if (!duplicateEmail || pendingPhase) return;
    onDuplicate(duplicateEmail);
    reset();
  }, [duplicateEmail, onDuplicate, pendingPhase, reset]);

  return {
    apply,
    back,
    close,
    commitExpectation,
    duplicateEmail,
    failure,
    intent,
    openAdd,
    openDuplicate,
    openEdit,
    openMerge,
    pendingPhase,
    rootPointerCommitExpectation,
    requestPreview,
    retryReview,
    review,
    sessionId,
  };
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Unknown actor mutation error";
}
