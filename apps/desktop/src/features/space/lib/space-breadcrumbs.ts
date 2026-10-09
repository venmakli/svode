import { getArtifactPresentationKind } from "@/features/artifact";
import { mediaFamilyFromFormat, mediaFormatFromPath } from "@/features/media";
import type { SpaceInfo, TreeNode } from "../model/types";

/** What a breadcrumb shows when its object has no icon of its own. */
export type BreadcrumbFallbackIcon =
  | "project"
  | "space"
  | "page"
  | "collection"
  | "app"
  | "directory"
  | "document"
  | "image"
  | "audio"
  | "video";

export interface SpaceBreadcrumbSegment {
  label: string;
  path: string;
  ownerKind: "collection" | "app-directory" | null;
  icon: string | null;
  fallback: BreadcrumbFallbackIcon;
}

/** What a breadcrumb opens. */
export type MainBreadcrumbTarget =
  | { kind: "project-home" }
  | { kind: "space-home"; spaceId: string }
  | {
      kind: "segment";
      segment: SpaceBreadcrumbSegment;
      spaceId: string | null;
    };

export interface MainBreadcrumb {
  key: string;
  label: string;
  icon: string | null;
  fallback: BreadcrumbFallbackIcon;
  target: MainBreadcrumbTarget;
}

export type BreadcrumbTrailItem =
  | { kind: "crumb"; crumb: MainBreadcrumb }
  | { kind: "ellipsis"; hidden: MainBreadcrumb[] };

export interface BreadcrumbProject {
  id: string;
  name: string;
  icon: string | null;
}

const MAX_VISIBLE_SEGMENTS = 3;

function findNodeInTree(
  nodes: TreeNode[],
  targetPath: string,
): TreeNode | null {
  for (const node of nodes) {
    if (node.path === targetPath) return node;
    const folderPath = node.path.replace(/\/readme\.md$/i, "");
    if (folderPath === targetPath) return node;
    if (node.children.length > 0) {
      const found = findNodeInTree(node.children, targetPath);
      if (found) return found;
    }
  }
  return null;
}

function fileFallback(path: string): BreadcrumbFallbackIcon {
  const format = mediaFormatFromPath(path);
  return format ? mediaFamilyFromFormat(format) : "document";
}

function segmentFallback(
  node: TreeNode | null,
  path: string,
  last: boolean,
): BreadcrumbFallbackIcon {
  const kind = getArtifactPresentationKind({
    hasSchema: Boolean(node?.has_schema),
    hasApp: node?.kind === "app" || Boolean(node?.has_app),
    hasPage: path.toLowerCase().endsWith(".md"),
  });
  return kind === "directory" && last ? fileFallback(path) : kind;
}

export function buildSpaceBreadcrumbSegments(
  docPath: string,
  tree: TreeNode[],
): SpaceBreadcrumbSegment[] {
  const parts = docPath.split("/");
  const segments: SpaceBreadcrumbSegment[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const cumPath = parts.slice(0, i + 1).join("/");

    if (i === parts.length - 1 && part.toLowerCase() === "readme.md") continue;

    if (i < parts.length - 1) {
      const node = findNodeInTree(tree, cumPath);
      const isCollectionOwner = Boolean(node?.has_schema);
      const isAppOwner = !isCollectionOwner && node?.kind === "app";
      const path = isCollectionOwner
        ? cumPath
        : (node?.path ?? `${cumPath}/README.md`);
      segments.push({
        label: node?.title ?? part,
        path,
        ownerKind: isCollectionOwner
          ? "collection"
          : isAppOwner
            ? "app-directory"
            : null,
        icon: node?.icon ?? null,
        fallback: segmentFallback(node, node?.path ?? path, false),
      });
    } else {
      const node = findNodeInTree(tree, cumPath);
      segments.push({
        label: node?.title ?? part.replace(/\.md$/, ""),
        path: cumPath,
        ownerKind: node?.has_schema
          ? "collection"
          : node?.kind === "app"
            ? "app-directory"
            : null,
        icon: node?.icon ?? null,
        fallback: segmentFallback(node, cumPath, true),
      });
    }
  }

  return segments;
}

/**
 * Where the object sits before its path: on Home the project, then a child
 * Space; inside the project only a child Space.
 */
export function buildBreadcrumbPrefix({
  home,
  project,
  space,
}: {
  home: boolean;
  project: BreadcrumbProject | null;
  /** The child Space of the object; null for the project root. */
  space: SpaceInfo | null;
}): MainBreadcrumb[] {
  const prefix: MainBreadcrumb[] = [];
  if (home && project) {
    prefix.push({
      key: `project:${project.id}`,
      label: project.name,
      icon: project.icon || null,
      fallback: "project",
      target: { kind: "project-home" },
    });
  }
  if (space) {
    prefix.push({
      key: `space:${space.id}`,
      label: space.name,
      icon: space.icon || null,
      fallback: "space",
      target: { kind: "space-home", spaceId: space.id },
    });
  }
  return prefix;
}

/** The prefix, then the path to the object; a Space home has no path. */
export function buildMainBreadcrumbs({
  path,
  tree,
  ...prefixInput
}: Parameters<typeof buildBreadcrumbPrefix>[0] & {
  path: string | null;
  tree: TreeNode[];
}): { crumbs: MainBreadcrumb[]; prefixLength: number } {
  const prefix = buildBreadcrumbPrefix(prefixInput);
  const spaceId = prefixInput.space?.id ?? prefixInput.project?.id ?? null;
  const segments = path ? buildSpaceBreadcrumbSegments(path, tree) : [];
  return {
    crumbs: [
      ...prefix,
      ...segments.map(
        (segment): MainBreadcrumb => ({
          key: `segment:${segment.path}`,
          label: segment.label,
          icon: segment.icon,
          fallback: segment.fallback,
          target: { kind: "segment", segment, spaceId },
        }),
      ),
    ],
    prefixLength: prefix.length,
  };
}

/**
 * A path longer than three segments keeps its first and two last segments
 * and folds the middle into "…"; the prefix always stays.
 */
export function collapseBreadcrumbs(
  crumbs: MainBreadcrumb[],
  prefixLength: number,
): BreadcrumbTrailItem[] {
  const prefix = crumbs.slice(0, prefixLength);
  const path = crumbs.slice(prefixLength);
  const asItem = (crumb: MainBreadcrumb): BreadcrumbTrailItem => ({
    kind: "crumb",
    crumb,
  });
  if (path.length <= MAX_VISIBLE_SEGMENTS) return crumbs.map(asItem);
  return [
    ...prefix.map(asItem),
    asItem(path[0]),
    { kind: "ellipsis", hidden: path.slice(1, -2) },
    ...path.slice(-2).map(asItem),
  ];
}

/** The Spaces the Space element switches between; one Space has no list. */
export function breadcrumbSpaceChoices(spaces: SpaceInfo[]): SpaceInfo[] {
  return spaces.length >= 2 ? spaces : [];
}
