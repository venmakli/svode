import { useCallback, useState } from "react";
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
  RoutineRow,
} from "../model/types";
import * as m from "@/paraglide/messages.js";

export interface RoutineEditSession {
  draft: RoutineDefinition;
  guard: { dirty: boolean };
  row: RoutineRow;
}

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
  const [editSession, setEditSession] = useState<RoutineEditSession | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<RoutineRow | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFailure = useCallback(
    async (result: Exclude<RoutineMutationResult, { status: "applied" }>) => {
      if (result.status === "stale") {
        setError(m.routines_mutation_stale());
        return refresh();
      } else {
        setError(result.message || m.routines_mutation_blocked());
        return null;
      }
    },
    [refresh],
  );

  const applyUpdate = useCallback(
    async (row: RoutineRow, definition: RoutineDefinition) => {
      setPending(true);
      setError(null);
      try {
        const result = await updateRoutine(owner, row, definition);
        if (result.status !== "applied") {
          const snapshot = await handleFailure(result);
          if (result.status === "stale") {
            const current = snapshot?.rows.find(
              (candidate) => candidate.id === row.id,
            );
            if (current?.definition) {
              setEditSession((session) => {
                if (session) session.guard.dirty = false;
                return {
                  draft: current.definition!,
                  guard: { dirty: false },
                  row: current,
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
        replaceSnapshot(result.snapshot);
        if (result.warnings.length > 0) {
          toast.warning(m.routines_update_applied_warning(), {
            description: result.warnings
              .map((warning) => warning.message)
              .join("\n"),
          });
        }
        return (
          result.snapshot.rows.find((candidate) => candidate.id === row.id) ??
          null
        );
      } catch (reason) {
        setError(routineErrorMessage(reason));
        return null;
      } finally {
        setPending(false);
      }
    },
    [handleFailure, onDetailInvalidated, owner, replaceSnapshot],
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
            snapshot?.rows.find(
              (candidate) => candidate.id === deleteTarget.id,
            ) ?? null,
          );
        }
        return;
      }
      replaceSnapshot(result.snapshot);
      setDeleteTarget(null);
      setEditSession(null);
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
    openDelete: (row: RoutineRow) => {
      if (!row.routineId) return;
      setError(null);
      setDeleteTarget(row);
    },
    openEdit: (row: RoutineRow) => {
      if (!row.routineId || !row.definition) return;
      setError(null);
      setEditSession({
        draft: row.definition,
        guard: { dirty: false },
        row,
      });
    },
    pending,
    setEditSession,
    submitDelete,
  };
}
