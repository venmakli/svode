import { useCallback, useEffect, useRef } from "react";
import type { Descendant } from "platejs";
import type { PlateEditor } from "platejs/react";

import {
  useActiveContentPath,
  useActiveContentSpaceId,
} from "@/features/artifact";
import { useOpenPage } from "@/features/page/navigation";
import type { Page, PageMeta } from "@/features/page";
import { useSpace, useSpaceTreeSync } from "@/features/space";

import { deserializeEditorMarkdownInsertion } from "../model/markdown-io";
import { loadProgrammaticEditorValue } from "../model/programmatic-editor-load";
import { useEditorStore } from "../model";
import { getDocumentCacheKey } from "../model/plate-document-cache";
import { resolveEditorDocumentContext } from "../lib/editor-asset-context";
import { useEditorDocumentLoader } from "./use-editor-document-loader";
import { useEditorDocumentWriter } from "./use-editor-document-writer";
import { useEditorLinkValidation } from "./use-editor-link-validation";
import { useEditorSaveShortcuts } from "./use-editor-save-shortcuts";
import { useFileWatcher } from "./use-file-watcher";

interface UsePlateDocumentSessionInput {
  bodyOnly: boolean;
  bodyOnlyMeta: PageMeta | null;
  documentPath: string | null;
  documentSpaceId: string | null;
  editor: PlateEditor | null;
  initialPage: Page | null;
  initialPageSpacePath: string | null;
  onDocumentPathChange?: (path: string) => void;
  documentPathHandoff?: { previousPath: string; path: string } | null;
  projectPath: string | null;
  spacePath: string | null;
  readOnly: boolean;
  onWriteAccessError?: (
    error: unknown,
    retry: () => Promise<void>,
  ) => Promise<boolean>;
}

interface UsePlateDocumentSessionResult {
  adoptDocumentPath: (path: string) => void;
  currentDocument: string | null;
  currentDocumentSpaceId: string | null;
  deserializeToolbarMarkdown: (text: string) => Descendant[];
  documentLoading: boolean;
  handleChange: (_: { value: Descendant[] }) => void;
  projectPath: string | null;
  spacePath: string;
  flushPendingSource: () => Promise<void>;
}

export function usePlateDocumentSession({
  bodyOnly,
  bodyOnlyMeta,
  documentPath,
  documentSpaceId,
  editor,
  initialPage,
  initialPageSpacePath,
  onDocumentPathChange,
  documentPathHandoff,
  projectPath: projectPathProp,
  spacePath: spacePathProp,
  readOnly,
  onWriteAccessError,
}: UsePlateDocumentSessionInput): UsePlateDocumentSessionResult {
  const activeDocument = useActiveContentPath();
  const activeDocumentSpaceId = useActiveContentSpaceId();
  const openDocument = useOpenPage();
  const {
    fileTrees,
    rootSpaces,
    spaces: childWorkspaces,
    activeRootPath,
    activeRootId,
  } = useSpace();
  const { patchPageTreeMeta, reloadTreePathParents, removeTreePath } =
    useSpaceTreeSync();
  const { markUnsaved, clearUnsaved, setBrokenLinks } = useEditorStore();

  const currentDocument = documentPath ?? activeDocument;
  const currentDocumentSpaceId = documentSpaceId ?? activeDocumentSpaceId;
  const resolvedDocumentContext = resolveEditorDocumentContext({
    activeRootId,
    documentPath: currentDocument,
    documentSpaceId: currentDocumentSpaceId,
    projectPath: projectPathProp ?? activeRootPath,
    rootSpaces,
    spaces: childWorkspaces,
  });
  const spacePath = spacePathProp ?? resolvedDocumentContext?.spacePath ?? "";
  const activeWsId = currentDocumentSpaceId;
  const projectPath =
    projectPathProp ?? resolvedDocumentContext?.projectPath ?? activeRootPath;
  const saveScopeTree = currentDocumentSpaceId
    ? (fileTrees[currentDocumentSpaceId] ?? [])
    : [];

  const setCurrentDocument = useCallback(
    (path: string) => {
      onDocumentPathChange?.(path);
      if (!documentPath) openDocument(path);
    },
    [documentPath, onDocumentPathChange, openDocument],
  );

  const isLoadingRef = useRef(false);
  const adoptedDocumentKeyRef = useRef<string | null>(null);
  const currentPathRef = useRef<string | null>(null);
  const currentCacheKeyRef = useRef<string | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bufferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDebouncePendingRef = useRef(false);
  const ownNoncesRef = useRef<Set<string>>(new Set());

  const loadEditorValue = useCallback(
    (value: Descendant[]) => {
      if (!editor) return value;
      return loadProgrammaticEditorValue(editor, value);
    },
    [editor],
  );

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

  const {
    applyLoadedPage,
    descriptionRef,
    documentLoading,
    iconRef,
    loadedDocumentKey,
    refreshLoadedDocumentKey,
    titleRef,
  } = useEditorDocumentLoader({
    bodyOnly,
    bodyOnlyMeta,
    adoptedDocumentKeyRef,
    cancelDebounce,
    clearUnsaved,
    currentCacheKeyRef,
    currentDocument,
    documentPathHandoff: documentPathHandoff ?? null,
    currentDocumentSpaceId,
    currentPathRef,
    editor,
    initialPage,
    initialPageSpacePath,
    isLoadingRef,
    loadEditorValue,
    setBrokenLinks,
    spacePath,
  });

  const linkValidationDocumentKey =
    loadedDocumentKey &&
    currentDocument &&
    spacePath &&
    loadedDocumentKey === getDocumentCacheKey(spacePath, currentDocument)
      ? loadedDocumentKey
      : null;

  useEditorLinkValidation({
    loadedDocumentKey: linkValidationDocumentKey,
    currentDocument,
    spacePath,
    projectPath: projectPath ?? null,
    setBrokenLinks,
  });

  useEffect(() => cancelDebounce, [cancelDebounce]);

  const { flushPendingSource, handleSave, handleSaveAll, scheduleAutoSave } =
    useEditorDocumentWriter({
      activeRootId,
      activeWsId,
      bufferTimerRef,
      cancelDebounce,
      clearUnsaved,
      currentCacheKeyRef,
      currentDocument,
      currentPathRef,
      debounceTimerRef,
      descriptionRef,
      editor,
      iconRef,
      isDebouncePendingRef,
      ownNoncesRef,
      patchPageTreeMeta,
      projectPath,
      reloadTreePathParents,
      removeTreePath,
      saveScopeTree,
      setCurrentDocument,
      spacePath,
      titleRef,
      readOnly,
      onWriteAccessError,
    });

  useEditorSaveShortcuts({
    disabled: readOnly,
    onSave: handleSave,
    onSaveAll: handleSaveAll,
  });

  const handleWatcherPageReloaded = useCallback(
    (page: Page) => {
      applyLoadedPage(page);
      refreshLoadedDocumentKey(currentCacheKeyRef.current);
    },
    [applyLoadedPage, currentCacheKeyRef, refreshLoadedDocumentKey],
  );

  const handleEditorValueReload = useCallback(
    (_path: string, value: Descendant[]) => loadEditorValue(value),
    [loadEditorValue],
  );

  useFileWatcher({
    editor,
    spacePath,
    activeDocument: currentDocument,
    ownNoncesRef,
    isDebouncePendingRef,
    isLoadingRef,
    onEditorValueReload: handleEditorValueReload,
    onPageReloaded: handleWatcherPageReloaded,
  });

  const handleChange = useCallback(
    (_: { value: Descendant[] }) => {
      const currentPath = currentPathRef.current;
      if (readOnly || !editor || isLoadingRef.current || !currentPath) return;

      const hasContentChange = editor.operations.some(
        (op) => op.type !== "set_selection",
      );
      if (hasContentChange) {
        markUnsaved(spacePath, currentPath);
        scheduleAutoSave();
      }
    },
    [editor, markUnsaved, readOnly, scheduleAutoSave, spacePath],
  );

  const deserializeToolbarMarkdown = useCallback(
    (text: string) =>
      editor ? deserializeEditorMarkdownInsertion(editor, text) : [],
    [editor],
  );

  return {
    adoptDocumentPath: setCurrentDocument,
    currentDocument,
    currentDocumentSpaceId,
    deserializeToolbarMarkdown,
    documentLoading,
    handleChange,
    projectPath,
    spacePath,
    flushPendingSource,
  };
}
