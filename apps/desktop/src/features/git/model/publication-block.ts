import type { GitPublicationSpaceClass } from "@/platform/git/publication-errors";

/**
 * A project publication stopped by Spaces whose versions, referenced by the
 * project, are not available from their sources.
 */
export interface GitPublicationBlock {
  /** The project repository whose gitlinks name the Spaces. */
  project: string;
  /** One entry per Space, `path` relative to the project root. */
  spaces: { path: string; class: GitPublicationSpaceClass }[];
}

export interface GitPublicationBlockedSpace {
  /** The gitlink path relative to the project root. */
  path: string;
  class: GitPublicationSpaceClass;
  /** The Space name, or its gitlink path when no current Space is there. */
  name: string;
  namedByPath: boolean;
  /** The Space location whose repository access applies to this entry. */
  spacePath: string;
  /** Repository access of the Space is confirmed read-only. */
  readOnly: boolean;
  /** The user can publish this Space's local commits. */
  publishable: boolean;
}

export interface PublicationBlockContext {
  projectPath: string | null;
  spaces: readonly { name: string; path: string }[];
}

/** The location of each Space the block names, as the app knows it. */
export function publicationBlockSpacePaths(
  block: GitPublicationBlock,
  context: PublicationBlockContext,
): string[] {
  return block.spaces.map(
    (space) =>
      knownSpace(block, space.path, context)?.path ??
      joinPath(block.project, space.path),
  );
}

/**
 * Names each blocked Space by the project's Spaces and marks local commits
 * as publishable unless the Space's access is confirmed read-only.
 */
export function publicationBlockedSpaces(
  block: GitPublicationBlock,
  context: PublicationBlockContext,
  readOnlyPaths: ReadonlySet<string>,
): GitPublicationBlockedSpace[] {
  return block.spaces.map((entry) => {
    const space = knownSpace(block, entry.path, context);
    const spacePath = space?.path ?? joinPath(block.project, entry.path);
    const readOnly = readOnlyPaths.has(spacePath);
    return {
      path: entry.path,
      class: entry.class,
      name: space?.name || entry.path,
      namedByPath: !space?.name,
      spacePath,
      readOnly,
      publishable: entry.class === "local_commits" && !readOnly,
    };
  });
}

function knownSpace(
  block: GitPublicationBlock,
  path: string,
  context: PublicationBlockContext,
) {
  const locations = new Set([joinPath(block.project, path)]);
  if (context.projectPath) locations.add(joinPath(context.projectPath, path));
  return context.spaces.find((space) => locations.has(locationKey(space.path)));
}

function joinPath(root: string, path: string) {
  return `${locationKey(root)}/${locationKey(path)}`;
}

function locationKey(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}
