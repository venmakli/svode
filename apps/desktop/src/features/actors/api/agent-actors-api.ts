import { lastAgentDeclarations } from "@/platform/agent-runtime/agent-runtime-api";
import { signInAgent } from "@/platform/agent-setup/agent-setup-api";
import {
  generateAgentActorId,
  getAgentActorCatalogSaveReview,
  getAgentActors,
  listenAgentActorCatalogInvalidated as listenAgentActorCatalogInvalidatedCommand,
  mutateAgentActor as mutateAgentActorCommand,
  previewAgentActorDeleteReferences as previewAgentActorDeleteReferencesCommand,
  saveAgentActorCatalog,
  type AgentActorBindingDto,
  type AgentActorCatalogSaveReviewDto,
  type AgentActorModeDto,
  type AgentActorMutationInputDto,
} from "@/platform/agent-actors/agent-actors-api";

import { actorOwnerLabel } from "../model/agent-actor-draft";
import {
  agentActorOptionCatalogDiagnostics,
  type AgentActorOptionCatalog,
} from "../model/agent-actor-reference";
import type {
  AgentActorBinding,
  AgentActorCatalogSnapshot,
  AgentActorMode,
  AgentActorMutationApplied,
  AgentAdapterId,
} from "../model/agent-actor-types";

export async function loadAgentActors(
  projectPath: string,
  launchSpacePath: string,
): Promise<AgentActorCatalogSnapshot> {
  const dto = await getAgentActors(projectPath, launchSpacePath);
  return Object.freeze({
    agents: Object.freeze(
      dto.bindableAgents.map((agent) =>
        Object.freeze({ id: agent.id, label: agent.displayName }),
      ),
    ),
    diagnostics: Object.freeze(
      dto.resolution.diagnostics.map((diagnostic) =>
        Object.freeze({ ...diagnostic }),
      ),
    ),
    fingerprints: Object.freeze({ ...dto.ownerFingerprints }),
    launchSpacePath,
    items: Object.freeze(
      dto.resolution.actors.map(({ actor, mode, ownerPath, version }) =>
        Object.freeze({
          actorRef: `agent:${actor.id}` as const,
          binding: normalizeBinding(actor.binding),
          description: actor.description?.trim() || null,
          id: actor.id,
          inherited: ownerPath !== launchSpacePath,
          mode: mode ? Object.freeze({ ...mode }) : null,
          name: actor.name,
          ownerLabel: actorOwnerLabel(ownerPath),
          ownerPath,
          version,
        }),
      ),
    ),
  });
}

export function listenAgentActorCatalogInvalidated(
  handler: (event: { ownerPath: string }) => void,
) {
  return listenAgentActorCatalogInvalidatedCommand((event) =>
    handler(event.payload),
  );
}

export async function loadAgentActorOptions(
  projectPath: string,
  launchSpacePath: string,
): Promise<AgentActorOptionCatalog> {
  const snapshot = await loadAgentActors(projectPath, launchSpacePath);
  return Object.freeze({
    ...agentActorOptionCatalogDiagnostics(snapshot.diagnostics),
    options: Object.freeze(
      snapshot.items.map((item) =>
        Object.freeze({
          description: item.description,
          label: item.name,
          ownerLabel: item.ownerLabel,
          value: item.actorRef,
        }),
      ),
    ),
  });
}

/** Opens the terminal of the agent's own sign-in command; resolves to its id. */
export async function signInBindingAgent(agent: AgentAdapterId) {
  return (await signInAgent(agent)).ptyId;
}

/** What `agent` declared last on this device, per model; none when unreadable. */
export function loadAgentDeclarations(agent: AgentAdapterId) {
  return lastAgentDeclarations(agent).catch(() => []);
}

export async function createAgentActorId(): Promise<string> {
  return generateAgentActorId();
}

export async function previewAgentActorDeleteReferences(
  projectPath: string,
  ownerPath: string,
  actorId: string,
) {
  const preview = await previewAgentActorDeleteReferencesCommand(
    projectPath,
    ownerPath,
    actorId,
  );
  return Object.freeze({
    actorId: preview.actorId,
    diagnostics: Object.freeze(
      preview.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })),
    ),
    references: Object.freeze(
      preview.references.map((reference) => Object.freeze({ ...reference })),
    ),
  });
}

/**
 * One write of one Agent, applied while the Agent is at `expectedVersion`
 * (null for a new Agent), whatever else changed in its catalog.
 */
export async function mutateAgentActor(input: {
  expectedVersion: string | null;
  mutation: AgentActorMutationInputDto;
  ownerPath: string;
  projectPath: string;
}): Promise<AgentActorMutationApplied | "stale" | { blocked: string }> {
  const result = await mutateAgentActorCommand(
    input.projectPath,
    input.ownerPath,
    input.expectedVersion,
    input.mutation,
  );
  if (result.status === "stale") return "stale";
  if (result.status === "blocked") return { blocked: result.message };
  return Object.freeze({
    version: result.version,
    persistence: Object.freeze({ ...result.persistence }),
    rootPointer: result.rootPointer
      ? Object.freeze({ ...result.rootPointer })
      : null,
  });
}

export { getAgentActorCatalogSaveReview, saveAgentActorCatalog };
export type { AgentActorCatalogSaveReviewDto };

export function toAgentActorMutationActor(input: {
  binding: AgentActorBinding;
  description: string | null;
  id: string;
  name: string;
}) {
  return {
    binding: toBindingDto(input.binding),
    description: input.description?.trim() || null,
    id: input.id,
    name: input.name.trim(),
  };
}

export function toAgentActorModeDto(
  mode: AgentActorMode | null,
): AgentActorModeDto | null {
  return mode ? { ...mode } : null;
}

function normalizeBinding(binding: AgentActorBindingDto): AgentActorBinding {
  if ("participant" in binding) return Object.freeze({ kind: "participant" });
  return Object.freeze({
    agent: binding.agent,
    kind: "agent",
    settings: Object.freeze(
      binding.settings.map((value) => Object.freeze({ ...value })),
    ),
  });
}

function toBindingDto(binding: AgentActorBinding): AgentActorBindingDto {
  if (binding.kind === "participant") return { participant: true };
  return {
    agent: binding.agent,
    settings: binding.settings.map((value) => ({ ...value })),
  };
}
