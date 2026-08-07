export type RoutineOwnerKind = "registered_space" | "collection_directory";
export type RoutineResolvedOwnerKind = "project" | "space" | "collection";

export type RoutineTriggerType = "manual" | "schedule" | "event";
export type RoutineActionType = "run_agent" | "update_properties";
export type RoutineEventType =
  | "collection.entry_created"
  | "collection.field_changed"
  | "collection.entry_deleted";

export type RoutineTrigger =
  | { type: "manual" }
  | {
      type: "schedule";
      cron: string;
      timezone: string;
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
  title: string;
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

export interface RoutineRow {
  id: string;
  definitionPath: string;
  filename: string;
  fingerprint: string;
  title: string;
  description: string;
  definition: RoutineDefinition | null;
  diagnostics: readonly RoutineDiagnostic[];
  valid: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

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
    }
  | {
      phase: "ready";
      snapshot: RoutineCatalogSnapshot;
      refreshing: boolean;
      refreshError: string | null;
    };

export interface RoutineCreateInput {
  title: string;
  description: string;
  triggerType: RoutineTriggerType;
  timezone: string | null;
}

export type RoutineMutationResult =
  | {
      status: "applied";
      snapshot: RoutineCatalogSnapshot;
      routineId: string;
    }
  | { status: "stale"; currentFingerprint: string | null }
  | { status: "blocked"; message: string };
