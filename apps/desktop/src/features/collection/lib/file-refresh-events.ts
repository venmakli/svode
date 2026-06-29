export type CollectionFileChangeKind = "entries" | "schema";

function normalizeEventPath(path: string) {
  return path.replace(/\\/g, "/");
}

function eventPathBasename(path: string) {
  return normalizeEventPath(path).split("/").pop() ?? "";
}

export function collectionFileChangeKind(
  path: string,
): CollectionFileChangeKind | null {
  const normalized = normalizeEventPath(path).toLowerCase();
  if (eventPathBasename(path) === "schema.yaml") return "schema";
  if (normalized.endsWith(".md")) return "entries";
  return null;
}
