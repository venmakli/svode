import { useEffect, useRef } from "react";
import { getSpaceSnapshot } from "@/features/space";
import { useEditorStore } from "../model";
import {
  type EditorFileEvent,
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

    // Own-write echoes and structural operations (nest/move/unnest) are not
    // changes of the source by another writer.
    const isOwnChange = (event: EditorFileEvent) => {
      const nonce = event.writeNonce;
      if (nonce && ownNoncesRef.current.has(nonce)) {
        ownNoncesRef.current.delete(nonce);
        return true;
      }
      return useEditorStore.getState().isSuppressed(spacePath, event.path);
    };

    // file:changed
    listenToEditorFileChanged((event) => {
      if (event.space && event.space !== spacePath) return;

      const changedPath = event.path;

      if (isSchemaPath(changedPath)) {
        reindexProjectForSchemaChange();
        return;
      }

      if (isOwnChange(event)) return;

      if (changedPath === activeDocRef.current) {
        // Reloaded without a draft; a draft against a changed body is kept
        // for an explicit choice instead of being written over the change.
        onActiveDocumentChanged(changedPath);
      } else {
        // Document not currently open — mark cache stale until it is opened.
        markAiModified(spacePath, changedPath);
      }
    }).then(trackUnlisten);

    // file:deleted — a gone document is closed by the Page detail that shows it.
    listenToEditorFileDeleted((event) => {
      if (event.space && event.space !== spacePath) return;

      if (isSchemaPath(event.path)) {
        reindexProjectForSchemaChange();
      }
    }).then(trackUnlisten);

    // file:created — an external replacement of the open document may arrive
    // as a creation of its path; the source sync treats it as a change.
    listenToEditorFileCreated((event) => {
      if (event.space && event.space !== spacePath) return;

      if (isSchemaPath(event.path)) {
        reindexProjectForSchemaChange();
        return;
      }

      if (event.path !== activeDocRef.current || isOwnChange(event)) return;
      onActiveDocumentChanged(event.path);
    }).then(trackUnlisten);

    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [spacePath, markAiModified, ownNoncesRef, onActiveDocumentChanged]);

  // Clear external-edit reload flag when opening a document.
  useEffect(() => {
    if (activeDocument) {
      clearAiModified(spacePath, activeDocument);
    }
  }, [activeDocument, clearAiModified, spacePath]);
}
