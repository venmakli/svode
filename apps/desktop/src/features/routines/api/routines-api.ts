import {
  acknowledgeRoutineStorageRecovery as acknowledgeRoutineStorageRecoveryCommand,
  createRoutine as createRoutineCommand,
  deleteRoutine as deleteRoutineCommand,
  dispatchManualRoutine as dispatchManualRoutineCommand,
  getRoutineAutomaticConsent as getRoutineAutomaticConsentCommand,
  listenRoutinesInvalidated as listenRoutinesInvalidatedCommand,
  listRoutines as listRoutinesCommand,
  refreshRoutines as refreshRoutinesCommand,
  resolveRoutineLaunches as resolveRoutineLaunchesCommand,
  setRoutineAutomaticConsent as setRoutineAutomaticConsentCommand,
  updateRoutine as updateRoutineCommand,
  type RoutineCatalogSnapshotDto,
  type RoutineDefinitionDto,
  type RoutineDiagnosticDto,
  type RoutineMutationResultDto,
  type RoutineInvalidatedEventDto,
  type RoutineLaunchRefusalDto,
} from "@/platform/routines/routines-api";

import type {
  RoutineCatalogSnapshot,
  RoutineDefinition,
  RoutineDiagnostic,
  RoutineNameConflict,
  RoutineMutationResult,
  RoutineManualDispatchResult,
  RoutineLaunchLink,
  RoutineLaunchRefusal,
  RoutineOwnerKind,
  RoutineItem,
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

export async function loadRoutineLaunchLinks(
  projectPath: string,
  launchIds: readonly string[],
  sessionIds: readonly string[],
): Promise<RoutineLaunchLink[]> {
  const links = await resolveRoutineLaunchesCommand({
    projectPath,
    launchIds,
    sessionIds,
  });
  return links.map(({ ownerKind, ...link }) => ({
    ...link,
    resolvedOwnerKind: ownerKind,
  }));
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
  item: RoutineItem,
  definition: RoutineDefinition,
  options: { materializeFilename: boolean },
): Promise<RoutineMutationResult> {
  return normalizeMutationResult(
    await updateRoutineCommand({
      ...owner,
      definition: toDefinitionDto(definition),
      expectedFingerprint: item.fingerprint,
      materializeFilename: options.materializeFilename,
      routineId: requireRoutineId(item),
    }),
  );
}

export async function deleteRoutine(
  owner: RoutineOwnerInput,
  item: RoutineItem,
): Promise<RoutineMutationResult> {
  return normalizeMutationResult(
    await deleteRoutineCommand({
      ...owner,
      expectedFingerprint: item.fingerprint,
      routineId: requireRoutineId(item),
    }),
  );
}

export async function dispatchManualRoutine(
  owner: RoutineOwnerInput,
  item: RoutineItem,
): Promise<RoutineManualDispatchResult> {
  const result = await dispatchManualRoutineCommand({
    ...owner,
    routineId: requireRoutineId(item),
  });
  if (result.status === "blocked" || result.status === "failed") {
    return { ...result, refusal: normalizeRefusal(result.refusal) };
  }
  return {
    ...result,
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
    items: Object.freeze(snapshot.routines.map(normalizeItem)),
    spaceId: snapshot.owner.spaceId,
  });
}

function normalizeItem(
  item: RoutineCatalogSnapshotDto["routines"][number],
): RoutineItem {
  return Object.freeze({
    definition: item.definition
      ? normalizeDefinition(item.definition, item.name, item.description)
      : null,
    definitionPath: item.path,
    description: item.description?.trim() ?? "",
    diagnostics: Object.freeze(item.diagnostics.map(normalizeDiagnostic)),
    filename: item.filename,
    fingerprint: item.fingerprint,
    id: item.routineId ?? `invalid:${item.path}`,
    lastRunAt: item.lastRunAt,
    lastRunOrigin: item.lastRunOrigin ?? null,
    lastRun: item.lastRun
      ? Object.freeze({
          ...item.lastRun,
          refusal: normalizeRefusal(item.lastRun.refusal),
          sourceSessionId: item.lastRun.sourceSessionId ?? null,
        })
      : null,
    nextRunAt: item.nextRunAt,
    name: item.name,
    nameConflict: item.nameConflict
      ? Object.freeze({
          conflictingPaths: Object.freeze([
            ...item.nameConflict.conflictingPaths,
          ]),
        })
      : null,
    routineId: item.routineId,
    valid:
      item.routineId !== null &&
      item.definition !== null &&
      item.diagnostics.length === 0,
  });
}

function normalizeRefusal(
  refusal: RoutineLaunchRefusalDto | null | undefined,
): RoutineLaunchRefusal | null {
  if (!refusal) return null;
  return Object.freeze({
    agent: refusal.agent ?? null,
    detail: refusal.detail ?? null,
    reason: refusal.reason,
    recovery: refusal.recovery,
    setting: refusal.setting ?? null,
    value: refusal.value ?? null,
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
        : definition.trigger.type === "schedule"
          ? Object.freeze({
              ...definition.trigger,
              timeBasis: Object.freeze({ ...definition.trigger.timeBasis }),
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
        : definition.trigger.type === "schedule"
          ? {
              ...definition.trigger,
              timeBasis: { ...definition.trigger.timeBasis },
            }
          : { ...definition.trigger },
  };
}

function requireRoutineId(item: RoutineItem) {
  if (!item.routineId) {
    throw new Error(
      "Invalid Routine definitions do not have an addressable id",
    );
  }
  return item.routineId;
}
