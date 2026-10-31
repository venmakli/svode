import type { GitConflictPlace } from "@/features/git";

/**
 * The text `UnresolvedFile` shows for a file in conflict: the places Svode
 * read (DF-238), each as one block of markers of 7 characters with my side
 * and the incoming one, and the text around them as merged. A line the
 * component would read as a marker of its own — a run of at least 7 `<`,
 * `|`, `>` or `=` — gets an invisible prefix, so the component shows
 * exactly Svode's places and no others; the shown text is never written.
 */
export function conflictDisplayText(
  content: string,
  places: readonly GitConflictPlace[],
  labels: { ours: string; theirs: string },
): string {
  const lines = content.split(/(?<=\n)/);
  const out: string[] = [];
  let line = 0;
  for (const place of places) {
    for (; line < place.startLine; line++) out.push(shown(lines[line]));
    out.push(`<<<<<<< ${labels.ours}\n`);
    for (const side of sideLines(place.ours)) out.push(shown(side));
    out.push("=======\n");
    for (const side of sideLines(place.theirs)) out.push(shown(side));
    out.push(`>>>>>>> ${labels.theirs}\n`);
    line = place.endLine + 1;
  }
  for (; line < lines.length; line++) out.push(shown(lines[line]));
  return out.join("");
}

const ZERO_WIDTH_SPACE = "\u200b";

function sideLines(side: string): string[] {
  return side === ""
    ? []
    : side
        .split(/(?<=\n)/)
        .map((line) => (line.endsWith("\n") ? line : `${line}\n`));
}

function shown(line: string) {
  return isComponentMarker(line) ? `${ZERO_WIDTH_SPACE}${line}` : line;
}

/** A marker line as `UnresolvedFile` 1.1.7 reads one. */
function isComponentMarker(line: string) {
  const text = line.replace(/\r?\n$/, "");
  const marker = text[0];
  if (marker !== "<" && marker !== "|" && marker !== ">" && marker !== "=")
    return false;
  let run = 1;
  while (run < text.length && text[run] === marker) run++;
  if (run < 7) return false;
  if (marker === "=") return run === text.length;
  return run === text.length || /\s/.test(text[run]);
}
