import { useEffect, useRef } from "react";
import type { Descendant } from "platejs";
import { listen } from "@/platform/native/events";
import { readEntry } from "@/features/entry/api";
import { reindexProject } from "@/platform/space/space-api";
import { toast } from "sonner";
import type { PlateEditor } from "platejs/react";
import { deserializeWithConflicts } from "../conflict/parse-conflicts";
import { useCloseEntryDocument } from "@/features/entry/selection";
import { getSpaceSnapshot } from "@/features/space";
import { useEditorStore } from "../model";
import { setCachedDocumentValue } from "../model/plate-document-cache";
import * as m from "@/paraglide/messages.js";

interface FileEvent {
  path: string;
  writeNonce?: string;
}

interface UseFileWatcherOptions {
  editor: PlateEditor | null;
  spacePath: string;
  activeDocument: string | null;
  /** Nonces emitted by our own `write_entry` calls — own-write echoes are filtered out. */
  ownNoncesRef: React.RefObject<Set<string>>;
  /** True while a debounce-auto-save is pending for the active document — local-wins. */
  isDebouncePendingRef: React.RefObject<boolean>;
  isLoadingRef: React.RefObject<boolean>;
  onEditorValueReload: (path: string, value: Descendant[]) => Descendant[];
  onEntryReloaded?: (entry: Awaited<ReturnType<typeof readEntry>>) => void;
}

function isSchemaPath(path: string) {
  return path.split("/").pop() === "schema.yaml";
}

function reindexProjectForSchemaChange() {
  const projectPath = getSpaceSnapshot().activeRootPath;
  if (!projectPath) return;
  reindexProject(projectPath).catch((err) =>
    console.warn("Failed to reindex after schema change:", err),
  );
}

export function useFileWatcher({
  editor,
  spacePath,
  activeDocument,
  ownNoncesRef,
  isDebouncePendingRef,
  isLoadingRef,
  onEditorValueReload,
  onEntryReloaded,
}: UseFileWatcherOptions) {
  const closeDocument = useCloseEntryDocument();
  const { markAiModified, clearAiModified } = useEditorStore();

  const activeDocRef = useRef(activeDocument);

  useEffect(() => {
    activeDocRef.current = activeDocument;
  }, [activeDocument]);

  // Listen to file events
  useEffect(() => {
    if (!spacePath) return;

    const unlisteners: Array<() => void> = [];

    // file:changed
    listen<FileEvent>("file:changed", (event) => {
      const changedPath = event.payload.path;
      const nonce = event.payload.writeNonce;

      if (isSchemaPath(changedPath)) {
        reindexProjectForSchemaChange();
        return;
      }

      // Own-write echo filter: drop events produced by our own write_entry.
      if (nonce && ownNoncesRef.current.has(nonce)) {
        ownNoncesRef.current.delete(nonce);
        return;
      }

      // Ignore events from structural operations (nest/move/unnest)
      if (useEditorStore.getState().isSuppressed(changedPath)) {
        return;
      }

      if (changedPath === activeDocRef.current && editor) {
        // Local-wins: debounce pending for this doc — our buffered write will
        // land within 1s and overwrite the external change on disk.
        if (isDebouncePendingRef.current) {
          return;
        }
        // Debounce not active — reload from disk.
        readEntry({ spacePath, path: changedPath })
          .then((entry) => {
            isLoadingRef.current = true;
            try {
              const value = deserializeWithConflicts(editor, entry.body);
              const loadedValue = onEditorValueReload(changedPath, value);
              setCachedDocumentValue(spacePath, changedPath, loadedValue);
              onEntryReloaded?.(entry);
            } finally {
              isLoadingRef.current = false;
            }
          })
          .catch((err) => console.error("Failed to reload document:", err));
      } else {
        // Document not currently open — mark cache stale until it is opened.
        markAiModified(changedPath);
      }
    }).then((unlisten) => unlisteners.push(unlisten));

    // file:deleted
    listen<FileEvent>("file:deleted", (event) => {
      const deletedPath = event.payload.path;

      if (isSchemaPath(deletedPath)) {
        reindexProjectForSchemaChange();
        return;
      }

      if (deletedPath === activeDocRef.current) {
        closeDocument();
        toast.error(m.editor_file_deleted());
      }
    }).then((unlisten) => unlisteners.push(unlisten));

    // file:created
    listen<FileEvent>("file:created", (event) => {
      if (isSchemaPath(event.payload.path)) {
        reindexProjectForSchemaChange();
      }
    }).then((unlisten) => unlisteners.push(unlisten));

    return () => {
      unlisteners.forEach((fn) => fn());
    };
  }, [
    editor,
    spacePath,
    markAiModified,
    closeDocument,
    ownNoncesRef,
    isDebouncePendingRef,
    isLoadingRef,
    onEditorValueReload,
    onEntryReloaded,
  ]);

  // Clear external-edit reload flag when opening a document.
  useEffect(() => {
    if (activeDocument) {
      clearAiModified(activeDocument);
    }
  }, [activeDocument, clearAiModified]);
}
