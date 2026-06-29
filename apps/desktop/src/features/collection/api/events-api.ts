import {
  listenFileChanged,
  listenFileCreated,
  listenFileDeleted,
} from "@/platform/filesystem/file-events-api";
import { listenSpaceSynced } from "@/platform/space/space-events-api";
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
  onEntriesChanged,
}: {
  spacePath: string;
  onEntriesChanged: () => void;
}): Promise<UnlistenFn> {
  return listenCollectionDataChanges({
    spacePath,
    onDataChanged: (kind) => {
      if (kind === "entries") onEntriesChanged();
    },
  });
}

export async function listenCollectionDataChanges({
  spacePath,
  onDataChanged,
}: {
  spacePath: string;
  onDataChanged: (kind: CollectionFileChangeKind) => void;
}): Promise<UnlistenFn> {
  const unlisteners = await Promise.all(
    [
      ...[listenFileCreated, listenFileChanged, listenFileDeleted].map(
        (listenFile) =>
          listenFile((payload) => {
            if (payload.space && payload.space !== spacePath) return;
            const kind = collectionFileChangeKind(payload.path);
            if (kind) onDataChanged(kind);
          }),
      ),
      listenSpaceSynced((payload) => {
        if (!payload.spacePath || payload.spacePath === spacePath) {
          onDataChanged("schema");
        }
      }),
    ],
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
  return listenCollectionDataChanges({
    spacePath,
    onDataChanged: (kind) => {
      if (kind === "schema") {
        onQueryInvalidated();
      }
    },
  });
}
