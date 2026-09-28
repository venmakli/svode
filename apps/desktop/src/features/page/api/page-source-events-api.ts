import {
  listenFileChanged,
  listenFileCreated,
  listenFileDeleted,
  type UnlistenFn,
} from "@/platform/filesystem/file-events-api";

/** Watcher events of one Space, for the Page detail that shows its files. */
export async function listenPageSourceEvents({
  spacePath,
  onEvent,
}: {
  spacePath: string;
  onEvent: (path: string) => void;
}): Promise<UnlistenFn> {
  const unlisteners = await Promise.all(
    [listenFileCreated, listenFileChanged, listenFileDeleted].map(
      (listenFile) =>
        listenFile((payload) => {
          if (payload.space && payload.space !== spacePath) return;
          onEvent(payload.path);
        }),
    ),
  );
  return () => {
    for (const unlisten of unlisteners) unlisten();
  };
}
