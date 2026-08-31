import { useCallback, useEffect, useRef, useState } from "react";
import type { Descendant } from "platejs";
import type { PlateEditor } from "platejs/react";
import { toast } from "sonner";

import type { Page, PageMeta } from "@/features/page";
import { readPage } from "@/features/page/page-api";
import { logTiming, nowMs } from "@/shared/lib/performance";

import { deserializeWithConflicts } from "../conflict/parse-conflicts";
import { useEditorStore } from "../model";
import {
  deleteCachedDocumentValue,
  getCachedDocumentValue,
  getDocumentCacheKey,
  setCachedDocumentValue,
  setCachedDocumentValueByKey,
} from "../model/plate-document-cache";
import * as m from "@/paraglide/messages.js";

interface MutableRef<T> {
  current: T;
}

interface UseEditorDocumentLoaderInput {
  bodyOnly: boolean;
  bodyOnlyMeta: PageMeta | null;
  adoptedDocumentKeyRef: MutableRef<string | null>;
  cancelDebounce: () => void;
  clearUnsaved: (scopePath: string | null | undefined, path: string) => void;
  currentCacheKeyRef: MutableRef<string | null>;
  currentDocument: string | null;
  documentPathHandoff: { previousPath: string; path: string } | null;
  currentDocumentSpaceId: string | null;
  currentPathRef: MutableRef<string | null>;
  editor: PlateEditor | null;
  initialPage: Page | null;
  initialPageSpacePath: string | null;
  isLoadingRef: MutableRef<boolean>;
  loadEditorValue: (value: Descendant[]) => Descendant[];
  setBrokenLinks: (links: Set<string>) => void;
  spacePath: string;
}

interface UseEditorDocumentLoaderResult {
  applyLoadedPage: (page: Pick<Page, "meta" | "warnings">) => void;
  descriptionRef: MutableRef<string>;
  documentLoading: boolean;
  iconRef: MutableRef<string | null>;
  loadedDocumentKey: string | null;
  refreshLoadedDocumentKey: (cacheKey: string | null) => void;
  titleRef: MutableRef<string>;
}

function waitForNextFrame(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function showPageWarnings(page: { warnings?: { kind: string }[] }) {
  if (
    page.warnings?.some((warning) => warning.kind === "malformed_frontmatter")
  ) {
    toast.warning(m.editor_frontmatter_malformed_warning());
  }
}

export function useEditorDocumentLoader({
  bodyOnly,
  bodyOnlyMeta,
  adoptedDocumentKeyRef,
  cancelDebounce,
  clearUnsaved,
  currentCacheKeyRef,
  currentDocument,
  documentPathHandoff,
  currentDocumentSpaceId,
  currentPathRef,
  editor,
  initialPage,
  initialPageSpacePath,
  isLoadingRef,
  loadEditorValue,
  setBrokenLinks,
  spacePath,
}: UseEditorDocumentLoaderInput): UseEditorDocumentLoaderResult {
  const initialPageRef = useRef<Page | null>(initialPage);
  const initialPageSpacePathRef = useRef<string | null>(initialPageSpacePath);
  const bodyOnlyMetaRef = useRef<PageMeta | null>(bodyOnlyMeta);
  const loadSeqRef = useRef(0);
  const titleRef = useRef("");
  const iconRef = useRef<string | null>(null);
  const descriptionRef = useRef("");

  const [, setMeta] = useState<PageMeta | null>(null);
  const [title, setTitle] = useState("");
  const [icon, setIcon] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [documentLoading, setDocumentLoading] = useState(false);
  const [loadedDocumentKey, setLoadedDocumentKey] = useState<string | null>(
    null,
  );

  useEffect(() => {
    initialPageRef.current = initialPage;
    initialPageSpacePathRef.current = initialPageSpacePath;
    bodyOnlyMetaRef.current = bodyOnlyMeta;
  }, [bodyOnlyMeta, initialPage, initialPageSpacePath]);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  useEffect(() => {
    iconRef.current = icon;
  }, [icon]);

  useEffect(() => {
    descriptionRef.current = description;
  }, [description]);

  const applyMeta = useCallback((pageMeta: PageMeta) => {
    titleRef.current = pageMeta.title;
    iconRef.current = pageMeta.icon;
    descriptionRef.current = pageMeta.description ?? "";
    setMeta(pageMeta);
    setTitle(pageMeta.title);
    setIcon(pageMeta.icon);
    setDescription(pageMeta.description ?? "");
  }, []);

  const applyLoadedPage = useCallback(
    (page: Pick<Page, "meta" | "warnings">) => {
      showPageWarnings(page);
      applyMeta(page.meta);
    },
    [applyMeta],
  );

  const refreshLoadedDocumentKey = useCallback(
    (cacheKey: string | null) => {
      if (!cacheKey) return;
      setLoadedDocumentKey(null);
      window.setTimeout(() => {
        if (currentCacheKeyRef.current === cacheKey) {
          setLoadedDocumentKey(cacheKey);
        }
      }, 0);
    },
    [currentCacheKeyRef],
  );

  const initialPageMatchesCurrentDocument =
    Boolean(initialPage && initialPage.path === currentDocument) &&
    Boolean(spacePath) &&
    initialPageSpacePath === spacePath;
  const initialPageLoadKey =
    initialPageMatchesCurrentDocument && initialPage
      ? `${spacePath}\0${initialPage.path}\0${initialPage.body.length}`
      : null;

  useEffect(() => {
    if (!editor || !currentDocument || !spacePath) return;

    const sequence = loadSeqRef.current + 1;
    loadSeqRef.current = sequence;
    const startedAt = nowMs();
    const currentCacheKey = getDocumentCacheKey(spacePath, currentDocument);
    const adoptsProvidedPath =
      documentPathHandoff?.path === currentDocument &&
      documentPathHandoff.previousPath === currentPathRef.current;
    if (
      adoptedDocumentKeyRef.current === currentCacheKey ||
      adoptsProvidedPath
    ) {
      adoptedDocumentKeyRef.current = null;
      if (adoptsProvidedPath && documentPathHandoff) {
        const editorState = useEditorStore.getState();
        const wasUnsaved = editorState.hasUnsaved(
          spacePath,
          documentPathHandoff.previousPath,
        );
        setCachedDocumentValue(spacePath, currentDocument, editor.children);
        deleteCachedDocumentValue(documentPathHandoff.previousPath, spacePath);
        editorState.clearUnsaved(spacePath, documentPathHandoff.previousPath);
        if (wasUnsaved) editorState.markUnsaved(spacePath, currentDocument);
      }
      currentPathRef.current = currentDocument;
      currentCacheKeyRef.current = currentCacheKey;
      isLoadingRef.current = false;
      queueMicrotask(() => {
        if (sequence !== loadSeqRef.current) return;
        setDocumentLoading(false);
        setLoadedDocumentKey(currentCacheKey);
      });
      return;
    }
    const prevPath = currentPathRef.current;
    const prevCacheKey = currentCacheKeyRef.current;

    if (prevPath && prevCacheKey && prevCacheKey !== currentCacheKey) {
      setCachedDocumentValueByKey(prevCacheKey, editor.children);
    }
    cancelDebounce();

    currentPathRef.current = currentDocument;
    currentCacheKeyRef.current = currentCacheKey;
    isLoadingRef.current = true;
    setBrokenLinks(new Set());
    queueMicrotask(() => {
      if (sequence === loadSeqRef.current) {
        setLoadedDocumentKey(null);
      }
    });

    const cached = getCachedDocumentValue(spacePath, currentDocument);
    const editorState = useEditorStore.getState();
    const wasExternallyModified =
      editorState.hasAiModified(spacePath, currentDocument) ||
      editorState.hasStale(spacePath, currentDocument);
    const cachedBody = cached && !wasExternallyModified ? cached : null;
    const initialPageSpacePathForDocument = initialPageSpacePathRef.current;
    const initialForDocument =
      initialPageRef.current?.path === currentDocument &&
      initialPageSpacePathForDocument === spacePath
        ? initialPageRef.current
        : null;
    const bodyOnlyMetaForDocument =
      initialPageSpacePathForDocument === spacePath
        ? bodyOnlyMetaRef.current
        : null;
    const metaForCachedBody =
      initialForDocument?.meta ?? bodyOnlyMetaForDocument;

    const nextDocumentLoading = !cachedBody;
    queueMicrotask(() => {
      if (sequence === loadSeqRef.current) {
        setDocumentLoading(nextDocumentLoading);
      }
    });

    const finish = (
      status: "ok" | "error",
      usedCachedBody: boolean,
      source: "cache" | "cache-meta-read" | "initial-page" | "read-page",
    ) => {
      if (sequence !== loadSeqRef.current) return;
      isLoadingRef.current = false;
      setDocumentLoading(false);
      if (status === "ok") setLoadedDocumentKey(currentCacheKey);
      logTiming("doc.open.editor", startedAt, {
        spaceId: currentDocumentSpaceId ?? null,
        cachedBody: usedCachedBody,
        source,
        status,
      });
    };

    if (cachedBody) {
      void (async () => {
        try {
          const pageMeta =
            metaForCachedBody ??
            (await readPage({ spacePath, path: currentDocument }));
          if (sequence !== loadSeqRef.current) return;
          if ("meta" in pageMeta) {
            applyLoadedPage(pageMeta);
          } else {
            applyMeta(pageMeta);
          }
          const loadedValue = loadEditorValue(cachedBody);
          setCachedDocumentValue(spacePath, currentDocument, loadedValue);
          clearUnsaved(spacePath, currentDocument);
          finish("ok", true, metaForCachedBody ? "cache" : "cache-meta-read");
        } catch (err) {
          if (sequence !== loadSeqRef.current) return;
          console.error("Failed to load document meta:", err);
          toast.error(m.editor_error_load());
          finish(
            "error",
            true,
            metaForCachedBody ? "cache" : "cache-meta-read",
          );
        }
      })();
    } else {
      deleteCachedDocumentValue(currentDocument, spacePath);
      useEditorStore.getState().clearStale(spacePath, currentDocument);
      void (async () => {
        const source = initialForDocument ? "initial-page" : "read-page";
        try {
          await waitForNextFrame();
          const page =
            initialForDocument ??
            (await readPage({ spacePath, path: currentDocument }));
          if (sequence !== loadSeqRef.current) return;
          applyLoadedPage(page);
          const value = deserializeWithConflicts(editor, page.body);
          const loadedValue = loadEditorValue(value);
          setCachedDocumentValue(spacePath, currentDocument, loadedValue);
          clearUnsaved(spacePath, currentDocument);
          finish("ok", false, source);
        } catch (err) {
          if (sequence !== loadSeqRef.current) return;
          console.error("Failed to load document:", err);
          toast.error(m.editor_error_load());
          finish("error", false, source);
        }
      })();
    }
  }, [
    editor,
    adoptedDocumentKeyRef,
    currentDocument,
    documentPathHandoff,
    currentDocumentSpaceId,
    spacePath,
    initialPageLoadKey,
    loadEditorValue,
    cancelDebounce,
    clearUnsaved,
    setBrokenLinks,
    applyLoadedPage,
    applyMeta,
    currentCacheKeyRef,
    currentPathRef,
    isLoadingRef,
  ]);

  useEffect(() => {
    bodyOnlyMetaRef.current = bodyOnlyMeta;
    if (!bodyOnly || !bodyOnlyMeta) return;
    if (initialPageSpacePath !== spacePath) {
      return;
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      applyMeta(bodyOnlyMeta);
    });
    return () => {
      cancelled = true;
    };
  }, [applyMeta, bodyOnly, bodyOnlyMeta, initialPageSpacePath, spacePath]);

  return {
    applyLoadedPage,
    descriptionRef,
    documentLoading,
    iconRef,
    loadedDocumentKey,
    refreshLoadedDocumentKey,
    titleRef,
  };
}
