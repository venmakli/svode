import type { ChildrenByParentPath } from "../lib/tree-cache";
import { treeParentKey } from "../lib/tree-cache";
import { folderPathForNode, normalizeTreePath } from "../lib/tree-patches";

export function projectExpansionPaths(
  paths: string[],
  children: ChildrenByParentPath = {},
): string[] {
  const rows = new Map<string, string>();
  for (const nodes of Object.values(children)) {
    for (const node of nodes) {
      const folder = folderPathForNode(node);
      if (folder) rows.set(folder, node.path);
    }
  }
  const identities = new Map<string, string>();
  for (const path of paths) {
    const identity = treeParentKey(path);
    if (identity && !identities.has(identity)) {
      identities.set(identity, rows.get(identity) ?? normalizeTreePath(path));
    }
  }
  return [...identities.values()];
}

export function remapTreePath(path: string, from: string, to: string): string {
  return path === from || path.startsWith(`${from}/`)
    ? to + path.slice(from.length)
    : path;
}

type ExpansionUpdate = (paths: string[]) => string[];
interface ExpansionSession {
  paths: string[];
  ready: boolean;
  edits: ExpansionUpdate[];
  loading?: Promise<void>;
  saving?: Promise<void>;
  revision: number;
  savedRevision: number;
}

/** One ordering owner per repository, including writes finishing after navigation. */
export function createTreeExpansionCoordinator(io: {
  read: (scope: string) => Promise<string[]>;
  write: (scope: string, paths: string[]) => Promise<unknown>;
  publish: (scope: string, paths: string[]) => void;
  project: (scope: string, paths: string[]) => string[];
}) {
  const sessions = new Map<string, ExpansionSession>();
  function session(scope: string, initial?: string[]) {
    let current = sessions.get(scope);
    if (!current) {
      current = {
        paths: initial ?? [],
        ready: initial !== undefined,
        edits: [],
        revision: 0,
        savedRevision: 0,
      };
      sessions.set(scope, current);
    }
    return current;
  }
  function persist(scope: string, current: ExpansionSession): Promise<void> {
    if (current.saving) return current.saving;
    if (!current.ready || current.savedRevision === current.revision)
      return Promise.resolve();
    let failed = false;
    current.saving = (async () => {
      while (current.savedRevision !== current.revision) {
        const revision = current.revision;
        try {
          await io.write(scope, [...current.paths]);
          current.savedRevision = revision;
        } catch (error) {
          failed = true;
          console.error("Failed to save tree expansion:", error);
          break;
        }
      }
    })().finally(() => {
      current.saving = undefined;
      if (!failed && current.savedRevision !== current.revision)
        return persist(scope, current);
    });
    return current.saving;
  }
  async function load(scope: string, initial?: string[]) {
    const current = session(scope, initial);
    if (!current.ready) {
      current.loading ??= (async () => {
        try {
          const stored = await io.read(scope);
          current.paths = current.edits.reduce(
            (paths, edit) => edit(paths),
            stored,
          );
          current.edits = [];
          current.ready = true;
        } catch (error) {
          console.error("Failed to load tree expansion:", error);
        }
      })().finally(() => {
        current.loading = undefined;
      });
      await current.loading;
    }
    const projected = io.project(scope, current.paths);
    if (JSON.stringify(projected) !== JSON.stringify(current.paths)) {
      current.paths = projected;
      current.revision++;
    }
    io.publish(scope, current.paths);
    await persist(scope, current);
  }
  function update(scope: string, edit: ExpansionUpdate, initial?: string[]) {
    const current = session(scope, initial);
    if (!current.ready) current.edits.push(edit);
    current.paths = edit(current.paths);
    current.revision++;
    io.publish(scope, current.paths);
    void load(scope);
  }
  return { load, update };
}
