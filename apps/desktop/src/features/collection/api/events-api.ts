import { listen, type UnlistenFn } from "@/platform/native/events";

interface FileEventDto {
  path: string;
}

interface SpaceSyncedEventDto {
  projectPath?: string;
  spacePath?: string;
  path?: string;
}

function isMarkdownEntryPath(path: string) {
  return path.replace(/\\/g, "/").toLowerCase().endsWith(".md");
}

function isSchemaPath(path: string) {
  return path.split("/").pop() === "schema.yaml";
}

function combineUnlisteners(unlisteners: UnlistenFn[]): UnlistenFn {
  return () => {
    for (const unlisten of unlisteners) unlisten();
  };
}

export async function listenCollectionEntryChanges(
  onEntriesChanged: () => void,
): Promise<UnlistenFn> {
  const unlisteners = await Promise.all(
    ["file:created", "file:changed", "file:deleted"].map((eventName) =>
      listen<FileEventDto>(eventName, (event) => {
        if (!isMarkdownEntryPath(event.payload.path)) return;
        onEntriesChanged();
      }),
    ),
  );

  return combineUnlisteners(unlisteners);
}

export async function listenCollectionQueryInvalidations({
  spacePath,
  onQueryInvalidated,
}: {
  spacePath: string;
  onQueryInvalidated: () => void;
}): Promise<UnlistenFn> {
  const unlisteners = await Promise.all([
    listen<FileEventDto>("file:changed", (event) => {
      if (isSchemaPath(event.payload.path)) {
        onQueryInvalidated();
      }
    }),
    listen<SpaceSyncedEventDto>("space:synced", (event) => {
      if (!event.payload.spacePath || event.payload.spacePath === spacePath) {
        onQueryInvalidated();
      }
    }),
  ]);

  return combineUnlisteners(unlisteners);
}
