import { invokeCommand } from "@/platform/native/invoke";
import {
  listen,
  type EventCallback,
  type UnlistenFn,
} from "@/platform/native/events";

/** An agent id from the registry; a catalog may hold one this build does not know. */
export type AgentAdapterIdDto = string;

/** A value of one setting as the agent names the setting and the value. */
export interface AgentActorSettingValueDto {
  setting: string;
  value: string;
}

/** The one binding of an Actor: a concrete agent or the participant's agent. */
export type AgentActorBindingDto =
  | { agent: AgentAdapterIdDto; settings: AgentActorSettingValueDto[] }
  | { participant: true };

/** The device mode of an Actor, kept with the agent it was chosen for. */
export interface AgentActorModeDto {
  agent: AgentAdapterIdDto;
  setting: string;
  value: string;
}

export interface AgentActorDto {
  id: string;
  name: string;
  description?: string | null;
  binding: AgentActorBindingDto;
}

export interface AgentActorAgentLabelDto {
  id: AgentAdapterIdDto;
  displayName: string;
}

export interface AgentActorsReadResultDto {
  resolution: {
    actors: {
      actor: AgentActorDto;
      ownerPath: string;
      mode: AgentActorModeDto | null;
      /** The version a write of the Actor expects: its definition and mode. */
      version: string;
    }[];
    diagnostics: { ownerPath: string; code: string; message: string }[];
  };
  ownerFingerprints: Record<string, string>;
  bindableAgents: AgentActorAgentLabelDto[];
}

export interface AgentActorCatalogInvalidatedEventDto {
  ownerPath: string;
}

export interface AgentActorRoutineReferenceDto {
  routineId: string;
  path: string;
  title: string;
  ownerPath: string;
}

export interface AgentActorDeleteReferencePreviewDto {
  actorId: string;
  references: AgentActorRoutineReferenceDto[];
  diagnostics: {
    ownerPath: string;
    path?: string | null;
    code: string;
    message: string;
  }[];
}

export type AgentActorMutationInputDto =
  | {
      kind: "create" | "update";
      actor: AgentActorDto;
      mode: AgentActorModeDto | null;
    }
  | { kind: "delete"; actorId: string }
  /** The local-only change of an existing Actor's device mode. */
  | { kind: "set_mode"; actorId: string; mode: AgentActorModeDto | null };

export type AgentActorPersistenceOutcomeDto =
  | { status: "committed" | "clean" }
  | {
      status: "pending";
      reason:
        | "policy_off"
        | "target_dirty"
        | "index_staged"
        | "target_changed"
        | "index_interference";
    }
  | { status: "failed"; message: string };

export type AgentActorMutationResultDto =
  | {
      status: "applied";
      /** The version of the Actor after the write; null once it is deleted. */
      version: string | null;
      persistence: AgentActorPersistenceOutcomeDto;
      rootPointer?: AgentActorPersistenceOutcomeDto | null;
    }
  /** The Actor changed since it was read: nothing was written. */
  | { status: "stale" }
  | { status: "blocked"; message: string };

export interface AgentActorCatalogSaveReviewDto {
  ownerPath: string;
  repositoryId: string;
  catalogFingerprint: string;
  targetStateFingerprint: string;
  rootPointerFingerprint?: string | null;
}

export type AgentActorCatalogSaveReviewResultDto =
  | { status: "clean" }
  | {
      status: "ready";
      review: AgentActorCatalogSaveReviewDto;
      requiresConsent: boolean;
    }
  | { status: "blocked"; message: string };

export type AgentActorCatalogSaveResultDto =
  | {
      status: "saved";
      catalog: AgentActorPersistenceOutcomeDto;
      rootPointer?: AgentActorPersistenceOutcomeDto | null;
    }
  | { status: "stale" }
  | { status: "blocked"; message: string };

export function getAgentActors(projectPath: string, spacePath: string) {
  return invokeCommand<AgentActorsReadResultDto>("agent_actors_get", {
    projectPath,
    spacePath,
    standalone: false,
  });
}

export function listenAgentActorCatalogInvalidated(
  handler: EventCallback<AgentActorCatalogInvalidatedEventDto>,
): Promise<UnlistenFn> {
  return listen<AgentActorCatalogInvalidatedEventDto>(
    "agent-actors:invalidated",
    handler,
  );
}

export function generateAgentActorId() {
  return invokeCommand<string>("agent_actors_generate_id");
}

export function previewAgentActorDeleteReferences(
  projectPath: string,
  ownerPath: string,
  actorId: string,
) {
  return invokeCommand<AgentActorDeleteReferencePreviewDto>(
    "agent_actors_preview_delete_references",
    { actorId, ownerPath, projectPath },
  );
}

/**
 * One write of one Actor, applied while the Actor is at `expectedVersion`,
 * the version it was read at (null for a new Actor), whatever else changed
 * in its catalog.
 */
export function mutateAgentActor(
  projectPath: string,
  ownerPath: string,
  expectedVersion: string | null,
  mutation: AgentActorMutationInputDto,
) {
  return invokeCommand<AgentActorMutationResultDto>("agent_actors_mutate", {
    expectedVersion,
    mutation,
    ownerPath,
    projectPath,
  });
}

export function getAgentActorCatalogSaveReview(
  projectPath: string,
  ownerPath: string,
) {
  return invokeCommand<AgentActorCatalogSaveReviewResultDto>(
    "agent_actors_get_catalog_save_review",
    { ownerPath, projectPath },
  );
}

export function saveAgentActorCatalog(
  projectPath: string,
  ownerPath: string,
  review: AgentActorCatalogSaveReviewDto,
) {
  return invokeCommand<AgentActorCatalogSaveResultDto>(
    "agent_actors_save_catalog",
    { ownerPath, projectPath, review },
  );
}
