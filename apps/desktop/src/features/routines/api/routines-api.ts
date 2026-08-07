import {
  createRoutine as createRoutineCommand,
  deleteRoutine as deleteRoutineCommand,
  listRoutines as listRoutinesCommand,
  refreshRoutines as refreshRoutinesCommand,
  updateRoutine as updateRoutineCommand,
  type RoutineCatalogSnapshotDto,
  type RoutineDefinitionDto,
  type RoutineDiagnosticDto,
  type RoutineMutationResultDto,
} from "@/platform/routines/routines-api";

import type {
  RoutineCatalogSnapshot,
  RoutineCreateInput,
  RoutineDefinition,
  RoutineDiagnostic,
  RoutineMutationResult,
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

export async function createRoutine(
  owner: RoutineOwnerInput,
  input: RoutineCreateInput,
): Promise<RoutineMutationResult> {
  return normalizeMutationResult(
    await createRoutineCommand({
      ...owner,
      description: input.description.trim() || null,
      timezone: input.timezone,
      title: input.title,
      triggerType: input.triggerType,
    }),
  );
}

export async function updateRoutine(
  owner: RoutineOwnerInput,
  row: RoutineRow,
  definition: RoutineDefinition,
): Promise<RoutineMutationResult> {
  return normalizeMutationResult(
    await updateRoutineCommand({
      ...owner,
      definition: toDefinitionDto(definition),
      expectedFingerprint: row.fingerprint,
      routineId: row.id,
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
      routineId: row.id,
    }),
  );
}

function normalizeMutationResult(
  result: RoutineMutationResultDto,
): RoutineMutationResult {
  if (result.status === "blocked") return result;
  if (result.status === "stale") {
    return {
      currentFingerprint: result.currentFingerprint ?? null,
      status: "stale",
    };
  }
  return {
    routineId: result.routineId,
    snapshot: normalizeSnapshot(result.snapshot),
    status: "applied",
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
      ? normalizeDefinition(row.definition, row.title, row.description)
      : null,
    definitionPath: row.path,
    description: row.description?.trim() ?? "",
    diagnostics: Object.freeze(row.diagnostics.map(normalizeDiagnostic)),
    filename: row.filename,
    fingerprint: row.fingerprint,
    id: row.routineId,
    lastRunAt: row.lastRunAt,
    nextRunAt: row.nextRunAt,
    title: row.title,
    valid: row.definition !== null && row.diagnostics.length === 0,
  });
}

function normalizeDefinition(
  definition: RoutineDefinitionDto,
  fallbackTitle: string,
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
    title: definition.title ?? fallbackTitle,
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
    title: definition.title.trim() || null,
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
