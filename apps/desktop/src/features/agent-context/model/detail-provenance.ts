import { skillSourceFamilies, skillSourceLocations } from "./provenance";
import type {
  AgentContextInstructionRole,
  AgentContextInstructionRow,
  AgentContextLinkKind,
  AgentContextReference,
  AgentContextSkillRow,
  AgentContextSourceFamily,
  AgentContextSourceLocation,
  AgentContextSourceResolution,
  AgentContextSourceSupport,
} from "./types";

export interface AgentContextDetailSource {
  linkKind: AgentContextLinkKind;
  location: AgentContextSourceLocation;
  path: string;
  precedence: number | null;
  resolution: AgentContextSourceResolution;
  role: AgentContextInstructionRole | null;
  sourceFamily: AgentContextSourceFamily | null;
  support: AgentContextSourceSupport;
}

export interface AgentContextDetailProvenance {
  artifactId: string;
  canonicalOwnerPath: string;
  canonicalSourcePath: string;
  contentTruncated: boolean;
  diagnostics: readonly string[];
  isSingleDirectSource: boolean;
  kind: "instruction" | "skill";
  references: readonly AgentContextReference[];
  sourceFamilies: readonly AgentContextSourceFamily[];
  sourceLocations: readonly AgentContextSourceLocation[];
  sources: readonly AgentContextDetailSource[];
}

export function instructionDetailProvenance(
  row: AgentContextInstructionRow,
): AgentContextDetailProvenance {
  const source: AgentContextDetailSource = {
    linkKind: row.linkKind,
    location: row.location,
    path: row.discoveryPath,
    precedence: row.precedence,
    resolution: row.resolution,
    role: row.role,
    sourceFamily: null,
    support: row.support,
  };

  return Object.freeze({
    artifactId: row.id,
    canonicalOwnerPath: row.ownerPath,
    canonicalSourcePath: row.canonicalPath,
    contentTruncated: row.truncated,
    diagnostics: uniqueStrings(row.healthReasons),
    isSingleDirectSource:
      source.linkKind === "direct" && source.path === row.canonicalPath,
    kind: "instruction",
    references: uniqueReferences(row.references),
    sourceFamilies: Object.freeze([]),
    sourceLocations: Object.freeze([row.location]),
    sources: Object.freeze([Object.freeze(source)]),
  });
}

export function skillDetailProvenance(
  row: AgentContextSkillRow,
): AgentContextDetailProvenance {
  const sources = uniqueSkillSources(
    row.aliases.map((alias) => ({
      linkKind: alias.linkKind,
      location: alias.location,
      path: alias.discoveryPath,
      precedence: null,
      resolution: alias.resolution,
      role: null,
      sourceFamily: alias.sourceFamily,
      support: alias.support,
    })),
  );

  return Object.freeze({
    artifactId: row.id,
    canonicalOwnerPath: row.ownerPath,
    canonicalSourcePath: row.manifestPath,
    contentTruncated: row.truncated,
    diagnostics: uniqueStrings(row.healthReasons),
    isSingleDirectSource:
      sources.length === 1 &&
      sources[0]?.linkKind === "direct" &&
      sources[0]?.path === row.canonicalPath,
    kind: "skill",
    references: Object.freeze([]),
    sourceFamilies: Object.freeze([...skillSourceFamilies(row)]),
    sourceLocations: Object.freeze([...skillSourceLocations(row)]),
    sources,
  });
}

function uniqueSkillSources(
  sources: readonly AgentContextDetailSource[],
): readonly AgentContextDetailSource[] {
  const unique = new Map<string, AgentContextDetailSource>();
  for (const source of sources) {
    const identity = [
      source.sourceFamily,
      source.location,
      source.linkKind,
      source.support,
      source.resolution,
      source.path,
    ].join("\0");
    if (!unique.has(identity)) unique.set(identity, Object.freeze(source));
  }
  return Object.freeze([...unique.values()]);
}

function uniqueReferences(
  references: readonly AgentContextReference[],
): readonly AgentContextReference[] {
  const unique = new Map<string, AgentContextReference>();
  for (const reference of references) {
    const identity = `${reference.status}\0${reference.path}`;
    if (!unique.has(identity)) unique.set(identity, Object.freeze(reference));
  }
  return Object.freeze([...unique.values()]);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}
