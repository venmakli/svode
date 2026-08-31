import { useEffect, useRef } from "react";
import type { Descendant } from "platejs";
import { readPage } from "@/features/page/page-api";
import { toast } from "sonner";
import type { PlateEditor } from "platejs/react";
import { deserializeWithConflicts } from "../conflict/parse-conflicts";
import { useCloseActiveContent } from "@/features/artifact";
import { getSpaceSnapshot } from "@/features/space";
import { useEditorStore } from "../model";
import { setCachedDocumentValue } from "../model/plate-document-cache";
import * as m from "@/paraglide/messages.js";
import {
  listenToEditorFileChanged,
  listenToEditorFileCreated,
  listenToEditorFileDeleted,
  reindexEditorProject,
} from "../api/editor-file-watch-api";

interface UseFileWatcherOptions {
  editor: PlateEditor | null;
  spacePath: string;
  activeDocument: string | null;
  /** Nonces emitted by our own Page writes — own-write echoes are filtered out. */
  ownNoncesRef: React.RefObject<Set<string>>;
  /** True while a debounce-auto-save is pending for the active document — local-wins. */
  isDebouncePendingRef: React.RefObject<boolean>;
  isLoadingRef: React.RefObject<boolean>;
  onEditorValueReload: (path: string, value: Descendant[]) => Descendant[];
  onPageReloaded?: (page: Awaited<ReturnType<typeof readPage>>) => void;
}

function isSchemaPath(path: string) {
  return path.split("/").pop() === "schema.yaml";
}

function reindexProjectForSchemaChange() {
  const projectPath = getSpaceSnapshot().activeRootPath;
  if (!projectPath) return;
  reindexEditorProject(projectPath).catch((err) =>
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
  onPageReloaded,
}: UseFileWatcherOptions) {
  const closeDocument = useCloseActiveContent();
  const { markAiModified, clearAiModified } = useEditorStore();

  const activeDocRef = useRef(activeDocument);

  useEffect(() => {
    activeDocRef.current = activeDocument;
  }, [activeDocument]);

  // Listen to file events
  useEffect(() => {
    if (!spacePath) return;

    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const trackUnlisten = (unlisten: () => void) => {
      if (disposed) {
        unlisten();
        return;
      }
      unlisteners.push(unlisten);
    };

    // file:changed
    listenToEditorFileChanged((event) => {
      if (event.space && event.space !== spacePath) return;

      const changedPath = event.path;
      const nonce = event.writeNonce;

      if (isSchemaPath(changedPath)) {
        reindexProjectForSchemaChange();
        return;
      }

      // Own-write echo filter: drop events produced by our own Page write.
      if (nonce && ownNoncesRef.current.has(nonce)) {
        ownNoncesRef.current.delete(nonce);
        return;
      }

      // Ignore events from structural operations (nest/move/unnest)
      if (useEditorStore.getState().isSuppressed(spacePath, changedPath)) {
        return;
      }

      if (changedPath === activeDocRef.current && editor) {
        // Local-wins: debounce pending for this doc — our buffered write will
        // land within 1s and overwrite the external change on disk.
        if (isDebouncePendingRef.current) {
          return;
        }
        // Debounce not active — reload from disk.
        readPage({ spacePath, path: changedPath })
          .then((page) => {
            isLoadingRef.current = true;
            try {
              const value = deserializeWithConflicts(editor, page.body);
              const loadedValue = onEditorValueReload(changedPath, value);
              setCachedDocumentValue(spacePath, changedPath, loadedValue);
              useEditorStore.getState().clearUnsaved(spacePath, changedPath);
              onPageReloaded?.(page);
            } finally {
              isLoadingRef.current = false;
            }
          })
          .catch((err) => console.error("Failed to reload document:", err));
      } else {
        // Document not currently open — mark cache stale until it is opened.
        markAiModified(spacePath, changedPath);
      }
    }).then(trackUnlisten);

    // file:deleted
    listenToEditorFileDeleted((event) => {
      if (event.space && event.space !== spacePath) return;

      const deletedPath = event.path;

      if (isSchemaPath(deletedPath)) {
        reindexProjectForSchemaChange();
        return;
      }

      if (deletedPath === activeDocRef.current) {
        closeDocument();
        toast.error(m.editor_file_deleted());
      }
    }).then(trackUnlisten);

    // file:created
    listenToEditorFileCreated((event) => {
      if (event.space && event.space !== spacePath) return;

      if (isSchemaPath(event.path)) {
        reindexProjectForSchemaChange();
      }
    }).then(trackUnlisten);

    return () => {
      disposed = true;
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
    onPageReloaded,
  ]);

  // Clear external-edit reload flag when opening a document.
  useEffect(() => {
    if (activeDocument) {
      clearAiModified(spacePath, activeDocument);
    }
  }, [activeDocument, clearAiModified, spacePath]);
}
