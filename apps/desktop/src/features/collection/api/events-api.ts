import {
  listenFileChanged,
  listenFileCreated,
  listenFileDeleted,
} from "@/platform/filesystem/file-events-api";
import type { UnlistenFn } from "@/platform/filesystem/file-events-api";
import {
  collectionFileChangeKind,
  type CollectionFileChangeKind,
} from "../lib/file-refresh-events";

function combineUnlisteners(unlisteners: UnlistenFn[]): UnlistenFn {
  return () => {
    for (const unlisten of unlisteners) unlisten();
  };
}

export async function listenCollectionEntryChanges({
  spacePath,
  collectionPath,
  onEntriesChanged,
}: {
  spacePath: string;
  collectionPath: string;
  onEntriesChanged: () => void;
}): Promise<UnlistenFn> {
  return listenCollectionDataChanges({
    spacePath,
    collectionPath,
    onDataChanged: (kind) => {
      if (kind === "entries") onEntriesChanged();
    },
  });
}

export async function listenCollectionDataChanges({
  spacePath,
  collectionPath,
  onDataChanged,
}: {
  spacePath: string;
  collectionPath: string;
  onDataChanged: (kind: CollectionFileChangeKind) => void;
}): Promise<UnlistenFn> {
  const unlisteners = await Promise.all([
    ...[listenFileCreated, listenFileChanged, listenFileDeleted].map(
      (listenFile) =>
        listenFile((payload) => {
          if (payload.space && payload.space !== spacePath) return;
          const kind = collectionFileChangeKind(payload.path, collectionPath);
          if (kind) onDataChanged(kind);
        }),
      ),
  ]);

  return combineUnlisteners(unlisteners);
}

export async function listenCollectionQueryInvalidations({
  spacePath,
  collectionPath,
  onQueryInvalidated,
}: {
  spacePath: string;
  collectionPath: string;
  onQueryInvalidated: () => void;
}): Promise<UnlistenFn> {
  return listenCollectionDataChanges({
    spacePath,
    collectionPath,
    onDataChanged: (kind) => {
      if (kind === "schema") {
        onQueryInvalidated();
      }
    },
  });
}
