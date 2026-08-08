import { useCallback, useState } from "react";

import type { SystemCollectionActionState } from "@/features/collection/system";
import * as m from "@/paraglide/messages.js";

import {
  dispatchManualRoutine,
  type RoutineOwnerInput,
} from "../api/routines-api";
import type { RoutineRow, RoutineSessionTarget } from "../model/types";

export function useRoutineDispatch({
  onOpenSession,
  owner,
}: {
  onOpenSession(target: RoutineSessionTarget): void;
  owner: RoutineOwnerInput;
}) {
  const [pendingRoutineId, setPendingRoutineId] = useState<string | null>(null);
  const [lastError, setLastError] = useState<{
    routineId: string;
    message: string;
  } | null>(null);

  const getRunState = useCallback(
    (row: RoutineRow): SystemCollectionActionState => {
      const disabledReason = routineRunDisabledReason(row);
      if (disabledReason) return { reason: disabledReason, status: "disabled" };
      if (pendingRoutineId === row.id) return { status: "pending" };
      if (lastError?.routineId === row.id) {
        return { message: lastError.message, status: "error" };
      }
      return { status: "idle" };
    },
    [lastError, pendingRoutineId],
  );

  const run = useCallback(
    async (row: RoutineRow) => {
      const disabledReason = routineRunDisabledReason(row);
      if (disabledReason) throw new Error(disabledReason);
      setPendingRoutineId(row.id);
      setLastError((current) =>
        current?.routineId === row.id ? null : current,
      );
      try {
        const result = await dispatchManualRoutine(owner, row);
        if (result.status === "blocked" || result.status === "failed") {
          setLastError({ message: result.message, routineId: row.id });
          throw new Error(result.message);
        }
        onOpenSession({
          launchId: result.launchId,
          sessionId: result.agentSessionId,
        });
      } finally {
        setPendingRoutineId((current) => (current === row.id ? null : current));
      }
    },
    [onOpenSession, owner],
  );

  const openLastSession = useCallback(
    (row: RoutineRow) => {
      if (!row.lastRun) return;
      onOpenSession({
        launchId: row.lastRun.launchId,
        sessionId: row.lastRun.agentSessionId,
      });
    },
    [onOpenSession],
  );

  return { getRunState, openLastSession, run };
}

function routineRunDisabledReason(row: RoutineRow) {
  if (!row.valid || !row.definition) return m.routines_invalid_run_disabled();
  if (row.definition.trigger.type === "event") {
    return m.routines_manual_run_only();
  }
  if (row.definition.action.type !== "run_agent") {
    return m.routines_run_agent_only();
  }
  if (!row.definition.action.executor.trim()) {
    return m.routines_executor_required();
  }
  return null;
}
