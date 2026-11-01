import { useCallback, useState } from "react";

import { useAgentAdapterDictionary } from "@/features/agent-adapters";
import type { CollectionActionState } from "@/features/collection";
import * as m from "@/paraglide/messages.js";

import {
  dispatchManualRoutine,
  type RoutineOwnerInput,
} from "../api/routines-api";
import { routineLaunchRefusalText } from "../lib/routine-launch-refusal";
import { RoutineLaunchRefusedError } from "../model/launch-refusal";
import type {
  RoutineLaunchRefusal,
  RoutineItem,
  RoutineSessionTarget,
} from "../model/types";

export function useRoutineDispatch({
  onOpenSession,
  owner,
}: {
  onOpenSession(target: RoutineSessionTarget): void;
  owner: RoutineOwnerInput;
}) {
  const [pendingRoutineId, setPendingRoutineId] = useState<string | null>(null);
  const agents = useAgentAdapterDictionary();
  const [lastError, setLastError] = useState<{
    routineId: string;
    message: string;
    refusal: RoutineLaunchRefusal | null;
  } | null>(null);

  const getRunState = useCallback(
    (item: RoutineItem): CollectionActionState => {
      const disabledReason = routineRunDisabledReason(item);
      if (disabledReason) return { reason: disabledReason, status: "disabled" };
      if (pendingRoutineId === item.id) return { status: "pending" };
      if (lastError?.routineId === item.id) {
        return { message: lastError.message, status: "error" };
      }
      return { status: "idle" };
    },
    [lastError, pendingRoutineId],
  );

  /** Why the last manual run of the Routine was refused before its prompt. */
  const getRunRefusal = useCallback(
    (item: RoutineItem) =>
      lastError?.routineId === item.id ? lastError.refusal : null,
    [lastError],
  );

  const run = useCallback(
    async (item: RoutineItem) => {
      const disabledReason = routineRunDisabledReason(item);
      if (disabledReason) throw new Error(disabledReason);
      setPendingRoutineId(item.id);
      setLastError((current) =>
        current?.routineId === item.id ? null : current,
      );
      try {
        const result = await dispatchManualRoutine(owner, item);
        if (result.status === "blocked" || result.status === "failed") {
          const refusal = result.refusal;
          const message = refusal
            ? routineLaunchRefusalText(refusal, agents.label)
            : result.message;
          setLastError({ message, refusal, routineId: item.id });
          throw refusal
            ? new RoutineLaunchRefusedError(message, refusal)
            : new Error(message);
        }
        onOpenSession({
          launchId: result.launchId,
          sessionId: result.agentSessionId,
        });
      } finally {
        setPendingRoutineId((current) =>
          current === item.id ? null : current,
        );
      }
    },
    [agents, onOpenSession, owner],
  );

  const openLastSession = useCallback(
    (item: RoutineItem) => {
      if (!item.lastRun) return;
      onOpenSession({
        launchId: item.lastRun.launchId,
        sessionId: item.lastRun.agentSessionId,
      });
    },
    [onOpenSession],
  );

  return { getRunRefusal, getRunState, openLastSession, run };
}

function routineRunDisabledReason(item: RoutineItem) {
  if (!item.valid || !item.definition) return m.routines_invalid_run_disabled();
  if (item.definition.trigger.type === "event") {
    return m.routines_manual_run_only();
  }
  if (item.definition.action.type !== "run_agent") {
    return m.routines_run_agent_only();
  }
  if (!item.definition.action.executor.trim()) {
    return m.routines_executor_required();
  }
  return null;
}
