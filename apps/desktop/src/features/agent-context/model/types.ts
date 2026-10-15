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

export type AgentContextItemKind = "instruction" | "skill" | "plugin";

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
  /** The agent has the plugin installed but off. */
  disabled: boolean;
  /** The agent keeps whether the plugin is on outside the device's files. */
  unverified: boolean;
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
  | { kind: "superseded"; by: readonly string[] }
  /** The enabled agents that find the plugin have it off. */
  | { kind: "disabled" };

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

/** A kind of plugin component that is no row of the "Context". */
export type AgentContextPluginComponentKind =
  | "commands"
  | "subagents"
  | "hooks"
  | "rules"
  | "executables"
  | "lsp_servers"
  | "themes";

export interface AgentContextPluginManifest {
  /** The manifest's file name, such as `plugin.json`. */
  file: string;
  version: string | null;
  author: string | null;
  homepage: string | null;
  repository: string | null;
  license: string | null;
  keywords: readonly string[];
}

export interface AgentContextPluginFacts {
  directory: string;
  /** `code`: the plugin's code registers what it brings. */
  composition: "declared" | "code";
  manifest: AgentContextPluginManifest | null;
  counts: readonly {
    kind: AgentContextPluginComponentKind;
    count: number;
  }[];
  /** The item's body is the plugin's `README.md`. */
  hasReadme: boolean;
}

/** One canonical source of the target's context: one row of "Context". */
export interface AgentContextItem {
  id: string;
  kind: AgentContextItemKind;
  name: string;
  description: string | null;
  /** The file the item opens: the instruction, `SKILL.md` or the plugin's manifest. */
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
  plugin: AgentContextPluginFacts | null;
  /** A plugin's skills and instructions, with its providers and sources. */
  components: readonly AgentContextItem[];
  /** The image the source declares, as a data URI. */
  icon: string | null;
  /** A part of the Svode integration, which "Providers" manages. */
  managedBySvode: boolean;
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
