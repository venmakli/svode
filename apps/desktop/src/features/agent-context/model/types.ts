export type SupportedAdapterId = "claude-code" | "codex";

export interface AgentContextDiagnostic {
  adapterId: SupportedAdapterId | null;
  code: string;
  message: string;
  path: string | null;
  severity: "warning" | "error";
}

export type AgentContextSourceSupport = "client_native" | "svode_recognized";

export type AgentContextSourceResolution =
  | "included"
  | "selected"
  | "superseded";

export type AgentContextSourceHealth = "degraded" | "normal";

export type AgentContextScope = "personal" | "project";

export type AgentContextInstructionRole =
  | "codex_user_precedence"
  | "codex_directory_precedence"
  | "claude_hierarchy"
  | "claude_import"
  | "target_root_recognition";

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
  support: AgentContextSourceSupport;
  resolution: AgentContextSourceResolution;
  health: AgentContextSourceHealth;
  healthReasons: readonly string[];
  ownerPath: string;
  canonicalPath: string;
  discoveryPath: string;
  linkTargetPath: string | null;
  precedence: number | null;
  body: string;
  truncated: boolean;
  references: readonly AgentContextReference[];
}

export type AgentContextSkillDiscoveryKind =
  | "codex_project"
  | "codex_standard_personal"
  | "claude_project"
  | "claude_personal";

export interface AgentContextSkillAlias {
  adapterId: SupportedAdapterId;
  support: AgentContextSourceSupport;
  resolution: AgentContextSourceResolution;
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
  health: AgentContextSourceHealth;
  healthReasons: readonly string[];
  id: string;
  license: string | null;
  manifestPath: string;
  name: string;
  ownerPath: string;
  scopes: readonly AgentContextScope[];
}

export interface AgentContextInstructionsSnapshot {
  targetPath: string;
  generation: number;
  diagnostics: readonly AgentContextDiagnostic[];
  rows: readonly AgentContextInstructionRow[];
  skills: readonly AgentContextSkillRow[];
  hasPersonalSources: boolean;
}
