import { useCallback, useState } from "react";

import { applyActorMutation, previewActorMutation } from "../api/actors-api";
import type {
  ActorMutationAction,
  ActorMutationFailure,
  ActorMutationIntent,
  ActorMutationReview,
} from "../model/identity-mutation";
import type { ActorCatalogSnapshot, ActorCatalogRow } from "../model/types";

type ActorMutationPendingPhase = "preview" | "apply" | null;

interface UseActorMutationOptions {
  spacePath: string;
  onApplied(snapshot: ActorCatalogSnapshot, canonicalEmail: string): void;
  onDuplicate(canonicalEmail: string): void;
}

export function useActorMutation({
  spacePath,
  onApplied,
  onDuplicate,
}: UseActorMutationOptions) {
  const [intent, setIntent] = useState<ActorMutationIntent | null>(null);
  const [review, setReview] = useState<ActorMutationReview | null>(null);
  const [duplicateEmail, setDuplicateEmail] = useState<string | null>(null);
  const [failure, setFailure] = useState<ActorMutationFailure | null>(null);
  const [pendingPhase, setPendingPhase] =
    useState<ActorMutationPendingPhase>(null);
  const [sessionId, setSessionId] = useState(0);

  const reset = useCallback(() => {
    setIntent(null);
    setReview(null);
    setDuplicateEmail(null);
    setFailure(null);
    setPendingPhase(null);
  }, []);

  const open = useCallback((nextIntent: ActorMutationIntent) => {
    setSessionId((current) => current + 1);
    setIntent(nextIntent);
    setReview(null);
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
        const result = await previewActorMutation(spacePath, action);
        if (result.status === "ready") {
          setReview(result.review);
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
    [spacePath],
  );

  const apply = useCallback(async () => {
    if (!review || pendingPhase) return;
    setPendingPhase("apply");
    setFailure(null);
    try {
      const result = await applyActorMutation(spacePath, review);
      if (result.status === "applied") {
        onApplied(result.catalog, result.canonicalEmail);
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
  }, [onApplied, pendingPhase, reset, review, spacePath]);

  const back = useCallback(() => {
    if (pendingPhase) return;
    setReview(null);
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
    duplicateEmail,
    failure,
    intent,
    openAdd,
    openDuplicate,
    openEdit,
    openMerge,
    pendingPhase,
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
