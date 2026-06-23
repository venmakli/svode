import {
  makeRelativeLink,
  resolveDocLink as resolveDocLinkCommand,
  suggestLinkFix as suggestLinkFixCommand,
  type DocLinkResolveResultDto,
  type LinkFixSuggestionDto,
} from "@/platform/entries/doc-links-api";
import { cloneMissingSpace } from "@/platform/space/space-api";
import { searchEntriesByTitle, type SearchItem } from "@/features/search";
import type { TreeNode } from "@/features/space";

import { makeRelativePath } from "../lib/doc-link-utils";

const DOC_SEARCH_LIMIT = 8;

export type DocLinkResolveResult = DocLinkResolveResultDto;
export type LinkFixSuggestion = LinkFixSuggestionDto;

export async function makeRelativeDocUrl(
  fromAbsPath: string,
  toAbsPath: string,
): Promise<string> {
  try {
    return await makeRelativeLink({
      sourceDocPath: fromAbsPath,
      targetDocPath: toAbsPath,
    });
  } catch (err) {
    console.warn("make_relative_link failed, using frontend fallback:", err);
    return makeRelativePath(fromAbsPath, toAbsPath);
  }
}

export function resolveDocLink(input: {
  projectPath: string;
  sourceSpaceId: string | null;
  sourcePath: string;
  url: string;
}): Promise<DocLinkResolveResult> {
  return resolveDocLinkCommand(input);
}

export function suggestLinkFix(input: {
  projectPath: string;
  targetSpaceId: string | null;
  brokenPath: string;
}): Promise<LinkFixSuggestion[]> {
  return suggestLinkFixCommand(input);
}

export function cloneMissingDocLinkSpace(input: {
  projectPath: string;
  spaceId: string;
}): Promise<void> {
  return cloneMissingSpace(input.projectPath, input.spaceId);
}

export async function searchDocLinkTargets(
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
            limit: DOC_SEARCH_LIMIT,
            scope: { kind: "project" },
          }),
        ]
      : [
          searchEntriesByTitle({
            projectPath,
            query: trimmed,
            limit: DOC_SEARCH_LIMIT,
            scope: { kind: "space", spaceId: activeSpaceId },
          }),
          searchEntriesByTitle({
            projectPath,
            query: trimmed,
            limit: DOC_SEARCH_LIMIT,
            scope: { kind: "space", spaceId: null },
          }),
        ];

  const responses = await Promise.all(calls);
  const seen = new Set<string>();
  const merged: SearchItem[] = [];
  if (activeSpaceId !== null && localCurrentSpace?.spaceId === activeSpaceId) {
    for (const item of treeToSearchItems(localCurrentSpace, trimmed)) {
      const key = `${item.spaceId ?? ""}::${item.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  for (const item of responses.flatMap((response) => response.items)) {
    if (item.type !== "page") continue;
    const key = `${item.spaceId ?? ""}::${item.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged.slice(0, DOC_SEARCH_LIMIT);
}

function treeToSearchItems(
  source: {
    spaceId: string;
    spacePath: string;
    spaceName: string;
    tree: TreeNode[];
  },
  query: string,
): SearchItem[] {
  const q = query.toLowerCase();
  const out: SearchItem[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (node.path.endsWith(".md")) {
        const matches =
          q.length === 0 ||
          node.title.toLowerCase().includes(q) ||
          node.path.toLowerCase().includes(q);
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
