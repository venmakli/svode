const HTML_COMMENT = /^<!--([\s\S]*?)-->$/;
const EXPRESSION_COMMENT = /\/\*([\s\S]*?)\*\/|\/\/([^\n]*)/g;
const DEFINITION_COMMENT =
  /^\[\/\/\]:\s*(?:<[^>]*>|\S+)(?:\s+(?:"([\s\S]*)"|'([\s\S]*)'|\(([\s\S]*)\)))?\s*$/;

/** Drops blank edge lines and the indentation shared by all lines. */
function tidy(text: string): string {
  const lines = text.split("\n").map((line) => line.trimEnd());
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => line.length - line.trimStart().length);
  const shared = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(shared)).join("\n");
}

function expressionText(raw: string): string {
  const body = raw.slice(1, -1);
  const parts: string[] = [];
  for (const match of body.matchAll(EXPRESSION_COMMENT)) {
    parts.push(tidy(match[1] ?? match[2] ?? ""));
  }
  return parts.filter(Boolean).join("\n");
}

/**
 * The text a Markdown comment holds, without its `<!-- -->`, `{/* *\/}` or
 * `[//]: #` delimiters; empty for a comment with no text.
 */
export function markdownCommentText(raw: string): string {
  const source = raw.trim();
  const html = HTML_COMMENT.exec(source);
  if (html) return tidy(html[1]);
  if (source.startsWith("{") && source.endsWith("}")) {
    return expressionText(source);
  }
  const definition = DEFINITION_COMMENT.exec(source);
  if (definition) {
    return tidy(definition[1] ?? definition[2] ?? definition[3] ?? "");
  }
  return tidy(source);
}
