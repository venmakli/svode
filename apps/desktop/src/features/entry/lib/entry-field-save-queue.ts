const entryFieldSaveQueues = new Map<string, Promise<unknown>>();

export function enqueueEntryFieldSave<T>(
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = entryFieldSaveQueues.get(key) ?? Promise.resolve();
  const queued = previous.catch(() => undefined).then(task);
  entryFieldSaveQueues.set(key, queued);
  void queued
    .finally(() => {
      if (entryFieldSaveQueues.get(key) === queued) {
        entryFieldSaveQueues.delete(key);
      }
    })
    .catch(() => undefined);
  return queued;
}

export function resolveEntryFieldSavePath(
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

export function recordEntryFieldSavePathAlias(
  aliases: Map<string, string>,
  fromPath: string,
  path: string,
) {
  if (fromPath === path) return;
  for (const sourcePath of aliases.keys()) {
    if (resolveEntryFieldSavePath(aliases, sourcePath) === fromPath) {
      aliases.set(sourcePath, path);
    }
  }
  aliases.delete(path);
  aliases.set(fromPath, path);
}
