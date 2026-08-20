import {
  getAgentContextInstructions,
  refreshAgentContextInstructions,
  type AgentContextInstructionsSnapshotDto,
  type AgentContextReferenceDto,
  listenAgentContextChanged,
} from "@/platform/agent-context/agent-context-api";
import {
  listArtifactOpeners,
  openArtifactInTool,
  type ArtifactOpener,
  type ArtifactOpenTarget,
} from "@/platform/project-openers";

export type { ArtifactOpener, ArtifactOpenTarget };

import type {
  AgentContextInstructionsSnapshot,
  AgentContextReference,
  AgentContextSkillRow,
} from "../model/types";
import {
  sourceFamilyFromSkillDiscovery,
  sourceLocationFromScope,
} from "../model/provenance";

export async function loadAgentContextInstructions(
  projectPath: string,
  spacePath: string,
): Promise<AgentContextInstructionsSnapshot> {
  return toAgentContextInstructionsSnapshot(
    await getAgentContextInstructions(projectPath, spacePath),
  );
}

export async function refreshAgentContextInstructionsSnapshot(
  projectPath: string,
  spacePath: string,
): Promise<AgentContextInstructionsSnapshot> {
  return toAgentContextInstructionsSnapshot(
    await refreshAgentContextInstructions(projectPath, spacePath),
  );
}

export function listenAgentContextInvalidation(
  handler: (payload: { spacePath: string; paths: readonly string[] }) => void,
) {
  return listenAgentContextChanged((event) => handler(event.payload));
}

export function listAgentContextArtifactOpeners(): Promise<ArtifactOpener[]> {
  return listArtifactOpeners();
}

export function openAgentContextArtifact(
  target: ArtifactOpenTarget,
  tool: ArtifactOpener["id"],
): Promise<void> {
  return openArtifactInTool(target, tool);
}

export function toAgentContextInstructionsSnapshot(
  dto: AgentContextInstructionsSnapshotDto,
): AgentContextInstructionsSnapshot {
  return Object.freeze({
    diagnostics: Object.freeze(
      dto.diagnostics.map((diagnostic) =>
        Object.freeze({
          adapterId: diagnostic.adapterId,
          code: diagnostic.code,
          message: diagnostic.message,
          path: diagnostic.path,
          severity: diagnostic.severity,
        }),
      ),
    ),
    generation: dto.generation,
    hasPersonalSources: dto.observedPersonalPaths.length > 0,
    rows: Object.freeze(
      dto.instructions.map((row) =>
        Object.freeze({
          adapterId: row.adapterId,
          body: row.preview?.markdown ?? "",
          canonicalPath: row.canonicalPath ?? row.path,
          discoveryPath: row.path,
          filename: row.name,
          health: row.health,
          healthReasons: Object.freeze([...row.healthReasons]),
          id: row.id,
          linkKind: row.linkKind,
          linkTargetPath:
            row.canonicalPath && row.canonicalPath !== row.path
              ? row.canonicalPath
              : null,
          ownerPath: row.owner.root,
          precedence: row.discovery.precedence,
          references: Object.freeze(
            row.references.map((reference) =>
              Object.freeze({
                path: reference.path,
                status: referenceStatus(reference),
              }),
            ),
          ),
          role: row.discovery.policy,
          resolution: row.resolution,
          location: sourceLocationFromScope(
            row.sourceKind === "personal" ? "personal" : "project",
          ),
          support: row.support,
          truncated: row.preview?.truncated ?? false,
        }),
      ),
    ),
    skills: Object.freeze(dto.skills.map(normalizeSkillRow)),
    targetPath: dto.targetRoot,
  });
}

function normalizeSkillRow(
  row: AgentContextInstructionsSnapshotDto["skills"][number],
): AgentContextSkillRow {
  const aliases = Object.freeze(
    row.aliases.map((alias) =>
      Object.freeze({
        discoveryPath: alias.path,
        linkKind: alias.linkKind,
        location: sourceLocationFromScope(alias.scope),
        resolution: alias.resolution,
        sourceFamily: sourceFamilyFromSkillDiscovery(alias.discoveryKind),
        support: alias.support,
      }),
    ),
  );
  return Object.freeze({
    aliases,
    body: row.preview.markdown,
    canonicalPath: row.canonicalPath,
    compatibility: row.compatibility,
    description: row.description,
    health: row.health,
    healthReasons: Object.freeze([...row.healthReasons]),
    id: row.id,
    license: row.license,
    manifestPath: row.path,
    name: row.name,
    ownerPath: row.owner.root,
  });
}

function referenceStatus(
  reference: AgentContextReferenceDto,
): AgentContextReference["status"] {
  if (reference.status === "included") return "available";
  if (reference.status === "outside_boundary") return "outside_boundary";
  if (reference.status === "requires_client_approval") {
    return "requires_client_approval";
  }
  return "unreadable";
}
