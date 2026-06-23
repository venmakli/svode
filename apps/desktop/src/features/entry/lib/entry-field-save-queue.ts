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
