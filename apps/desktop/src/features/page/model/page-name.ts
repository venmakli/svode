import type { PageNameConflict } from "./types";

const UNICODE_WHITESPACE = /\p{White_Space}+/gu;

export function pageNameKey(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .replace(UNICODE_WHITESPACE, " ")
    .toLowerCase()
    .normalize("NFKC");
}

export function findPageNameConflictPath(
  title: string,
  siblings: readonly { path: string; title: string }[],
  currentPath: string,
) {
  const key = pageNameKey(title);
  return (
    siblings.find(
      (sibling) =>
        sibling.path !== currentPath && pageNameKey(sibling.title) === key,
    )?.path ?? null
  );
}

export function pageNameConflictDisplayPath(page: {
  path: string;
  name_conflict?: PageNameConflict | null;
}) {
  return page.name_conflict ? page.path : null;
}

export function pageNameConflictFromError(
  error: unknown,
): PageNameConflict | null {
  const value =
    error instanceof Error
      ? ((error as Error & { cause?: unknown }).cause ?? error)
      : error;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== "page_name_conflict") return null;
  const conflict = record.conflict;
  if (!conflict || typeof conflict !== "object") return null;
  const candidate = conflict as Partial<PageNameConflict>;
  if (!Array.isArray(candidate.conflicts)) return null;
  return {
    parentPath:
      typeof candidate.parentPath === "string" ? candidate.parentPath : null,
    conflicts: candidate.conflicts.filter(
      (item): item is { path: string; title: string } =>
        !!item &&
        typeof item === "object" &&
        typeof (item as { path?: unknown }).path === "string" &&
        typeof (item as { title?: unknown }).title === "string",
    ),
  };
}
