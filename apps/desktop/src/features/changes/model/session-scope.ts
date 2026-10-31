import { normalizeGitStatusPath, type GitStatus } from "@/features/git";
import type { ChangesTarget } from "./scope";

/** The uncommitted work of a session in one Space. */
export interface SessionAreaPart {
  spaceId: string;
  spacePath: string;
  /** Relative to the Space, in the order of its Git status. */
  paths: string[];
}

/** The uncommitted work of a session in one repository. */
export interface SessionAreaSection {
  /** The repository id; `path:<Space>` while its repository is not read. */
  repository: string;
  /** Its Spaces in work order; an Inline Space shares the project's. */
  parts: SessionAreaPart[];
}

/**
 * The area of the "Changes" of a chat session (Stage 11 1.7): its work
 * files that are uncommitted now, by repository, and how many uncommitted
 * files of its own Space lie outside the work. Built from the projection,
 * the current Git status and the repository of each Space, so it stores
 * nothing.
 */
export interface SessionArea {
  sections: SessionAreaSection[];
  /** Uncommitted files of the session's Space outside the area. */
  outside: number;
  /** Every Space of the work has a status read. */
  read: boolean;
  /** A status lists only part of its paths. */
  incomplete: boolean;
}

export function sessionWorkSpaces(target: ChangesTarget): string[] {
  const spaces = [target.spacePath];
  for (const file of target.work?.files ?? []) {
    if (!spaces.includes(file.spacePath)) spaces.push(file.spacePath);
  }
  return spaces;
}

/** Every Space part of the area, section after section. */
export function sessionAreaParts(area: SessionArea): SessionAreaPart[] {
  return area.sections.flatMap((section) => section.parts);
}

export function sessionAreaPaths(area: SessionArea): string[] {
  return sessionAreaParts(area).flatMap((part) => part.paths);
}

export function sessionArea(
  target: ChangesTarget,
  statuses: Readonly<Record<string, GitStatus | undefined>>,
  repositories: Readonly<Record<string, string>> = {},
): SessionArea {
  const files = target.work?.files ?? [];
  const sections: SessionAreaSection[] = [];
  const claimed = new Set<string>();
  let read = true;
  let incomplete = false;
  for (const spacePath of sessionWorkSpaces(target)) {
    const status = statuses[spacePath];
    if (!status) {
      read = false;
      continue;
    }
    if (status.omittedFiles > 0) incomplete = true;
    const work = new Set(
      files
        .filter((file) => file.spacePath === spacePath)
        .map((file) => normalizeGitStatusPath(file.path)),
    );
    const paths = [
      ...new Set(
        status.files
          .map((file) => normalizeGitStatusPath(file.path))
          .filter((path) => work.has(path)),
      ),
    ];
    for (const path of paths) claimed.add(absolute(spacePath, path));
    const spaceId = files.find((file) => file.spacePath === spacePath)?.spaceId;
    if (paths.length === 0 || spaceId === undefined) continue;
    const repository = repositories[spacePath] ?? `path:${spacePath}`;
    const part = { spaceId, spacePath, paths };
    const section = sections.find((known) => known.repository === repository);
    if (section) section.parts.push(part);
    else sections.push({ repository, parts: [part] });
  }
  const own = statuses[target.spacePath];
  const outside = own
    ? new Set(
        own.files
          .map((file) => normalizeGitStatusPath(file.path))
          .filter((path) => !claimed.has(absolute(target.spacePath, path))),
      ).size
    : 0;
  return { sections, outside, read, incomplete };
}

function absolute(spacePath: string, path: string) {
  return `${spacePath.replace(/[\\/]+$/, "")}/${path}`;
}
