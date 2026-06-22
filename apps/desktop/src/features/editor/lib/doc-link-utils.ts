import { invokeCommand as invoke } from "@/platform/native/invoke";
import { searchEntriesByTitle, type SearchItem } from "@/features/search";
import type { TreeNode } from "@/features/entry";
import type { SpaceInfo } from "@/features/space";

const DOC_SEARCH_LIMIT = 8;

export function isDocLink(url: string | undefined): boolean {
  if (!url) return false;
  if (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("mailto:") ||
    url.startsWith("#")
  ) {
    return false;
  }
  return url.split("#")[0].endsWith(".md");
}

export function joinAbs(base: string, rel: string): string {
  if (!rel) return base;
  if (rel.startsWith("/")) return rel;
  return `${base.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`;
}

export function relativeDocumentPath(path: string, spacePath: string): string {
  const normalizedSpace = spacePath.replace(/\/+$/, "");
  if (path === normalizedSpace) return "";
  if (path.startsWith(`${normalizedSpace}/`)) {
    return path.slice(normalizedSpace.length + 1);
  }
  return path;
}

export function absoluteDocumentPath(path: string, spacePath: string): string {
  return path.startsWith("/") ? path : joinAbs(spacePath, path);
}

export function stripAnchor(url: string): string {
  return url.split("#")[0];
}

export function makeRelativePath(
  fromAbsPath: string,
  toAbsPath: string,
): string {
  const fromParts = stripAnchor(fromAbsPath).split("/").filter(Boolean);
  fromParts.pop();
  const toParts = stripAnchor(toAbsPath).split("/").filter(Boolean);

  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }

  const ups = fromParts.length - common;
  const parts = [...Array<string>(ups).fill(".."), ...toParts.slice(common)];
  return parts.join("/") || toAbsPath;
}

export async function makeRelativeDocUrl(
  fromAbsPath: string,
  toAbsPath: string,
): Promise<string> {
  try {
    return await invoke<string>("make_relative_link", {
      sourceDocPath: fromAbsPath,
      targetDocPath: toAbsPath,
    });
  } catch (err) {
    console.warn("make_relative_link failed, using frontend fallback:", err);
    return makeRelativePath(fromAbsPath, toAbsPath);
  }
}

export function resolveRelativeDocPath(
  currentDoc: string,
  relativeUrl: string,
): string {
  const url = stripAnchor(relativeUrl);
  const parts = currentDoc.split("/");
  parts.pop();

  for (const segment of url.split("/")) {
    if (segment === "..") {
      parts.pop();
    } else if (segment !== "." && segment !== "") {
      parts.push(segment);
    }
  }

  return parts.join("/");
}

export function findSpaceById(
  rootSpaces: SpaceInfo[],
  spaces: SpaceInfo[],
  id: string | null,
): SpaceInfo | null {
  if (!id) return null;
  return [...rootSpaces, ...spaces].find((space) => space.id === id) ?? null;
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
