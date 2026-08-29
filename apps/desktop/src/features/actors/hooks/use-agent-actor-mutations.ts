import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import type { SystemCollectionDetailController } from "@/features/collection/system";
import * as m from "@/paraglide/messages.js";

import {
  createAgentActorId,
  mutateAgentActor,
  previewAgentActorDeleteReferences,
  toAgentActorMutationActor,
} from "../api/agent-actors-api";
import {
  actorPersistenceNeedsAttention,
  actorRootPointerDescription,
} from "../lib/persistence-feedback";
import { createAgentActorDraft } from "../model/agent-actor-draft";
import type {
  AgentActorCatalogSnapshot,
  AgentActorDeleteReferenceState,
  AgentActorDraft,
  AgentActorMutationApplied,
  AgentActorRow,
} from "../model/agent-actor-types";

export interface AgentActorEditSession {
  draft: AgentActorDraft;
  guard: { dirty: boolean };
  row: AgentActorRow;
}

export interface AgentActorMutationAccessContext {
  draftOrRow: AgentActorDraft | AgentActorRow;
  kind: "create" | "update" | "delete";
  ownerPath: string;
}

export function useAgentActorMutations({
  detailController,
  projectPath,
  refresh,
  saveCatalog,
  snapshot,
  onAccessDenied,
}: {
  detailController: SystemCollectionDetailController | null;
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
  const [deleteActor, setDeleteActor] = useState<AgentActorRow | null>(null);
  const [deleteReferences, setDeleteReferences] =
    useState<AgentActorDeleteReferenceState>({ phase: "idle" });
  const deletePreviewRequestRef = useRef(0);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

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
    (row: AgentActorRow) => {
      const requestId = ++deletePreviewRequestRef.current;
      setFailure(null);
      setDeleteActor(row);
      setDeleteReferences({ phase: "loading" });
      void previewAgentActorDeleteReferences(
        projectPath,
        row.ownerPath,
        row.id,
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
  const openEdit = useCallback((row: AgentActorRow) => {
    setFailure(null);
    setEditSession({
      draft: createAgentActorDraft(row.ownerPath, row),
      guard: { dirty: false },
      row,
    });
  }, []);

  const apply = useCallback(
    async (
      kind: "create" | "update" | "delete",
      targetOwnerPath: string,
      draftOrRow: AgentActorDraft | AgentActorRow,
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
            ? ({ kind, actorId: (draftOrRow as AgentActorRow).id } as const)
            : await portableMutation(kind, draftOrRow as AgentActorDraft);
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
        setCreateDraft(null);
        setDeleteActor(null);
        setDeleteReferences({ phase: "idle" });
        if (editSession) editSession.guard.dirty = false;
        setEditSession(null);
        await detailController?.close();
        await refresh();
      } catch (error) {
        if (
          await onAccessDenied?.(error, {
            draftOrRow,
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
      detailController,
      editSession,
      projectPath,
      refresh,
      saveCatalog,
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

async function portableMutation(
  kind: "create" | "update",
  draft: AgentActorDraft,
) {
  const id = draft.id ?? (await createAgentActorId());
  return {
    kind,
    actor: toAgentActorMutationActor({ ...draft, id }),
    approvalMode: draft.approvalMode,
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
