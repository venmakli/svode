import type { DocumentNameConflict } from "./types";

const UNICODE_WHITESPACE = /\p{White_Space}+/gu;

export function documentNameKey(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .replace(UNICODE_WHITESPACE, " ")
    .toLowerCase()
    .normalize("NFKC");
}

export function findDocumentNameConflictPath(
  title: string,
  siblings: readonly { path: string; title: string; has_schema: boolean }[],
  currentPath: string,
) {
  const key = documentNameKey(title);
  return (
    siblings.find(
      (sibling) =>
        !sibling.has_schema &&
        sibling.path !== currentPath &&
        documentNameKey(sibling.title) === key,
    )?.path ?? null
  );
}

export function documentNameConflictFromError(
  error: unknown,
): DocumentNameConflict | null {
  const value =
    error instanceof Error
      ? ((error as Error & { cause?: unknown }).cause ?? error)
      : error;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== "document_name_conflict") return null;
  const conflict = record.conflict;
  if (!conflict || typeof conflict !== "object") return null;
  const candidate = conflict as Partial<DocumentNameConflict>;
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
