import { useCallback, useMemo } from "react";

import type {
  SystemCollectionActionState,
  SystemCollectionDetailController,
  SystemCollectionPresentationState,
} from "@/features/collection/system";
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
import { useAgentActorMutations } from "./use-agent-actor-mutations";
import { ActorAccessPreflightDialog } from "../ui/actor-access-preflight-dialog";
import { AgentActorDeleteDialog } from "../ui/agent-actor-delete-dialog";
import { AgentActorEditorDialog } from "../ui/agent-actor-editor-dialog";
import { AgentActorSaveDialog } from "../ui/agent-actor-save-dialog";
import { CatalogRetryButton } from "../ui/catalog-retry-button";

export function useAgentActorsController({
  detailController,
  instanceKey,
  owner,
}: {
  detailController: SystemCollectionDetailController | null;
  instanceKey: string;
  owner: ScopeOwnerRef;
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
    launchSpacePath: owner.spacePath,
    onContinue: continueIntent,
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
    applyMutation,
    descriptors: snapshot?.adapterDescriptors ?? [],
    detailController,
    diagnose: catalog.diagnose,
    diagnostics: catalog.diagnostics,
    editRuntime: editRuntime.runtime,
    editSession,
    instanceKey,
    mutationPending,
    pendingAdapter: catalog.pendingAdapter,
    savedRuntimeFor,
    setEditSession,
  });

  const actionState: SystemCollectionActionState = mutationPending
    ? { status: "pending" }
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
      <ActorAccessPreflightDialog
        error={accessCoordinator.access.error}
        intent={
          accessCoordinator.intent?.kind === "add-agent"
            ? null
            : accessCoordinator.intent
        }
        snapshot={accessCoordinator.access.snapshot}
        verifying={accessCoordinator.access.verifying}
        onClose={accessCoordinator.close}
        onVerify={accessCoordinator.verify}
      />
      <AgentActorEditorDialog
        accessRecovery={
          accessCoordinator.intent?.kind === "add-agent"
            ? {
                error: accessCoordinator.access.error,
                snapshot: accessCoordinator.access.snapshot,
                verifying: accessCoordinator.access.verifying,
                onCancel: accessCoordinator.close,
                onVerify: accessCoordinator.verify,
              }
            : null
        }
        descriptors={snapshot?.adapterDescriptors ?? []}
        diagnostics={catalog.diagnostics}
        draft={createDraft}
        failure={mutationFailure}
        pending={mutationPending}
        requesting={accessCoordinator.requesting}
        pendingAdapter={catalog.pendingAdapter}
        runtime={createRuntime}
        onChange={setCreateDraft}
        onCheck={(adapter) => void catalog.diagnose(adapter)}
        onClose={() => {
          if (mutationPending) return;
          accessCoordinator.close();
          setCreateDraft(null);
        }}
        onSave={() =>
          createDraft &&
          requestAccess({ kind: "add-agent", ownerPath: createDraft.ownerPath })
        }
      />
      <AgentActorDeleteDialog
        actor={deleteActor}
        failure={mutationFailure}
        pending={mutationPending}
        referenceState={deleteReferences}
        onClose={() => !mutationPending && closeDelete()}
        onConfirm={() =>
          deleteActor &&
          void applyMutation("delete", deleteActor.ownerPath, deleteActor)
        }
        onRetry={() => deleteActor && openDelete(deleteActor)}
      />
      <AgentActorSaveDialog
        candidates={catalogSave.candidates}
        failure={catalogSave.failure}
        pending={catalogSave.pending}
        selectedOwnerPath={catalogSave.selectedOwnerPath}
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
        openCreate(owner.spacePath);
      },
      onDelete: (row: AgentActorRow) =>
        requestAccess({ kind: "delete-agent", ownerPath: row.ownerPath, row }),
      onEdit: (row: AgentActorRow) =>
        requestAccess({ kind: "edit-agent", ownerPath: row.ownerPath, row }),
    },
    inheritedVisible: snapshot?.rows.some((row) => row.inherited) ?? false,
    overlays,
    presentationState,
    renderDetail: createReadOnlyDetail,
  };
}
