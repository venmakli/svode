import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import type { PlateEditor } from "platejs/react";
import { deserializeWithConflicts } from "./conflict/parse-conflicts";
import { useLayoutStore } from "@/stores/layout";
import { useWorkspaceStore } from "@/stores/workspace";
import { useEditorStore } from "@/stores/editor";
import * as m from "@/paraglide/messages.js";

interface FileEvent {
  path: string;
  workspace: string;
}

interface UseFileWatcherOptions {
  editor: PlateEditor | null;
  workspacePath: string;
  activeDocument: string | null;
  onConflict: (path: string) => void;
  justSavedRef: React.RefObject<boolean>;
  isLoadingRef: React.RefObject<boolean>;
}

export function useFileWatcher({
  editor,
  workspacePath,
  activeDocument,
  onConflict,
  justSavedRef,
  isLoadingRef,
}: UseFileWatcherOptions) {
  const { closeDocument } = useLayoutStore();
  const { refreshTree } = useWorkspaceStore();
  const { unsavedChanges, markAiModified, clearAiModified } = useEditorStore();

  const activeDocRef = useRef(activeDocument);
  const unsavedRef = useRef(unsavedChanges);

  useEffect(() => {
    activeDocRef.current = activeDocument;
  }, [activeDocument]);

  useEffect(() => {
    unsavedRef.current = unsavedChanges;
  }, [unsavedChanges]);

  // Watch/unwatch workspace
  useEffect(() => {
    if (!workspacePath) return;

    invoke("watch_workspace", { workspace: workspacePath }).catch((err) =>
      console.error("Failed to watch workspace:", err),
    );

    return () => {
      invoke("unwatch_workspace", { workspace: workspacePath }).catch(
        (err) => console.error("Failed to unwatch workspace:", err),
      );
    };
  }, [workspacePath]);

  // Listen to file events
  useEffect(() => {
    if (!workspacePath) return;

    const unlisteners: Array<() => void> = [];

    // file:changed
    listen<FileEvent>("file:changed", (event) => {
      const changedPath = event.payload.path;

      // Ignore events from structural operations (nest/move/unnest)
      if (useEditorStore.getState().isSuppressed(changedPath)) {
        return;
      }

      // Ignore file change events triggered by our own save.
      // Don't reset here — multiple FS events can arrive from a single write.
      // Cleared by onUpdate (next user edit) or document switch.
      if (changedPath === activeDocRef.current && justSavedRef.current) {
        return;
      }

      if (changedPath === activeDocRef.current && editor) {
        // Document is currently open
        if (unsavedRef.current[changedPath]) {
          // Has unsaved edits — show conflict dialog
          onConflict(changedPath);
        } else {
          // No unsaved edits — silently reload
          invoke<{
            meta: { id: string; title: string; icon: string | null; created: string; updated: string };
            body: string;
            path: string;
          }>("read_entry", {
            workspace: workspacePath,
            path: changedPath,
          })
            .then((entry) => {
              isLoadingRef.current = true;
              const value = deserializeWithConflicts(editor, entry.body);
              editor.tf.setValue(value as never);
              isLoadingRef.current = false;
            })
            .catch((err) =>
              console.error("Failed to reload document:", err),
            );
        }
      } else {
        // Document not currently open — mark as AI modified
        markAiModified(changedPath);
      }
    }).then((unlisten) => unlisteners.push(unlisten));

    // file:deleted
    listen<FileEvent>("file:deleted", (event) => {
      const deletedPath = event.payload.path;

      if (deletedPath === activeDocRef.current) {
        closeDocument();
        toast.error(m.editor_file_deleted());
      }
      refreshTree();
    }).then((unlisten) => unlisteners.push(unlisten));

    // file:created
    listen<FileEvent>("file:created", () => {
      refreshTree();
    }).then((unlisten) => unlisteners.push(unlisten));

    return () => {
      unlisteners.forEach((fn) => fn());
    };
  }, [editor, workspacePath, onConflict, markAiModified, closeDocument, refreshTree]);

  // Clear AI modified flag when opening a document
  useEffect(() => {
    if (activeDocument) {
      clearAiModified(activeDocument);
    }
  }, [activeDocument, clearAiModified]);
}
