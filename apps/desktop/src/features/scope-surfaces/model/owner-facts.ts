import {
  createAppDirectoryOwner,
  createCollectionDirectoryOwner,
  createPageOwner,
} from "./owners";
import type { ScopeOwnerRef } from "./types";

/** Backend identity and direct capabilities of one content target. */
export interface ScopeOwnerFacts {
  identity:
    | "page-file"
    | "page-directory"
    | "collection-directory"
    | "app-directory";
  ownerPath: string;
  contentPath: string;
  hasApp: boolean;
}

export interface ScopeOwnerTarget {
  spaceId: string;
  spacePath: string;
  projectPath: string;
  path: string;
}

/** The content tree node fields that carry the same backend facts. */
export interface KnownScopeOwnerNode {
  path: string;
  has_schema: boolean;
  has_app?: boolean;
  kind?: "page" | "folder" | "collection" | "app";
}

export function createScopeOwner(
  target: Omit<ScopeOwnerTarget, "path">,
  facts: ScopeOwnerFacts,
): ScopeOwnerRef {
  const context = { ...target, status: "ready" as const };
  if (facts.identity === "page-file")
    return createPageOwner({
      ...context,
      form: "leaf",
      contentPath: facts.contentPath,
    });
  if (facts.identity === "page-directory")
    return createPageOwner({
      ...context,
      form: "folder",
      ownerPath: facts.ownerPath,
      contentPath: facts.contentPath,
      hasApp: facts.hasApp,
    });
  const owner =
    facts.identity === "collection-directory"
      ? createCollectionDirectoryOwner({
          ...context,
          ownerPath: facts.ownerPath,
          hasSchema: true,
          hasApp: facts.hasApp,
        })
      : createAppDirectoryOwner({
          ...context,
          ownerPath: facts.ownerPath,
          hasApp: facts.hasApp,
        });
  return { ...owner, readmePath: facts.contentPath };
}

export function sameScopeOwnerFacts(
  left: ScopeOwnerFacts,
  right: ScopeOwnerFacts,
) {
  return (
    left.identity === right.identity &&
    left.ownerPath === right.ownerPath &&
    left.contentPath === right.contentPath &&
    left.hasApp === right.hasApp
  );
}

/**
 * Facts the sidebar tree already holds for the target, so an open from the
 * sidebar does not wait for the resolver's first answer.
 */
export function knownScopeOwnerFacts(
  path: string,
  node: KnownScopeOwnerNode,
): ScopeOwnerFacts | null {
  const directory = ownerDirectory(path);
  if (directory === null)
    return node.has_schema || node.kind === "app"
      ? null
      : {
          identity: "page-file",
          ownerPath: path,
          contentPath: path,
          hasApp: false,
        };
  if (node.kind === "folder" && !node.has_schema) return null;
  const contentPath = isReadme(path)
    ? path
    : isReadme(node.path)
      ? node.path
      : `${directory}/README.md`;
  return {
    identity: node.has_schema
      ? "collection-directory"
      : node.kind === "app"
        ? "app-directory"
        : "page-directory",
    ownerPath: directory,
    contentPath,
    hasApp: node.has_app === true,
  };
}

/**
 * Whether a file event can change the facts of the target: the target itself
 * and the direct markers of its owner directory, not its siblings.
 */
export function affectsScopeOwnerFacts(
  path: string,
  facts: ScopeOwnerFacts | null,
  eventPath: string,
) {
  if (eventPath === path) return true;
  const directory = facts
    ? facts.identity === "page-file"
      ? null
      : facts.ownerPath
    : ownerDirectory(path);
  if (directory === null) return false;
  if (eventPath === directory) return true;
  const slash = eventPath.lastIndexOf("/");
  if (slash < 0 || eventPath.slice(0, slash) !== directory) return false;
  const name = eventPath.slice(slash + 1).toLowerCase();
  return name === "schema.yaml" || name === "app.yaml" || name === "readme.md";
}

function ownerDirectory(path: string): string | null {
  if (isReadme(path)) {
    const slash = path.lastIndexOf("/");
    return slash < 0 ? null : path.slice(0, slash);
  }
  return /\.md$/i.test(path) ? null : path;
}

function isReadme(path: string) {
  return /(^|\/)readme\.md$/i.test(path);
}
