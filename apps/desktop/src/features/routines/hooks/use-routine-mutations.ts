import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import { useSignalUserEdit } from "@/features/navigation";

import {
  deleteRoutine,
  updateRoutine,
  type RoutineOwnerInput,
} from "../api/routines-api";
import { routineErrorMessage } from "./use-routine-catalog";
import type {
  RoutineCatalogSnapshot,
  RoutineDefinition,
  RoutineMutationResult,
  RoutineItem,
} from "../model/types";
import { findRoutineNameConflictPath } from "../model/routine-name";
import { routineMutationWarningDescription } from "../lib/routine-mutation-warning";
import * as m from "@/paraglide/messages.js";

export interface RoutineEditSession {
  draft: RoutineDefinition;
  guard: { dirty: boolean };
  item: RoutineItem;
}

export function useRoutineMutations({
  owner,
  refresh,
  replaceSnapshot,
  items,
  onDetailInvalidated,
}: {
  owner: RoutineOwnerInput;
  refresh(): Promise<RoutineCatalogSnapshot | null>;
  replaceSnapshot(snapshot: RoutineCatalogSnapshot): void;
  items: readonly RoutineItem[];
  onDetailInvalidated(): void | Promise<void>;
}) {
  const [editSession, setEditSession] = useState<RoutineEditSession | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<RoutineItem | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authoritativeNameConflictPath, setAuthoritativeNameConflictPath] =
    useState<string | null>(null);
  // An edit of a Routine the main area shows keeps it in Now.
  const signalUserEdit = useSignalUserEdit();
  const optimisticNameConflictPath = editSession
    ? findRoutineNameConflictPath(
        editSession.draft.name,
        items,
        editSession.item.id,
      )
    : null;
  const nameConflictPath =
    authoritativeNameConflictPath ?? optimisticNameConflictPath;
  const nameError = nameConflictPath
    ? m.routines_name_conflict({ path: nameConflictPath })
    : null;

  const handleFailure = useCallback(
    async (result: Exclude<RoutineMutationResult, { status: "applied" }>) => {
      if (result.status === "stale") {
        setAuthoritativeNameConflictPath(null);
        setError(m.routines_mutation_stale());
        return refresh();
      } else if (result.status === "name_conflict") {
        setAuthoritativeNameConflictPath(
          result.conflict.conflicts[0]?.path ?? result.conflict.ownerPath,
        );
        setError(null);
        return null;
      } else {
        setError(result.message || m.routines_mutation_blocked());
        return null;
      }
    },
    [refresh],
  );

  const applyUpdate = useCallback(
    async (
      item: RoutineItem,
      definition: RoutineDefinition,
      options: { materializeFilename?: boolean } = {},
    ) => {
      const materializeFilename = options.materializeFilename ?? true;
      if (materializeFilename) {
        const conflictPath = findRoutineNameConflictPath(
          definition.name,
          items,
          item.id,
        );
        if (conflictPath) {
          setAuthoritativeNameConflictPath(conflictPath);
          setError(null);
          return null;
        }
      }
      setPending(true);
      setError(null);
      try {
        const result = await updateRoutine(owner, item, definition, {
          materializeFilename,
        });
        if (result.status !== "applied") {
          const snapshot = await handleFailure(result);
          if (result.status === "stale") {
            const current = snapshot?.items.find(
              (candidate) => candidate.id === item.id,
            );
            if (current?.definition) {
              setEditSession((session) => {
                if (session) session.guard.dirty = false;
                return {
                  draft: current.definition!,
                  guard: { dirty: false },
                  item: current,
                };
              });
            } else {
              setEditSession((session) => {
                if (session) session.guard.dirty = false;
                return null;
              });
              await onDetailInvalidated();
            }
          }
          return null;
        }
        setAuthoritativeNameConflictPath(null);
        replaceSnapshot(result.snapshot);
        signalUserEdit();
        if (result.warnings.length > 0) {
          toast.warning(m.routines_update_applied_warning(), {
            description: result.warnings
              .map(routineMutationWarningDescription)
              .join("\n"),
          });
        }
        return (
          result.snapshot.items.find((candidate) => candidate.id === item.id) ??
          null
        );
      } catch (reason) {
        setError(routineErrorMessage(reason));
        return null;
      } finally {
        setPending(false);
      }
    },
    [
      handleFailure,
      onDetailInvalidated,
      owner,
      replaceSnapshot,
      items,
      signalUserEdit,
    ],
  );

  // The pending property writes of each Routine, by item id.
  const propertyWritesRef = useRef(
    new Map<string, Promise<RoutineItem | null>>(),
  );

  /**
   * Saves one property of a Routine from the panel: the definition whole
   * with the one changed field and `expectedFingerprint`. The writes of one
   * Routine run one after another, each on the version the previous one
   * wrote. It rejects with the reason a write was not applied; on a version
   * conflict the catalog is read again first, so the Routine shows its
   * values from disk. Other Routines and actions stay available meanwhile.
   */
  const writeProperty = useCallback(
    (
      item: RoutineItem,
      change: (definition: RoutineDefinition) => RoutineDefinition,
    ): Promise<RoutineItem> => {
      const writes = propertyWritesRef.current;
      const previous = writes.get(item.id) ?? Promise.resolve(null);
      const write = previous
        .catch(() => null)
        .then(async (afterPrevious) => {
          const base = afterPrevious ?? item;
          if (!base.definition) throw new Error(m.routines_mutation_blocked());
          let result: RoutineMutationResult;
          try {
            result = await updateRoutine(owner, base, change(base.definition), {
              materializeFilename: false,
            });
          } catch (reason) {
            throw new Error(routineErrorMessage(reason), { cause: reason });
          }
          if (result.status === "stale") {
            await refresh();
            throw new Error(m.routines_property_stale());
          }
          if (result.status === "name_conflict") {
            throw new Error(
              m.routines_name_conflict({
                path:
                  result.conflict.conflicts[0]?.path ??
                  result.conflict.ownerPath,
              }),
            );
          }
          if (result.status === "blocked") {
            throw new Error(result.message || m.routines_mutation_blocked());
          }
          replaceSnapshot(result.snapshot);
          if (result.warnings.length > 0) {
            toast.warning(m.routines_update_applied_warning(), {
              description: result.warnings
                .map(routineMutationWarningDescription)
                .join("\n"),
            });
          }
          const updated = result.snapshot.items.find(
            (candidate) => candidate.routineId === base.routineId,
          );
          if (!updated) throw new Error(m.routines_mutation_blocked());
          return updated;
        });
      writes.set(item.id, write);
      const release = () => {
        if (writes.get(item.id) === write) writes.delete(item.id);
      };
      write.then(release, release);
      return write;
    },
    [owner, refresh, replaceSnapshot],
  );

  const submitDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setPending(true);
    setError(null);
    try {
      const result = await deleteRoutine(owner, deleteTarget);
      if (result.status !== "applied") {
        const snapshot = await handleFailure(result);
        if (result.status === "stale") {
          setDeleteTarget(
            snapshot?.items.find(
              (candidate) => candidate.id === deleteTarget.id,
            ) ?? null,
          );
        }
        return;
      }
      replaceSnapshot(result.snapshot);
      setDeleteTarget(null);
      setEditSession(null);
      setAuthoritativeNameConflictPath(null);
      await onDetailInvalidated();
    } catch (reason) {
      setError(routineErrorMessage(reason));
    } finally {
      setPending(false);
    }
  }, [
    deleteTarget,
    handleFailure,
    onDetailInvalidated,
    owner,
    replaceSnapshot,
  ]);

  return {
    applyUpdate,
    closeDelete: () => !pending && setDeleteTarget(null),
    deleteTarget,
    editSession,
    error,
    nameError,
    openDelete: (item: RoutineItem) => {
      if (!item.routineId) return;
      setError(null);
      setDeleteTarget(item);
    },
    openEdit: (item: RoutineItem) => {
      if (!item.routineId || !item.definition) return;
      setError(null);
      setAuthoritativeNameConflictPath(null);
      setEditSession({
        draft: item.definition,
        guard: { dirty: false },
        item,
      });
    },
    pending,
    changeEditDraft: (draft: RoutineDefinition) => {
      setAuthoritativeNameConflictPath(null);
      setError(null);
      setEditSession((current) => {
        if (!current) return current;
        current.guard.dirty = true;
        return { ...current, draft };
      });
    },
    setEditSession,
    submitDelete,
    writeProperty,
  };
}
