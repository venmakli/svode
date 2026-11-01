import { useCallback, useEffect, useMemo } from "react";

import {
  useCollectionState,
  type CollectionActionState,
  type CollectionInstance,
} from "@/features/collection";
import {
  CollectionItemMain,
  CollectionItemPeek,
  useCollectionItemPeek,
} from "@/features/collection/app-shell";
import type {
  ScopeItemRef,
  ScopeMainItem,
  ScopeOpenItem,
  ScopeOwnerRef,
} from "@/features/scope-surfaces";
import { useSpaceNames } from "@/features/space";
import * as m from "@/paraglide/messages.js";

import type { RoutineOwnerInput } from "../api/routines-api";
import type {
  RoutineAgentActorTarget,
  RoutineLaunchRecoveryActions,
  RoutineItem,
  RoutineOwnership,
  RoutineSessionTarget,
} from "../model/types";
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
import { useRoutinePeek } from "./use-routine-peek";
import { useRoutineDispatch } from "./use-routine-dispatch";
import { useRoutineExecutors } from "./use-routine-executors";
import { useRoutineMutations } from "./use-routine-mutations";
import { useRoutineStorageRecovery } from "./use-routine-storage-recovery";

export function useRoutinesController(
  owner: ScopeOwnerRef,
  onOpenSession: (target: RoutineSessionTarget) => void,
  readOnly: boolean,
  openItem?: ScopeOpenItem,
  host: {
    /** The name of the owner the surface shows, such as its Collection's. */
    ownerName?: string;
    onOpenAgentActor?(target: RoutineAgentActorTarget): void;
    onOpenAgentSettings?(): void;
    /** The Routine expanded as the main area object, by its Routine id. */
    mainItem?: ScopeMainItem;
    onExpandItem?(item: ScopeItemRef): void;
  } = {},
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
  const spaceName = useSpaceNames();
  const ownership = useMemo<RoutineOwnership>(
    () => ({
      collection:
        owner.identityKind === "collection-directory"
          ? host.ownerName || folderName(owner.ownerPath)
          : null,
      space: spaceName(owner.spacePath),
    }),
    [host.ownerName, owner, spaceName],
  );
  const automaticConsent = useRoutineAutomaticConsent(routineOwner);
  const storageRecovery = useRoutineStorageRecovery({
    owner: routineOwner,
    retryAutomaticConsent: automaticConsent.retry,
  });
  const executors = useRoutineExecutors(owner.projectPath, owner.spacePath);
  const peek = useCollectionItemPeek<string>(routinePeekIdentity);
  const instanceKey = `routines:${owner.ownerKey}`;
  const { close: closePeek, open: openPeek } = peek;
  const onDetailInvalidated = useCallback(async () => {
    await closePeek();
  }, [closePeek]);
  const mutations = useRoutineMutations({
    onDetailInvalidated,
    owner: routineOwner,
    refresh,
    replaceSnapshot,
    items: state.phase === "ready" ? state.snapshot.items : [],
  });
  const dispatch = useRoutineDispatch({ onOpenSession, owner: routineOwner });
  const { mainItem, onExpandItem, onOpenAgentActor, onOpenAgentSettings } =
    host;
  const recovery = useMemo<RoutineLaunchRecoveryActions>(
    () => ({
      onOpenAgentActor: onOpenAgentActor
        ? (actorId) => onOpenAgentActor({ actorId, spaceId: owner.spaceId })
        : undefined,
      onOpenAgentSettings,
    }),
    [onOpenAgentActor, onOpenAgentSettings, owner.spaceId],
  );
  const routinePeek = useRoutinePeek({
    applyUpdate: mutations.applyUpdate,
    editSession: mutations.editSession,
    executors: executors.state,
    mutationError: mutations.error,
    nameError: mutations.nameError,
    getRunRefusal: dispatch.getRunRefusal,
    getRunState: dispatch.getRunState,
    onOpenSession: dispatch.openLastSession,
    onRun: dispatch.run,
    owner: routineOwner,
    peek,
    pending: mutations.pending,
    readOnly,
    recovery,
    items: state.phase === "ready" ? state.snapshot.items : null,
    onEditChange: mutations.changeEditDraft,
    setEditSession: mutations.setEditSession,
  });
  const onRoutineCreated = useCallback(
    async ({
      owner: createdOwner,
      item,
      snapshot,
    }: {
      owner: RoutineOwnerInput;
      item: RoutineItem;
      snapshot: Parameters<typeof replaceSnapshot>[0];
    }) => {
      if (!sameRoutineOwner(createdOwner, routineOwner)) return;
      replaceSnapshot(snapshot);
      openPeek(item.id);
    },
    [openPeek, replaceSnapshot, routineOwner],
  );
  // A Routine addressed by the open request opens once the catalog is read.
  useEffect(() => {
    if (!openItem || state.phase !== "ready") return;
    openItem.consume();
    const item = state.snapshot.items.find(
      (candidate) => candidate.routineId === openItem.id,
    );
    if (!item) return;
    openPeek(item.id);
  }, [openItem, openPeek, state]);
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
  const actionState = useMemo<CollectionActionState>(() => {
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
    getDeleteState: (item) =>
      item.routineId
        ? actionState
        : {
            reason: m.routines_invalid_identity_disabled(),
            status: "disabled",
          },
    getEditState: (item) =>
      !item.routineId
        ? {
            reason: m.routines_invalid_identity_disabled(),
            status: "disabled",
          }
        : item.definition
          ? actionState
          : {
              reason: m.routines_invalid_edit_disabled(),
              status: "disabled",
            },
    getEnabledState: (item) =>
      item.valid && item.definition && item.definition.trigger.type !== "manual"
        ? actionState
        : {
            reason: item.definition
              ? m.routines_manual_enabled_disabled()
              : m.routines_invalid_edit_disabled(),
            status: "disabled",
          },
    getRunState: (item) => {
      if (!readOnly) return dispatch.getRunState(item);
      if (item.lastRun?.active) return { status: "idle" };
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
        baselineItems: state.snapshot.items,
        owner: routineOwner,
        ownerLabel: routineOwnerLabel(owner),
      });
    },
    onDelete: (item) => {
      if (!readOnly) mutations.openDelete(item);
    },
    onEdit: (item) => {
      if (!readOnly) mutations.openEdit(item);
    },
    onEnabledChange: async (item, enabled) => {
      if (readOnly) throw new Error(m.repository_work_status_read_only());
      if (!item.definition || item.definition.trigger.type === "manual") return;
      await mutations.writeProperty(item, (definition) => ({
        ...definition,
        enabled,
      }));
    },
    onRun: async (item) => {
      if (readOnly) {
        if (item.lastRun?.active) dispatch.openLastSession(item);
        else throw new Error(m.repository_work_status_read_only());
        return;
      }
      await dispatch.run(item);
    },
  };
  const presentation = createRoutinesPresentation({
    actions,
    executors: executors.state,
    recovery,
    onActivate: peek.activation((_item, context) => context.itemId),
    ownership,
    state: toRoutinePresentationState(state, () => void refresh()),
  });
  const instance: CollectionInstance = {
    defaultPresentationId: "all",
    instanceKey,
    presentations: [presentation],
    stateScope: "session",
  };
  const collectionState = useCollectionState(instance);
  const catalogItems = state.phase === "ready" ? state.snapshot.items : null;
  // A Routine is expanded by the id of its definition; one without a
  // readable id has no identity to show in the main area.
  const expand = (itemId: string) => {
    const routineId = catalogItems?.find(
      (candidate) => candidate.id === itemId,
    )?.routineId;
    return routineId && onExpandItem
      ? () => onExpandItem({ surfaceId: "routines", itemId: routineId })
      : null;
  };
  const editedItem = mutations.editSession?.item ?? null;
  const main = mainItem ? (
    <CollectionItemMain
      main={mainItem}
      target={mainItem.item.itemId}
      find={(routineId: string) => {
        if (!catalogItems) return null;
        return (
          catalogItems.find((candidate) => candidate.routineId === routineId) ??
          (editedItem?.routineId === routineId ? editedItem : undefined)
        );
      }}
      render={(item) => routinePeek.render(item, presentation)}
    />
  ) : null;
  const overlays = (
    <>
      {mainItem ? null : (
        <CollectionItemPeek
          peek={peek}
          find={routinePeek.find}
          render={(item) => routinePeek.render(item, presentation)}
          expand={expand}
        />
      )}
      {create.session ? (
        <RoutineCreateDialog
          automaticAuthority={create.session.automaticAuthority}
          collectionOwner={
            create.session.owner.ownerKind === "collection_directory"
          }
          definition={create.session.draft}
          error={create.error}
          executors={createExecutors.state}
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
    main,
    overlays,
    storageRecovery,
  };
}

function routinePeekIdentity(itemId: string) {
  return itemId;
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

function folderName(path: string) {
  return path.split("/").at(-1) || path;
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
