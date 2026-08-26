import {
  acknowledgeRoutineStorageRecovery as acknowledgeRoutineStorageRecoveryCommand,
  createRoutine as createRoutineCommand,
  deleteRoutine as deleteRoutineCommand,
  dispatchManualRoutine as dispatchManualRoutineCommand,
  getRoutineAutomaticConsent as getRoutineAutomaticConsentCommand,
  listenRoutinesInvalidated as listenRoutinesInvalidatedCommand,
  listRoutines as listRoutinesCommand,
  refreshRoutines as refreshRoutinesCommand,
  setRoutineAutomaticConsent as setRoutineAutomaticConsentCommand,
  updateRoutine as updateRoutineCommand,
  type RoutineCatalogSnapshotDto,
  type RoutineDefinitionDto,
  type RoutineDiagnosticDto,
  type RoutineMutationResultDto,
  type RoutineInvalidatedEventDto,
} from "@/platform/routines/routines-api";

import type {
  RoutineCatalogSnapshot,
  RoutineDefinition,
  RoutineDiagnostic,
  RoutineNameConflict,
  RoutineMutationResult,
  RoutineManualDispatchResult,
  RoutineOwnerKind,
  RoutineRow,
} from "../model/types";

export interface RoutineOwnerInput {
  projectPath: string;
  spacePath: string;
  spaceId: string;
  ownerPath: string;
  ownerKind: RoutineOwnerKind;
}

export async function loadRoutineCatalog(
  owner: RoutineOwnerInput,
): Promise<RoutineCatalogSnapshot> {
  return normalizeSnapshot(await listRoutinesCommand(owner));
}

export async function refreshRoutineCatalog(
  owner: RoutineOwnerInput,
): Promise<RoutineCatalogSnapshot> {
  return normalizeSnapshot(await refreshRoutinesCommand(owner));
}

export function listenRoutineCatalogInvalidated(
  handler: (event: RoutineInvalidatedEventDto) => void,
) {
  return listenRoutinesInvalidatedCommand((event) => handler(event.payload));
}

export async function createRoutine(
  owner: RoutineOwnerInput,
  definition: RoutineDefinition,
): Promise<RoutineMutationResult> {
  return normalizeMutationResult(
    await createRoutineCommand({
      ...owner,
      definition: toDefinitionDto(definition),
    }),
  );
}

export async function updateRoutine(
  owner: RoutineOwnerInput,
  row: RoutineRow,
  definition: RoutineDefinition,
  options: { materializeFilename: boolean },
): Promise<RoutineMutationResult> {
  return normalizeMutationResult(
    await updateRoutineCommand({
      ...owner,
      definition: toDefinitionDto(definition),
      expectedFingerprint: row.fingerprint,
      materializeFilename: options.materializeFilename,
      routineId: requireRoutineId(row),
    }),
  );
}

export async function deleteRoutine(
  owner: RoutineOwnerInput,
  row: RoutineRow,
): Promise<RoutineMutationResult> {
  return normalizeMutationResult(
    await deleteRoutineCommand({
      ...owner,
      expectedFingerprint: row.fingerprint,
      routineId: requireRoutineId(row),
    }),
  );
}

export async function dispatchManualRoutine(
  owner: RoutineOwnerInput,
  row: RoutineRow,
): Promise<RoutineManualDispatchResult> {
  const result = await dispatchManualRoutineCommand({
    ...owner,
    routineId: requireRoutineId(row),
  });
  if (result.status === "blocked" || result.status === "failed") return result;
  return {
    ...result,
    ptyId: result.ptyId ?? null,
    sourceSessionId: result.sourceSessionId ?? null,
  };
}

export async function loadRoutineAutomaticConsent(owner: RoutineOwnerInput) {
  return getRoutineAutomaticConsentCommand(owner);
}

export async function updateRoutineAutomaticConsent(
  owner: RoutineOwnerInput,
  enabled: boolean,
) {
  return setRoutineAutomaticConsentCommand({ ...owner, enabled });
}

export async function acknowledgeRoutineStorageRecovery(
  owner: RoutineOwnerInput,
) {
  return acknowledgeRoutineStorageRecoveryCommand(owner.spacePath);
}

function normalizeMutationResult(
  result: RoutineMutationResultDto,
): RoutineMutationResult {
  if (result.status === "blocked") return result;
  if (result.status === "name_conflict") {
    return {
      conflict: normalizeNameConflict(result.conflict),
      status: "name_conflict",
    };
  }
  if (result.status === "stale") {
    return {
      currentFingerprint: result.currentFingerprint ?? null,
      status: "stale",
    };
  }
  return {
    changedPaths: Object.freeze([...result.changedPaths]),
    routineId: result.routineId,
    snapshot: normalizeSnapshot(result.snapshot),
    status: "applied",
    warnings: Object.freeze(result.warnings.map(normalizeDiagnostic)),
  };
}

function normalizeSnapshot(
  snapshot: RoutineCatalogSnapshotDto,
): RoutineCatalogSnapshot {
  return Object.freeze({
    catalogFingerprint: snapshot.catalogFingerprint,
    diagnostics: Object.freeze(snapshot.diagnostics.map(normalizeDiagnostic)),
    ownerPath: snapshot.owner.ownerPath,
    refreshedAt: snapshot.refreshedAt,
    resolvedOwnerKind: snapshot.owner.kind,
    rows: Object.freeze(snapshot.routines.map(normalizeRow)),
    spaceId: snapshot.owner.spaceId,
  });
}

function normalizeRow(
  row: RoutineCatalogSnapshotDto["routines"][number],
): RoutineRow {
  return Object.freeze({
    definition: row.definition
      ? normalizeDefinition(row.definition, row.name, row.description)
      : null,
    definitionPath: row.path,
    description: row.description?.trim() ?? "",
    diagnostics: Object.freeze(row.diagnostics.map(normalizeDiagnostic)),
    filename: row.filename,
    fingerprint: row.fingerprint,
    id: row.routineId ?? `invalid:${row.path}`,
    lastRunAt: row.lastRunAt,
    lastRunOrigin: row.lastRunOrigin ?? null,
    lastRun: row.lastRun
      ? Object.freeze({
          ...row.lastRun,
          ptyId: row.lastRun.ptyId ?? null,
          sourceSessionId: row.lastRun.sourceSessionId ?? null,
        })
      : null,
    nextRunAt: row.nextRunAt,
    name: row.name,
    nameConflict: row.nameConflict
      ? Object.freeze({
          conflictingPaths: Object.freeze([
            ...row.nameConflict.conflictingPaths,
          ]),
        })
      : null,
    routineId: row.routineId,
    valid:
      row.routineId !== null &&
      row.definition !== null &&
      row.diagnostics.length === 0,
  });
}

function normalizeNameConflict(
  conflict: Extract<
    RoutineMutationResultDto,
    { status: "name_conflict" }
  >["conflict"],
): RoutineNameConflict {
  return Object.freeze({
    conflicts: Object.freeze(
      conflict.conflicts.map((evidence) => Object.freeze({ ...evidence })),
    ),
    ownerPath: conflict.owner.ownerPath,
    resolvedOwnerKind: conflict.owner.kind,
    spaceId: conflict.owner.spaceId,
  });
}

function normalizeDefinition(
  definition: RoutineDefinitionDto,
  fallbackName: string,
  fallbackDescription: string | null,
): RoutineDefinition {
  return Object.freeze({
    action:
      definition.action.type === "update_properties"
        ? Object.freeze({
            ...definition.action,
            set: Object.freeze({ ...definition.action.set }),
          })
        : Object.freeze({ ...definition.action }),
    body: definition.body,
    description: definition.description ?? fallbackDescription ?? "",
    enabled:
      definition.trigger.type === "manual"
        ? null
        : (definition.enabled ?? false),
    name: definition.name ?? fallbackName,
    trigger:
      definition.trigger.type === "event"
        ? Object.freeze({
            ...definition.trigger,
            match: definition.trigger.match
              ? Object.freeze({ ...definition.trigger.match })
              : null,
          })
        : Object.freeze({ ...definition.trigger }),
  });
}

function normalizeDiagnostic(
  diagnostic: RoutineDiagnosticDto,
): RoutineDiagnostic {
  return Object.freeze({
    code: diagnostic.code,
    field: diagnostic.field ?? null,
    message: diagnostic.message,
    path: diagnostic.path ?? null,
  });
}

function toDefinitionDto(definition: RoutineDefinition): RoutineDefinitionDto {
  return {
    action:
      definition.action.type === "update_properties"
        ? { ...definition.action, set: { ...definition.action.set } }
        : { ...definition.action },
    body: definition.body,
    description: definition.description.trim() || null,
    enabled: definition.trigger.type === "manual" ? null : definition.enabled,
    name: definition.name.trim() || null,
    trigger:
      definition.trigger.type === "event"
        ? {
            ...definition.trigger,
            match: definition.trigger.match
              ? { ...definition.trigger.match }
              : null,
          }
        : { ...definition.trigger },
  };
}

function requireRoutineId(row: RoutineRow) {
  if (!row.routineId) {
    throw new Error(
      "Invalid Routine definitions do not have an addressable id",
    );
  }
  return row.routineId;
}
