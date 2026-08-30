import { useCallback, useMemo } from "react";

import type {
  SystemCollectionActionState,
  SystemCollectionDetailController,
  SystemCollectionPresentationState,
} from "@/features/collection/system";
import { RepositoryAccessPreflightDialog } from "@/features/git";
import type { ScopeOwnerRef } from "@/features/scope-surfaces";
import * as m from "@/paraglide/messages.js";

import { runtimeKey } from "../api/agent-actors-api";
import type {
  AgentActorBindingRuntime,
  AgentActorRow,
} from "../model/agent-actor-types";
import {
  useAgentActorAccessCoordinator,
  type AgentActorAccessIntent,
} from "./use-agent-actor-access-coordinator";
import { useAgentActorCatalog } from "./use-agent-actor-catalog";
import { useAgentActorCatalogSave } from "./use-agent-actor-catalog-save";
import { useAgentActorDetail } from "./use-agent-actor-detail";
import { useAgentActorDraftRuntime } from "./use-agent-actor-draft-runtime";
import {
  useAgentActorMutations,
  type AgentActorMutationAccessContext,
} from "./use-agent-actor-mutations";
import { AgentActorDeleteDialog } from "../ui/agent-actor-delete-dialog";
import { AgentActorEditorDialog } from "../ui/agent-actor-editor-dialog";
import { AgentActorSaveDialog } from "../ui/agent-actor-save-dialog";
import { CatalogRetryButton } from "../ui/catalog-retry-button";

export function useAgentActorsController({
  detailController,
  instanceKey,
  owner,
  readOnly,
  onOpenRepositorySettings,
}: {
  detailController: SystemCollectionDetailController | null;
  instanceKey: string;
  owner: ScopeOwnerRef;
  readOnly: boolean;
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
              ...snapshot.rows.map((row) => row.ownerPath),
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
    detailController,
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
  const createRuntime = useAgentActorDraftRuntime(createDraft);
  const editRuntime = useAgentActorDraftRuntime(editSession?.draft ?? null);

  const continueIntent = useCallback(
    (intent: AgentActorAccessIntent) => {
      if (intent.kind === "add-agent") {
        if (createDraft)
          void applyMutation("create", intent.ownerPath, createDraft);
        return;
      }
      if (intent.kind === "delete-agent") {
        openDelete(intent.row);
        return;
      }
      if (intent.kind === "save-agent-catalog") {
        void catalogSave.confirm();
        return;
      }
      openEdit(intent.row);
    },
    [applyMutation, catalogSave, createDraft, openDelete, openEdit],
  );
  const accessCoordinator = useAgentActorAccessCoordinator({
    onContinue: continueIntent,
    onOpenRepositorySettings,
  });
  const requestAccess = accessCoordinator.request;

  const savedRuntimeFor = useCallback(
    (row: AgentActorRow) => {
      const runtime =
        snapshot?.bindingRuntime[runtimeKey(row.ownerPath, row.id)] ?? [];
      return Object.fromEntries(
        row.adapters.map((binding, index) => [binding.adapter, runtime[index]]),
      ) as Partial<
        Record<
          AgentActorRow["adapters"][number]["adapter"],
          AgentActorBindingRuntime
        >
      >;
    },
    [snapshot?.bindingRuntime],
  );

  const createReadOnlyDetail = useAgentActorDetail({
    accessRecovery: accessCoordinator.recovery,
    applyMutation,
    descriptors: snapshot?.adapterDescriptors ?? [],
    detailController,
    diagnose: catalog.diagnose,
    diagnostics: catalog.diagnostics,
    editRuntime: editRuntime.runtime,
    editSession,
    instanceKey,
    mutationPending,
    readOnly,
    pendingAdapter: catalog.pendingAdapter,
    savedRuntimeFor,
    setEditSession,
  });

  function handleMutationAccessDenied(
    error: unknown,
    context: AgentActorMutationAccessContext,
  ) {
    const row = "ownerLabel" in context.draftOrRow ? context.draftOrRow : null;
    const retry = () => {
      if (context.kind === "delete" && row) {
        openDelete(row);
        return;
      }
      return mutations.apply(
        context.kind,
        context.ownerPath,
        context.draftOrRow,
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
        if (context.kind === "delete" && row) {
          openDelete(row);
          return;
        }
        return catalog.refresh();
      },
      ownerName: row?.ownerLabel,
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

  const actionState: SystemCollectionActionState = mutationPending
    ? { status: "pending" }
    : readOnly
      ? {
          reason: m.repository_work_status_read_only(),
          status: "disabled",
        }
      : snapshot
        ? { status: "idle" }
        : { status: "disabled", reason: m.agent_actors_catalog_unavailable() };
  const actionStateForOwner = (
    ownerPath: string,
  ): SystemCollectionActionState =>
    actionState.status === "idle" && !snapshot?.fingerprints[ownerPath]
      ? {
          reason: m.agent_actors_catalog_unavailable(),
          status: "disabled",
        }
      : actionState;
  const presentationState: SystemCollectionPresentationState<AgentActorRow> =
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
            rows: catalog.state.snapshot.rows,
          };

  const overlays = (
    <>
      <RepositoryAccessPreflightDialog recovery={accessCoordinator.recovery} />
      <AgentActorEditorDialog
        accessRecovery={accessCoordinator.recovery}
        descriptors={snapshot?.adapterDescriptors ?? []}
        diagnostics={catalog.diagnostics}
        draft={createDraft}
        failure={mutationFailure}
        pending={mutationPending}
        requesting={accessCoordinator.requesting}
        pendingAdapter={catalog.pendingAdapter}
        runtime={createRuntime}
        readOnly={readOnly}
        onChange={setCreateDraft}
        onCheck={(adapter) => void catalog.diagnose(adapter)}
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
      getDeleteState: (row: AgentActorRow) =>
        actionStateForOwner(row.ownerPath),
      getEditState: (row: AgentActorRow) => actionStateForOwner(row.ownerPath),
      onAdd: () => {
        if (readOnly) return;
        openCreate(owner.spacePath);
      },
      onDelete: (row: AgentActorRow) => {
        if (readOnly) return;
        requestAccess({ kind: "delete-agent", ownerPath: row.ownerPath, row });
      },
      onEdit: (row: AgentActorRow) => {
        if (readOnly) return;
        requestAccess({ kind: "edit-agent", ownerPath: row.ownerPath, row });
      },
    },
    inheritedVisible: snapshot?.rows.some((row) => row.inherited) ?? false,
    overlays,
    presentationState,
    renderDetail: createReadOnlyDetail,
  };
}
