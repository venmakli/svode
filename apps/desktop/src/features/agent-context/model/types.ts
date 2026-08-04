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
    skillsDiscovery: boolean;
    launch: false;
    modelSelection: false;
    permissions: false;
  };
}

export interface AgentContextReference {
  path: string;
  status:
    | "available"
    | "outside_boundary"
    | "requires_client_approval"
    | "unreadable";
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

export type AgentContextSkillAvailability = Exclude<
  AgentContextAvailability,
  "recognized_only"
>;

export type AgentContextSkillDiscoveryKind =
  | "codex_project"
  | "codex_standard_personal"
  | "codex_compatibility_personal"
  | "claude_project"
  | "claude_personal";

export interface AgentContextSkillAlias {
  adapterId: SupportedAdapterId;
  availability: AgentContextSkillAvailability;
  availabilityReason: string | null;
  discoveryKind: AgentContextSkillDiscoveryKind;
  discoveryPath: string;
  linkKind: "direct" | "symbolic_link" | "directory_alias";
  ownerPath: string;
  rootPath: string;
  scope: AgentContextScope;
}

export interface AgentContextSkillRow {
  aliases: readonly AgentContextSkillAlias[];
  body: string;
  canonicalPath: string;
  clients: readonly SupportedAdapterId[];
  compatibility: string | null;
  description: string;
  diagnostics: readonly string[];
  id: string;
  license: string | null;
  manifestPath: string;
  name: string;
  ownerPath: string;
  scopes: readonly AgentContextScope[];
  validation: "valid" | "warning";
  warnings: readonly string[];
}

export interface AgentContextInstructionsSnapshot {
  targetPath: string;
  generation: number;
  adapters: readonly AgentContextAdapterSnapshot[];
  instructionDiagnostics: readonly string[];
  rows: readonly AgentContextInstructionRow[];
  skillDiagnostics: readonly string[];
  skills: readonly AgentContextSkillRow[];
  hasPersonalSources: boolean;
}
