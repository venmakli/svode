import { useCallback, useMemo, useState } from "react";

import type {
  CollectionActionState,
  CollectionPresentationState,
} from "@/features/collection";
import type { CollectionItemPeekController } from "@/features/collection/app-shell";
import { RepositoryAccessPreflightDialog } from "@/features/git";
import type { CollectionPropertyActionState } from "@/features/properties";
import type { ScopeOwnerRef } from "@/features/scope-surfaces";
import { useSpaceNames } from "@/features/space";
import * as m from "@/paraglide/messages.js";

import type { ActorPeekTarget } from "../model/actor-peek";
import type {
  AgentActorAgentOption,
  AgentActorCatalogSnapshot,
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
  type AgentActorAccessDenial,
} from "./use-agent-actor-mutations";
import { AgentActorBindingPopover } from "../ui/agent-actor-binding-popover";
import { AgentActorDeleteDialog } from "../ui/agent-actor-delete-dialog";
import { AgentActorSaveDialog } from "../ui/agent-actor-save-dialog";
import type { AgentActorsPresentationEditing } from "../ui/agent-actors-presentation";
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
  const spaceName = useSpaceNames();
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
    closeDelete,
    confirmDelete,
    create,
    deleteActor,
    deleteReferences,
    failure: mutationFailure,
    openDelete,
    pending: mutationPending,
    write,
  } = mutations;

  // A created Agent opens in the peek with focus in its name, once.
  const [focusTitleRequest, setFocusTitleRequest] = useState<{
    itemId: string;
    request: number;
  } | null>(null);
  const { open: openPeek } = peek;
  const shownItemId =
    peek.target?.presentationId === "agents" ? peek.target.itemId : null;
  const [lastShownItemId, setLastShownItemId] = useState(shownItemId);
  if (lastShownItemId !== shownItemId) {
    setLastShownItemId(shownItemId);
    if (
      focusTitleRequest !== null &&
      shownItemId !== focusTitleRequest.itemId
    ) {
      setFocusTitleRequest(null);
    }
  }
  const createAndOpen = useCallback(
    async (ownerPath: string) => {
      const itemId = await create(ownerPath);
      if (itemId === null) return;
      openPeek({ presentationId: "agents", itemId });
      setFocusTitleRequest((current) => ({
        itemId,
        request: (current?.request ?? 0) + 1,
      }));
    },
    [create, openPeek],
  );

  const continueIntent = useCallback(
    (intent: AgentActorAccessIntent) => {
      if (intent.kind === "add-agent") {
        void createAndOpen(intent.ownerPath);
        return;
      }
      if (intent.kind === "delete-agent") {
        openDelete(intent.item);
        return;
      }
      void catalogSave.confirm();
    },
    [catalogSave, createAndOpen, openDelete],
  );
  const agentFacts = useAgentActorFacts({
    agents: snapshot?.agents ?? NO_AGENTS,
    items: snapshot?.items ?? null,
  });
  const accessCoordinator = useAgentActorAccessCoordinator({
    onContinue: continueIntent,
    onOpenRepositorySettings,
  });
  const requestAccess = accessCoordinator.request;

  const editState = useCallback(
    (item: AgentActorItem): CollectionPropertyActionState => {
      if (readOnly) {
        return {
          reason: m.repository_work_status_read_only(),
          status: "disabled",
        };
      }
      const reason = snapshot ? agentActorReadOnlyReason(snapshot, item) : null;
      return reason ? { reason, status: "disabled" } : { status: "idle" };
    },
    [readOnly, snapshot],
  );
  const agents = snapshot?.agents ?? NO_AGENTS;
  const offers = agentFacts.offers;
  const reloadOffers = agentFacts.reloadOffers;
  const editing = useMemo<AgentActorsPresentationEditing>(
    () => ({
      getState: editState,
      update: (item, edit) =>
        write(
          item,
          (current) => ({ ...current, binding: edit.binding, mode: edit.mode }),
          edit.since,
        ),
      renderPopover: (input, opensOnMode) => (
        <AgentActorBindingPopover
          agents={agents}
          input={input}
          offers={offers}
          opensOnMode={opensOnMode}
          onOpenAgentSettings={onOpenAgentSettings}
          onRecheckOffers={reloadOffers}
        />
      ),
    }),
    [agents, editState, offers, onOpenAgentSettings, reloadOffers, write],
  );

  const agentPeek = useAgentActorPeek({
    editState,
    focusTitleRequest,
    items: snapshot?.items ?? null,
    write,
  });

  function handleMutationAccessDenied(
    error: unknown,
    denial: AgentActorAccessDenial,
  ) {
    return accessCoordinator.recoverFromError(error, {
      continue: denial.retry,
      intentKey: `agent-actor-${denial.kind}-apply`,
      intentLabel:
        denial.kind === "delete"
          ? m.agent_actors_delete()
          : denial.kind === "create"
            ? m.agent_actors_add()
            : m.agent_actors_edit(),
      onPlanChanged: () => {
        if (denial.kind === "delete" && denial.item) {
          openDelete(denial.item);
          return;
        }
        return catalog.refresh();
      },
      ownerName: denial.item?.ownerLabel,
      ownerPath: denial.ownerPath,
      placement: denial.kind === "delete" ? "inline" : "dialog",
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
      <AgentActorDeleteDialog
        accessRecovery={accessCoordinator.recovery}
        actor={deleteActor}
        failure={mutationFailure}
        pending={mutationPending}
        referenceState={deleteReferences}
        readOnly={readOnly}
        onClose={() => !mutationPending && closeDelete()}
        onConfirm={() => deleteActor && void confirmDelete(deleteActor)}
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
      onAdd: () => {
        if (readOnly) return;
        requestAccess({ kind: "add-agent", ownerPath: owner.spacePath });
      },
      onDelete: (item: AgentActorItem) => {
        if (readOnly) return;
        requestAccess({
          kind: "delete-agent",
          ownerPath: item.ownerPath,
          item,
        });
      },
    },
    editing,
    /** What the Agents collection shows of an Agent on this device. */
    facts: agentFacts.facts,
    inheritedVisible: snapshot?.items.some((item) => item.inherited) ?? false,
    overlays,
    peek: agentPeek,
    presentationState,
    spaceName,
  };
}

/**
 * Why an Agent cannot be edited (Stage 11 `04`, 4.I): its catalog is open
 * only for reading, as one of an unknown schema version, with unknown fields
 * or a diagnostic of its source, or its id is ambiguous; null when it can.
 */
export function agentActorReadOnlyReason(
  snapshot: AgentActorCatalogSnapshot,
  item: AgentActorItem,
): string | null {
  const diagnostics = snapshot.diagnostics.filter(
    (diagnostic) => diagnostic.ownerPath === item.ownerPath,
  );
  if (
    diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "ambiguous_actor_id" &&
        diagnostic.message.includes(item.actorRef),
    )
  ) {
    return m.agent_actors_reference_ambiguous();
  }
  if (
    !snapshot.fingerprints[item.ownerPath] ||
    diagnostics.some((diagnostic) => diagnostic.code === "catalog_unavailable")
  ) {
    return m.agent_actors_catalog_read_only();
  }
  return null;
}
