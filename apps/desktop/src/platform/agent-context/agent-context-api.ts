import { listen, type EventCallback, type UnlistenFn } from "@/platform/native/events";
import { invokeCommand } from "@/platform/native/invoke";

export type SupportedAdapterIdDto = "claude-code" | "codex";
export type AgentContextAvailabilityDto =
  | "available"
  | "shadowed"
  | "recognized_only"
  | "compatibility_unknown";
export interface AgentContextAdapterSnapshotDto {
  id: SupportedAdapterIdDto;
  displayName: string;
  executable: {
    executable: string;
    path: string | null;
    version: string | null;
    diagnostic: string | null;
  };
  personalRoot: string;
  nativeDefault: {
    cwd: string;
    projectedContext: boolean;
    additionalRoots: boolean;
    hiddenLauncherConfig: boolean;
  };
  capabilities: {
    instructions: {
      availability: "available" | "unavailable";
      policy: "codex_agents" | "claude_memory";
    };
    launch: AgentContextUnavailableCapabilityDto;
    modelSelection: AgentContextUnavailableCapabilityDto;
    permissionModes: AgentContextUnavailableCapabilityDto;
  };
}

interface AgentContextUnavailableCapabilityDto {
  availability: "unavailable";
  reason: string;
}

export interface AgentContextReferenceDto {
  path: string;
  canonicalPath: string | null;
  depth: number;
  availability: AgentContextAvailabilityDto;
  reason: string | null;
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
  availability: AgentContextAvailabilityDto;
  reason: string | null;
  discovery: {
    policy:
      | "codex_user_precedence"
      | "codex_directory_precedence"
      | "claude_hierarchy"
      | "claude_import"
      | "target_root_recognition";
    directoryDepth: number;
    precedence: number;
    effective: boolean;
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

export interface AgentContextInstructionsSnapshotDto {
  generation: number;
  projectRoot: string;
  targetRoot: string;
  repositoryRoot: string;
  adapters: AgentContextAdapterSnapshotDto[];
  instructions: AgentContextInstructionRowDto[];
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
