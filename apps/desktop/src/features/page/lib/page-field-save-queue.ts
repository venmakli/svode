const pageFieldSaveQueues = new Map<string, Promise<unknown>>();

export function enqueuePageFieldSave<T>(
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = pageFieldSaveQueues.get(key) ?? Promise.resolve();
  const queued = previous.catch(() => undefined).then(task);
  pageFieldSaveQueues.set(key, queued);
  void queued
    .finally(() => {
      if (pageFieldSaveQueues.get(key) === queued) {
        pageFieldSaveQueues.delete(key);
      }
    })
    .catch(() => undefined);
  return queued;
}

export function resolvePageFieldSavePath(
  aliases: ReadonlyMap<string, string>,
  path: string,
) {
  let current = path;
  const visited = new Set<string>();
  while (!visited.has(current)) {
    visited.add(current);
    const next = aliases.get(current);
    if (!next || next === current) return current;
    current = next;
  }
  return current;
}

export function recordPageFieldSavePathAlias(
  aliases: Map<string, string>,
  fromPath: string,
  path: string,
) {
  if (fromPath === path) return;
  for (const sourcePath of aliases.keys()) {
    if (resolvePageFieldSavePath(aliases, sourcePath) === fromPath) {
      aliases.set(sourcePath, path);
    }
  }
  aliases.delete(path);
  aliases.set(fromPath, path);
}
