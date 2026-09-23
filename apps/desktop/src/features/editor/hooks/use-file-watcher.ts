import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useCloseActiveContent } from "@/features/artifact";
import { getSpaceSnapshot } from "@/features/space";
import { useEditorStore } from "../model";
import * as m from "@/paraglide/messages.js";
import {
  listenToEditorFileChanged,
  listenToEditorFileCreated,
  listenToEditorFileDeleted,
  reindexEditorProject,
} from "../api/editor-file-watch-api";

interface UseFileWatcherOptions {
  spacePath: string;
  activeDocument: string | null;
  /** Nonces emitted by our own Page writes — own-write echoes are filtered out. */
  ownNoncesRef: React.RefObject<Set<string>>;
  /** Another writer changed the active document's source. */
  onActiveDocumentChanged: (path: string) => void;
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
  spacePath,
  activeDocument,
  ownNoncesRef,
  onActiveDocumentChanged,
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

      if (changedPath === activeDocRef.current) {
        // Reloaded without a draft; a draft against a changed body is kept
        // for an explicit choice instead of being written over the change.
        onActiveDocumentChanged(changedPath);
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
    spacePath,
    markAiModified,
    closeDocument,
    ownNoncesRef,
    onActiveDocumentChanged,
  ]);

  // Clear external-edit reload flag when opening a document.
  useEffect(() => {
    if (activeDocument) {
      clearAiModified(spacePath, activeDocument);
    }
  }, [activeDocument, clearAiModified, spacePath]);
}
