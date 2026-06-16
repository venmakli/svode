import { useEffect, useRef } from "react";
import { listen } from "@/platform/native/events";
import { readEntry } from "@/platform/entries/entries-api";
import {
  reindexProject,
  unwatchSpace,
  watchSpace,
} from "@/platform/space/space-api";
import { toast } from "sonner";
import type { PlateEditor } from "platejs/react";
import { deserializeWithConflicts } from "../conflict/parse-conflicts";
import { useEntrySelectionStore } from "@/features/entry";
import { useSpaceStore } from "@/features/space/model";
import { useEditorStore } from "../model";
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
}

function isSchemaPath(path: string) {
  return path.split("/").pop() === "schema.yaml";
}

function reindexProjectForSchemaChange() {
  const projectPath = useSpaceStore.getState().activeRootPath;
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
}: UseFileWatcherOptions) {
  const { closeDocument } = useEntrySelectionStore();
  const { refreshTree } = useSpaceStore();
  const { markAiModified, clearAiModified } = useEditorStore();

  const activeDocRef = useRef(activeDocument);

  useEffect(() => {
    activeDocRef.current = activeDocument;
  }, [activeDocument]);

  // Watch/unwatch space
  useEffect(() => {
    if (!spacePath) return;

    watchSpace(spacePath).catch((err) =>
      console.error("Failed to watch space:", err),
    );

    return () => {
      unwatchSpace(spacePath).catch(
        (err) => console.error("Failed to unwatch space:", err),
      );
    };
  }, [spacePath]);

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
        refreshTree();
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
        readEntry(spacePath, changedPath)
          .then((entry) => {
            isLoadingRef.current = true;
            const value = deserializeWithConflicts(editor, entry.body);
            editor.tf.setValue(value as never);
            isLoadingRef.current = false;
          })
          .catch((err) =>
            console.error("Failed to reload document:", err),
          );
      } else {
        // Document not currently open — mark as AI modified
        markAiModified(changedPath);
      }
    }).then((unlisten) => unlisteners.push(unlisten));

    // file:deleted
    listen<FileEvent>("file:deleted", (event) => {
      const deletedPath = event.payload.path;

      if (isSchemaPath(deletedPath)) {
        reindexProjectForSchemaChange();
        refreshTree();
        return;
      }

      if (deletedPath === activeDocRef.current) {
        closeDocument();
        toast.error(m.editor_file_deleted());
      }
      refreshTree();
    }).then((unlisten) => unlisteners.push(unlisten));

    // file:created
    listen<FileEvent>("file:created", (event) => {
      if (isSchemaPath(event.payload.path)) {
        reindexProjectForSchemaChange();
      }
      refreshTree();
    }).then((unlisten) => unlisteners.push(unlisten));

    return () => {
      unlisteners.forEach((fn) => fn());
    };
  }, [editor, spacePath, markAiModified, closeDocument, refreshTree, ownNoncesRef, isDebouncePendingRef, isLoadingRef]);

  // Clear AI modified flag when opening a document
  useEffect(() => {
    if (activeDocument) {
      clearAiModified(activeDocument);
    }
  }, [activeDocument, clearAiModified]);
}
