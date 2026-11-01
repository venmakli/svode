import { useCallback, useEffect } from "react";
import { AlertTriangle, LoaderCircle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { AgentActorOptionsState } from "@/features/actors/agent-reference";
import {
  CollectionItemActionsMenu,
  type CollectionItemPeekController,
  type CollectionItemPeekScreen,
} from "@/features/collection/app-shell";
import type {
  CollectionActionState,
  CollectionPresentationRuntime,
} from "@/features/collection";
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
import { RoutineRunError, RoutineRunTool } from "../ui/routine-run-tool";
import {
  routineScreenIcon,
  routineSecondaryDescription,
} from "../ui/routines-presentation";
import type { RoutineEditSession } from "./use-routine-mutations";

/**
 * The screen of a Routine in the peek of the Routines, by its item id: the
 * read-only Routine with "Run now" among its tools and its item actions in
 * ⋯, or its editing form while an edit session of it is open.
 */
export function useRoutinePeek({
  applyUpdate,
  editSession,
  executors,
  mutationError,
  nameError,
  getRunRefusal,
  getRunState,
  onOpenSession,
  onRun,
  owner,
  peek,
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
  editSession: RoutineEditSession | null;
  executors: AgentActorOptionsState;
  mutationError: string | null;
  nameError: string | null;
  getRunRefusal(item: RoutineItem): RoutineLaunchRefusal | null;
  getRunState(item: RoutineItem): CollectionActionState;
  onOpenSession(item: RoutineItem): void;
  onRun(item: RoutineItem): Promise<void>;
  owner: RoutineOwnerInput;
  peek: CollectionItemPeekController<string>;
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
}) {
  // A Routine without a readable id is listed as `invalid:<path>`, so its
  // peek closes as a Routine that is gone. An open form keeps its draft even
  // when its Routine leaves the catalog.
  const editedItem = editSession?.item ?? null;
  const find = useCallback(
    (itemId: string) => {
      if (!items) return null;
      const item = items.find((candidate) => candidate.id === itemId);
      return item ?? (editedItem?.id === itemId ? editedItem : undefined);
    },
    [editedItem, items],
  );

  // "Edit" of a Routine opens its form in the peek of the Routine.
  const editedItemId = editedItem?.id ?? null;
  const { open, target } = peek;
  useEffect(() => {
    if (editedItemId !== null && target !== editedItemId) open(editedItemId);
  }, [editedItemId, open, target]);

  const render = useCallback(
    (
      item: RoutineItem,
      presentation: CollectionPresentationRuntime,
    ): CollectionItemPeekScreen => {
      const identity = { icon: routineScreenIcon(item), name: item.name };
      const session = editSession?.item.id === item.id ? editSession : null;
      if (!session) {
        const runState = getRunState(item);
        return {
          content: (
            <>
              <RoutineRunError
                item={item}
                recovery={recovery}
                runRefusal={getRunRefusal(item)}
                runState={runState}
              />
              <RoutineDetailView
                executors={executors}
                recovery={recovery}
                item={item}
              />
            </>
          ),
          header: {
            description: routineSecondaryDescription(item),
            icon: identity.icon,
            title: item.name,
          },
          identity,
          menu: (
            <CollectionItemActionsMenu
              item={item}
              presentation={presentation}
            />
          ),
          tools: (
            <RoutineRunTool
              item={item}
              runState={runState}
              onOpenSession={onOpenSession}
              onRun={onRun}
            />
          ),
        };
      }
      const formId = `routine-detail-${item.id}`;
      return {
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
                    setEditSession((current) =>
                      current === session ? null : current,
                    );
                  })();
                }}
              />
            </fieldset>
          </div>
        ),
        footer: (
          <div className="flex w-full justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                session.guard.dirty = false;
                setEditSession(null);
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
        identity: {
          icon: identity.icon,
          name: session.draft.name || item.name,
        },
        layout: "form",
      };
    },
    [
      applyUpdate,
      editSession,
      executors,
      getRunRefusal,
      getRunState,
      mutationError,
      nameError,
      onEditChange,
      onOpenSession,
      onRun,
      owner.ownerKind,
      pending,
      readOnly,
      recovery,
      setEditSession,
    ],
  );

  return { find, render };
}
