import type {
  AgentContextInstructionRow,
  AgentContextLinkKind,
  AgentContextReference,
  AgentContextSkillRow,
} from "./types";

/** A path by which clients discover an item, with its link target. */
export interface AgentContextSourceLine {
  path: string;
  linkKind: AgentContextLinkKind;
  /** Where a link or alias leads; null for a direct file. */
  target: string | null;
}

export function instructionSourceLines(
  row: AgentContextInstructionRow,
): readonly AgentContextSourceLine[] {
  return [
    {
      linkKind: row.linkKind,
      path: row.discoveryPath,
      target:
        row.linkKind === "direct"
          ? null
          : (row.linkTargetPath ?? row.canonicalPath),
    },
  ];
}

/** One line per discovery path of a skill, whichever client finds it. */
export function skillSourceLines(
  row: AgentContextSkillRow,
): readonly AgentContextSourceLine[] {
  const lines = new Map<string, AgentContextSourceLine>();
  for (const alias of row.aliases) {
    if (lines.has(alias.discoveryPath)) continue;
    lines.set(alias.discoveryPath, {
      linkKind: alias.linkKind,
      path: alias.discoveryPath,
      target: alias.linkKind === "direct" ? null : row.canonicalPath,
    });
  }
  return [...lines.values()];
}

/** Every `@import` of an instruction once, in scanner order. */
export function instructionImports(
  row: AgentContextInstructionRow,
): readonly AgentContextReference[] {
  const imports = new Map<string, AgentContextReference>();
  for (const reference of row.references) {
    const identity = `${reference.status}\0${reference.path}`;
    if (!imports.has(identity)) imports.set(identity, reference);
  }
  return [...imports.values()];
}
