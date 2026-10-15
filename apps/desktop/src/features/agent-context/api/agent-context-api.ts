import {
  getAgentContext,
  listAgentContextSkillFiles,
  listenAgentContextChanged,
  readAgentContextSkillFile,
  refreshAgentContext,
  type AgentContextItemDto,
  type AgentContextReferenceDto,
  type AgentContextSkillMetadataLeafDto,
  type AgentContextSkillMetadataValueDto,
  type AgentContextSnapshotDto,
} from "@/platform/agent-context/agent-context-api";
import { listenAgentsEnabledChanged } from "@/platform/agent-setup/agent-setup-api";
import {
  listArtifactApps,
  openArtifactInApp,
  openArtifactInTool,
  type ArtifactOpenTarget,
} from "@/platform/project-openers";
import {
  filePreferenceKey,
  type ExternalOpenTarget,
} from "@/features/external-open";

export type { ArtifactOpenTarget };

import type {
  AgentContextItem,
  AgentContextReference,
  AgentContextSkillMetadataLeaf,
  AgentContextSkillFile,
  AgentContextSkillMetadataValue,
  AgentContextSnapshot,
} from "../model/types";

export async function loadAgentContext(
  projectPath: string,
  spacePath: string,
): Promise<AgentContextSnapshot> {
  return toAgentContextSnapshot(await getAgentContext(projectPath, spacePath));
}

export async function refreshAgentContextSnapshot(
  projectPath: string,
  spacePath: string,
): Promise<AgentContextSnapshot> {
  return toAgentContextSnapshot(
    await refreshAgentContext(projectPath, spacePath),
  );
}

export function listenAgentContextInvalidation(
  handler: (payload: { spacePath: string; paths: readonly string[] }) => void,
) {
  return listenAgentContextChanged((event) => handler(event.payload));
}

/** Enabling or disabling an agent changes which sources every target reads. */
export function listenAgentContextEnabledAgentsChanged(handler: () => void) {
  return listenAgentsEnabledChanged(handler);
}

/** The files directly inside `branch` of a skill folder; `""` is the folder. */
export async function loadAgentContextSkillFiles(
  itemId: string,
  branch: string,
): Promise<readonly AgentContextSkillFile[]> {
  const listed = await listAgentContextSkillFiles(itemId, branch);
  return listed.files.map((file) => Object.freeze({ ...file }));
}

/** The text of a Markdown file of a skill, bounded like a skill's body. */
export async function loadAgentContextSkillMarkdown(
  itemId: string,
  path: string,
): Promise<{ markdown: string; truncated: boolean }> {
  const preview = await readAgentContextSkillFile(itemId, path);
  return { markdown: preview.markdown, truncated: preview.truncated };
}

/** External open of an instruction or skill file, re-validated inside its owner root. */
export function agentContextArtifactExternalOpenTarget(
  target: ArtifactOpenTarget,
): ExternalOpenTarget {
  return {
    preferenceKey: filePreferenceKey(target.canonicalArtifactPath),
    listApps: () => listArtifactApps(target),
    open: (appId) => openArtifactInApp(target, appId),
    reveal: () => openArtifactInTool(target, "file_manager"),
  };
}

export function toAgentContextSnapshot(
  dto: AgentContextSnapshotDto,
): AgentContextSnapshot {
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
    enabledAgents: Object.freeze([...dto.enabledAgents]),
    generation: dto.generation,
    hasPersonalSources: dto.observedPersonalPaths.length > 0,
    items: Object.freeze(dto.items.map(normalizeItem)),
    targetPath: dto.targetRoot,
  });
}

function normalizeItem(item: AgentContextItemDto): AgentContextItem {
  return Object.freeze({
    body: item.preview.markdown,
    description: item.description,
    health: item.health,
    healthReasons: Object.freeze([...item.healthReasons]),
    id: item.id,
    kind: item.kind,
    location: Object.freeze({ ...item.location }),
    modifiedAt: item.modifiedAt,
    name: item.name,
    ownerPath: item.ownerRoot,
    path: item.path,
    providers: Object.freeze([...item.providers]),
    references: Object.freeze(
      item.references.map((reference) =>
        Object.freeze({
          path: reference.path,
          status: referenceStatus(reference),
        }),
      ),
    ),
    skill: item.skill
      ? Object.freeze({
          directory: item.skill.directory,
          hasFiles: item.skill.hasFiles,
          allowedTools: item.skill.allowedTools,
          compatibility: item.skill.compatibility,
          license: item.skill.license,
          metadata: item.skill.metadata
            ? Object.freeze(
                Object.fromEntries(
                  Object.entries(item.skill.metadata).map(([key, value]) => [
                    key,
                    skillMetadataValue(value),
                  ]),
                ),
              )
            : null,
        })
      : null,
    sources: Object.freeze(
      item.sources.map((source) =>
        Object.freeze({
          path: source.path,
          readers: Object.freeze(
            source.readers.map((reader) =>
              Object.freeze({
                agent: reader.agent,
                supersededBy: reader.supersededBy,
              }),
            ),
          ),
          target: source.target,
        }),
      ),
    ),
    truncated: item.preview.truncated,
    unapplied: item.unapplied
      ? Object.freeze(
          item.unapplied.kind === "not_found"
            ? {
                kind: "not_found" as const,
                readers: Object.freeze([...item.unapplied.readers]),
              }
            : {
                by: Object.freeze([...item.unapplied.by]),
                kind: "superseded" as const,
              },
        )
      : null,
  });
}

function skillMetadataValue(
  value: AgentContextSkillMetadataValueDto,
): AgentContextSkillMetadataValue {
  if (value.kind !== "object") return skillMetadataLeaf(value);
  return Object.freeze({
    entries: Object.freeze(
      Object.entries(value.value).map(([key, leaf]) =>
        Object.freeze([key, skillMetadataLeaf(leaf)] as const),
      ),
    ),
    kind: "object",
  });
}

function skillMetadataLeaf(
  leaf: AgentContextSkillMetadataLeafDto,
): AgentContextSkillMetadataLeaf {
  return leaf.kind === "text"
    ? Object.freeze({ kind: "text", text: leaf.value })
    : Object.freeze({ items: Object.freeze([...leaf.value]), kind: "list" });
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
