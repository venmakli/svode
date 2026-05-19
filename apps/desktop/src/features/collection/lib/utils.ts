import type { Entry } from "@/features/editor/types";
import type {
  CollectionView,
  ViewType,
} from "@/features/collection/query";

export function humanize(path: string) {
  const name = path.split("/").filter(Boolean).at(-1) ?? path;
  return name
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function collectionPathFor(documentPath: string) {
  if (documentPath.toLowerCase() === "readme.md") return "";
  return documentPath
    .replace(/\/readme\.md$/i, "")
    .replace(/\/README\.md$/, "");
}

export function readmePathFor(collectionPath: string) {
  return collectionPath ? `${collectionPath}/README.md` : "README.md";
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
