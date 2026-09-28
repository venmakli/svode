import type { Page } from "./types";

const IDENTITY_FIELDS = new Set(["title", "icon", "description", "cover"]);

function normalizeEventPath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function parentDirectory(path: string) {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

/** The event names the source file of this Page. */
export function isPageSourceEvent(eventPath: string, pagePath: string) {
  return normalizeEventPath(eventPath) === normalizeEventPath(pagePath);
}

/**
 * The event names a directory that contains this Page: a rename or removal of
 * it can take the Page away without an event for the Page file itself.
 */
export function isPageAncestorEvent(eventPath: string, pagePath: string) {
  const path = normalizeEventPath(eventPath);
  return path !== "" && normalizeEventPath(pagePath).startsWith(`${path}/`);
}

/** The event names a `schema.yaml` that can own this Page's properties. */
export function isPageSchemaEvent(eventPath: string, pagePath: string) {
  const path = normalizeEventPath(eventPath);
  if (path !== "schema.yaml" && !path.endsWith("/schema.yaml")) return false;
  const schemaDirectory = parentDirectory(path);
  const pageDirectory = parentDirectory(normalizeEventPath(pagePath));
  return (
    !schemaDirectory ||
    pageDirectory === schemaDirectory ||
    pageDirectory.startsWith(`${schemaDirectory}/`)
  );
}

function sameValue(left: unknown, right: unknown) {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

type Fields = Record<string, unknown>;

/** Takes `source` values, keeping `current` for local and unchanged fields. */
function mergeFields(
  current: Fields,
  source: Fields,
  isLocal: (field: string) => boolean,
): Fields {
  const next: Fields = {};
  let changed = false;
  for (const field of new Set([
    ...Object.keys(current),
    ...Object.keys(source),
  ])) {
    const keepCurrent =
      isLocal(field) || sameValue(current[field], source[field]);
    const hasField = Object.prototype.hasOwnProperty.call(
      keepCurrent ? current : source,
      field,
    );
    if (hasField) next[field] = keepCurrent ? current[field] : source[field];
    if (!keepCurrent) changed = true;
  }
  return changed ? next : current;
}

/**
 * Adopts the metadata another writer left in the file. Fields with local work
 * keep their value, the body stays with the editor, and unchanged values keep
 * their identity so an echo of the same file changes nothing.
 */
export function mergeExternalPageMeta(
  current: Page,
  source: Page,
  localFields: ReadonlySet<string>,
): Page {
  const { extra: currentExtra, ...currentMeta } = current.meta;
  const { extra: sourceExtra, ...sourceMeta } = source.meta;
  const meta = mergeFields(
    currentMeta,
    sourceMeta,
    (field) => IDENTITY_FIELDS.has(field) && localFields.has(field),
  );
  const extra = mergeFields(
    currentExtra,
    sourceExtra,
    (field) => !IDENTITY_FIELDS.has(field) && localFields.has(field),
  );
  if (meta === currentMeta && extra === currentExtra) return current;
  return {
    ...current,
    meta: { ...(meta as Omit<Page["meta"], "extra">), extra },
  };
}
