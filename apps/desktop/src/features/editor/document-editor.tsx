import { useEffect, useCallback, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { getExtensions } from "./extensions";
import { TitleZone } from "./title-zone";
import { FrontmatterPanel } from "./frontmatter-panel";
import { EditorBubbleMenu } from "./bubble-menu";
import { useFileWatcher } from "./use-file-watcher";
import { useLayoutStore } from "@/stores/layout";
import { useWorkspaceStore } from "@/stores/workspace";
import { useEditorStore } from "@/stores/editor";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import * as m from "@/paraglide/messages.js";
import "./editor-styles.css";

interface EntryMeta {
  id: string;
  title: string;
  icon: string | null;
  created: string;
  updated: string;
  extra: Record<string, unknown>;
}

interface Entry {
  meta: EntryMeta;
  body: string;
  path: string;
}

export function DocumentEditor() {
  const { activeDocument } = useLayoutStore();
  const { workspaces, activeWorkspaceId } = useWorkspaceStore();
  const { markUnsaved, clearUnsaved } = useEditorStore();

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const workspacePath = activeWorkspace?.path ?? "";

  const isLoadingRef = useRef(false);
  const currentPathRef = useRef<string | null>(null);
  const justSavedRef = useRef(false);

  const [meta, setMeta] = useState<EntryMeta | null>(null);
  const [title, setTitle] = useState("");
  const [icon, setIcon] = useState<string | null>(null);
  const [frontmatterOpen, setFrontmatterOpen] = useState(false);
  const [conflictPath, setConflictPath] = useState<string | null>(null);

  const editor = useEditor({
    extensions: getExtensions(m.editor_placeholder_body()),
    editable: true,
    editorProps: {
      attributes: {
        class: "tiptap prose-editor min-h-[300px] focus:outline-none",
      },
    },
    onUpdate: () => {
      if (!isLoadingRef.current && currentPathRef.current) {
        markUnsaved(currentPathRef.current);
      }
    },
  });

  // Load document when activeDocument changes
  useEffect(() => {
    if (!editor || !activeDocument || !workspacePath) return;

    currentPathRef.current = activeDocument;
    isLoadingRef.current = true;

    invoke<Entry>("read_entry", {
      workspace: workspacePath,
      path: activeDocument,
    })
      .then((entry) => {
        setMeta(entry.meta);
        setTitle(entry.meta.title);
        setIcon(entry.meta.icon);
        editor.commands.setContent(entry.body);
        clearUnsaved(activeDocument);
      })
      .catch((err) => {
        console.error("Failed to load document:", err);
        toast.error(m.editor_error_load());
      })
      .finally(() => {
        isLoadingRef.current = false;
      });
  }, [editor, activeDocument, workspacePath]);

  // Mark unsaved on title/icon change
  const handleTitleChange = useCallback(
    (newTitle: string) => {
      setTitle(newTitle);
      if (currentPathRef.current) {
        markUnsaved(currentPathRef.current);
      }
    },
    [markUnsaved],
  );

  const handleIconChange = useCallback(
    (newIcon: string) => {
      setIcon(newIcon);
      if (currentPathRef.current) {
        markUnsaved(currentPathRef.current);
      }
    },
    [markUnsaved],
  );

  const handleExtraChange = useCallback(
    (newExtra: Record<string, unknown>) => {
      setMeta((prev) => (prev ? { ...prev, extra: newExtra } : prev));
      if (currentPathRef.current) {
        markUnsaved(currentPathRef.current);
      }
    },
    [markUnsaved],
  );

  // Save handler
  const handleSave = useCallback(() => {
    if (!editor || !activeDocument || !workspacePath) return;

    const markdown = (editor.storage as any).markdown?.getMarkdown() ?? "";

    justSavedRef.current = true;

    invoke("write_entry", {
      workspace: workspacePath,
      path: activeDocument,
      content: markdown,
      title: title || m.editor_untitled(),
      icon: icon,
      extra: meta?.extra ?? null,
    })
      .then(() => {
        clearUnsaved(activeDocument);
        toast.success(m.editor_save_success());
      })
      .catch((err) => {
        console.error("Failed to save document:", err);
        toast.error(m.editor_error_save());
      });
  }, [editor, activeDocument, workspacePath, title, icon, clearUnsaved]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "p") {
        e.preventDefault();
        setFrontmatterOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave]);

  // File watcher
  const handleConflict = useCallback((path: string) => {
    setConflictPath(path);
  }, []);

  useFileWatcher({
    editor,
    workspacePath,
    activeDocument,
    onConflict: handleConflict,
    justSavedRef,
  });

  // Conflict resolution: reload from disk
  const handleConflictReload = useCallback(() => {
    if (!editor || !conflictPath || !workspacePath) return;

    invoke<Entry>("read_entry", {
      workspace: workspacePath,
      path: conflictPath,
    })
      .then((entry) => {
        setMeta(entry.meta);
        setTitle(entry.meta.title);
        setIcon(entry.meta.icon);
        editor.commands.setContent(entry.body);
        clearUnsaved(conflictPath);
      })
      .catch((err) => {
        console.error("Failed to reload document:", err);
        toast.error(m.editor_error_load());
      })
      .finally(() => {
        setConflictPath(null);
      });
  }, [editor, conflictPath, workspacePath, clearUnsaved]);

  if (!editor) {
    return null;
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-12 py-8">
        <TitleZone
          title={title}
          icon={icon}
          onTitleChange={handleTitleChange}
          onIconChange={handleIconChange}
          onEnter={() => editor.commands.focus("start")}
        />
        <FrontmatterPanel
          meta={meta}
          isOpen={frontmatterOpen}
          onOpenChange={setFrontmatterOpen}
          onExtraChange={handleExtraChange}
        />
        <EditorBubbleMenu editor={editor} />
        <EditorContent editor={editor} />
      </div>

      {/* Conflict dialog */}
      <AlertDialog
        open={conflictPath !== null}
        onOpenChange={(open) => {
          if (!open) setConflictPath(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.editor_conflict_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.editor_conflict_description()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConflictPath(null)}>
              {m.editor_conflict_keep()}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleConflictReload}>
              {m.editor_conflict_reload()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
