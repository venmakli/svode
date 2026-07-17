export type CollectionFileChangeKind = "entries" | "schema";

function normalizeEventPath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function normalizedCollectionPath(collectionPath: string) {
  const normalized = normalizeEventPath(collectionPath);
  return normalized === "." ? "" : normalized;
}

function isPathInsideCollection(path: string, collectionPath: string) {
  return (
    !collectionPath ||
    path === collectionPath ||
    path.startsWith(`${collectionPath}/`)
  );
}

export function isCollectionSchemaPath(path: string, collectionPath: string) {
  const normalizedPath = normalizeEventPath(path);
  const normalizedCollection = normalizedCollectionPath(collectionPath);
  const schemaPath = normalizedCollection
    ? `${normalizedCollection}/schema.yaml`
    : "schema.yaml";
  return normalizedPath === schemaPath;
}

export function collectionFileChangeKind(
  path: string,
  collectionPath: string,
): CollectionFileChangeKind | null {
  const normalizedPath = normalizeEventPath(path);
  const normalizedCollection = normalizedCollectionPath(collectionPath);
  if (isCollectionSchemaPath(normalizedPath, normalizedCollection)) {
    return "schema";
  }
  if (
    isPathInsideCollection(normalizedPath, normalizedCollection) &&
    normalizedPath.toLowerCase().endsWith(".md")
  ) {
    return "entries";
  }
  return null;
}
