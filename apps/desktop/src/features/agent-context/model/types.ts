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

export type AgentContextSourceFamily = "agents" | "claude";

export type AgentContextSourceLocation = "global" | "space";

export type AgentContextLinkKind =
  | "direct"
  | "symbolic_link"
  | "directory_alias";

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
  location: AgentContextSourceLocation;
  linkKind: AgentContextLinkKind;
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
  sourceFamily: AgentContextSourceFamily;
  location: AgentContextSourceLocation;
  support: AgentContextSourceSupport;
  resolution: AgentContextSourceResolution;
  discoveryPath: string;
  linkKind: AgentContextLinkKind;
}

export interface AgentContextSkillRow {
  allowedTools: string | null;
  aliases: readonly AgentContextSkillAlias[];
  body: string;
  canonicalPath: string;
  compatibility: string | null;
  description: string;
  health: AgentContextSourceHealth;
  healthReasons: readonly string[];
  id: string;
  license: string | null;
  manifestPath: string;
  metadata: Readonly<Record<string, string>> | null;
  name: string;
  ownerPath: string;
  truncated: boolean;
}

export interface AgentContextInstructionsSnapshot {
  targetPath: string;
  generation: number;
  diagnostics: readonly AgentContextDiagnostic[];
  rows: readonly AgentContextInstructionRow[];
  skills: readonly AgentContextSkillRow[];
  hasPersonalSources: boolean;
}
