import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { Descendant } from "platejs";
import type { PlateEditor } from "platejs/react";
import { toast } from "sonner";

import type { Entry, EntryMeta } from "@/features/entry";
import { readEntry } from "@/features/entry/entry-api";
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
  bodyOnlyMeta: EntryMeta | null;
  cancelDebounce: () => void;
  clearUnsaved: (path: string) => void;
  currentCacheKeyRef: MutableRef<string | null>;
  currentDocument: string | null;
  currentDocumentSpaceId: string | null;
  currentPathRef: MutableRef<string | null>;
  editor: PlateEditor | null;
  initialEntry: Entry | null;
  initialEntrySpacePath: string | null;
  isLoadingRef: MutableRef<boolean>;
  loadEditorValue: (value: Descendant[]) => Descendant[];
  setBrokenLinks: (links: Set<string>) => void;
  spacePath: string;
}

interface UseEditorDocumentLoaderResult {
  applyLoadedEntry: (entry: Pick<Entry, "meta" | "warnings">) => void;
  descriptionRef: MutableRef<string>;
  documentLoading: boolean;
  iconRef: MutableRef<string | null>;
  loadedDocumentKey: string | null;
  refreshLoadedDocumentKey: (cacheKey: string | null) => void;
  setTitle: Dispatch<SetStateAction<string>>;
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

function showEntryWarnings(entry: { warnings?: { kind: string }[] }) {
  if (
    entry.warnings?.some((warning) => warning.kind === "malformed_frontmatter")
  ) {
    toast.warning(m.editor_frontmatter_malformed_warning());
  }
}

export function useEditorDocumentLoader({
  bodyOnly,
  bodyOnlyMeta,
  cancelDebounce,
  clearUnsaved,
  currentCacheKeyRef,
  currentDocument,
  currentDocumentSpaceId,
  currentPathRef,
  editor,
  initialEntry,
  initialEntrySpacePath,
  isLoadingRef,
  loadEditorValue,
  setBrokenLinks,
  spacePath,
}: UseEditorDocumentLoaderInput): UseEditorDocumentLoaderResult {
  const initialEntryRef = useRef<Entry | null>(initialEntry);
  const initialEntrySpacePathRef = useRef<string | null>(initialEntrySpacePath);
  const bodyOnlyMetaRef = useRef<EntryMeta | null>(bodyOnlyMeta);
  const loadSeqRef = useRef(0);
  const titleRef = useRef("");
  const iconRef = useRef<string | null>(null);
  const descriptionRef = useRef("");

  const [, setMeta] = useState<EntryMeta | null>(null);
  const [title, setTitle] = useState("");
  const [icon, setIcon] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [documentLoading, setDocumentLoading] = useState(false);
  const [loadedDocumentKey, setLoadedDocumentKey] = useState<string | null>(
    null,
  );

  useEffect(() => {
    initialEntryRef.current = initialEntry;
    initialEntrySpacePathRef.current = initialEntrySpacePath;
    bodyOnlyMetaRef.current = bodyOnlyMeta;
  }, [bodyOnlyMeta, initialEntry, initialEntrySpacePath]);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  useEffect(() => {
    iconRef.current = icon;
  }, [icon]);

  useEffect(() => {
    descriptionRef.current = description;
  }, [description]);

  const applyMeta = useCallback((entryMeta: EntryMeta) => {
    titleRef.current = entryMeta.title;
    iconRef.current = entryMeta.icon;
    descriptionRef.current = entryMeta.description ?? "";
    setMeta(entryMeta);
    setTitle(entryMeta.title);
    setIcon(entryMeta.icon);
    setDescription(entryMeta.description ?? "");
  }, []);

  const applyLoadedEntry = useCallback(
    (entry: Pick<Entry, "meta" | "warnings">) => {
      showEntryWarnings(entry);
      applyMeta(entry.meta);
    },
    [applyMeta],
  );

  const refreshLoadedDocumentKey = useCallback((cacheKey: string | null) => {
    if (!cacheKey) return;
    setLoadedDocumentKey(null);
    window.setTimeout(() => {
      if (currentCacheKeyRef.current === cacheKey) {
        setLoadedDocumentKey(cacheKey);
      }
    }, 0);
  }, [currentCacheKeyRef]);

  const initialEntryMatchesCurrentDocument =
    Boolean(initialEntry && initialEntry.path === currentDocument) &&
    Boolean(spacePath) &&
    initialEntrySpacePath === spacePath;
  const initialEntryLoadKey =
    initialEntryMatchesCurrentDocument && initialEntry
      ? `${spacePath}\0${initialEntry.path}\0${initialEntry.body.length}`
      : null;

  useEffect(() => {
    if (!editor || !currentDocument || !spacePath) return;

    const sequence = loadSeqRef.current + 1;
    loadSeqRef.current = sequence;
    const startedAt = nowMs();
    const currentCacheKey = getDocumentCacheKey(spacePath, currentDocument);
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
      editorState.aiModified[currentDocument] ||
      editorState.staleCache[currentDocument];
    const cachedBody = cached && !wasExternallyModified ? cached : null;
    const initialEntrySpacePathForDocument = initialEntrySpacePathRef.current;
    const initialForDocument =
      initialEntryRef.current?.path === currentDocument &&
      initialEntrySpacePathForDocument === spacePath
        ? initialEntryRef.current
        : null;
    const bodyOnlyMetaForDocument =
      initialEntrySpacePathForDocument === spacePath
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
      source: "cache" | "cache-meta-read" | "initial-entry" | "read-entry",
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
          const entryMeta =
            metaForCachedBody ??
            (await readEntry({ spacePath, path: currentDocument }));
          if (sequence !== loadSeqRef.current) return;
          if ("meta" in entryMeta) {
            applyLoadedEntry(entryMeta);
          } else {
            applyMeta(entryMeta);
          }
          const loadedValue = loadEditorValue(cachedBody);
          setCachedDocumentValue(spacePath, currentDocument, loadedValue);
          clearUnsaved(currentDocument);
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
      useEditorStore.getState().clearStale(currentDocument);
      void (async () => {
        const source = initialForDocument ? "initial-entry" : "read-entry";
        try {
          await waitForNextFrame();
          const entry =
            initialForDocument ??
            (await readEntry({ spacePath, path: currentDocument }));
          if (sequence !== loadSeqRef.current) return;
          applyLoadedEntry(entry);
          const value = deserializeWithConflicts(editor, entry.body);
          const loadedValue = loadEditorValue(value);
          setCachedDocumentValue(spacePath, currentDocument, loadedValue);
          clearUnsaved(currentDocument);
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
    currentDocument,
    currentDocumentSpaceId,
    spacePath,
    initialEntryLoadKey,
    loadEditorValue,
    cancelDebounce,
    clearUnsaved,
    setBrokenLinks,
    applyLoadedEntry,
    applyMeta,
    currentCacheKeyRef,
    currentPathRef,
    isLoadingRef,
  ]);

  useEffect(() => {
    bodyOnlyMetaRef.current = bodyOnlyMeta;
    if (!bodyOnly || !bodyOnlyMeta) return;
    if (initialEntrySpacePath !== spacePath) {
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
  }, [applyMeta, bodyOnly, bodyOnlyMeta, initialEntrySpacePath, spacePath]);

  return {
    applyLoadedEntry,
    descriptionRef,
    documentLoading,
    iconRef,
    loadedDocumentKey,
    refreshLoadedDocumentKey,
    setTitle,
    titleRef,
  };
}
