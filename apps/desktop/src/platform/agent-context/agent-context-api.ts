import {
  listen,
  type EventCallback,
  type UnlistenFn,
} from "@/platform/native/events";
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

interface AgentContextMarkdownPreviewDto {
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

export interface AgentContextChangedEventDto {
  spacePath: string;
  paths: string[];
}

interface AgentContextTargetInput extends Record<string, unknown> {
  projectPath: string;
  spacePath: string;
}

export function getAgentContext(projectPath: string, spacePath: string) {
  return invokeCommand<AgentContextSnapshotDto>(
    "agent_context_get_items",
    { projectPath, spacePath } satisfies AgentContextTargetInput,
  );
}

export function refreshAgentContext(projectPath: string, spacePath: string) {
  return invokeCommand<AgentContextSnapshotDto>(
    "agent_context_refresh_items",
    { projectPath, spacePath } satisfies AgentContextTargetInput,
  );
}

export function listenAgentContextChanged(
  handler: EventCallback<AgentContextChangedEventDto>,
): Promise<UnlistenFn> {
  return listen<AgentContextChangedEventDto>("agent-context:changed", handler);
}
