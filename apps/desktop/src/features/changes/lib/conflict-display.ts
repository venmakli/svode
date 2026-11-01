import type { GitConflictPlace, GitPlaceChoice } from "@/features/git";

/** A place with a choice, as the view shows it: the text of the side. */
export interface ChosenPlaceDisplay {
  place: number;
  choice: GitPlaceChoice;
  /**
   * The 1-based number of the last shown line of the place on the side of
   * the incoming lines, where `UnresolvedFile` counts its text lines; with
   * no open place left it is the number of the line in the shown text.
   */
  lineNumber: number;
}

/** What the view of a file in conflict shows for its places and choices. */
export interface ConflictDisplay {
  text: string;
  /** The Svode place of each block the component reads, by its index. */
  open: number[];
  chosen: ChosenPlaceDisplay[];
}

/**
 * The text `UnresolvedFile` shows for a file in conflict (DF-291 R2): each
 * place Svode read (DF-238) without a choice as one block of markers of 7
 * characters with my side and the incoming one, each place with a choice as
 * the text of that side («Оба» — mine, then the incoming), and the text
 * around them as merged. A place whose side is empty shows one empty line,
 * so its mark has a line to stand at. A line the component would read as a
 * marker of its own — a run of at least 7 `<`, `|`, `>` or `=` — gets an
 * invisible prefix, so the component shows exactly Svode's open places; the
 * shown text is never written.
 */
export function conflictDisplay(
  content: string,
  places: readonly GitConflictPlace[],
  choices: readonly (GitPlaceChoice | null)[],
  labels: { ours: string; theirs: string },
): ConflictDisplay {
  const lines = content.split(/(?<=\n)/);
  const out: string[] = [];
  const open: number[] = [];
  const chosen: ChosenPlaceDisplay[] = [];
  // Lines on the incoming side: the text around the places and their sides.
  let incoming = 0;
  const text = (line: string) => {
    if (line === "") return;
    out.push(shown(line));
    incoming++;
  };
  let line = 0;
  places.forEach((place, index) => {
    for (; line < place.startLine; line++) text(lines[line]);
    line = place.endLine + 1;
    const choice = choices[index] ?? null;
    if (choice === null) {
      open.push(index);
      out.push(`<<<<<<< ${labels.ours}\n`);
      for (const side of sideLines(place.ours)) out.push(shown(side));
      out.push("=======\n");
      for (const side of sideLines(place.theirs)) text(side);
      out.push(`>>>>>>> ${labels.theirs}\n`);
      return;
    }
    const side = [
      ...(choice === "theirs" ? [] : sideLines(place.ours)),
      ...(choice === "ours" ? [] : sideLines(place.theirs)),
    ];
    for (const sideLine of side.length > 0 ? side : ["\n"]) text(sideLine);
    chosen.push({ place: index, choice, lineNumber: incoming });
  });
  for (; line < lines.length; line++) text(lines[line]);
  return { text: out.join(""), open, chosen };
}

const ZERO_WIDTH_SPACE = "​";

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
