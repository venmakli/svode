import { useCallback, useEffect, useMemo } from "react";
import { AlertTriangle, LoaderCircle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { AgentActorOptionsState } from "@/features/actors/agent-reference";
import {
  useCollectionDetailItemBinding,
  type CollectionDetailContent,
  type CollectionDetailController,
  type CollectionDetailItemBinding,
} from "@/features/collection/app-shell";
import type { CollectionActionState } from "@/features/collection";
import * as m from "@/paraglide/messages.js";

import type { RoutineOwnerInput } from "../api/routines-api";
import type {
  RoutineDefinition,
  RoutineLaunchRecoveryActions,
  RoutineLaunchRefusal,
  RoutineItem,
} from "../model/types";
import { RoutineDefinitionForm } from "../ui/routine-definition-form";
import { RoutineDetailView } from "../ui/routine-detail-view";
import { RoutineDetailActions } from "../ui/routine-detail-actions";
import { routineDetailTitle } from "../ui/routines-presentation";
import type { RoutineEditSession } from "./use-routine-mutations";

export function useRoutineDetail({
  applyUpdate,
  detailController,
  editSession,
  executors,
  instanceKey,
  mutationError,
  nameError,
  getRunRefusal,
  getRunState,
  onOpenSession,
  onRun,
  owner,
  pending,
  readOnly,
  recovery,
  items,
  onEditChange,
  setEditSession,
}: {
  applyUpdate(
    item: RoutineItem,
    definition: RoutineDefinition,
  ): Promise<RoutineItem | null>;
  detailController: CollectionDetailController | null;
  editSession: RoutineEditSession | null;
  executors: AgentActorOptionsState;
  instanceKey: string;
  mutationError: string | null;
  nameError: string | null;
  getRunRefusal(item: RoutineItem): RoutineLaunchRefusal | null;
  getRunState(item: RoutineItem): CollectionActionState;
  onOpenSession(item: RoutineItem): void;
  onRun(item: RoutineItem): Promise<void>;
  owner: RoutineOwnerInput;
  pending: boolean;
  readOnly: boolean;
  recovery: RoutineLaunchRecoveryActions;
  /** The Routines of the ready catalog; null until it is read. */
  items: readonly RoutineItem[] | null;
  onEditChange(definition: RoutineDefinition): void;
  setEditSession(
    value:
      | RoutineEditSession
      | null
      | ((current: RoutineEditSession | null) => RoutineEditSession | null),
  ): void;
}): CollectionDetailItemBinding<RoutineItem> {
  const createReadOnlyDetail = useCallback(
    (item: RoutineItem): CollectionDetailContent => ({
      content: (
        <RoutineDetailView
          executors={executors}
          recovery={recovery}
          item={item}
        />
      ),
      description: (
        <span className="sr-only">{m.routines_detail_description()}</span>
      ),
      footerActions: (
        <RoutineDetailActions
          recovery={recovery}
          item={item}
          runRefusal={getRunRefusal(item)}
          runState={getRunState(item)}
          onOpenSession={onOpenSession}
          onRun={onRun}
        />
      ),
      title: routineDetailTitle(item),
    }),
    [executors, getRunRefusal, getRunState, onOpenSession, onRun, recovery],
  );
  // A Routine without a readable id is listed as `invalid:<path>`, so its
  // detail closes as a Routine that is gone.
  const findItem = useMemo(
    () =>
      items
        ? (selection: { itemId: string }) =>
            items.find((item) => item.id === selection.itemId)
        : null,
    [items],
  );
  const detail = useCollectionDetailItemBinding({
    controller: detailController,
    createContent: createReadOnlyDetail,
    findItem,
  });

  useEffect(() => {
    if (!editSession || !detailController) return;
    const session = editSession;
    const formId = `routine-detail-${session.item.id}`;
    const selection = {
      instanceKey,
      presentationId: "all",
      itemId: session.item.id,
    };
    void detailController
      .open({
        canClose: async () => {
          // The Tauri dialog plugin makes window.confirm resolve asynchronously.
          if (
            session.guard.dirty &&
            !(await window.confirm(m.routines_discard_confirm()))
          ) {
            return false;
          }
          session.guard.dirty = false;
          setEditSession((current) => (current === session ? null : current));
          return true;
        },
        content: (
          <div className="flex flex-col gap-4">
            {mutationError ? (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertDescription>{mutationError}</AlertDescription>
              </Alert>
            ) : null}
            <fieldset disabled={readOnly} className="contents">
              <RoutineDefinitionForm
                collectionOwner={owner.ownerKind === "collection_directory"}
                definition={session.draft}
                executors={executors}
                formId={formId}
                nameError={nameError}
                onChange={onEditChange}
                onSubmit={() => {
                  if (readOnly) return;
                  void (async () => {
                    const updated = await applyUpdate(
                      session.item,
                      session.draft,
                    );
                    if (!updated) return;
                    session.guard.dirty = false;
                    setEditSession(null);
                    await detail.open(updated, selection);
                  })();
                }}
              />
            </fieldset>
          </div>
        ),
        description: (
          <span className="sr-only">{m.routines_edit_description()}</span>
        ),
        footerActions: (
          <div className="flex w-full justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                session.guard.dirty = false;
                setEditSession(null);
                void detail.open(session.item, selection);
              }}
            >
              {m.routines_cancel()}
            </Button>
            <Button type="submit" form={formId} disabled={pending || readOnly}>
              {pending ? (
                <LoaderCircle
                  data-icon="inline-start"
                  className="animate-spin"
                />
              ) : null}
              {pending ? m.routines_saving() : m.routines_save()}
            </Button>
          </div>
        ),
        layout: "form",
        selection,
        title: routineDetailTitle({
          ...session.item,
          description: session.draft.description,
          name: session.draft.name,
        }),
      })
      .then((opened) => {
        if (!opened) {
          setEditSession((current) => (current === session ? null : current));
        }
      });
  }, [
    applyUpdate,
    detail,
    detailController,
    editSession,
    executors,
    instanceKey,
    mutationError,
    nameError,
    getRunState,
    onOpenSession,
    onRun,
    owner.ownerKind,
    pending,
    readOnly,
    onEditChange,
    setEditSession,
  ]);

  return detail;
}
