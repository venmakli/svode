import type { AgentContextSkillMetadataValue } from "./types";

/**
 * The tools of a raw `allowed-tools` value: separated by spaces or commas,
 * while a parenthesized argument such as `Bash(git log:*)` stays one tool.
 */
export function splitAllowedTools(value: string): readonly string[] {
  const tools: string[] = [];
  let current = "";
  let depth = 0;
  for (const character of value) {
    if (character === "(") depth += 1;
    if (character === ")" && depth > 0) depth -= 1;
    if (depth === 0 && (character === "," || /\s/.test(character))) {
      if (current) tools.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current) tools.push(current);
  return tools;
}

/** Metadata entries of a skill in a stable order by key. */
export function sortedSkillMetadata<Value>(
  metadata: Readonly<Record<string, Value>> | null,
): readonly (readonly [string, Value])[] {
  return Object.entries(metadata ?? {}).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

/** A metadata object as "key: value" lines; a list value joins its items. */
export function skillMetadataObjectLines(
  value: Extract<AgentContextSkillMetadataValue, { kind: "object" }>,
): string {
  return value.entries
    .map(
      ([key, leaf]) =>
        `${key}: ${leaf.kind === "text" ? leaf.text : leaf.items.join(", ")}`,
    )
    .join("\n");
}
