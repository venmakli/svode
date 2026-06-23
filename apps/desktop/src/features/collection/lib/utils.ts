import type { Entry } from "@/features/entry";
import type { CollectionView, ViewType } from "@/features/collection/query/model";

export function humanize(path: string) {
  const normalized = normalizeEntryPath(path);
  const name = normalized.split("/").filter(Boolean).at(-1) ?? normalized;
  return name
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function normalizeEntryPath(path: string) {
  return path.replace(/\\/g, "/");
}

export function collectionPathFor(documentPath: string) {
  const normalized = normalizeEntryPath(documentPath);
  if (normalized.toLowerCase() === "readme.md") return "";
  return normalized.replace(/\/readme\.md$/i, "");
}

export function readmePathFor(collectionPath: string) {
  const normalized = normalizeEntryPath(collectionPath).replace(/\/+$/g, "");
  return normalized ? `${normalized}/README.md` : "README.md";
}

export function viewName(view: unknown): string {
  return typeof view === "object" && view !== null && "name" in view
    ? String((view as { name: unknown }).name)
    : "";
}

export function viewType(view: CollectionView | null | undefined): ViewType {
  const type = view?.type;
  return type === "board" ||
    type === "calendar" ||
    type === "list" ||
    type === "gallery"
    ? type
    : "table";
}

export function titleFilter(entries: Entry[], query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return entries;
  return entries.filter((entry) =>
    entry.meta.title.toLowerCase().includes(normalized),
  );
}

export function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return (
    tagName === "input" || tagName === "textarea" || target.isContentEditable
  );
}

export function nextViewName(views: CollectionView[], baseName: string) {
  const names = new Set(views.map((view) => view.name));
  if (!names.has(baseName)) return baseName;
  let index = 2;
  while (names.has(`${baseName} ${index}`)) index += 1;
  return `${baseName} ${index}`;
}

export function nextTableViewName(views: CollectionView[]) {
  return nextViewName(views, "Table");
}

export function entryTemplateSlug(collectionPath: string, entryPath: string) {
  const normalizedCollectionPath = normalizeEntryPath(collectionPath);
  const normalizedEntryPath = normalizeEntryPath(entryPath);
  const prefix = normalizedCollectionPath
    ? `${normalizedCollectionPath}/.templates/`
    : ".templates/";
  const rest = normalizedEntryPath.startsWith(prefix)
    ? normalizedEntryPath.slice(prefix.length)
    : normalizedEntryPath;
  return rest.replace(/\/README\.md$/i, "").replace(/\.md$/i, "");
}
