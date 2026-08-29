import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import {
  getAgentActorCatalogSaveReview,
  saveAgentActorCatalog,
  type AgentActorCatalogSaveReviewDto,
} from "../api/agent-actors-api";
import { actorOwnerLabel } from "../model/agent-actor-draft";
import type { AgentActorPersistenceOutcome } from "../model/agent-actor-types";
import { actorRootPointerDescription } from "../lib/persistence-feedback";
import {
  consumeAgentActorCatalogSaveRequest,
  useActorMailmapSaveRequest,
} from "../model/mailmap-save-request";
import * as m from "@/paraglide/messages.js";

export interface AgentActorSaveCandidate {
  label: string;
  ownerPath: string;
  review: AgentActorCatalogSaveReviewDto;
}

export function useAgentActorCatalogSave({
  ownerPaths,
  projectPath,
  spacePath,
  onAccessDenied,
}: {
  ownerPaths: readonly string[];
  projectPath: string;
  spacePath: string;
  onAccessDenied?(
    error: unknown,
    candidate: AgentActorSaveCandidate,
  ): boolean | Promise<boolean>;
}) {
  const request = useActorMailmapSaveRequest(
    (state) => state.agentCatalogRequest,
  );
  const [candidates, setCandidates] = useState<AgentActorSaveCandidate[]>([]);
  const [selectedOwnerPath, setSelectedOwnerPath] = useState<string | null>(
    null,
  );
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const open = useCallback(
    async (pinnedOwnerPath?: string | null) => {
      const targets = pinnedOwnerPath ? [pinnedOwnerPath] : [...ownerPaths];
      setPending(true);
      setFailure(null);
      try {
        const results = await Promise.all(
          targets.map(async (ownerPath) => ({
            ownerPath,
            result: await getAgentActorCatalogSaveReview(
              projectPath,
              ownerPath,
            ),
          })),
        );
        const ready = results.flatMap(({ ownerPath, result }) =>
          result.status === "ready"
            ? [
                {
                  label: actorOwnerLabel(ownerPath),
                  ownerPath,
                  review: result.review,
                },
              ]
            : [],
        );
        const blocked = results.find(
          ({ result }) => result.status === "blocked",
        );
        if (ready.length === 0) {
          if (blocked?.result.status === "blocked") {
            toast.error(m.agent_actors_save_catalog_unavailable(), {
              description: blocked.result.message,
            });
          } else {
            toast.info(m.agent_actors_save_catalog_clean());
          }
          return;
        }
        setCandidates(ready);
        setSelectedOwnerPath(ready.length === 1 ? ready[0]!.ownerPath : null);
      } catch (error) {
        toast.error(m.agent_actors_save_catalog_unavailable(), {
          description: errorMessage(error),
        });
      } finally {
        setPending(false);
      }
    },
    [ownerPaths, projectPath],
  );

  useEffect(() => {
    if (
      !request ||
      request.projectPath !== projectPath ||
      request.spacePath !== spacePath ||
      !consumeAgentActorCatalogSaveRequest(request.id)
    ) {
      return;
    }
    void open(request.ownerPath);
  }, [open, projectPath, request, spacePath]);

  const close = useCallback(() => {
    if (pending) return;
    setCandidates([]);
    setSelectedOwnerPath(null);
    setFailure(null);
  }, [pending]);

  const confirm = useCallback(async () => {
    const candidate = candidates.find(
      (item) => item.ownerPath === selectedOwnerPath,
    );
    if (!candidate || pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await saveAgentActorCatalog(
        projectPath,
        candidate.ownerPath,
        candidate.review,
      );
      if (result.status === "stale") {
        close();
        toast.info(m.agent_actors_save_catalog_stale());
      } else if (result.status === "blocked") {
        setFailure(result.message);
      } else {
        close();
        showSaveOutcome(
          result.catalog,
          result.rootPointer ?? null,
          () => void open(candidate.ownerPath),
        );
      }
    } catch (error) {
      if (await onAccessDenied?.(error, candidate)) return;
      setFailure(errorMessage(error));
    } finally {
      setPending(false);
    }
  }, [
    candidates,
    close,
    onAccessDenied,
    open,
    pending,
    projectPath,
    selectedOwnerPath,
  ]);

  return {
    candidates,
    close,
    confirm,
    failure,
    open,
    pending,
    selectedOwnerPath,
    setSelectedOwnerPath,
  };
}

function showSaveOutcome(
  catalog: AgentActorPersistenceOutcome,
  rootPointer: AgentActorPersistenceOutcome | null,
  retry: () => void,
) {
  if (rootPointer?.status === "failed" || rootPointer?.status === "pending") {
    toast.warning(m.agent_actors_mutation_committed(), {
      action: { label: m.agent_actors_save_catalog(), onClick: retry },
      description: actorRootPointerDescription(rootPointer),
    });
  } else if (catalog.status === "committed" || catalog.status === "clean") {
    toast.success(m.agent_actors_mutation_committed());
  } else {
    toast.error(m.agent_actors_save_catalog_unavailable(), {
      description: catalog.status === "failed" ? catalog.message : undefined,
    });
  }
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Unknown agent actor catalog save error";
}
