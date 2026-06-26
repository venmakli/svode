import {
  listenFileChanged,
  listenFileCreated,
  listenFileDeleted,
} from "@/platform/filesystem/file-events-api";
import { listenSpaceSynced } from "@/platform/space/space-events-api";
import type { UnlistenFn } from "@/platform/filesystem/file-events-api";

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

export async function listenCollectionEntryChanges({
  spacePath,
  onEntriesChanged,
}: {
  spacePath: string;
  onEntriesChanged: () => void;
}): Promise<UnlistenFn> {
  const unlisteners = await Promise.all(
    [listenFileCreated, listenFileChanged, listenFileDeleted].map(
      (listenFile) =>
        listenFile((payload) => {
          if (payload.space && payload.space !== spacePath) return;
          if (!isMarkdownEntryPath(payload.path)) return;
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
    listenFileChanged((payload) => {
      if (payload.space && payload.space !== spacePath) return;
      if (isSchemaPath(payload.path)) {
        onQueryInvalidated();
      }
    }),
    listenSpaceSynced((payload) => {
      if (!payload.spacePath || payload.spacePath === spacePath) {
        onQueryInvalidated();
      }
    }),
  ]);

  return combineUnlisteners(unlisteners);
}
