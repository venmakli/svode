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
import { findRoutineNameConflictPath } from "../model/routine-name";
import type {
  RoutineCatalogSnapshot,
  RoutineDefinition,
  RoutineDiagnostic,
  RoutineItem,
} from "../model/types";
import { routineMutationWarningDescription } from "../lib/routine-mutation-warning";
import { routineErrorMessage } from "./use-routine-catalog";

interface RoutineCreateSession {
  automaticAuthority: boolean | null;
  baselineItems: readonly RoutineItem[];
  draft: RoutineDefinition;
  initialDraft: RoutineDefinition;
  owner: RoutineOwnerInput;
  ownerLabel: string;
}

interface RoutineCreateApplied {
  owner: RoutineOwnerInput;
  item: RoutineItem;
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
  const [authoritativeNameConflictPath, setAuthoritativeNameConflictPath] =
    useState<string | null>(null);
  const pendingRef = useRef(false);

  const open = useCallback(
    ({
      automaticAuthority,
      baselineItems,
      owner,
      ownerLabel,
    }: {
      automaticAuthority: boolean | null;
      baselineItems: readonly RoutineItem[];
      owner: RoutineOwnerInput;
      ownerLabel: string;
    }) => {
      const draft = createRoutineDraft();
      setError(null);
      setRetryBlocked(false);
      setAuthoritativeNameConflictPath(null);
      setSession({
        automaticAuthority,
        baselineItems,
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
    setAuthoritativeNameConflictPath(null);
    setSession(null);
  }, []);

  const change = useCallback((draft: RoutineDefinition) => {
    setSession((current) => (current ? { ...current, draft } : current));
    setError(null);
    setRetryBlocked(false);
    setAuthoritativeNameConflictPath(null);
  }, []);

  const optimisticNameConflictPath = session
    ? findRoutineNameConflictPath(session.draft.name, session.baselineItems)
    : null;
  const nameConflictPath =
    authoritativeNameConflictPath ?? optimisticNameConflictPath;
  const nameError = nameConflictPath
    ? m.routines_name_conflict({ path: nameConflictPath })
    : null;

  const submit = useCallback(async () => {
    if (!session || pendingRef.current || retryBlocked || nameConflictPath) {
      return;
    }
    const active = session;
    const candidate = normalizeRoutineCreateCandidate(active.draft);
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await createRoutine(active.owner, candidate);
      if (result.status !== "applied") {
        if (result.status === "name_conflict") {
          setAuthoritativeNameConflictPath(
            result.conflict.conflicts[0]?.path ?? active.owner.ownerPath,
          );
          setError(null);
          return;
        }
        setError(
          result.status === "stale"
            ? m.routines_mutation_stale()
            : result.message || m.routines_mutation_blocked(),
        );
        return;
      }
      const item = result.snapshot.items.find(
        (candidateItem) => candidateItem.id === result.routineId,
      );
      if (!item?.definition) {
        setRetryBlocked(true);
        setError(m.routines_create_result_missing());
        return;
      }
      publishWarnings(result.warnings);
      setAuthoritativeNameConflictPath(null);
      setSession(null);
      await onApplied({ owner: active.owner, item, snapshot: result.snapshot });
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
  }, [nameConflictPath, onApplied, retryBlocked, session]);

  return {
    change,
    close,
    error,
    nameError,
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
    const baseline = new Set(session.baselineItems.map((item) => item.id));
    const matches = snapshot.items.filter(
      (item) =>
        !baseline.has(item.id) &&
        item.definition &&
        routineDefinitionMatchesCandidate(item.definition, candidate),
    );
    if (matches.length === 1) {
      toast.warning(m.routines_create_reconciled());
      actions.close();
      await onApplied({ owner: session.owner, item: matches[0]!, snapshot });
      return;
    }
    if (snapshot.items.every((item) => baseline.has(item.id))) {
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
    description: warnings.map(routineMutationWarningDescription).join("\n"),
  });
}
