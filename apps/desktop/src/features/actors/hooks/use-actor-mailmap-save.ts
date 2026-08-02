import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import * as m from "@/paraglide/messages.js";

import { getActorMailmapSaveReview, saveActorMailmap } from "../api/actors-api";
import { actorManualSaveFeedback } from "../lib/persistence-feedback";
import type { ActorMailmapSaveReview } from "../model/mailmap-save";
import {
  consumeActorMailmapSaveRequest,
  useActorMailmapSaveRequest,
} from "../model/mailmap-save-request";

type PendingPhase = "review" | "commit" | null;

export function useActorMailmapSave({
  projectPath,
  spacePath,
}: {
  projectPath: string;
  spacePath: string;
}) {
  const request = useActorMailmapSaveRequest((state) => state.request);
  const [review, setReview] = useState<ActorMailmapSaveReview | null>(null);
  const [pendingPhase, setPendingPhase] = useState<PendingPhase>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const requestReview = useCallback(async () => {
    setPendingPhase("review");
    setFailure(null);
    try {
      const result = await getActorMailmapSaveReview(projectPath, spacePath);
      if (result.status === "ready") {
        setReview(result.review);
      } else if (result.status === "clean") {
        toast.info(m.actors_mailmap_save_clean());
      } else {
        toast.error(m.actors_mailmap_save_unavailable(), {
          description: result.message,
        });
      }
    } catch (error) {
      toast.error(m.actors_mailmap_save_unavailable(), {
        description: errorMessage(error),
      });
    } finally {
      setPendingPhase(null);
    }
  }, [projectPath, spacePath]);

  useEffect(() => {
    if (
      !request ||
      request.projectPath !== projectPath ||
      request.spacePath !== spacePath
    ) {
      return;
    }
    if (!consumeActorMailmapSaveRequest(request.id)) return;
    void requestReview();
  }, [projectPath, request, requestReview, spacePath]);

  const close = useCallback(() => {
    if (pendingPhase) return;
    setReview(null);
    setFailure(null);
  }, [pendingPhase]);

  const confirm = useCallback(async () => {
    if (!review || pendingPhase) return;
    setPendingPhase("commit");
    setFailure(null);
    try {
      const result = await saveActorMailmap(projectPath, spacePath, review);
      if (result.status === "saved") {
        setReview(null);
        const feedback = actorManualSaveFeedback(result.persistence);
        toast[feedback.tone](feedback.title, {
          description: feedback.description,
        });
      } else if (result.status === "stale") {
        setReview(null);
        toast.info(m.actors_mailmap_save_stale());
      } else {
        setFailure(result.message);
      }
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setPendingPhase(null);
    }
  }, [pendingPhase, projectPath, review, spacePath]);

  return {
    close,
    confirm,
    failure,
    pendingPhase,
    review,
  };
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Unknown .mailmap save error";
}
