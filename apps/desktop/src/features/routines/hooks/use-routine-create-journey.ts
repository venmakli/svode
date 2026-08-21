import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import * as m from "@/paraglide/messages.js";

import {
  createRoutine,
  loadRoutineCatalog,
  type RoutineOwnerInput,
} from "../api/routines-api";
import {
  cloneRoutineDefinition,
  createRoutineDraft,
  normalizeRoutineCreateCandidate,
  routineDefinitionMatchesCandidate,
} from "../model/routine-create";
import type {
  RoutineCatalogSnapshot,
  RoutineDefinition,
  RoutineDiagnostic,
  RoutineRow,
} from "../model/types";
import { routineErrorMessage } from "./use-routine-catalog";

interface RoutineCreateSession {
  automaticAuthority: boolean | null;
  baselineRoutineIds: readonly string[];
  draft: RoutineDefinition;
  initialDraft: RoutineDefinition;
  owner: RoutineOwnerInput;
  ownerLabel: string;
}

interface RoutineCreateApplied {
  owner: RoutineOwnerInput;
  row: RoutineRow;
  snapshot: RoutineCatalogSnapshot;
}

export function useRoutineCreateJourney({
  onApplied,
}: {
  onApplied(result: RoutineCreateApplied): void | Promise<void>;
}) {
  const [session, setSession] = useState<RoutineCreateSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [retryBlocked, setRetryBlocked] = useState(false);
  const pendingRef = useRef(false);

  const open = useCallback(
    ({
      automaticAuthority,
      baselineRoutineIds,
      owner,
      ownerLabel,
    }: {
      automaticAuthority: boolean | null;
      baselineRoutineIds: readonly string[];
      owner: RoutineOwnerInput;
      ownerLabel: string;
    }) => {
      const draft = createRoutineDraft();
      setError(null);
      setRetryBlocked(false);
      setSession({
        automaticAuthority,
        baselineRoutineIds,
        draft,
        initialDraft: cloneRoutineDefinition(draft),
        owner: { ...owner },
        ownerLabel,
      });
    },
    [],
  );

  const close = useCallback(() => {
    if (pendingRef.current) return;
    setError(null);
    setRetryBlocked(false);
    setSession(null);
  }, []);

  const change = useCallback((draft: RoutineDefinition) => {
    setSession((current) => (current ? { ...current, draft } : current));
    setError(null);
    setRetryBlocked(false);
  }, []);

  const submit = useCallback(async () => {
    if (!session || pendingRef.current || retryBlocked) return;
    const active = session;
    const candidate = normalizeRoutineCreateCandidate(active.draft);
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await createRoutine(active.owner, candidate);
      if (result.status !== "applied") {
        setError(
          result.status === "stale"
            ? m.routines_mutation_stale()
            : result.message || m.routines_mutation_blocked(),
        );
        return;
      }
      const row = result.snapshot.rows.find(
        (candidateRow) => candidateRow.id === result.routineId,
      );
      if (!row?.definition) {
        setRetryBlocked(true);
        setError(m.routines_create_result_missing());
        return;
      }
      publishWarnings(result.warnings);
      setSession(null);
      await onApplied({ owner: active.owner, row, snapshot: result.snapshot });
    } catch (reason) {
      await reconcileUncertainCreate(active, candidate, reason, onApplied, {
        blockRetry: () => setRetryBlocked(true),
        close: () => setSession(null),
        fail: setError,
      });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, [onApplied, retryBlocked, session]);

  return {
    change,
    close,
    error,
    open,
    pending,
    retryBlocked,
    session,
    submit,
  };
}

async function reconcileUncertainCreate(
  session: RoutineCreateSession,
  candidate: RoutineDefinition,
  reason: unknown,
  onApplied: (result: RoutineCreateApplied) => void | Promise<void>,
  actions: {
    blockRetry(): void;
    close(): void;
    fail(message: string): void;
  },
) {
  try {
    const snapshot = await loadRoutineCatalog(session.owner);
    const baseline = new Set(session.baselineRoutineIds);
    const matches = snapshot.rows.filter(
      (row) =>
        !baseline.has(row.id) &&
        row.definition &&
        routineDefinitionMatchesCandidate(row.definition, candidate),
    );
    if (matches.length === 1) {
      toast.warning(m.routines_create_reconciled());
      actions.close();
      await onApplied({ owner: session.owner, row: matches[0]!, snapshot });
      return;
    }
    if (snapshot.rows.every((row) => baseline.has(row.id))) {
      actions.fail(routineErrorMessage(reason));
      return;
    }
  } catch {
    // The original error remains the most useful user-facing message.
  }
  actions.blockRetry();
  actions.fail(
    `${routineErrorMessage(reason)} ${m.routines_create_reconcile_failed()}`,
  );
}

function publishWarnings(warnings: readonly RoutineDiagnostic[]) {
  if (warnings.length === 0) return;
  toast.warning(m.routines_create_applied_warning(), {
    description: warnings.map((warning) => warning.message).join("\n"),
  });
}
