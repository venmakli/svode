import { useCallback, useMemo } from "react";

import {
  useOptionalSystemCollectionDetailController,
  useSystemCollectionState,
  type SystemCollectionActionState,
  type SystemCollectionInstance,
} from "@/features/collection/system";
import type { ScopeOwnerRef } from "@/features/scope-surfaces";
import * as m from "@/paraglide/messages.js";

import type { RoutineOwnerInput } from "../api/routines-api";
import type { RoutineRow } from "../model/types";
import { RoutineCreateDialog } from "../ui/routine-create-dialog";
import { RoutineDeleteDialog } from "../ui/routine-delete-dialog";
import {
  createRoutinesPresentation,
  toRoutinePresentationState,
  type RoutinePresentationActions,
} from "../ui/routines-presentation";
import { useRoutineCatalog } from "./use-routine-catalog";
import { useRoutineDetail } from "./use-routine-detail";
import { useRoutineExecutors } from "./use-routine-executors";
import { useRoutineMutations } from "./use-routine-mutations";

export function useRoutinesController(owner: ScopeOwnerRef) {
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
  const executors = useRoutineExecutors(owner.projectPath, owner.spacePath);
  const detailController = useOptionalSystemCollectionDetailController();
  const instanceKey = `routines:${owner.ownerKey}`;
  const onDetailInvalidated = useCallback(async () => {
    await detailController?.close();
  }, [detailController]);
  const mutations = useRoutineMutations({
    onDetailInvalidated,
    owner: routineOwner,
    refresh,
    replaceSnapshot,
  });
  const createReadOnlyDetail = useRoutineDetail({
    applyUpdate: mutations.applyUpdate,
    detailController,
    editSession: mutations.editSession,
    executorError: executors.error,
    executors: executors.options,
    instanceKey,
    mutationError: mutations.error,
    owner: routineOwner,
    pending: mutations.pending,
    setEditSession: mutations.setEditSession,
  });
  const actionState = useMemo<SystemCollectionActionState>(() => {
    if (mutations.pending) return { status: "pending" };
    if (state.phase !== "ready") {
      return {
        reason: m.routines_catalog_unavailable(),
        status: "disabled",
      };
    }
    return { status: "idle" };
  }, [mutations.pending, state.phase]);
  const actions: RoutinePresentationActions = {
    createState: actionState,
    getDeleteState: () => actionState,
    getEditState: (row) =>
      row.definition
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
    onAdd: mutations.openCreate,
    onDelete: mutations.openDelete,
    onEdit: mutations.openEdit,
    onEnabledChange: async (row, enabled) => {
      if (!row.definition || row.definition.trigger.type === "manual") return;
      const updated = await mutations.applyUpdate(row, {
        ...row.definition,
        enabled,
      });
      if (!updated) throw new Error(m.routines_mutation_blocked());
    },
  };
  const presentation = createRoutinesPresentation({
    actions,
    createDetailRequest: createReadOnlyDetail,
    getExecutorLabel: (row) => executorLabel(row, executors.options),
    onRefresh: async () => {
      await refresh();
    },
    refreshing: state.phase === "ready" && state.refreshing,
    state: toRoutinePresentationState(state),
  });
  const instance: SystemCollectionInstance = {
    defaultPresentationId: "all",
    instanceKey,
    presentations: [presentation],
    stateScope: "session",
  };
  const collectionState = useSystemCollectionState(instance);
  const createPending = mutations.pending && mutations.createOpen;
  const overlays = (
    <>
      <RoutineCreateDialog
        collectionOwner={routineOwner.ownerKind === "collection_directory"}
        error={mutations.createOpen ? mutations.error : null}
        input={mutations.createInput}
        open={mutations.createOpen}
        pending={createPending}
        onChange={mutations.setCreateInput}
        onClose={mutations.closeCreate}
        onSubmit={() => void mutations.submitCreate()}
      />
      <RoutineDeleteDialog
        error={mutations.deleteTarget ? mutations.error : null}
        pending={mutations.pending && mutations.deleteTarget !== null}
        routine={mutations.deleteTarget}
        onClose={mutations.closeDelete}
        onConfirm={() => void mutations.submitDelete()}
      />
    </>
  );

  return { collectionState, detailController, instance, overlays };
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
