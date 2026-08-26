export type RoutineOwnerKind = "registered_space" | "collection_directory";
export type RoutineResolvedOwnerKind = "project" | "space" | "collection";

export type RoutineTriggerType = "manual" | "schedule" | "event";
export type RoutineActionType = "run_agent" | "update_properties";
export type RoutineEventType =
  | "collection.entry_created"
  | "collection.field_changed"
  | "collection.entry_deleted";

export type RoutineTimeBasis =
  | { mode: "local" }
  | { mode: "fixed"; timezone: string };

export type RoutineTrigger =
  | { type: "manual" }
  | {
      type: "schedule";
      cron: string;
      timeBasis: RoutineTimeBasis;
      missedRuns: "skip" | "run_once";
    }
  | {
      type: "event";
      event: RoutineEventType;
      match?: {
        field: string;
        from?: unknown;
        to?: unknown;
      } | null;
    };

export type RoutineAction =
  | {
      type: "run_agent";
      executor: string;
    }
  | {
      type: "update_properties";
      target: "trigger.entry";
      set: Readonly<Record<string, unknown>>;
    };

export interface RoutineDefinition {
  name: string;
  description: string;
  enabled: boolean | null;
  trigger: RoutineTrigger;
  action: RoutineAction;
  body: string;
}

export interface RoutineDiagnostic {
  code: string;
  message: string;
  field: string | null;
  path: string | null;
}

export interface RoutineNameConflictProjection {
  conflictingPaths: readonly string[];
}

export interface RoutineNameConflictEvidence {
  routineId: string | null;
  name: string;
  filename: string;
  path: string;
}

export interface RoutineNameConflict {
  resolvedOwnerKind: RoutineResolvedOwnerKind;
  spaceId: string;
  ownerPath: string;
  conflicts: readonly RoutineNameConflictEvidence[];
}

export interface RoutineRow {
  id: string;
  routineId: string | null;
  definitionPath: string;
  filename: string;
  fingerprint: string;
  name: string;
  nameConflict?: RoutineNameConflictProjection | null;
  description: string;
  definition: RoutineDefinition | null;
  diagnostics: readonly RoutineDiagnostic[];
  valid: boolean;
  lastRunAt: string | null;
  lastRunOrigin: "local" | "remote" | null;
  nextRunAt: string | null;
  lastRun: RoutineRunRef | null;
}

export interface RoutineRunRef {
  routineRunId: string;
  launchId: string;
  agentSessionId: string;
  sourceSessionId: string | null;
  ptyId: string | null;
  active: boolean;
}

export interface RoutineSessionTarget {
  sessionId: string;
  launchId: string;
}

export type RoutineDispatchBlockedCode =
  | "invalid_routine"
  | "non_manual_trigger"
  | "unsupported_action"
  | "missing_executor"
  | "missing_actor_id"
  | "ambiguous_actor_id"
  | "unavailable_executor"
  | "repository_access_denied";

export type RoutineManualDispatchResult =
  | {
      status: "started" | "focused";
      routineId: string;
      routineRunId: string;
      launchId: string;
      agentSessionId: string;
      sourceSessionId: string | null;
      ptyId: string | null;
    }
  | {
      status: "blocked";
      routineId: string;
      code: RoutineDispatchBlockedCode;
      message: string;
    }
  | {
      status: "failed";
      routineId: string;
      routineRunId: string;
      launchId: string;
      agentSessionId: string;
      message: string;
    };

export interface RoutineCatalogSnapshot {
  catalogFingerprint: string;
  refreshedAt: string;
  resolvedOwnerKind: RoutineResolvedOwnerKind;
  spaceId: string;
  ownerPath: string;
  rows: readonly RoutineRow[];
  diagnostics: readonly RoutineDiagnostic[];
}

export type RoutineCatalogState =
  | { phase: "initial" }
  | {
      phase: "blocking_error";
      error: string;
      retrying: boolean;
    }
  | {
      phase: "ready";
      snapshot: RoutineCatalogSnapshot;
      refreshing: boolean;
      refreshError: string | null;
    };

export type RoutineMutationResult =
  | {
      status: "applied";
      snapshot: RoutineCatalogSnapshot;
      routineId: string;
      changedPaths: readonly string[];
      warnings: readonly RoutineDiagnostic[];
    }
  | { status: "stale"; currentFingerprint: string | null }
  | { status: "name_conflict"; conflict: RoutineNameConflict }
  | { status: "blocked"; message: string };
