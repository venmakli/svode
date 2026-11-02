import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

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
import { routineMutationWarningDescription } from "../lib/routine-mutation-warning";
import * as m from "@/paraglide/messages.js";

export function useRoutineMutations({
  owner,
  refresh,
  replaceSnapshot,
  onDetailInvalidated,
}: {
  owner: RoutineOwnerInput;
  refresh(): Promise<RoutineCatalogSnapshot | null>;
  replaceSnapshot(snapshot: RoutineCatalogSnapshot): void;
  onDetailInvalidated(): void | Promise<void>;
}) {
  const [deleteTarget, setDeleteTarget] = useState<RoutineItem | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      options: { materializeFilename?: boolean } = {},
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
              materializeFilename: options.materializeFilename ?? false,
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
      if (result.status === "stale") {
        setError(m.routines_mutation_stale());
        const snapshot = await refresh();
        setDeleteTarget(
          snapshot?.items.find(
            (candidate) => candidate.id === deleteTarget.id,
          ) ?? null,
        );
        return;
      }
      if (result.status !== "applied") {
        setError(
          result.status === "blocked"
            ? result.message || m.routines_mutation_blocked()
            : m.routines_mutation_blocked(),
        );
        return;
      }
      replaceSnapshot(result.snapshot);
      setDeleteTarget(null);
      await onDetailInvalidated();
    } catch (reason) {
      setError(routineErrorMessage(reason));
    } finally {
      setPending(false);
    }
  }, [deleteTarget, onDetailInvalidated, owner, refresh, replaceSnapshot]);

  return {
    closeDelete: () => !pending && setDeleteTarget(null),
    deleteTarget,
    error,
    openDelete: (item: RoutineItem) => {
      if (!item.routineId) return;
      setError(null);
      setDeleteTarget(item);
    },
    pending,
    submitDelete,
    writeProperty,
  };
}
