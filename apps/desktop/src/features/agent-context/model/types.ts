export type SupportedAdapterId = "claude-code" | "codex";

export type AgentContextAvailability =
  | "available"
  | "shadowed"
  | "recognized_only"
  | "compatibility_unknown";

export type AgentContextScope = "personal" | "project";

export type AgentContextInstructionRole =
  | "codex_user_precedence"
  | "codex_directory_precedence"
  | "claude_hierarchy"
  | "claude_import"
  | "target_root_recognition";

export interface AgentContextAdapterSnapshot {
  id: SupportedAdapterId;
  displayName: string;
  executable: string;
  version: string | null;
  installed: boolean;
  nativeDefaultTarget: string;
  capabilities: {
    contextDiscovery: boolean;
    launch: false;
    modelSelection: false;
    permissions: false;
  };
}

export interface AgentContextReference {
  path: string;
  status: "available" | "outside_boundary" | "requires_client_approval" | "unreadable";
}

export interface AgentContextInstructionRow {
  id: string;
  adapterId: SupportedAdapterId | null;
  role: AgentContextInstructionRole;
  filename: string;
  scope: AgentContextScope;
  availability: AgentContextAvailability;
  availabilityReason: string | null;
  ownerPath: string;
  canonicalPath: string;
  discoveryPath: string;
  linkTargetPath: string | null;
  precedence: number | null;
  body: string;
  truncated: boolean;
  references: readonly AgentContextReference[];
  diagnostics: readonly string[];
}

export interface AgentContextInstructionsSnapshot {
  targetPath: string;
  generation: number;
  adapters: readonly AgentContextAdapterSnapshot[];
  rows: readonly AgentContextInstructionRow[];
  diagnostics: readonly string[];
  hasPersonalSources: boolean;
}
