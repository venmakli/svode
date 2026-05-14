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
import { useSpaceStore } from "@/stores/space";
import { useEditorStore } from "@/stores/editor";
import {
  commitAllSpace,
  commitFileAndMaybeSync,
  syncSpace,
} from "@/features/workspace/git-actions";
import { useGitStore } from "@/stores/git";
import { deserializeWithConflicts, hasUnresolvedConflicts } from "../conflict/parse-conflicts";
import { Editor, EditorContainer } from "@/components/ui/editor";
import { FixedToolbar } from "@/components/ui/fixed-toolbar";
import { FixedToolbarButtons } from "@/components/ui/fixed-toolbar-buttons";
import { TocSidebar } from "../toc-sidebar";
import * as m from "@/paraglide/messages.js";

const AUTOSAVE_DEBOUNCE_MS = 1000;

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

interface WriteResult {
  new_path: string | null;
  modified_files: string[];
  write_nonce: string;
}

export function PlateDocumentEditor() {
  const { activeDocument, activeDocumentSpaceId, openDocument } = useLayoutStore();
  const { updateNodeMeta, rootSpaces, spaces: childWorkspaces, activeRootPath } = useSpaceStore();
  const { markUnsaved, clearUnsaved, pendingRename, clearPendingRename, setBrokenLinks } = useEditorStore();

  // Resolve workspace path from the document's workspace id
  const docWs = activeDocumentSpaceId
    ? [...rootSpaces, ...childWorkspaces].find((w) => w.id === activeDocumentSpaceId)
    : null;
  const spacePath = docWs?.path ?? "";
  const activeWsId = activeDocumentSpaceId;

  const isLoadingRef = useRef(false);
  const currentPathRef = useRef<string | null>(null);
  const titleRef = useRef("");
  const iconRef = useRef<string | null>(null);
  const extraRef = useRef<Record<string, unknown> | null>(null);
  const metaIdRef = useRef<string | null>(null);
  const docCacheRef = useRef(new Map<string, Descendant[]>());

  // Debounce auto-save refs
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Buffer timer kept after IPC resolves so the delayed watcher echo
  // (200 ms watcher debounce + Tauri delivery) still sees pending=true and
  // is dropped by use-file-watcher's local-wins guard. Without this the
  // backend's nonce/path echo-guard is the only line of defence and it
  // races on macOS when canonicalize() rewrites the path before notify
  // delivers the FSEvent (cursor jumps to top-left, slash menu closes).
  const bufferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDebouncePendingRef = useRef(false);
  const ownNoncesRef = useRef<Set<string>>(new Set());

  const [meta, setMeta] = useState<EntryMeta | null>(null);
  const [title, setTitle] = useState("");
  const [icon, setIcon] = useState<string | null>(null);
  const [frontmatterOpen, setFrontmatterOpen] = useState(false);

  // Keep refs in sync with state for stable callback access
  useEffect(() => {
    titleRef.current = title;
  }, [title]);
  useEffect(() => {
    iconRef.current = icon;
  }, [icon]);
  useEffect(() => {
    extraRef.current = meta?.extra ?? null;
    metaIdRef.current = meta?.id ?? null;
  }, [meta]);

  const editor = usePlateEditor({
    plugins: EditorKit,
  });

  // Cancel any pending debounced auto-save. Used on document switch / unmount
  // and before ⌘S materialize.
  const cancelDebounce = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (bufferTimerRef.current) {
      clearTimeout(bufferTimerRef.current);
      bufferTimerRef.current = null;
    }
    isDebouncePendingRef.current = false;
  }, []);

  // Serialize the editor + current meta refs and call `write_entry`. Tracks
  // the returned write-nonce so the watcher can drop our own file:changed
  // echo. `skipRename=true` = auto-save (body+frontmatter only). false = ⌘S
  // materialize (rename + update_links + structural schedule on backend).
  const performWrite = useCallback(
    async (skipRename: boolean): Promise<WriteResult | null> => {
      if (!editor || !currentPathRef.current || !spacePath) return null;
      const path = currentPathRef.current;

      if (hasUnresolvedConflicts(editor.children)) {
        // Skip silently during auto-save; surface the error on explicit save.
        if (!skipRename) {
          toast.error(m.git_sync_conflict({ count: "1" }));
        }
        return null;
      }

      const markdown = editor.getApi(MarkdownPlugin).markdown.serialize();

      const result = await invoke<WriteResult>("write_entry", {
        space: spacePath,
        path,
        content: markdown,
        title: titleRef.current || m.editor_untitled(),
        icon: iconRef.current,
        extra: extraRef.current,
        existingId: metaIdRef.current,
        skipRename,
        projectPath: activeRootPath ?? null,
      });

      if (result.write_nonce) {
        ownNoncesRef.current.add(result.write_nonce);
      }

      return result;
    },
    [editor, spacePath, activeRootPath],
  );

  // Schedule a debounced auto-save of the active document. Resets the timer
  // on every call, so continuous typing never triggers mid-stream writes.
  // pending stays true through the IPC + a 500 ms post-write buffer so the
  // own-write `file:changed` echo (watcher debounces 200 ms + Tauri delivery)
  // is dropped by the local-wins branch before it can reload the editor.
  // Don't clear unsavedChanges here — the file is on disk but still
  // uncommitted in git, indicator should stay grey until ⌘S commit.
  const scheduleAutoSave = useCallback(() => {
    if (!currentPathRef.current || !spacePath) return;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    if (bufferTimerRef.current) {
      clearTimeout(bufferTimerRef.current);
      bufferTimerRef.current = null;
    }
    isDebouncePendingRef.current = true;
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      const path = currentPathRef.current;
      void performWrite(true)
        .then((result) => {
          if (!result || !path) return;
          if (editor) {
            docCacheRef.current.set(path, editor.children);
          }
        })
        .catch((err) => {
          console.error("Auto-save failed:", err);
        })
        .finally(() => {
          bufferTimerRef.current = setTimeout(() => {
            bufferTimerRef.current = null;
            isDebouncePendingRef.current = false;
          }, 500);
        });
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [performWrite, editor, spacePath]);

  // Load document when activeDocument changes
  useEffect(() => {
    if (!editor || !activeDocument || !spacePath) return;

    // Cache current editor state before switching. Cancel any debounce for
    // the previous doc — any in-memory edits not yet written are discarded
    // at switch time (v1 — acceptable loss ≤1s of edits).
    const prevPath = currentPathRef.current;
    if (prevPath && prevPath !== activeDocument) {
      docCacheRef.current.set(prevPath, editor.children);
    }
    cancelDebounce();

    currentPathRef.current = activeDocument;
    isLoadingRef.current = true;

    // Validate links in background
    invoke<{ url: string; exists: boolean }[]>("validate_links", {
      space: spacePath,
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
    // (visual aiModified flag) or invalidated by a prior backlinks update (staleCache).
    const cached = docCacheRef.current.get(activeDocument);
    const editorState = useEditorStore.getState();
    const wasExternallyModified =
      editorState.aiModified[activeDocument] || editorState.staleCache[activeDocument];

    if (cached && !wasExternallyModified) {
      invoke<Entry>("read_entry", {
        space: spacePath,
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
      useEditorStore.getState().clearStale(activeDocument);
      invoke<Entry>("read_entry", {
        space: spacePath,
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
  }, [editor, activeDocument, spacePath, cancelDebounce, clearUnsaved, setBrokenLinks]);

  // Cancel debounce on unmount
  useEffect(() => cancelDebounce, [cancelDebounce]);

  // Title / icon / extra edits — mark unsaved + schedule auto-save
  const handleTitleChange = useCallback(
    (newTitle: string) => {
      setTitle(newTitle);
      if (currentPathRef.current && activeWsId) {
        markUnsaved(currentPathRef.current);
        updateNodeMeta(activeWsId, currentPathRef.current, newTitle, iconRef.current);
      }
      scheduleAutoSave();
    },
    [markUnsaved, updateNodeMeta, activeWsId, scheduleAutoSave],
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
  }, [pendingRename, activeDocument, editor, clearPendingRename, clearUnsaved, openDocument, updateNodeMeta, activeWsId]);

  const handleIconChange = useCallback(
    (newIcon: string) => {
      setIcon(newIcon);
      if (currentPathRef.current && activeWsId) {
        markUnsaved(currentPathRef.current);
        updateNodeMeta(activeWsId, currentPathRef.current, titleRef.current, newIcon);
      }
      scheduleAutoSave();
    },
    [markUnsaved, updateNodeMeta, activeWsId, scheduleAutoSave],
  );

  const handleExtraChange = useCallback(
    (newExtra: Record<string, unknown>) => {
      setMeta((prev) => (prev ? { ...prev, extra: newExtra } : prev));
      if (currentPathRef.current) {
        markUnsaved(currentPathRef.current);
      }
      scheduleAutoSave();
    },
    [markUnsaved, scheduleAutoSave],
  );

  // ⌘S — cancel debounce, materialize (rename + backlinks + structural
  // schedule on the backend), then commit. `flush_target_repo` inside
  // git_commit_file drains the structural batch → Rename commit before user.
  const handleSave = useCallback(async () => {
    if (!editor || !activeDocument || !spacePath) return;

    cancelDebounce();

    try {
      const result = await performWrite(false);
      if (!result) return;

      clearUnsaved(activeDocument);

      if (result.new_path) {
        docCacheRef.current.delete(activeDocument);
        docCacheRef.current.set(result.new_path, editor.children);
        useLayoutStore.getState().openDocument(result.new_path);
        if (activeWsId) {
          useSpaceStore.getState().refreshTree(activeWsId);
        }
      } else {
        docCacheRef.current.set(activeDocument, editor.children);
      }

      // Backlinks files: invalidate cache so next open re-reads from disk,
      // and suppress the watcher so it doesn't re-mark them as aiModified
      // (no spurious blue dot — the user initiated this rename).
      if (result.modified_files.length > 0) {
        for (const f of result.modified_files) {
          docCacheRef.current.delete(f);
        }
        useEditorStore.getState().suppressPaths(result.modified_files);
      }

      // Auto-commit the saved file. During mid-merge, route through
      // git_resolve_continue to finalize the merge instead.
      const committedPath = result.new_path ?? activeDocument;
      const status = useGitStore.getState().statuses[spacePath];
      if (status?.hasConflicts) {
        try {
          await invoke("git_resolve_continue", { spacePath });
          void useGitStore.getState().refreshStatus(spacePath);
          void syncSpace(spacePath);
        } catch (err) {
          console.error("git_resolve_continue failed:", err);
          toast.error(m.git_sync_failed());
        }
      } else {
        await commitFileAndMaybeSync(spacePath, committedPath, activeRootPath ?? undefined);
      }
    } catch (err) {
      console.error("Failed to save document:", err);
      toast.error(m.editor_error_save());
    }
  }, [editor, activeDocument, spacePath, activeWsId, activeRootPath, cancelDebounce, performWrite, clearUnsaved]);

  // ⌘⇧S — flush the active document (if dirty) with materialize, then
  // `git add . && git commit` via commitAllSpace — catches every other
  // on-disk change too (externally-modified files, AI writes, backlink updates).
  const handleSaveAll = useCallback(async () => {
    if (!spacePath) return;
    cancelDebounce();

    if (!editor || !activeDocument) {
      void commitAllSpace(spacePath, activeRootPath ?? undefined);
      return;
    }
    const isDirty = useEditorStore.getState().unsavedChanges[activeDocument];
    if (!isDirty) {
      void commitAllSpace(spacePath, activeRootPath ?? undefined);
      return;
    }
    try {
      const result = await performWrite(false);
      if (!result) return;
      clearUnsaved(activeDocument);
      if (result.new_path) {
        docCacheRef.current.delete(activeDocument);
        docCacheRef.current.set(result.new_path, editor.children);
        useLayoutStore.getState().openDocument(result.new_path);
        if (activeWsId) {
          useSpaceStore.getState().refreshTree(activeWsId);
        }
      }
      // See handleSave: same backlinks suppress + cache-invalidate.
      if (result.modified_files.length > 0) {
        for (const f of result.modified_files) {
          docCacheRef.current.delete(f);
        }
        useEditorStore.getState().suppressPaths(result.modified_files);
      }
      await commitAllSpace(spacePath, activeRootPath ?? undefined);
    } catch (err) {
      console.error("Save-all failed:", err);
      toast.error(m.editor_error_save());
    }
  }, [editor, activeDocument, spacePath, activeWsId, activeRootPath, cancelDebounce, performWrite, clearUnsaved]);

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
        void handleSave();
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "p") {
        e.preventDefault();
        setFrontmatterOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave, handleSaveAll]);

  useFileWatcher({
    editor,
    spacePath,
    activeDocument,
    ownNoncesRef,
    isDebouncePendingRef,
    isLoadingRef,
  });

  // onChange — mark unsaved + schedule auto-save on actual content changes
  // (skip selection-only changes like clicking or focusing)
  const handleChange = useCallback(
    (_: { value: Descendant[] }) => {
      if (!isLoadingRef.current && currentPathRef.current) {
        const hasContentChange = editor.operations.some(
          (op) => op.type !== "set_selection",
        );
        if (hasContentChange) {
          markUnsaved(currentPathRef.current);
          scheduleAutoSave();
        }
      }
    },
    [editor, markUnsaved, scheduleAutoSave],
  );

  return (
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
  );
}
