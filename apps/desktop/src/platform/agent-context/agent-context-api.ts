import {
  listen,
  type EventCallback,
  type UnlistenFn,
} from "@/platform/native/events";
import type { DocumentSourceDescriptorDto } from "@/platform/document/document-api";
import type { MediaSourceSessionDto } from "@/platform/media/media-api";
import { invokeCommand } from "@/platform/native/invoke";

/** The id of a built-in agent of the registry. */
export type AgentIdDto = string;
export type AgentContextSourceHealthDto = "degraded" | "normal";
export type AgentContextLinkKindDto =
  | "direct"
  | "symbolic_link"
  | "directory_alias";

export interface AgentContextReferenceDto {
  path: string;
  canonicalPath: string | null;
  depth: number;
  status:
    | "cyclic"
    | "included"
    | "outside_boundary"
    | "requires_client_approval"
    | "unreadable";
  preview: AgentContextMarkdownPreviewDto | null;
}

export interface AgentContextMarkdownPreviewDto {
  markdown: string;
  truncated: boolean;
  bytesRead: number;
  totalBytes: number;
}

export interface AgentContextDiagnosticDto {
  code: string;
  severity: "warning" | "error";
  message: string;
  path: string | null;
  adapterId: AgentIdDto | null;
}

export type AgentContextSkillMetadataLeafDto =
  | { kind: "text"; value: string }
  | { kind: "list"; value: string[] };

export type AgentContextSkillMetadataValueDto =
  | AgentContextSkillMetadataLeafDto
  | { kind: "object"; value: Record<string, AgentContextSkillMetadataLeafDto> };

export interface AgentContextLocationDto {
  /** `target`: from the target root, `""` being the root itself; `home`: from `~`. */
  kind: "target" | "home" | "absolute";
  path: string;
}

export interface AgentContextItemSourceDto {
  path: string;
  target: string | null;
  linkKind: AgentContextLinkKindDto;
  readers: { agent: AgentIdDto; supersededBy: string | null }[];
}

export type AgentContextUnappliedDto =
  | { kind: "not_found"; readers: AgentIdDto[] }
  | { kind: "superseded"; by: string[] };

export interface AgentContextItemDto {
  id: string;
  kind: "instruction" | "skill";
  name: string;
  description: string | null;
  path: string;
  ownerRoot: string;
  location: AgentContextLocationDto;
  modifiedAt: string | null;
  health: AgentContextSourceHealthDto;
  healthReasons: string[];
  providers: AgentIdDto[];
  unapplied: AgentContextUnappliedDto | null;
  sources: AgentContextItemSourceDto[];
  preview: AgentContextMarkdownPreviewDto;
  references: AgentContextReferenceDto[];
  skill: {
    /** The canonical skill folder. */
    directory: string;
    /** Whether the folder holds files Svode supports besides `SKILL.md`. */
    hasFiles: boolean;
    license: string | null;
    compatibility: string | null;
    metadata: Record<string, AgentContextSkillMetadataValueDto> | null;
    allowedTools: string | null;
  } | null;
}

export interface AgentContextSnapshotDto {
  generation: number;
  projectRoot: string;
  targetRoot: string;
  repositoryRoot: string;
  enabledAgents: AgentIdDto[];
  items: AgentContextItemDto[];
  diagnostics: AgentContextDiagnosticDto[];
  observedProjectPaths: string[];
  observedPersonalPaths: string[];
}

/** A supported file of a skill folder, or a folder holding one. */
export interface AgentContextSkillFileDto {
  /** The path inside the skill folder, `/`-separated. */
  path: string;
  canonicalPath: string;
  name: string;
  kind: "directory" | "markdown" | "document" | "media";
  /** The lowercased extension; empty for a folder. */
  format: string;
  availability: "available" | "limited" | "external_only";
  modifiedAt: string | null;
  sizeBytes: number | null;
}

export interface AgentContextSkillFilesDto {
  path: string;
  files: AgentContextSkillFileDto[];
}

export interface AgentContextChangedEventDto {
  spacePath: string;
  paths: string[];
}

interface AgentContextTargetInput extends Record<string, unknown> {
  projectPath: string;
  spacePath: string;
}

export function getAgentContext(projectPath: string, spacePath: string) {
  return invokeCommand<AgentContextSnapshotDto>("agent_context_get_items", {
    projectPath,
    spacePath,
  } satisfies AgentContextTargetInput);
}

export function refreshAgentContext(projectPath: string, spacePath: string) {
  return invokeCommand<AgentContextSnapshotDto>("agent_context_refresh_items", {
    projectPath,
    spacePath,
  } satisfies AgentContextTargetInput);
}

/** The files directly inside `path` of a skill folder; `""` is the folder. */
export function listAgentContextSkillFiles(itemId: string, path: string) {
  return invokeCommand<AgentContextSkillFilesDto>(
    "agent_context_list_skill_files",
    { itemId, path },
  );
}

/** The text of a Markdown file of a skill. */
export function readAgentContextSkillFile(itemId: string, path: string) {
  return invokeCommand<AgentContextMarkdownPreviewDto>(
    "agent_context_read_skill_file",
    { itemId, path },
  );
}

/** A document of a skill folder, resolved inside it by Desktop. */
export function inspectAgentContextSkillDocument(itemId: string, path: string) {
  return invokeCommand<DocumentSourceDescriptorDto>(
    "agent_context_inspect_skill_document",
    { itemId, path },
  );
}

export async function readAgentContextSkillDocument(
  itemId: string,
  path: string,
  expectedGeneration: string,
): Promise<Uint8Array> {
  const response = await invokeCommand<ArrayBuffer | Uint8Array>(
    "agent_context_read_skill_document",
    { expectedGeneration, itemId, path },
  );
  return response instanceof Uint8Array ? response : new Uint8Array(response);
}

/** A media capability for a file of a skill folder, resolved inside it. */
export function createAgentContextSkillMediaSource(
  itemId: string,
  path: string,
) {
  return invokeCommand<MediaSourceSessionDto>(
    "agent_context_create_skill_media_source",
    { itemId, path },
  );
}

export function listenAgentContextChanged(
  handler: EventCallback<AgentContextChangedEventDto>,
): Promise<UnlistenFn> {
  return listen<AgentContextChangedEventDto>("agent-context:changed", handler);
}
