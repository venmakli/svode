import type {
  AgentContextSkillDiscoveryKind,
  AgentContextSkillRow,
  AgentContextSourceFamily,
  AgentContextSourceLocation,
} from "./types";

export function sourceFamilyFromSkillDiscovery(
  discoveryKind: AgentContextSkillDiscoveryKind,
): AgentContextSourceFamily {
  return discoveryKind === "codex_project" ||
    discoveryKind === "codex_standard_personal"
    ? "agents"
    : "claude";
}

export function sourceLocationFromScope(
  scope: "personal" | "project",
): AgentContextSourceLocation {
  return scope === "personal" ? "global" : "space";
}

export function skillSourceFamilies(
  row: AgentContextSkillRow,
): readonly AgentContextSourceFamily[] {
  return orderedUnique(
    row.aliases.map((alias) => alias.sourceFamily),
    ["agents", "claude"],
  );
}

export function skillSourceLocations(
  row: AgentContextSkillRow,
): readonly AgentContextSourceLocation[] {
  return orderedUnique(
    row.aliases.map((alias) => alias.location),
    ["space", "global"],
  );
}

function orderedUnique<Value extends string>(
  values: readonly Value[],
  order: readonly Value[],
): readonly Value[] {
  const unique = new Set(values);
  return order.filter((value) => unique.has(value));
}
