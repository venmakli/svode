import {
  diagnoseAgentActorAdapter as diagnoseAgentActorAdapterCommand,
  generateAgentActorId,
  getAgentActorCatalogSaveReview,
  getAgentActors,
  inspectAgentActorBinding as inspectAgentActorBindingCommand,
  mutateAgentActor as mutateAgentActorCommand,
  previewAgentActorDeleteReferences as previewAgentActorDeleteReferencesCommand,
  saveAgentActorCatalog,
  type AgentActorBindingDto,
  type AgentActorCatalogSaveReviewDto,
  type AgentActorMutationInputDto,
} from "@/platform/agent-actors/agent-actors-api";

import { actorOwnerLabel } from "../model/agent-actor-draft";
import type {
  AgentActorAdapterDiagnostic,
  AgentActorBinding,
  AgentActorBindingRuntime,
  AgentActorCatalogSnapshot,
  AgentActorMutationApplied,
} from "../model/agent-actor-types";

export interface AgentActorOption {
  description: string | null;
  label: string;
  ownerLabel: string;
  value: `agent:${string}`;
}

export async function loadAgentActors(
  projectPath: string,
  launchSpacePath: string,
): Promise<AgentActorCatalogSnapshot> {
  const dto = await getAgentActors(projectPath, launchSpacePath);
  const runtimeByRow: Record<string, AgentActorBindingRuntime[]> = {};
  for (const runtime of dto.bindings) {
    const key = runtimeKey(runtime.ownerPath, runtime.actorId);
    const values = runtimeByRow[key] ?? [];
    values[runtime.bindingIndex] = Object.freeze({
      approval: Object.freeze({ ...runtime.approval }),
      effortOptions: Object.freeze(
        runtime.effortOptions.map((option) => Object.freeze({ ...option })),
      ),
      validation: Object.freeze({
        ...runtime.validation,
        issues: Object.freeze(
          runtime.validation.issues.map((issue) => Object.freeze({ ...issue })),
        ),
      }),
    });
    runtimeByRow[key] = values;
  }

  return Object.freeze({
    adapterDescriptors: Object.freeze(
      dto.adapterDescriptors.map((descriptor) =>
        Object.freeze({
          ...descriptor,
          modelOptions: Object.freeze(
            descriptor.modelOptions.map((option) =>
              Object.freeze({ ...option }),
            ),
          ),
        }),
      ),
    ),
    bindingRuntime: Object.freeze(
      Object.fromEntries(
        Object.entries(runtimeByRow).map(([key, values]) => [
          key,
          Object.freeze(values),
        ]),
      ),
    ),
    diagnostics: Object.freeze(
      dto.resolution.diagnostics.map((diagnostic) =>
        Object.freeze({ ...diagnostic }),
      ),
    ),
    fingerprints: Object.freeze({ ...dto.ownerFingerprints }),
    launchSpacePath,
    rows: Object.freeze(
      dto.resolution.actors.map(({ actor, approvalMode, ownerPath }) =>
        Object.freeze({
          actorRef: `agent:${actor.id}` as const,
          adapters: Object.freeze(
            actor.adapters.map((binding) => normalizeBinding(binding)),
          ),
          approvalMode,
          description: actor.description?.trim() || null,
          id: actor.id,
          inherited: ownerPath !== launchSpacePath,
          name: actor.name,
          ownerLabel: actorOwnerLabel(ownerPath),
          ownerPath,
          runtimeStatus: "unchecked" as const,
        }),
      ),
    ),
  });
}

export async function listAgentActorOptions(
  projectPath: string,
  launchSpacePath: string,
): Promise<readonly AgentActorOption[]> {
  const snapshot = await loadAgentActors(projectPath, launchSpacePath);
  return Object.freeze(
    snapshot.rows.map((row) =>
      Object.freeze({
        description: row.description,
        label: row.name,
        ownerLabel: row.ownerLabel,
        value: row.actorRef,
      }),
    ),
  );
}

export function diagnoseAgentActorAdapter(
  launchSpacePath: string,
  adapter: AgentActorBinding["adapter"],
): Promise<AgentActorAdapterDiagnostic> {
  return diagnoseAgentActorAdapterCommand(launchSpacePath, adapter);
}

export async function inspectAgentActorBinding(
  binding: AgentActorBinding,
  approvalMode: AgentActorCatalogSnapshot["rows"][number]["approvalMode"],
): Promise<AgentActorBindingRuntime> {
  const result = await inspectAgentActorBindingCommand(
    toBindingDto(binding),
    approvalMode,
  );
  return Object.freeze({
    approval: Object.freeze({ ...result.approval }),
    effortOptions: Object.freeze(
      result.effortOptions.map((option) => Object.freeze({ ...option })),
    ),
    validation: Object.freeze({
      ...result.validation,
      issues: Object.freeze(
        result.validation.issues.map((issue) => Object.freeze({ ...issue })),
      ),
    }),
  });
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

export async function mutateAgentActor(input: {
  expectedFingerprint: string;
  mutation: AgentActorMutationInputDto;
  ownerPath: string;
  projectPath: string;
}): Promise<AgentActorMutationApplied | "stale" | { blocked: string }> {
  const result = await mutateAgentActorCommand(
    input.projectPath,
    input.ownerPath,
    input.expectedFingerprint,
    input.mutation,
  );
  if (result.status === "stale") return "stale";
  if (result.status === "blocked") return { blocked: result.message };
  return Object.freeze({
    fingerprint: result.fingerprint,
    persistence: Object.freeze({ ...result.persistence }),
    rootPointer: result.rootPointer
      ? Object.freeze({ ...result.rootPointer })
      : null,
  });
}

export { getAgentActorCatalogSaveReview, saveAgentActorCatalog };
export type { AgentActorCatalogSaveReviewDto };

export function toAgentActorMutationActor(input: {
  adapters: readonly AgentActorBinding[];
  description: string;
  id: string;
  name: string;
}) {
  return {
    adapters: input.adapters.map(toBindingDto),
    description: input.description.trim() || null,
    id: input.id,
    name: input.name.trim(),
  };
}

export function runtimeKey(ownerPath: string, actorId: string): string {
  return JSON.stringify([ownerPath, actorId]);
}

function normalizeBinding(binding: AgentActorBindingDto): AgentActorBinding {
  return Object.freeze({
    adapter: binding.adapter,
    effort: binding.effort ?? null,
    model: binding.model ?? null,
  });
}

function toBindingDto(binding: AgentActorBinding): AgentActorBindingDto {
  return {
    adapter: binding.adapter,
    ...(binding.effort ? { effort: binding.effort } : {}),
    ...(binding.model ? { model: binding.model } : {}),
  };
}
