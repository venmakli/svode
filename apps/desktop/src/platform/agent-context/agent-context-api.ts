import {
  listen,
  type EventCallback,
  type UnlistenFn,
} from "@/platform/native/events";
import { invokeCommand } from "@/platform/native/invoke";

export type SupportedAdapterIdDto = "claude-code" | "codex";
export type AgentContextSourceSupportDto =
  | "client_native"
  | "svode_recognized";
export type AgentContextSourceResolutionDto =
  | "included"
  | "selected"
  | "superseded";
export type AgentContextSourceHealthDto = "degraded" | "normal";

export interface AgentContextSourcePolicyDto {
  id: SupportedAdapterIdDto;
  displayName: string;
  personalRoot: string;
  capabilities: {
    instructions: {
      policy: "codex_agents" | "claude_memory";
    };
    skills: {
      policy: "codex_directory_chain" | "claude_personal_shadows_project";
      projectRelativeRoot: string;
      personalRoots: {
        kind: "standard_personal";
        path: string;
      }[];
    };
  };
}

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

export interface AgentContextInstructionRowDto {
  id: string;
  adapterId: SupportedAdapterIdDto | null;
  name: string;
  path: string;
  canonicalPath: string | null;
  owner: {
    kind: "target_space" | "client_configuration";
    root: string;
  };
  sourceKind: "personal" | "project" | "recognized";
  support: AgentContextSourceSupportDto;
  resolution: AgentContextSourceResolutionDto;
  health: AgentContextSourceHealthDto;
  healthReasons: string[];
  discovery: {
    policy:
      | "codex_user_precedence"
      | "codex_directory_precedence"
      | "claude_hierarchy"
      | "claude_import"
      | "target_root_recognition";
    directoryDepth: number;
    precedence: number;
  };
  preview: AgentContextMarkdownPreviewDto | null;
  references: AgentContextReferenceDto[];
}

export interface AgentContextDiagnosticDto {
  code: string;
  severity: "warning" | "error";
  message: string;
  path: string | null;
  adapterId: SupportedAdapterIdDto | null;
}

export interface AgentContextSkillAliasDto {
  adapterId: SupportedAdapterIdDto;
  scope: "personal" | "project";
  discoveryKind:
    | "codex_project"
    | "codex_standard_personal"
    | "claude_project"
    | "claude_personal";
  path: string;
  root: string;
  owner: {
    kind: "target_space" | "client_configuration";
    root: string;
  };
  support: AgentContextSourceSupportDto;
  resolution: AgentContextSourceResolutionDto;
  linkKind: "direct" | "symbolic_link" | "directory_alias";
}

export interface AgentContextSkillRowDto {
  id: string;
  name: string;
  description: string;
  path: string;
  canonicalPath: string;
  owner: {
    kind: "target_space" | "client_configuration";
    root: string;
  };
  license: string | null;
  compatibility: string | null;
  metadata: unknown | null;
  validation: "valid" | "warning";
  health: AgentContextSourceHealthDto;
  healthReasons: string[];
  warnings: string[];
  preview: AgentContextMarkdownPreviewDto;
  aliases: AgentContextSkillAliasDto[];
}

export interface AgentContextInstructionsSnapshotDto {
  generation: number;
  projectRoot: string;
  targetRoot: string;
  repositoryRoot: string;
  adapters: AgentContextSourcePolicyDto[];
  instructions: AgentContextInstructionRowDto[];
  skills: AgentContextSkillRowDto[];
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

export function getAgentContextInstructions(
  projectPath: string,
  spacePath: string,
) {
  return invokeCommand<AgentContextInstructionsSnapshotDto>(
    "agent_context_get_instructions",
    { projectPath, spacePath } satisfies AgentContextTargetInput,
  );
}

export function refreshAgentContextInstructions(
  projectPath: string,
  spacePath: string,
) {
  return invokeCommand<AgentContextInstructionsSnapshotDto>(
    "agent_context_refresh_instructions",
    { projectPath, spacePath } satisfies AgentContextTargetInput,
  );
}

export function listenAgentContextChanged(
  handler: EventCallback<AgentContextChangedEventDto>,
): Promise<UnlistenFn> {
  return listen<AgentContextChangedEventDto>("agent-context:changed", handler);
}
