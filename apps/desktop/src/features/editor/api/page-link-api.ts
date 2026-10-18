import {
  makeRelativePageLink,
  resolvePageLink as resolvePageLinkCommand,
  suggestPageLinkFix as suggestPageLinkFixCommand,
  type PageLinkResolveResultDto,
  type PageLinkFixSuggestionDto,
} from "@/platform/pages/page-links-api";
import { cloneMissingSpace } from "@/platform/space/space-api";
import { searchEntriesByTitle, type SearchItem } from "@/features/search";
import type { TreeNode } from "@/features/space";

import { makeRelativePath } from "../lib/page-link-utils";
import {
  PAGE_LINK_NO_MATCH,
  pageLinkMatchLevel,
  pageNameKey,
  rankPageLinkTargets,
} from "../lib/page-link-target-rank";

const PAGE_SEARCH_LIMIT = 8;

export type PageLinkResolveResult = PageLinkResolveResultDto;
export type PageLinkFixSuggestion = PageLinkFixSuggestionDto;

export async function makeRelativePageUrl(
  fromAbsPath: string,
  toAbsPath: string,
): Promise<string> {
  try {
    return await makeRelativePageLink({
      sourcePagePath: fromAbsPath,
      targetPagePath: toAbsPath,
    });
  } catch (err) {
    console.warn("Relative Page link failed, using frontend fallback:", err);
    return makeRelativePath(fromAbsPath, toAbsPath);
  }
}

export function resolvePageLink(input: {
  projectPath: string;
  sourceSpaceId: string | null;
  sourcePath: string;
  url: string;
}): Promise<PageLinkResolveResult> {
  return resolvePageLinkCommand(input);
}

export function suggestPageLinkFix(input: {
  projectPath: string;
  targetSpaceId: string | null;
  brokenPath: string;
}): Promise<PageLinkFixSuggestion[]> {
  return suggestPageLinkFixCommand(input);
}

export function cloneMissingPageLinkSpace(input: {
  projectPath: string;
  spaceId: string;
}): Promise<void> {
  return cloneMissingSpace(input.projectPath, input.spaceId);
}

export async function searchPageLinkTargets(
  projectPath: string,
  activeSpaceId: string | null,
  query: string,
  localCurrentSpace?: {
    spaceId: string;
    spacePath: string;
    spaceName: string;
    tree: TreeNode[];
  } | null,
): Promise<SearchItem[]> {
  const trimmed = query.trim();
  const calls =
    activeSpaceId === null
      ? [
          searchEntriesByTitle({
            projectPath,
            query: trimmed,
            limit: PAGE_SEARCH_LIMIT,
            scope: { kind: "project" },
          }),
        ]
      : [
          searchEntriesByTitle({
            projectPath,
            query: trimmed,
            limit: PAGE_SEARCH_LIMIT,
            scope: { kind: "space", spaceId: activeSpaceId },
          }),
          searchEntriesByTitle({
            projectPath,
            query: trimmed,
            limit: PAGE_SEARCH_LIMIT,
            scope: { kind: "space", spaceId: null },
          }),
        ];

  const responses = await Promise.all(calls);
  const queryKey = pageNameKey(trimmed);
  const local =
    activeSpaceId !== null && localCurrentSpace?.spaceId === activeSpaceId
      ? treeToSearchItems(localCurrentSpace, queryKey)
      : [];
  const seen = new Set<string>();
  const merged: SearchItem[] = [];
  for (const item of [
    ...local,
    ...responses.flatMap((response) => response.items),
  ]) {
    if (item.type !== "page") continue;
    const key = `${item.spaceId ?? ""}::${item.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return rankPageLinkTargets(merged, queryKey).slice(0, PAGE_SEARCH_LIMIT);
}

function treeToSearchItems(
  source: {
    spaceId: string;
    spacePath: string;
    spaceName: string;
    tree: TreeNode[];
  },
  queryKey: string,
): SearchItem[] {
  const out: SearchItem[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (node.path.endsWith(".md")) {
        const matches =
          queryKey.length === 0 ||
          pageLinkMatchLevel(node, queryKey) < PAGE_LINK_NO_MATCH;
        if (matches) {
          out.push({
            id: `${source.spaceId}:${node.path}`,
            spaceId: source.spaceId,
            spacePath: source.spacePath,
            spaceName: source.spaceName,
            path: node.path,
            title: node.title,
            type: "page",
            tableName: null,
            snippet: null,
            icon: node.icon ?? "📄",
          });
        }
      }
      if (node.children.length > 0) walk(node.children);
    }
  };
  walk(source.tree);
  return out;
}
