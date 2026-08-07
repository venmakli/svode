import { useCallback, useState } from "react";

import {
  createRoutine,
  deleteRoutine,
  updateRoutine,
  type RoutineOwnerInput,
} from "../api/routines-api";
import { routineErrorMessage } from "./use-routine-catalog";
import type {
  RoutineCatalogSnapshot,
  RoutineCreateInput,
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
  const [createOpen, setCreateOpen] = useState(false);
  const [createInput, setCreateInput] = useState<RoutineCreateInput>(() => ({
    description: "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    title: "",
    triggerType: "manual",
  }));
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

  const submitCreate = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const result = await createRoutine(owner, createInput);
      if (result.status !== "applied") {
        await handleFailure(result);
        return;
      }
      replaceSnapshot(result.snapshot);
      setCreateOpen(false);
      setCreateInput((current) => ({
        ...current,
        description: "",
        title: "",
        triggerType: "manual",
      }));
      const row = result.snapshot.rows.find(
        (candidate) => candidate.id === result.routineId,
      );
      if (row?.definition) {
        setEditSession({
          draft: row.definition,
          guard: { dirty: false },
          row,
        });
      }
    } catch (reason) {
      setError(routineErrorMessage(reason));
    } finally {
      setPending(false);
    }
  }, [createInput, handleFailure, owner, replaceSnapshot]);

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
    closeCreate: () => !pending && setCreateOpen(false),
    closeDelete: () => !pending && setDeleteTarget(null),
    createInput,
    createOpen,
    deleteTarget,
    editSession,
    error,
    openCreate: () => {
      setError(null);
      setCreateOpen(true);
    },
    openDelete: (row: RoutineRow) => {
      setError(null);
      setDeleteTarget(row);
    },
    openEdit: (row: RoutineRow) => {
      if (!row.definition) return;
      setError(null);
      setEditSession({
        draft: row.definition,
        guard: { dirty: false },
        row,
      });
    },
    pending,
    setCreateInput,
    setEditSession,
    submitCreate,
    submitDelete,
  };
}
