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
export function sortedSkillMetadata(
  metadata: Readonly<Record<string, string>> | null,
): readonly (readonly [string, string])[] {
  return Object.entries(metadata ?? {}).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}
