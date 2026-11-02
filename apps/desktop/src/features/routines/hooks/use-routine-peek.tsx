import { useCallback, useRef } from "react";

import {
  CollectionItemActionsMenu,
  type CollectionItemPeekScreen,
  type ObjectContentHeaderEdit,
} from "@/features/collection/app-shell";
import type {
  CollectionActionState,
  CollectionPresentationRuntime,
} from "@/features/collection";
import * as m from "@/paraglide/messages.js";

import { findRoutineNameConflictPath } from "../model/routine-name";
import type {
  RoutineDefinition,
  RoutineLaunchRecoveryActions,
  RoutineLaunchRefusal,
  RoutineItem,
} from "../model/types";
import { RoutineDetailView } from "../ui/routine-detail-view";
import type { RoutineInstructionFlush } from "./use-routine-instruction-autosave";
import { RoutineRunError, RoutineRunTool } from "../ui/routine-run-tool";
import {
  routineScreenIcon,
  routineSecondaryDescription,
} from "../ui/routines-presentation";

/** The Routine whose name takes focus once its screen shows, after creating it. */
export interface RoutineTitleFocus {
  itemId: string;
  request: number;
}

/**
 * The screen of a Routine in its peek or in the main area, by its item id:
 * its name and description edited in place in the content header, its
 * properties in the property panel, where they are edited, and its
 * instruction, saved by itself; "Run now" among its tools and its item
 * actions in ⋯. Leaving the screen waits for the instruction to be written.
 */
export function useRoutinePeek({
  getRunRefusal,
  getRunState,
  items,
  onOpenSession,
  onRun,
  readOnly,
  recovery,
  titleFocus,
  writeProperty,
}: {
  getRunRefusal(item: RoutineItem): RoutineLaunchRefusal | null;
  getRunState(item: RoutineItem): CollectionActionState;
  /** The Routines of the ready catalog; null until it is read. */
  items: readonly RoutineItem[] | null;
  onOpenSession(item: RoutineItem): void;
  onRun(item: RoutineItem): Promise<void>;
  readOnly: boolean;
  recovery: RoutineLaunchRecoveryActions;
  titleFocus: RoutineTitleFocus | null;
  writeProperty(
    item: RoutineItem,
    change: (definition: RoutineDefinition) => RoutineDefinition,
    options?: { materializeFilename?: boolean },
  ): Promise<RoutineItem>;
}) {
  // A Routine without a readable id is listed as `invalid:<path>`, so its
  // peek closes as a Routine that is gone.
  const find = useCallback(
    (itemId: string) => {
      if (!items) return null;
      return items.find((candidate) => candidate.id === itemId);
    },
    [items],
  );

  // The flush of the instruction each shown Routine edits, by item id.
  const instructionFlushesRef = useRef(
    new Map<string, RoutineInstructionFlush>(),
  );
  const registerInstructionFlush = useCallback(
    (itemId: string, flush: RoutineInstructionFlush | null) => {
      const flushes = instructionFlushesRef.current;
      if (flush) flushes.set(itemId, flush);
      else flushes.delete(itemId);
    },
    [],
  );

  const render = useCallback(
    (
      item: RoutineItem,
      presentation: CollectionPresentationRuntime,
    ): CollectionItemPeekScreen => {
      const identity = { icon: routineScreenIcon(item), name: item.name };
      const runState = getRunState(item);
      const editable =
        !readOnly && item.routineId !== null && item.definition !== null;
      const edit: ObjectContentHeaderEdit | undefined = editable
        ? {
            description: item.definition?.description ?? item.description,
            onDescriptionCommit: async (description) => {
              await writeProperty(item, (definition) => ({
                ...definition,
                description,
              }));
            },
            onTitleCommit: async (name) => {
              const conflictPath = findRoutineNameConflictPath(
                name,
                items ?? [],
                item.id,
              );
              if (conflictPath) {
                throw new Error(
                  m.routines_name_conflict({ path: conflictPath }),
                );
              }
              await writeProperty(
                item,
                (definition) => ({ ...definition, name }),
                { materializeFilename: true },
              );
            },
            titleFocusRequest:
              titleFocus?.itemId === item.id ? titleFocus.request : undefined,
          }
        : undefined;
      return {
        canClose: async () => {
          await instructionFlushesRef.current.get(item.id)?.();
          return true;
        },
        content: (
          <>
            <RoutineRunError
              item={item}
              recovery={recovery}
              runRefusal={getRunRefusal(item)}
              runState={runState}
            />
            <RoutineDetailView
              item={item}
              presentation={presentation}
              readOnly={!editable}
              registerInstructionFlush={registerInstructionFlush}
              saveInstruction={async (body) => {
                await writeProperty(item, (definition) => ({
                  ...definition,
                  body,
                }));
              }}
            />
          </>
        ),
        header: {
          description: routineSecondaryDescription(item),
          edit,
          icon: identity.icon,
          title: item.name,
        },
        identity,
        menu: (
          <CollectionItemActionsMenu item={item} presentation={presentation} />
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
    },
    [
      getRunRefusal,
      getRunState,
      items,
      onOpenSession,
      onRun,
      readOnly,
      recovery,
      registerInstructionFlush,
      titleFocus,
      writeProperty,
    ],
  );

  return { find, render };
}
