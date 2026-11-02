import { locateAttachment } from "./attachments";
import type { ChangedFile, TurnChanges } from "./changed-files";

/** The most «Веб-превью» cards a turn shows (Stage 11 `06` H1). */
export const WEB_PREVIEW_LIMIT = 3;

/**
 * The HTML files of a finished turn that may get a «Веб-превью» card: from
 * its changed files, in order of first appearance, `.html` or `.htm` not
 * deleted and not through a hidden folder such as `.codex_scratch`. A file
 * of the project is judged by its path in its Space, so a project inside a
 * hidden folder still shows its pages. Whether one is a file of an App of
 * the project the caller learns separately.
 */
export function webPreviewCandidates(
  changes: TurnChanges | null,
  spaces: readonly { id: string; path: string }[],
): ChangedFile[] {
  if (!changes) return [];
  return changes.files.filter(
    (file) =>
      file.change !== "deleted" &&
      /\.html?$/iu.test(file.path) &&
      !throughHiddenFolder(
        locateAttachment(file.path, spaces)?.path ?? file.path,
      ),
  );
}

/**
 * The cards of a turn: its candidates outside `appFiles`, at most three. A
 * moved file that is gone is where the move started, not a file the turn
 * left: it gets no card and takes no place.
 */
export function webPreviewFiles(
  candidates: readonly ChangedFile[],
  appFiles: ReadonlySet<string>,
  removed: ReadonlySet<string>,
): ChangedFile[] {
  return candidates
    .filter(
      (file) =>
        !appFiles.has(file.path) &&
        !(file.change === "moved" && removed.has(file.path)),
    )
    .slice(0, WEB_PREVIEW_LIMIT);
}

function throughHiddenFolder(path: string): boolean {
  const folders = path.split(/[\\/]/u).slice(0, -1);
  return folders.some((folder) => folder.startsWith("."));
}
