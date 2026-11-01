import { useCallback, useRef, useState } from "react";

import { useSignalUserEdit } from "@/features/navigation";
import { toast } from "sonner";

import * as m from "@/paraglide/messages.js";

import {
  createAgentActorId,
  mutateAgentActor,
  previewAgentActorDeleteReferences,
  toAgentActorMutationActor,
  toAgentActorModeDto,
} from "../api/agent-actors-api";
import {
  actorPersistenceNeedsAttention,
  actorRootPointerDescription,
} from "../lib/persistence-feedback";
import {
  createAgentActorDraft,
  isAgentActorPortableUnchanged,
} from "../model/agent-actor-draft";
import type {
  AgentActorCatalogSnapshot,
  AgentActorDeleteReferenceState,
  AgentActorDraft,
  AgentActorMutationApplied,
  AgentActorItem,
} from "../model/agent-actor-types";

export interface AgentActorEditSession {
  draft: AgentActorDraft;
  guard: { dirty: boolean };
  item: AgentActorItem;
}

export interface AgentActorMutationAccessContext {
  draftOrItem: AgentActorDraft | AgentActorItem;
  kind: "create" | "update" | "delete";
  ownerPath: string;
}

export function useAgentActorMutations({
  projectPath,
  refresh,
  saveCatalog,
  snapshot,
  onAccessDenied,
}: {
  projectPath: string;
  refresh(): void | Promise<void>;
  saveCatalog(ownerPath: string): void;
  snapshot: AgentActorCatalogSnapshot | null;
  onAccessDenied?(
    error: unknown,
    context: AgentActorMutationAccessContext,
  ): boolean | Promise<boolean>;
}) {
  const [createDraft, setCreateDraft] = useState<AgentActorDraft | null>(null);
  const [editSession, setEditSession] = useState<AgentActorEditSession | null>(
    null,
  );
  const [deleteActor, setDeleteActor] = useState<AgentActorItem | null>(null);
  const [deleteReferences, setDeleteReferences] =
    useState<AgentActorDeleteReferenceState>({ phase: "idle" });
  const deletePreviewRequestRef = useRef(0);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // An edit of an Agent the main area shows keeps it in Now.
  const signalUserEdit = useSignalUserEdit();

  const openCreate = useCallback((ownerPath: string) => {
    setFailure(null);
    setCreateDraft(createAgentActorDraft(ownerPath));
  }, []);
  const closeDelete = useCallback(() => {
    ++deletePreviewRequestRef.current;
    setDeleteActor(null);
    setDeleteReferences({ phase: "idle" });
  }, []);
  const openDelete = useCallback(
    (item: AgentActorItem) => {
      const requestId = ++deletePreviewRequestRef.current;
      setFailure(null);
      setDeleteActor(item);
      setDeleteReferences({ phase: "loading" });
      void previewAgentActorDeleteReferences(
        projectPath,
        item.ownerPath,
        item.id,
      ).then(
        (preview) => {
          if (requestId !== deletePreviewRequestRef.current) return;
          setDeleteReferences({
            diagnostics: preview.diagnostics,
            phase: "ready",
            references: preview.references,
          });
        },
        (error: unknown) => {
          if (requestId !== deletePreviewRequestRef.current) return;
          setDeleteReferences({ phase: "error", message: errorMessage(error) });
        },
      );
    },
    [projectPath],
  );
  const openEdit = useCallback((item: AgentActorItem) => {
    setFailure(null);
    setEditSession({
      draft: createAgentActorDraft(item.ownerPath, item),
      guard: { dirty: false },
      item,
    });
  }, []);

  const apply = useCallback(
    async (
      kind: "create" | "update" | "delete",
      targetOwnerPath: string,
      draftOrItem: AgentActorDraft | AgentActorItem,
    ) => {
      if (!snapshot) return;
      const fingerprint = snapshot.fingerprints[targetOwnerPath];
      if (!fingerprint) {
        setFailure(m.agent_actors_catalog_unavailable());
        return;
      }
      setPending(true);
      setFailure(null);
      try {
        const mutation =
          kind === "delete"
            ? ({ kind, actorId: (draftOrItem as AgentActorItem).id } as const)
            : await draftMutation(
                kind,
                draftOrItem as AgentActorDraft,
                snapshot.items.find(
                  (item) =>
                    item.ownerPath === targetOwnerPath &&
                    item.id === (draftOrItem as AgentActorDraft).id,
                ),
              );
        const result = await mutateAgentActor({
          expectedFingerprint: fingerprint,
          mutation,
          ownerPath: targetOwnerPath,
          projectPath,
        });
        if (result === "stale") {
          setFailure(m.agent_actors_mutation_stale());
          return;
        }
        if ("blocked" in result) {
          setFailure(result.blocked);
          return;
        }
        showMutationOutcome(result, () => saveCatalog(targetOwnerPath));
        if (kind === "update") signalUserEdit();
        setCreateDraft(null);
        setDeleteActor(null);
        setDeleteReferences({ phase: "idle" });
        if (editSession) editSession.guard.dirty = false;
        // An edited Agent shows again in its peek; a deleted one closes it.
        setEditSession(null);
        await refresh();
      } catch (error) {
        if (
          await onAccessDenied?.(error, {
            draftOrItem,
            kind,
            ownerPath: targetOwnerPath,
          })
        ) {
          return;
        }
        setFailure(errorMessage(error));
      } finally {
        setPending(false);
      }
    },
    [
      editSession,
      projectPath,
      refresh,
      saveCatalog,
      signalUserEdit,
      snapshot,
      onAccessDenied,
    ],
  );

  return {
    apply,
    closeDelete,
    createDraft,
    deleteActor,
    deleteReferences,
    editSession,
    failure,
    openCreate,
    openDelete,
    openEdit,
    pending,
    setCreateDraft,
    setEditSession,
  };
}

/**
 * The write of a draft: a change of the device mode alone is local-only
 * and leaves the catalog and Git as they are (Stage 11 `03`).
 */
async function draftMutation(
  kind: "create" | "update",
  draft: AgentActorDraft,
  current: AgentActorItem | undefined,
) {
  if (
    kind === "update" &&
    current &&
    isAgentActorPortableUnchanged(draft, current)
  ) {
    return {
      kind: "set_mode",
      actorId: current.id,
      mode: toAgentActorModeDto(draft.mode),
    } as const;
  }
  const id = draft.id ?? (await createAgentActorId());
  return {
    kind,
    actor: toAgentActorMutationActor({ ...draft, id }),
    mode: toAgentActorModeDto(draft.mode),
  } as const;
}

function showMutationOutcome(
  result: AgentActorMutationApplied,
  saveCatalog: () => void,
) {
  const rootNeedsAttention = actorPersistenceNeedsAttention(
    result.rootPointer ?? undefined,
  );
  const action =
    actorPersistenceNeedsAttention(result.persistence) || rootNeedsAttention
      ? { label: m.agent_actors_save_catalog(), onClick: saveCatalog }
      : undefined;
  const description = rootNeedsAttention
    ? actorRootPointerDescription(result.rootPointer ?? undefined)
    : undefined;
  if (result.persistence.status === "committed") {
    toast[rootNeedsAttention ? "warning" : "success"](
      m.agent_actors_mutation_committed(),
      { action, description },
    );
  } else if (result.persistence.status === "pending") {
    toast.info(m.agent_actors_mutation_pending(), {
      action,
      description,
    });
  } else if (result.persistence.status === "failed") {
    toast.error(m.agent_actors_mutation_commit_failed(), {
      action,
      description: [result.persistence.message, description]
        .filter(Boolean)
        .join(" "),
    });
  } else {
    toast[rootNeedsAttention ? "warning" : "success"](
      m.agent_actors_mutation_saved(),
      { action, description },
    );
  }
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return m.agent_actors_mutation_blocked();
}
