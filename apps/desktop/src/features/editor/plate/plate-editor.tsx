import { useEffect, useCallback, useRef, useState } from "react";
import type { Descendant } from "platejs";
import { Plate, usePlateEditor } from "platejs/react";
import { MarkdownPlugin } from "@platejs/markdown";
import { invokeCommand as invoke } from "@/platform/native/invoke";
import { toast } from "sonner";
import { EditorKit } from "./editor-kit";
import { useFileWatcher } from "../hooks/use-file-watcher";
import { useEntrySelectionStore } from "@/features/entry";
import { useSpaceStore } from "@/features/space/model";
import { useEditorStore } from "../model";
import { cn } from "@/shared/lib/utils";
import {
  commitAllSpace,
  commitFileAndMaybeSync,
  syncSpace,
} from "@/features/git/api/git-actions";
import { isTerminalKeyboardEvent } from "@/features/terminal/lib/is-terminal-keyboard-event";
import { useGitStore } from "@/features/git/model";
import {
  deserializeWithConflicts,
  hasUnresolvedConflicts,
} from "../conflict/parse-conflicts";
import { Editor, EditorContainer } from "@/components/ui/editor";
import { FixedToolbar } from "@/components/ui/fixed-toolbar";
import { FixedToolbarButtons } from "@/components/ui/fixed-toolbar-buttons";
import { detailPageBodyClassName } from "@/shared/ui/page-layout";
import { logTiming, nowMs } from "@/shared/lib/performance";
import { TocSidebar } from "../ui/toc-sidebar";
import { EditorMediaAdapterProvider } from "../ui/editor-media-adapter-provider";
import type { Entry, EntryMeta, WriteResult } from "@/features/entry";
import * as m from "@/paraglide/messages.js";

const AUTOSAVE_DEBOUNCE_MS = 1000;
const ENABLE_FIXED_FORMATTING_TOOLBAR = false;
const DOCUMENT_CACHE_SEPARATOR = "\0";

function getDocumentCacheKey(spacePath: string, path: string): string {
  return `${spacePath}${DOCUMENT_CACHE_SEPARATOR}${path}`;
}

function deleteCachedPath(
  cache: Map<string, Descendant[]>,
  path: string,
  spacePath?: string | null,
) {
  if (spacePath) {
    cache.delete(getDocumentCacheKey(spacePath, path));
    return;
  }

  const pathSuffix = `${DOCUMENT_CACHE_SEPARATOR}${path}`;
  for (const key of cache.keys()) {
    if (key.endsWith(pathSuffix)) cache.delete(key);
  }
}

interface PlateDocumentEditorProps {
  bodyOnly: true;
  pageScroll?: boolean;
  documentPath?: string | null;
  documentSpaceId?: string | null;
  spacePath?: string | null;
  projectPath?: string | null;
  bodyOnlyMeta?: EntryMeta | null;
  onDocumentPathChange?: (path: string) => void;
}

export function PlateDocumentEditor({
  bodyOnly,
  pageScroll = false,
  documentPath = null,
  documentSpaceId = null,
  spacePath: spacePathProp = null,
  projectPath: projectPathProp = null,
  bodyOnlyMeta = null,
  onDocumentPathChange,
}: PlateDocumentEditorProps) {
  const { activeDocument, activeDocumentSpaceId, openDocument } =
    useEntrySelectionStore();
  const {
    updateNodeMeta,
    rootSpaces,
    spaces: childWorkspaces,
    activeRootPath,
    activeRootId,
  } = useSpaceStore();
  const {
    markUnsaved,
    clearUnsaved,
    pendingRename,
    clearPendingRename,
    setBrokenLinks,
  } = useEditorStore();

  const currentDocument = documentPath ?? activeDocument;
  const usePageScroll = bodyOnly && pageScroll;
  const currentDocumentSpaceId = documentSpaceId ?? activeDocumentSpaceId;

  // Resolve workspace path from the document's workspace id
  const docWs = currentDocumentSpaceId
    ? [...rootSpaces, ...childWorkspaces].find(
        (w) => w.id === currentDocumentSpaceId,
      )
    : null;
  const spacePath = spacePathProp ?? docWs?.path ?? "";
  const activeWsId = currentDocumentSpaceId;
  const projectPath = projectPathProp ?? activeRootPath;
  const setCurrentDocument = useCallback(
    (path: string) => {
      onDocumentPathChange?.(path);
      if (!documentPath) openDocument(path);
    },
    [documentPath, onDocumentPathChange, openDocument],
  );

  const isLoadingRef = useRef(false);
  const currentPathRef = useRef<string | null>(null);
  const currentCacheKeyRef = useRef<string | null>(null);
  const titleRef = useRef("");
  const iconRef = useRef<string | null>(null);
  const descriptionRef = useRef("");
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
  const [description, setDescription] = useState("");

  // Keep refs in sync with state for stable callback access
  useEffect(() => {
    titleRef.current = title;
  }, [title]);
  useEffect(() => {
    iconRef.current = icon;
  }, [icon]);
  useEffect(() => {
    descriptionRef.current = description;
  }, [description]);
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
        projectPath: projectPath ?? null,
      });

      if (result.write_nonce) {
        ownNoncesRef.current.add(result.write_nonce);
      }

      return result;
    },
    [editor, spacePath, projectPath],
  );

  const handleModifiedSources = useCallback(
    (result: WriteResult) => {
      const sources =
        result.modified_sources && result.modified_sources.length > 0
          ? result.modified_sources
          : result.modified_files.map((path) => ({
              spaceId: activeWsId ?? null,
              path,
            }));
      if (sources.length === 0) return;

      const paths = sources.map((source) => source.path);
      for (const path of paths) {
        deleteCachedPath(docCacheRef.current, path);
      }
      useEditorStore.getState().suppressPaths(paths);

      const treeIds = new Set(
        sources
          .map((source) => source.spaceId ?? activeRootId)
          .filter((id): id is string => Boolean(id)),
      );
      for (const id of treeIds) {
        void useSpaceStore.getState().refreshTree(id);
      }
    },
    [activeRootId, activeWsId],
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
      const cacheKey = currentCacheKeyRef.current;
      void performWrite(true)
        .then((result) => {
          if (!result || !path || !cacheKey) return;
          if (editor) {
            docCacheRef.current.set(cacheKey, editor.children);
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

  // Load document when the target document changes
  useEffect(() => {
    if (!editor || !currentDocument || !spacePath) return;

    const startedAt = nowMs();

    // Cache current editor state before switching. Cancel any debounce for
    // the previous doc — any in-memory edits not yet written are discarded
    // at switch time (v1 — acceptable loss ≤1s of edits).
    const currentCacheKey = getDocumentCacheKey(spacePath, currentDocument);
    const prevPath = currentPathRef.current;
    const prevCacheKey = currentCacheKeyRef.current;
    if (prevPath && prevCacheKey && prevCacheKey !== currentCacheKey) {
      docCacheRef.current.set(prevCacheKey, editor.children);
    }
    cancelDebounce();

    currentPathRef.current = currentDocument;
    currentCacheKeyRef.current = currentCacheKey;
    isLoadingRef.current = true;

    // Validate links in background
    invoke<{ url: string; exists: boolean }[]>("validate_links", {
      space: spacePath,
      path: currentDocument,
      projectPath: projectPath ?? null,
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
    const cached = docCacheRef.current.get(currentCacheKey);
    const editorState = useEditorStore.getState();
    const wasExternallyModified =
      editorState.aiModified[currentDocument] ||
      editorState.staleCache[currentDocument];
    const cachedBody = cached && !wasExternallyModified ? cached : null;

    if (cachedBody) {
      let status: "ok" | "error" = "ok";
      invoke<Entry>("read_entry", {
        space: spacePath,
        path: currentDocument,
      })
        .then((entry) => {
          setMeta(entry.meta);
          setTitle(entry.meta.title);
          setIcon(entry.meta.icon);
          setDescription(entry.meta.description ?? "");
          editor.tf.setValue(cachedBody);
          clearUnsaved(currentDocument);
        })
        .catch((err) => {
          status = "error";
          console.error("Failed to load document meta:", err);
          toast.error(m.editor_error_load());
        })
        .finally(() => {
          isLoadingRef.current = false;
          logTiming("doc.open.editor", startedAt, {
            spaceId: currentDocumentSpaceId ?? null,
            cachedBody: true,
            status,
          });
        });
    } else {
      let status: "ok" | "error" = "ok";
      docCacheRef.current.delete(currentCacheKey);
      useEditorStore.getState().clearStale(currentDocument);
      invoke<Entry>("read_entry", {
        space: spacePath,
        path: currentDocument,
      })
        .then((entry) => {
          setMeta(entry.meta);
          setTitle(entry.meta.title);
          setIcon(entry.meta.icon);
          setDescription(entry.meta.description ?? "");
          const value = deserializeWithConflicts(editor, entry.body);
          editor.tf.setValue(value);
          clearUnsaved(currentDocument);
        })
        .catch((err) => {
          status = "error";
          console.error("Failed to load document:", err);
          toast.error(m.editor_error_load());
        })
        .finally(() => {
          isLoadingRef.current = false;
          logTiming("doc.open.editor", startedAt, {
            spaceId: currentDocumentSpaceId ?? null,
            cachedBody: false,
            status,
          });
        });
    }
  }, [
    editor,
    currentDocument,
    currentDocumentSpaceId,
    spacePath,
    projectPath,
    cancelDebounce,
    clearUnsaved,
    setBrokenLinks,
  ]);

  useEffect(() => {
    if (!bodyOnly || !bodyOnlyMeta) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setMeta(bodyOnlyMeta);
      setTitle(bodyOnlyMeta.title);
      setIcon(bodyOnlyMeta.icon);
      setDescription(bodyOnlyMeta.description ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [bodyOnly, bodyOnlyMeta]);

  // Cancel debounce on unmount
  useEffect(() => cancelDebounce, [cancelDebounce]);

  // Apply pending rename from sidebar (file already renamed on disk)
  useEffect(() => {
    if (!pendingRename || pendingRename.path !== currentDocument || !editor)
      return;
    const { title: newTitle, newPath } = pendingRename;
    clearPendingRename();

    titleRef.current = newTitle;
    queueMicrotask(() => setTitle(newTitle));

    if (newPath) {
      // File was renamed on disk — cache editor content for new path and switch
      if (spacePath) {
        docCacheRef.current.set(
          getDocumentCacheKey(spacePath, newPath),
          editor.children,
        );
        docCacheRef.current.delete(
          getDocumentCacheKey(spacePath, pendingRename.path),
        );
      }
      clearUnsaved(pendingRename.path);
      setCurrentDocument(newPath);
    } else {
      // Slug unchanged, just update sidebar
      if (currentPathRef.current && activeWsId) {
        updateNodeMeta(
          activeWsId,
          currentPathRef.current,
          newTitle,
          iconRef.current,
        );
      }
    }
  }, [
    pendingRename,
    currentDocument,
    editor,
    clearPendingRename,
    clearUnsaved,
    setCurrentDocument,
    updateNodeMeta,
    activeWsId,
    spacePath,
  ]);

  // ⌘S — cancel debounce, materialize (rename + backlinks + structural
  // schedule on the backend), then commit. `flush_target_repo` inside
  // git_commit_file drains the structural batch → Rename commit before user.
  const handleSave = useCallback(async () => {
    if (!editor || !currentDocument || !spacePath) return;

    cancelDebounce();

    try {
      const result = await performWrite(false);
      if (!result) return;

      clearUnsaved(currentDocument);

      if (result.new_path) {
        docCacheRef.current.delete(
          getDocumentCacheKey(spacePath, currentDocument),
        );
        docCacheRef.current.set(
          getDocumentCacheKey(spacePath, result.new_path),
          editor.children,
        );
        setCurrentDocument(result.new_path);
        if (activeWsId) {
          useSpaceStore.getState().refreshTree(activeWsId);
        }
      } else {
        docCacheRef.current.set(
          getDocumentCacheKey(spacePath, currentDocument),
          editor.children,
        );
      }

      // Backlinks files: invalidate cache so next open re-reads from disk,
      // and suppress the watcher so it doesn't re-mark them as aiModified
      // (no spurious blue dot — the user initiated this rename).
      handleModifiedSources(result);

      // Auto-commit the saved file. During mid-merge, route through
      // git_resolve_continue to finalize the merge instead.
      const committedPath = result.new_path ?? currentDocument;
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
        await commitFileAndMaybeSync(
          spacePath,
          committedPath,
          projectPath ?? undefined,
        );
      }
    } catch (err) {
      console.error("Failed to save document:", err);
      toast.error(m.editor_error_save());
    }
  }, [
    editor,
    currentDocument,
    spacePath,
    activeWsId,
    projectPath,
    cancelDebounce,
    performWrite,
    clearUnsaved,
    handleModifiedSources,
    setCurrentDocument,
  ]);

  // ⌘⇧S — flush the active document (if dirty) with materialize, then
  // `git add . && git commit` via commitAllSpace — catches every other
  // on-disk change too (externally-modified files, AI writes, backlink updates).
  const handleSaveAll = useCallback(async () => {
    if (!spacePath) return;
    cancelDebounce();

    if (!editor || !currentDocument) {
      void commitAllSpace(spacePath, projectPath ?? undefined);
      return;
    }
    const isDirty = useEditorStore.getState().unsavedChanges[currentDocument];
    if (!isDirty) {
      void commitAllSpace(spacePath, projectPath ?? undefined);
      return;
    }
    try {
      const result = await performWrite(false);
      if (!result) return;
      clearUnsaved(currentDocument);
      if (result.new_path) {
        docCacheRef.current.delete(
          getDocumentCacheKey(spacePath, currentDocument),
        );
        docCacheRef.current.set(
          getDocumentCacheKey(spacePath, result.new_path),
          editor.children,
        );
        setCurrentDocument(result.new_path);
        if (activeWsId) {
          useSpaceStore.getState().refreshTree(activeWsId);
        }
      }
      // See handleSave: same backlinks suppress + cache-invalidate.
      handleModifiedSources(result);
      await commitAllSpace(spacePath, projectPath ?? undefined);
    } catch (err) {
      console.error("Save-all failed:", err);
      toast.error(m.editor_error_save());
    }
  }, [
    editor,
    currentDocument,
    spacePath,
    activeWsId,
    projectPath,
    cancelDebounce,
    performWrite,
    clearUnsaved,
    handleModifiedSources,
    setCurrentDocument,
  ]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isTerminalKeyboardEvent(e)) return;
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "s"
      ) {
        e.preventDefault();
        void handleSaveAll();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave, handleSaveAll]);

  useFileWatcher({
    editor,
    spacePath,
    activeDocument: currentDocument,
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
    <EditorMediaAdapterProvider>
      <Plate editor={editor} onChange={handleChange}>
        <div
          className={cn(
            "flex w-full flex-col",
            usePageScroll ? "min-h-0" : "h-full",
          )}
        >
          {ENABLE_FIXED_FORMATTING_TOOLBAR ? (
            <FixedToolbar>
              <FixedToolbarButtons />
            </FixedToolbar>
          ) : null}

          <div
            className={cn(
              "relative",
              usePageScroll ? "overflow-visible" : "flex-1 overflow-hidden",
            )}
          >
            <TocSidebar />
            <EditorContainer
              className={cn(
                usePageScroll
                  ? "h-auto overflow-visible overflow-y-visible"
                  : "h-full",
              )}
            >
              <Editor
                variant={usePageScroll ? "none" : "default"}
                className={cn(usePageScroll && detailPageBodyClassName)}
                placeholder={m.editor_placeholder_body()}
              />
            </EditorContainer>
          </div>
        </div>
      </Plate>
    </EditorMediaAdapterProvider>
  );
}
