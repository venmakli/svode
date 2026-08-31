import { useCallback, useMemo } from "react";

import {
  useCollectionCoreState,
  type CollectionCoreActionState,
  type CollectionCoreInstance,
} from "@/features/collection/core";
import {
  createCollectionDetailActivation,
  useOptionalCollectionDetailController,
} from "@/features/collection/app-shell";
import type { ScopeOwnerRef } from "@/features/scope-surfaces";
import * as m from "@/paraglide/messages.js";

import type { RoutineOwnerInput } from "../api/routines-api";
import type { RoutineRow, RoutineSessionTarget } from "../model/types";
import { RoutineCreateDialog } from "../ui/routine-create-dialog";
import { RoutineDeleteDialog } from "../ui/routine-delete-dialog";
import {
  createRoutinesPresentation,
  toRoutinePresentationState,
  type RoutinePresentationActions,
} from "../ui/routines-presentation";
import { useRoutineCatalog } from "./use-routine-catalog";
import { useRoutineAutomaticConsent } from "./use-routine-automatic-consent";
import { useRoutineCreateJourney } from "./use-routine-create-journey";
import { useRoutineDetail } from "./use-routine-detail";
import { useRoutineDispatch } from "./use-routine-dispatch";
import { useRoutineExecutors } from "./use-routine-executors";
import { useRoutineMutations } from "./use-routine-mutations";
import { useRoutineStorageRecovery } from "./use-routine-storage-recovery";

export function useRoutinesController(
  owner: ScopeOwnerRef,
  onOpenSession: (target: RoutineSessionTarget) => void,
  readOnly: boolean,
) {
  const routineOwner = useMemo<RoutineOwnerInput>(
    () => ({
      ownerKind:
        owner.identityKind === "registered-space"
          ? "registered_space"
          : "collection_directory",
      ownerPath: owner.ownerPath,
      projectPath: owner.projectPath,
      spaceId: owner.spaceId,
      spacePath: owner.spacePath,
    }),
    [owner],
  );
  const { refresh, replaceSnapshot, state } = useRoutineCatalog(routineOwner);
  const automaticConsent = useRoutineAutomaticConsent(routineOwner);
  const storageRecovery = useRoutineStorageRecovery({
    owner: routineOwner,
    retryAutomaticConsent: automaticConsent.retry,
  });
  const executors = useRoutineExecutors(owner.projectPath, owner.spacePath);
  const detailController = useOptionalCollectionDetailController();
  const instanceKey = `routines:${owner.ownerKey}`;
  const onDetailInvalidated = useCallback(async () => {
    await detailController?.close();
  }, [detailController]);
  const mutations = useRoutineMutations({
    onDetailInvalidated,
    owner: routineOwner,
    refresh,
    replaceSnapshot,
    rows: state.phase === "ready" ? state.snapshot.rows : [],
  });
  const dispatch = useRoutineDispatch({ onOpenSession, owner: routineOwner });
  const createReadOnlyDetail = useRoutineDetail({
    applyUpdate: mutations.applyUpdate,
    detailController,
    editSession: mutations.editSession,
    executorError: executors.error,
    executors: executors.options,
    instanceKey,
    mutationError: mutations.error,
    nameError: mutations.nameError,
    getRunState: dispatch.getRunState,
    onOpenSession: dispatch.openLastSession,
    onRun: dispatch.run,
    owner: routineOwner,
    pending: mutations.pending,
    readOnly,
    onEditChange: mutations.changeEditDraft,
    setEditSession: mutations.setEditSession,
  });
  const onRoutineCreated = useCallback(
    async ({
      owner: createdOwner,
      row,
      snapshot,
    }: {
      owner: RoutineOwnerInput;
      row: RoutineRow;
      snapshot: Parameters<typeof replaceSnapshot>[0];
    }) => {
      if (!sameRoutineOwner(createdOwner, routineOwner)) return;
      replaceSnapshot(snapshot);
      await detailController?.open({
        ...createReadOnlyDetail(row),
        selection: {
          instanceKey,
          presentationId: "all",
          rowId: row.id,
        },
      });
    },
    [
      createReadOnlyDetail,
      detailController,
      instanceKey,
      replaceSnapshot,
      routineOwner,
    ],
  );
  const create = useRoutineCreateJourney({ onApplied: onRoutineCreated });
  const createExecutorOwner = create.session?.owner ?? routineOwner;
  const useDetachedCreateExecutors = Boolean(
    create.session && !sameRoutineOwner(create.session.owner, routineOwner),
  );
  const detachedCreateExecutors = useRoutineExecutors(
    createExecutorOwner.projectPath,
    createExecutorOwner.spacePath,
    useDetachedCreateExecutors,
  );
  const createExecutors = useDetachedCreateExecutors
    ? detachedCreateExecutors
    : executors;
  const actionState = useMemo<CollectionCoreActionState>(() => {
    if (mutations.pending || create.pending) return { status: "pending" };
    if (readOnly) {
      return {
        reason: m.repository_work_status_read_only(),
        status: "disabled",
      };
    }
    if (state.phase !== "ready") {
      return {
        reason: m.routines_catalog_unavailable(),
        status: "disabled",
      };
    }
    return { status: "idle" };
  }, [create.pending, mutations.pending, readOnly, state.phase]);
  const actions: RoutinePresentationActions = {
    createState: actionState,
    getDeleteState: (row) =>
      row.routineId
        ? actionState
        : {
            reason: m.routines_invalid_identity_disabled(),
            status: "disabled",
          },
    getEditState: (row) =>
      !row.routineId
        ? {
            reason: m.routines_invalid_identity_disabled(),
            status: "disabled",
          }
        : row.definition
          ? actionState
          : {
              reason: m.routines_invalid_edit_disabled(),
              status: "disabled",
            },
    getEnabledState: (row) =>
      row.valid && row.definition && row.definition.trigger.type !== "manual"
        ? actionState
        : {
            reason: row.definition
              ? m.routines_manual_enabled_disabled()
              : m.routines_invalid_edit_disabled(),
            status: "disabled",
          },
    getRunState: (row) => {
      if (!readOnly) return dispatch.getRunState(row);
      if (row.lastRun?.active) return { status: "idle" };
      return {
        reason: m.repository_work_status_read_only(),
        status: "disabled",
      };
    },
    onAdd: () => {
      if (readOnly || state.phase !== "ready") return;
      create.open({
        automaticAuthority:
          automaticConsent.loading || automaticConsent.error
            ? null
            : automaticConsent.enabled,
        baselineRows: state.snapshot.rows,
        owner: routineOwner,
        ownerLabel: routineOwnerLabel(owner),
      });
    },
    onDelete: (row) => {
      if (!readOnly) mutations.openDelete(row);
    },
    onEdit: (row) => {
      if (!readOnly) mutations.openEdit(row);
    },
    onEnabledChange: async (row, enabled) => {
      if (readOnly) throw new Error(m.repository_work_status_read_only());
      if (!row.definition || row.definition.trigger.type === "manual") return;
      const updated = await mutations.applyUpdate(
        row,
        {
          ...row.definition,
          enabled,
        },
        { materializeFilename: false },
      );
      if (!updated) throw new Error(m.routines_mutation_blocked());
    },
    onRun: async (row) => {
      if (readOnly) {
        if (row.lastRun?.active) dispatch.openLastSession(row);
        else throw new Error(m.repository_work_status_read_only());
        return;
      }
      await dispatch.run(row);
    },
  };
  const presentation = createRoutinesPresentation({
    actions,
    getExecutorLabel: (row) => executorLabel(row, executors.options),
    onActivate: createCollectionDetailActivation({
      controller: detailController,
      createContent: createReadOnlyDetail,
      instanceKey,
      presentationId: "all",
    }),
    state: toRoutinePresentationState(state, () => void refresh()),
  });
  const instance: CollectionCoreInstance = {
    defaultPresentationId: "all",
    instanceKey,
    presentations: [presentation],
    stateScope: "session",
  };
  const collectionState = useCollectionCoreState(instance);
  const overlays = (
    <>
      {create.session ? (
        <RoutineCreateDialog
          automaticAuthority={create.session.automaticAuthority}
          collectionOwner={
            create.session.owner.ownerKind === "collection_directory"
          }
          definition={create.session.draft}
          error={create.error}
          executorError={createExecutors.error}
          executorLoading={createExecutors.loading}
          executors={createExecutors.options}
          initialDefinition={create.session.initialDraft}
          nameError={create.nameError}
          ownerLabel={create.session.ownerLabel}
          pending={create.pending}
          readOnly={readOnly}
          retryBlocked={create.retryBlocked}
          onChange={create.change}
          onClose={create.close}
          onRetryExecutors={createExecutors.retry}
          onSubmit={() => void create.submit()}
        />
      ) : null}
      <RoutineDeleteDialog
        error={mutations.deleteTarget ? mutations.error : null}
        pending={mutations.pending && mutations.deleteTarget !== null}
        readOnly={readOnly}
        routine={mutations.deleteTarget}
        onClose={mutations.closeDelete}
        onConfirm={() => void mutations.submitDelete()}
      />
    </>
  );

  return {
    automaticConsent,
    collectionState,
    instance,
    overlays,
    storageRecovery,
  };
}

function sameRoutineOwner(left: RoutineOwnerInput, right: RoutineOwnerInput) {
  return (
    left.ownerKind === right.ownerKind &&
    left.ownerPath === right.ownerPath &&
    left.projectPath === right.projectPath &&
    left.spaceId === right.spaceId &&
    left.spacePath === right.spacePath
  );
}

function routineOwnerLabel(owner: ScopeOwnerRef) {
  if (owner.identityKind === "collection-directory") {
    return m.routines_create_owner_collection({ path: owner.ownerPath });
  }
  if (owner.projectPath === owner.spacePath) {
    return m.routines_create_owner_project();
  }
  return m.routines_create_owner_space();
}

function executorLabel(
  row: RoutineRow,
  options: readonly { label: string; value: string }[],
) {
  const executor =
    row.definition?.action.type === "run_agent"
      ? row.definition.action.executor
      : null;
  return options.find((option) => option.value === executor)?.label ?? executor;
}
