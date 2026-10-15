/** The id of a built-in agent of the registry. */
export type AgentId = string;

export interface AgentContextDiagnostic {
  adapterId: AgentId | null;
  code: string;
  message: string;
  path: string | null;
  severity: "warning" | "error";
}

export type AgentContextSourceHealth = "degraded" | "normal";

export type AgentContextItemKind = "instruction" | "skill";

export interface AgentContextReference {
  path: string;
  status:
    | "available"
    | "outside_boundary"
    | "requires_client_approval"
    | "unreadable";
}

/** Where an item lies, as a short path. */
export type AgentContextLocation =
  /** From the target root; `""` is the root itself. */
  | { kind: "target"; path: string }
  /** From `~`; `""` is the home directory itself. */
  | { kind: "home"; path: string }
  | { kind: "absolute"; path: string };

/** An agent that reads an item by one path. */
export interface AgentContextSourceReader {
  agent: AgentId;
  /** What shadows the item for this agent; `""` when not known. */
  supersededBy: string | null;
}

/** A path by which enabled agents find an item. */
export interface AgentContextItemSource {
  path: string;
  /** Where a link or alias leads; null for a direct path. */
  target: string | null;
  readers: readonly AgentContextSourceReader[];
}

/** Why no enabled agent applies an item. */
export type AgentContextUnapplied =
  /** No enabled agent finds it; `readers` read it by their policy. */
  | { kind: "not_found"; readers: readonly AgentId[] }
  /** Every enabled agent that finds it takes another file. */
  | { kind: "superseded"; by: readonly string[] };

/** A `metadata` value of `SKILL.md` as the scanner keeps it. */
export type AgentContextSkillMetadataLeaf =
  | { kind: "text"; text: string }
  | { kind: "list"; items: readonly string[] };

export type AgentContextSkillMetadataValue =
  | AgentContextSkillMetadataLeaf
  | {
      kind: "object";
      entries: readonly (readonly [string, AgentContextSkillMetadataLeaf])[];
    };

export interface AgentContextSkillFacts {
  /** The canonical skill folder. */
  directory: string;
  /** Whether the folder holds files Svode supports besides `SKILL.md`. */
  hasFiles: boolean;
  allowedTools: string | null;
  compatibility: string | null;
  license: string | null;
  metadata: Readonly<Record<string, AgentContextSkillMetadataValue>> | null;
}

/** One canonical source of the target's context: one row of "Context". */
export interface AgentContextItem {
  id: string;
  kind: AgentContextItemKind;
  name: string;
  description: string | null;
  /** The canonical file the item opens: the instruction or `SKILL.md`. */
  path: string;
  ownerPath: string;
  location: AgentContextLocation;
  modifiedAt: string | null;
  health: AgentContextSourceHealth;
  healthReasons: readonly string[];
  /** Enabled agents that apply the item. */
  providers: readonly AgentId[];
  /** Set when `providers` is empty. */
  unapplied: AgentContextUnapplied | null;
  sources: readonly AgentContextItemSource[];
  body: string;
  truncated: boolean;
  references: readonly AgentContextReference[];
  skill: AgentContextSkillFacts | null;
}

export interface AgentContextSnapshot {
  targetPath: string;
  generation: number;
  diagnostics: readonly AgentContextDiagnostic[];
  items: readonly AgentContextItem[];
  /** Agents enabled in Providers; without any, only project items show. */
  enabledAgents: readonly AgentId[];
  hasPersonalSources: boolean;
}

/** A supported file of a skill folder, or a folder holding one. */
export interface AgentContextSkillFile {
  /** The path inside the skill folder, `/`-separated. */
  path: string;
  canonicalPath: string;
  name: string;
  kind: "directory" | "markdown" | "document" | "media";
  format: string;
  availability: "available" | "limited" | "external_only";
  modifiedAt: string | null;
  sizeBytes: number | null;
}
