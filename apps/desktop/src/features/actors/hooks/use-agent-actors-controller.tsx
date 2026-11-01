import { useCallback, useMemo } from "react";

import type {
  CollectionActionState,
  CollectionPresentationState,
} from "@/features/collection";
import type { CollectionItemPeekController } from "@/features/collection/app-shell";
import { RepositoryAccessPreflightDialog } from "@/features/git";
import type { ScopeOwnerRef } from "@/features/scope-surfaces";
import * as m from "@/paraglide/messages.js";

import type { ActorPeekTarget } from "../model/actor-peek";
import type {
  AgentActorAgentOption,
  AgentActorItem,
} from "../model/agent-actor-types";
import {
  useAgentActorAccessCoordinator,
  type AgentActorAccessIntent,
} from "./use-agent-actor-access-coordinator";
import { useAgentActorCatalog } from "./use-agent-actor-catalog";
import { useAgentActorCatalogSave } from "./use-agent-actor-catalog-save";
import { useAgentActorPeek } from "./use-agent-actor-peek";
import { useAgentActorFacts } from "./use-agent-actor-facts";
import {
  useAgentActorMutations,
  type AgentActorMutationAccessContext,
} from "./use-agent-actor-mutations";
import { AgentActorDeleteDialog } from "../ui/agent-actor-delete-dialog";
import { AgentActorEditorDialog } from "../ui/agent-actor-editor-dialog";
import { AgentActorSaveDialog } from "../ui/agent-actor-save-dialog";
import { CatalogRetryButton } from "../ui/catalog-retry-button";

const NO_AGENTS: readonly AgentActorAgentOption[] = [];

export function useAgentActorsController({
  owner,
  peek,
  readOnly,
  onOpenAgentSettings,
  onOpenRepositorySettings,
}: {
  owner: ScopeOwnerRef;
  peek: CollectionItemPeekController<ActorPeekTarget>;
  readOnly: boolean;
  onOpenAgentSettings(): void;
  onOpenRepositorySettings?: (repositoryPath: string) => void;
}) {
  const catalog = useAgentActorCatalog(owner.projectPath, owner.spacePath);
  const snapshot =
    catalog.state.phase === "ready" ? catalog.state.snapshot : null;
  const ownerPaths = useMemo(
    () => [
      ...new Set(
        snapshot
          ? [
              owner.spacePath,
              ...Object.keys(snapshot.fingerprints),
              ...snapshot.items.map((item) => item.ownerPath),
            ]
          : [owner.spacePath],
      ),
    ],
    [owner.spacePath, snapshot],
  );
  const catalogSave = useAgentActorCatalogSave({
    onAccessDenied: handleCatalogAccessDenied,
    ownerPaths,
    projectPath: owner.projectPath,
    spacePath: owner.spacePath,
  });
  const openCatalogSaveReview = catalogSave.open;
  const openCatalogSave = useCallback(
    (ownerPath: string) => void openCatalogSaveReview(ownerPath),
    [openCatalogSaveReview],
  );
  const mutations = useAgentActorMutations({
    onAccessDenied: handleMutationAccessDenied,
    projectPath: owner.projectPath,
    refresh: catalog.refresh,
    saveCatalog: openCatalogSave,
    snapshot,
  });
  const {
    apply: applyMutation,
    closeDelete,
    createDraft,
    deleteActor,
    deleteReferences,
    editSession,
    failure: mutationFailure,
    openCreate,
    openDelete,
    openEdit,
    pending: mutationPending,
    setCreateDraft,
    setEditSession,
  } = mutations;

  const continueIntent = useCallback(
    (intent: AgentActorAccessIntent) => {
      if (intent.kind === "add-agent") {
        if (createDraft)
          void applyMutation("create", intent.ownerPath, createDraft);
        return;
      }
      if (intent.kind === "delete-agent") {
        openDelete(intent.item);
        return;
      }
      if (intent.kind === "save-agent-catalog") {
        void catalogSave.confirm();
        return;
      }
      openEdit(intent.item);
    },
    [applyMutation, catalogSave, createDraft, openDelete, openEdit],
  );
  const agentFacts = useAgentActorFacts({
    agents: snapshot?.agents ?? NO_AGENTS,
    editing: createDraft !== null || editSession !== null,
    items: snapshot?.items ?? null,
  });
  const accessCoordinator = useAgentActorAccessCoordinator({
    onContinue: continueIntent,
    onOpenRepositorySettings,
  });
  const requestAccess = accessCoordinator.request;

  const agentPeek = useAgentActorPeek({
    accessRecovery: accessCoordinator.recovery,
    applyMutation,
    agents: snapshot?.agents ?? NO_AGENTS,
    editSession,
    mutationPending,
    offers: agentFacts.offers,
    peek,
    readOnly,
    items: snapshot?.items ?? null,
    setEditSession,
    onOpenAgentSettings,
    onRecheckOffers: agentFacts.reloadOffers,
  });

  function handleMutationAccessDenied(
    error: unknown,
    context: AgentActorMutationAccessContext,
  ) {
    const item =
      "ownerLabel" in context.draftOrItem ? context.draftOrItem : null;
    const retry = () => {
      if (context.kind === "delete" && item) {
        openDelete(item);
        return;
      }
      return mutations.apply(
        context.kind,
        context.ownerPath,
        context.draftOrItem,
      );
    };
    return accessCoordinator.recoverFromError(error, {
      continue: retry,
      intentKey: `agent-actor-${context.kind}-apply`,
      intentLabel:
        context.kind === "delete"
          ? m.agent_actors_delete()
          : m.agent_actors_save(),
      onPlanChanged: () => {
        if (context.kind === "delete" && item) {
          openDelete(item);
          return;
        }
        return catalog.refresh();
      },
      ownerName: item?.ownerLabel,
      ownerPath: context.ownerPath,
      placement: "inline",
    });
  }

  function handleCatalogAccessDenied(
    error: unknown,
    candidate: { label: string; ownerPath: string },
  ) {
    return accessCoordinator.recoverFromError(error, {
      continue: () => catalogSave.open(candidate.ownerPath),
      intentKey: "agent-actor-catalog-save-apply",
      intentLabel: m.agent_actors_save_catalog(),
      onPlanChanged: () => catalogSave.open(candidate.ownerPath),
      ownerName: candidate.label,
      ownerPath: candidate.ownerPath,
      placement: "inline",
    });
  }

  const actionState: CollectionActionState = mutationPending
    ? { status: "pending" }
    : readOnly
      ? {
          reason: m.repository_work_status_read_only(),
          status: "disabled",
        }
      : snapshot
        ? { status: "idle" }
        : { status: "disabled", reason: m.agent_actors_catalog_unavailable() };
  const actionStateForOwner = (ownerPath: string): CollectionActionState =>
    actionState.status === "idle" && !snapshot?.fingerprints[ownerPath]
      ? {
          reason: m.agent_actors_catalog_unavailable(),
          status: "disabled",
        }
      : actionState;
  const presentationState: CollectionPresentationState<AgentActorItem> =
    catalog.state.phase === "initial"
      ? { phase: "initial" }
      : catalog.state.phase === "blocking_error"
        ? {
            phase: "blocking_error",
            error: (
              <span className="flex flex-col items-start gap-2">
                <span>{catalog.state.error}</span>
                <CatalogRetryButton
                  disabled={catalog.state.retrying}
                  label={m.agent_actors_retry()}
                  onRetry={() => void catalog.refresh()}
                />
              </span>
            ),
          }
        : {
            diagnostics: [
              ...catalog.state.snapshot.diagnostics.map((item) => item.message),
              ...(catalog.state.refreshError
                ? [
                    <span
                      key="refresh"
                      className="flex flex-col items-start gap-2"
                    >
                      <span>{catalog.state.refreshError}</span>
                      <CatalogRetryButton
                        disabled={catalog.state.refreshing}
                        label={m.agent_actors_retry()}
                        onRetry={() => void catalog.refresh()}
                      />
                    </span>,
                  ]
                : []),
            ],
            phase: "ready",
            items: catalog.state.snapshot.items,
          };

  const overlays = (
    <>
      <RepositoryAccessPreflightDialog recovery={accessCoordinator.recovery} />
      <AgentActorEditorDialog
        accessRecovery={accessCoordinator.recovery}
        agents={snapshot?.agents ?? NO_AGENTS}
        draft={createDraft}
        failure={mutationFailure}
        offers={agentFacts.offers}
        pending={mutationPending}
        requesting={accessCoordinator.requesting}
        readOnly={readOnly}
        onChange={setCreateDraft}
        onOpenAgentSettings={onOpenAgentSettings}
        onRecheckOffers={agentFacts.reloadOffers}
        onClose={() => {
          if (mutationPending) return;
          accessCoordinator.recovery.close();
          setCreateDraft(null);
        }}
        onSave={() =>
          createDraft &&
          requestAccess({ kind: "add-agent", ownerPath: createDraft.ownerPath })
        }
      />
      <AgentActorDeleteDialog
        accessRecovery={accessCoordinator.recovery}
        actor={deleteActor}
        failure={mutationFailure}
        pending={mutationPending}
        referenceState={deleteReferences}
        readOnly={readOnly}
        onClose={() => !mutationPending && closeDelete()}
        onConfirm={() =>
          deleteActor &&
          void applyMutation("delete", deleteActor.ownerPath, deleteActor)
        }
        onRetry={() => deleteActor && openDelete(deleteActor)}
      />
      <AgentActorSaveDialog
        accessRecovery={accessCoordinator.recovery}
        candidates={catalogSave.candidates}
        failure={catalogSave.failure}
        pending={catalogSave.pending}
        selectedOwnerPath={catalogSave.selectedOwnerPath}
        readOnly={readOnly}
        onClose={catalogSave.close}
        onConfirm={() =>
          catalogSave.selectedOwnerPath &&
          requestAccess({
            kind: "save-agent-catalog",
            ownerPath: catalogSave.selectedOwnerPath,
          })
        }
        onSelect={catalogSave.setSelectedOwnerPath}
      />
    </>
  );

  return {
    actions: {
      createState: actionStateForOwner(owner.spacePath),
      getDeleteState: (item: AgentActorItem) =>
        actionStateForOwner(item.ownerPath),
      getEditState: (item: AgentActorItem) =>
        actionStateForOwner(item.ownerPath),
      onAdd: () => {
        if (readOnly) return;
        openCreate(owner.spacePath);
      },
      onDelete: (item: AgentActorItem) => {
        if (readOnly) return;
        requestAccess({
          kind: "delete-agent",
          ownerPath: item.ownerPath,
          item,
        });
      },
      onEdit: (item: AgentActorItem) => {
        if (readOnly) return;
        requestAccess({ kind: "edit-agent", ownerPath: item.ownerPath, item });
      },
    },
    /** What the Agents collection shows of an Agent on this device. */
    facts: agentFacts.facts,
    inheritedVisible: snapshot?.items.some((item) => item.inherited) ?? false,
    overlays,
    peek: agentPeek,
    presentationState,
  };
}
