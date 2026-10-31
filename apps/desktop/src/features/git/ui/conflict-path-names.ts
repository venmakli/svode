import * as m from "@/paraglide/messages.js";

/** A Space with the tree of its objects, as the sidebar knows it. */
export interface ConflictNameSpace {
  path: string;
  name: string;
  nodes: ReadonlyMap<string, string>;
}

/**
 * The name the person knows a conflicted path by (1.F): the title of its
 * Page, «Схема коллекции „Задачи“» for a Collection schema, otherwise the
 * file name. `path` is relative to `repositoryPath`; the Space holding it
 * gives the titles of its objects by their paths in it.
 */
export function conflictPathName(
  repositoryPath: string,
  path: string,
  spaces: readonly ConflictNameSpace[],
): string {
  const absolute = `${trimSlashes(repositoryPath)}/${path}`;
  const space = spaces
    .filter(
      (candidate) =>
        absolute.startsWith(`${trimSlashes(candidate.path)}/`) &&
        candidate.path.length > 0,
    )
    .sort((a, b) => b.path.length - a.path.length)[0];
  const relative = space
    ? absolute.slice(trimSlashes(space.path).length + 1)
    : path;
  const parts = relative.split("/");
  const file = parts.at(-1) ?? relative;
  const directory = parts.slice(0, -1).join("/");
  const ownerName = () =>
    space?.nodes.get(directory) ??
    space?.nodes.get(`${directory}/README.md`) ??
    (directory ? (parts.at(-2) ?? directory) : (space?.name ?? directory));
  if (file === "schema.yaml") {
    return m.git_conflict_name_schema({ name: ownerName() });
  }
  const title = space?.nodes.get(relative);
  if (title) return title;
  if (file.toLowerCase() === "readme.md") return ownerName() || file;
  return file;
}

function trimSlashes(path: string) {
  return path.replace(/[\\/]+$/, "");
}
