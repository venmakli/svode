import { useEffect, useCallback, useRef, useState } from "react";
import type { Descendant } from "platejs";
import { Plate, usePlateEditor } from "platejs/react";
import { MarkdownPlugin } from "@platejs/markdown";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { EditorKit } from "@/components/editor/editor-kit";
import { TitleZone } from "../title-zone";
import { FrontmatterPanel } from "../frontmatter-panel";
import { useFileWatcher } from "../use-file-watcher";
import { useLayoutStore } from "@/stores/layout";
import { useWorkspaceStore } from "@/stores/workspace";
import { useEditorStore } from "@/stores/editor";
import {
  commitAllWorkspace,
  commitFileAndMaybeSync,
  syncWorkspace,
} from "@/features/workspace/git-actions";
import { useGitStore } from "@/stores/git";
import { deserializeWithConflicts, hasUnresolvedConflicts } from "../conflict/parse-conflicts";
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
import { Editor, EditorContainer } from "@/components/ui/editor";
import { FixedToolbar } from "@/components/ui/fixed-toolbar";
import { FixedToolbarButtons } from "@/components/ui/fixed-toolbar-buttons";
import { TocSidebar } from "../toc-sidebar";
import * as m from "@/paraglide/messages.js";

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

export function PlateDocumentEditor() {
  const { activeDocument, activeDocumentWorkspaceId, openDocument } = useLayoutStore();
  const { updateNodeMeta, rootWorkspaces, children: childWorkspaces } = useWorkspaceStore();
  const { markUnsaved, clearUnsaved, pendingRename, clearPendingRename, setBrokenLinks } = useEditorStore();

  // Resolve workspace path from the document's workspace id
  const docWs = activeDocumentWorkspaceId
    ? [...rootWorkspaces, ...childWorkspaces].find((w) => w.id === activeDocumentWorkspaceId)
    : null;
  const workspacePath = docWs?.path ?? "";
  const activeWsId = activeDocumentWorkspaceId;

  const isLoadingRef = useRef(false);
  const currentPathRef = useRef<string | null>(null);
  const justSavedRef = useRef(false);
  const titleRef = useRef("");
  const iconRef = useRef<string | null>(null);
  const docCacheRef = useRef(new Map<string, Descendant[]>());

  const [meta, setMeta] = useState<EntryMeta | null>(null);
  const [title, setTitle] = useState("");
  const [icon, setIcon] = useState<string | null>(null);
  const [frontmatterOpen, setFrontmatterOpen] = useState(false);
  const [conflictPath, setConflictPath] = useState<string | null>(null);

  // Keep refs in sync with state for stable callback access
  useEffect(() => {
    titleRef.current = title;
  }, [title]);
  useEffect(() => {
    iconRef.current = icon;
  }, [icon]);

  const editor = usePlateEditor({
    plugins: EditorKit,
  });

  // Load document when activeDocument changes
  useEffect(() => {
    if (!editor || !activeDocument || !workspacePath) return;

    // Cache current editor state before switching
    const prevPath = currentPathRef.current;
    if (prevPath && prevPath !== activeDocument) {
      docCacheRef.current.set(prevPath, editor.children);
    }

    currentPathRef.current = activeDocument;
    isLoadingRef.current = true;
    justSavedRef.current = false;

    // Validate links in background
    invoke<{ url: string; exists: boolean }[]>("validate_links", {
      workspace: workspacePath,
      path: activeDocument,
    })
      .then((results) => {
        const broken = new Set(
          results.filter((r) => !r.exists).map((r) => r.url),
        );
        setBrokenLinks(broken);
      })
      .catch(() => setBrokenLinks(new Set()));

    // Use cached Plate value if available and file wasn't modified externally
    const cached = docCacheRef.current.get(activeDocument);
    const wasExternallyModified =
      useEditorStore.getState().aiModified[activeDocument];

    if (cached && !wasExternallyModified) {
      invoke<Entry>("read_entry", {
        workspace: workspacePath,
        path: activeDocument,
      })
        .then((entry) => {
          setMeta(entry.meta);
          setTitle(entry.meta.title);
          setIcon(entry.meta.icon);
          editor.tf.setValue(cached);
          clearUnsaved(activeDocument);
        })
        .catch((err) => {
          console.error("Failed to load document meta:", err);
          toast.error(m.editor_error_load());
        })
        .finally(() => {
          isLoadingRef.current = false;
        });
    } else {
      docCacheRef.current.delete(activeDocument);
      invoke<Entry>("read_entry", {
        workspace: workspacePath,
        path: activeDocument,
      })
        .then((entry) => {
          setMeta(entry.meta);
          setTitle(entry.meta.title);
          setIcon(entry.meta.icon);
          const value = deserializeWithConflicts(editor, entry.body);
          editor.tf.setValue(value);
          clearUnsaved(activeDocument);
        })
        .catch((err) => {
          console.error("Failed to load document:", err);
          toast.error(m.editor_error_load());
        })
        .finally(() => {
          isLoadingRef.current = false;
        });
    }
  }, [editor, activeDocument, workspacePath]);

  // Mark unsaved on title/icon change + sync sidebar
  const handleTitleChange = useCallback(
    (newTitle: string) => {
      setTitle(newTitle);
      if (currentPathRef.current && activeWsId) {
        markUnsaved(currentPathRef.current);
        updateNodeMeta(activeWsId, currentPathRef.current, newTitle, iconRef.current);
      }
    },
    [markUnsaved, updateNodeMeta, activeWsId],
  );

  // Apply pending rename from sidebar (file already renamed on disk)
  useEffect(() => {
    if (!pendingRename || pendingRename.path !== activeDocument || !editor) return;
    const { title: newTitle, newPath } = pendingRename;
    clearPendingRename();

    setTitle(newTitle);
    titleRef.current = newTitle;

    if (newPath) {
      // File was renamed on disk — cache editor content for new path and switch
      docCacheRef.current.set(newPath, editor.children);
      docCacheRef.current.delete(pendingRename.path);
      clearUnsaved(pendingRename.path);
      openDocument(newPath);
    } else {
      // Slug unchanged, just update sidebar
      if (currentPathRef.current && activeWsId) {
        updateNodeMeta(activeWsId, currentPathRef.current, newTitle, iconRef.current);
      }
    }
  }, [pendingRename, activeDocument, editor, clearPendingRename, clearUnsaved, openDocument, updateNodeMeta]);

  const handleIconChange = useCallback(
    (newIcon: string) => {
      setIcon(newIcon);
      if (currentPathRef.current && activeWsId) {
        markUnsaved(currentPathRef.current);
        updateNodeMeta(activeWsId, currentPathRef.current, titleRef.current, newIcon);
      }
    },
    [markUnsaved, updateNodeMeta, activeWsId],
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

    // Prevent saving while unresolved conflict blocks remain — otherwise the
    // markdown serializer would silently drop them.
    if (hasUnresolvedConflicts(editor.children)) {
      toast.error(m.git_sync_conflict({ count: "1" }));
      return;
    }

    const markdown = editor.getApi(MarkdownPlugin).markdown.serialize();

    justSavedRef.current = true;

    invoke<{ new_path: string | null; modified_files: string[] }>("write_entry", {
      workspace: workspacePath,
      path: activeDocument,
      content: markdown,
      title: title || m.editor_untitled(),
      icon: icon,
      extra: meta?.extra ?? null,
      existingId: meta?.id ?? null,
    })
      .then((result) => {
        clearUnsaved(activeDocument);

        if (result.new_path) {
          // File was renamed — update caches and stores
          docCacheRef.current.delete(activeDocument);
          if (editor) {
            docCacheRef.current.set(result.new_path, editor.children);
          }
          useLayoutStore.getState().openDocument(result.new_path);
          if (activeWsId) {
            useWorkspaceStore.getState().refreshTree(activeWsId);
          }
        } else {
          if (editor) {
            docCacheRef.current.set(activeDocument, editor.children);
          }
        }

        // Mark files with updated backlinks for reload
        for (const f of result.modified_files) {
          useEditorStore.getState().markAiModified(f);
          docCacheRef.current.delete(f);
        }

        // Stage 3 — auto-commit the saved file (and auto-sync if enabled).
        // No success toast — the sidebar git indicator is the visible feedback.
        const committedPath = result.new_path ?? activeDocument;
        if (workspacePath) {
          // If the workspace is mid-merge (conflicts present), the file save
          // is actually a conflict-resolution save. Call git_resolve_continue
          // which runs add+commit+push against the pending merge.
          const status = useGitStore.getState().statuses[workspacePath];
          if (status?.hasConflicts) {
            invoke("git_resolve_continue", { workspacePath })
              .then(() => {
                void useGitStore.getState().refreshStatus(workspacePath);
                void syncWorkspace(workspacePath);
              })
              .catch((err) => {
                console.error("git_resolve_continue failed:", err);
                toast.error(m.git_sync_failed());
              });
          } else {
            void commitFileAndMaybeSync(workspacePath, committedPath);
          }
        }
      })
      .catch((err) => {
        console.error("Failed to save document:", err);
        toast.error(m.editor_error_save());
      });
  }, [editor, activeDocument, workspacePath, title, icon, clearUnsaved]);

  // Save-all (⌘⇧S): flush the currently-open document's in-memory edits to
  // disk (if dirty), then `git add . && git commit` through commitAllWorkspace
  // — which catches every other on-disk change too (externally-modified files,
  // AI writes, backlink updates).
  //
  // Note: multi-document editors aren't wired yet. When they are, this hook
  // should iterate unsavedChanges and flush each editor instance before
  // calling commitAllWorkspace.
  const handleSaveAll = useCallback(async () => {
    if (!workspacePath) return;
    if (!editor || !activeDocument) {
      void commitAllWorkspace(workspacePath);
      return;
    }
    const isDirty = useEditorStore.getState().unsavedChanges[activeDocument];
    if (!isDirty) {
      void commitAllWorkspace(workspacePath);
      return;
    }
    // Prevent double-commit: handleSave would otherwise call
    // commitFileAndMaybeSync on its own. Write the file directly and let
    // commitAllWorkspace own the single commit.
    if (hasUnresolvedConflicts(editor.children)) {
      toast.error(m.git_sync_conflict({ count: "1" }));
      return;
    }
    const markdown = editor.getApi(MarkdownPlugin).markdown.serialize();
    justSavedRef.current = true;
    try {
      await invoke("write_entry", {
        workspace: workspacePath,
        path: activeDocument,
        content: markdown,
        title: title || m.editor_untitled(),
        icon: icon,
        extra: meta?.extra ?? null,
        existingId: meta?.id ?? null,
      });
      clearUnsaved(activeDocument);
      await commitAllWorkspace(workspacePath);
    } catch (err) {
      console.error("Save-all failed:", err);
      toast.error(m.editor_error_save());
    }
  }, [editor, activeDocument, workspacePath, title, icon, meta, clearUnsaved]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSaveAll();
        return;
      }
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
  }, [handleSave, handleSaveAll]);

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
    isLoadingRef,
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
        const value = deserializeWithConflicts(editor, entry.body);
        editor.tf.setValue(value);
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

  // onChange — mark unsaved only when editor content actually changes
  // (skip selection-only changes like clicking or focusing)
  const handleChange = useCallback(
    ({ value }: { value: Descendant[] }) => {
      if (!isLoadingRef.current && currentPathRef.current) {
        const hasContentChange = editor.operations.some(
          (op) => op.type !== "set_selection",
        );
        if (hasContentChange) {
          justSavedRef.current = false;
          markUnsaved(currentPathRef.current);
        }
      }
    },
    [editor, markUnsaved],
  );

  return (
    <>
      <Plate editor={editor} onChange={handleChange}>
        <div className="flex flex-col h-full w-full">
          <FixedToolbar>
            <FixedToolbarButtons />
          </FixedToolbar>

          <div className="flex-1 relative overflow-hidden">
            <EditorContainer className="h-full">
            <div className="mx-auto px-16 pt-8 sm:px-[max(64px,calc(50%-350px))]">
              <TitleZone
                title={title}
                icon={icon}
                onTitleChange={handleTitleChange}
                onIconChange={handleIconChange}
                onEnter={() => editor.tf.focus({ edge: "start" })}
              />
              <FrontmatterPanel
                meta={meta}
                isOpen={frontmatterOpen}
                onOpenChange={setFrontmatterOpen}
                onExtraChange={handleExtraChange}
              />
            </div>
            <Editor
              variant="default"
              placeholder={m.editor_placeholder_body()}
            />
          </EditorContainer>
            <TocSidebar />
          </div>
        </div>
      </Plate>

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
    </>
  );
}
