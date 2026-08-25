import { invokeCommand } from "@/platform/native/invoke";
import {
  listen,
  type EventCallback,
  type UnlistenFn,
} from "@/platform/native/events";

export type RoutineOwnerKindDto = "registered_space" | "collection_directory";
export type RoutineResolvedOwnerKindDto = "project" | "space" | "collection";
export type RoutineTriggerTypeDto = "manual" | "schedule" | "event";
export type RoutineActionTypeDto = "run_agent" | "update_properties";
export type RoutineEventTypeDto =
  | "collection.entry_created"
  | "collection.field_changed"
  | "collection.entry_deleted";

export type RoutineTriggerDto =
  | { type: "manual" }
  | {
      type: "schedule";
      cron: string;
      timezone: string;
      missedRuns: "skip" | "run_once";
    }
  | {
      type: "event";
      event: RoutineEventTypeDto;
      match?: {
        field: string;
        from?: unknown;
        to?: unknown;
      } | null;
    };

export type RoutineActionDto =
  | { type: "run_agent"; executor: string }
  | {
      type: "update_properties";
      target: "trigger.entry";
      set: Record<string, unknown>;
    };

export interface RoutineDefinitionDto {
  name?: string | null;
  description?: string | null;
  enabled?: boolean | null;
  trigger: RoutineTriggerDto;
  action: RoutineActionDto;
  body: string;
}

export interface RoutineDiagnosticDto {
  code: string;
  message: string;
  field?: string | null;
  path?: string | null;
}

export interface RoutineNameConflictProjectionDto {
  conflictingPaths: string[];
}

export interface RoutineNameConflictEvidenceDto {
  routineId: string | null;
  name: string;
  filename: string;
  path: string;
}

export interface RoutineNameConflictDto {
  owner: {
    kind: RoutineResolvedOwnerKindDto;
    spaceId: string;
    ownerPath: string;
  };
  conflicts: RoutineNameConflictEvidenceDto[];
}

export interface RoutineRowDto {
  routineId: string | null;
  filename: string;
  path: string;
  name: string;
  nameConflict?: RoutineNameConflictProjectionDto | null;
  description: string | null;
  enabled: boolean | null;
  triggerType: RoutineTriggerTypeDto | null;
  triggerSummary: string | null;
  actionType: RoutineActionTypeDto | null;
  actionSummary: string | null;
  executor: string | null;
  lastRunAt: string | null;
  lastRunOrigin?: "local" | "remote" | null;
  nextRunAt: string | null;
  lastRun?: RoutineRunRefDto | null;
  fingerprint: string;
  executionFingerprint: string;
  definition: RoutineDefinitionDto | null;
  diagnostics: RoutineDiagnosticDto[];
}

export interface RoutineRunRefDto {
  routineRunId: string;
  launchId: string;
  agentSessionId: string;
  sourceSessionId?: string | null;
  ptyId?: string | null;
  active: boolean;
}

export interface RoutineCatalogSnapshotDto {
  owner: {
    kind: RoutineResolvedOwnerKindDto;
    spaceId: string;
    ownerPath: string;
  };
  routines: RoutineRowDto[];
  diagnostics: RoutineDiagnosticDto[];
  catalogFingerprint: string;
  refreshedAt: string;
}

export interface RoutineAutomaticConsentDto {
  enabled: boolean;
}

export interface RoutineInvalidatedEventDto {
  ownerKind: RoutineResolvedOwnerKindDto;
  ownerPath: string;
  projectPath: string;
  spacePath: string;
}

export type RoutineMutationResultDto =
  | {
      status: "applied";
      routineId: string;
      snapshot: RoutineCatalogSnapshotDto;
      changedPaths: string[];
      warnings: RoutineDiagnosticDto[];
    }
  | { status: "stale"; currentFingerprint?: string | null }
  | { status: "name_conflict"; conflict: RoutineNameConflictDto }
  | { status: "blocked"; message: string };

export type RoutineDispatchBlockedCodeDto =
  | "invalid_routine"
  | "non_manual_trigger"
  | "unsupported_action"
  | "missing_executor"
  | "missing_actor_id"
  | "ambiguous_actor_id"
  | "unavailable_executor"
  | "repository_access_denied";

export type RoutineManualDispatchResultDto =
  | {
      status: "started" | "focused";
      routineId: string;
      routineRunId: string;
      launchId: string;
      agentSessionId: string;
      sourceSessionId?: string | null;
      ptyId?: string | null;
    }
  | {
      status: "blocked";
      routineId: string;
      code: RoutineDispatchBlockedCodeDto;
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

interface RoutineOwnerCommandInput {
  projectPath: string;
  spacePath: string;
  spaceId: string;
  ownerPath: string;
  ownerKind: RoutineOwnerKindDto;
}

export function listRoutines(input: RoutineOwnerCommandInput) {
  return invokeCommand<RoutineCatalogSnapshotDto>("routines_list", {
    ...input,
  });
}

export function refreshRoutines(input: RoutineOwnerCommandInput) {
  return invokeCommand<RoutineCatalogSnapshotDto>("routines_refresh", {
    ...input,
  });
}

export function listenRoutinesInvalidated(
  handler: EventCallback<RoutineInvalidatedEventDto>,
): Promise<UnlistenFn> {
  return listen<RoutineInvalidatedEventDto>("routines:invalidated", handler);
}

export function createRoutine(
  input: RoutineOwnerCommandInput & {
    definition: RoutineDefinitionDto;
  },
) {
  return invokeCommand<RoutineMutationResultDto>("routines_create", {
    ...input,
  });
}

export function updateRoutine(
  input: RoutineOwnerCommandInput & {
    routineId: string;
    expectedFingerprint: string;
    definition: RoutineDefinitionDto;
    materializeFilename: boolean;
  },
) {
  return invokeCommand<RoutineMutationResultDto>("routines_update", {
    ...input,
  });
}

export function deleteRoutine(
  input: RoutineOwnerCommandInput & {
    routineId: string;
    expectedFingerprint: string;
  },
) {
  return invokeCommand<RoutineMutationResultDto>("routines_delete", {
    ...input,
  });
}

export function dispatchManualRoutine(
  input: RoutineOwnerCommandInput & { routineId: string },
) {
  return invokeCommand<RoutineManualDispatchResultDto>(
    "routines_dispatch_manual",
    { ...input },
  );
}

export function getRoutineAutomaticConsent(input: RoutineOwnerCommandInput) {
  return invokeCommand<RoutineAutomaticConsentDto>(
    "routines_get_automatic_consent",
    { ...input },
  );
}

export function setRoutineAutomaticConsent(
  input: RoutineOwnerCommandInput & { enabled: boolean },
) {
  return invokeCommand<RoutineAutomaticConsentDto>(
    "routines_set_automatic_consent",
    { ...input },
  );
}
