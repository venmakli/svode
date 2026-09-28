import {
  listenFileChanged,
  listenFileCreated,
  listenFileDeleted,
  type UnlistenFn,
} from "@/platform/filesystem/file-events-api";

export type PageSourceEventKind = "created" | "changed" | "deleted";

/** Watcher events of one Space, for the Page detail that shows its files. */
export async function listenPageSourceEvents({
  spacePath,
  onEvent,
}: {
  spacePath: string;
  onEvent: (path: string, kind: PageSourceEventKind) => void;
}): Promise<UnlistenFn> {
  const unlisteners = await Promise.all(
    (
      [
        ["created", listenFileCreated],
        ["changed", listenFileChanged],
        ["deleted", listenFileDeleted],
      ] as const
    ).map(([kind, listenFile]) =>
      listenFile((payload) => {
        if (payload.space && payload.space !== spacePath) return;
        onEvent(payload.path, kind);
      }),
    ),
  );
  return () => {
    for (const unlisten of unlisteners) unlisten();
  };
}
