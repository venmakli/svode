import { useCallback, useEffect, useRef, useState } from "react";
import type { DocxDocument, DocxScrollViewer } from "@silurus/ooxml/docx";

import type { DocumentViewState, DocumentZoomMode } from "../model/types";
import {
  DOCX_IMAGE_RESOURCES,
  getDocxRuntime,
  normalizeDocxRuntimeError,
} from "./docx-runtime";

type DocxScrollViewerHandle = Omit<DocxScrollViewer, "load">;

export function useDocxScrollViewer({
  document,
  onRegisterRendererDisposer,
  onRenderError,
  onViewStateChange,
  viewState,
}: {
  document: DocxDocument;
  onRegisterRendererDisposer(disposer: () => void): () => void;
  onRenderError(error: unknown): void;
  onViewStateChange(
    update:
      | DocumentViewState
      | ((current: DocumentViewState) => DocumentViewState),
  ): void;
  viewState: DocumentViewState;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<DocxScrollViewerHandle | null>(null);
  const viewStateRef = useRef(viewState);
  const findGenerationRef = useRef(0);
  const onRenderErrorRef = useRef(onRenderError);
  const onViewStateChangeRef = useRef(onViewStateChange);
  const [findMatches, setFindMatches] = useState(0);
  const [viewerGeneration, setViewerGeneration] = useState(0);

  useEffect(() => {
    viewStateRef.current = viewState;
    onRenderErrorRef.current = onRenderError;
    onViewStateChangeRef.current = onViewStateChange;
  }, [onRenderError, onViewStateChange, viewState]);

  const updateViewState = useCallback((patch: Partial<DocumentViewState>) => {
    onViewStateChangeRef.current((current) => {
      const next = { ...current, ...patch };
      viewStateRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const lifecycle = new AbortController();
    let unregister: () => void = () => undefined;
    let destroyed = false;

    void getDocxRuntime()
      .then((runtime) => {
        if (lifecycle.signal.aborted) return;
        const viewer = runtime.DocxScrollViewer.fromDocument(
          container,
          document,
          {
            background: "transparent",
            enableHyperlinks: false,
            enableTextSelection: true,
            imageResources: DOCX_IMAGE_RESOURCES,
            onError: (error) =>
              onRenderErrorRef.current(normalizeDocxRuntimeError(error)),
            onScaleChange: (scale) => updateViewState({ zoom: scale }),
            onVisiblePageChange: (pageIndex) =>
              updateViewState({ pageNumber: pageIndex + 1 }),
            refitOnResize: true,
          },
        );
        const destroy = () => {
          if (destroyed) return;
          destroyed = true;
          if (viewerRef.current === viewer) viewerRef.current = null;
          viewer.destroy();
          container.replaceChildren();
        };
        viewerRef.current = viewer;
        unregister = onRegisterRendererDisposer(destroy);

        const initial = viewStateRef.current;
        applyZoomMode(viewer, initial.zoomMode, initial.zoom);
        viewer.scrollToPage(clampPage(initial.pageNumber, document.pageCount) - 1);
        setViewerGeneration((generation) => generation + 1);
      })
      .catch((error) => {
        if (!lifecycle.signal.aborted) {
          onRenderErrorRef.current(normalizeDocxRuntimeError(error));
        }
      });

    return () => {
      lifecycle.abort();
      unregister();
      const viewer = viewerRef.current;
      if (viewer) {
        viewerRef.current = null;
        if (!destroyed) viewer.destroy();
      }
      container.replaceChildren();
    };
  }, [document, onRegisterRendererDisposer, updateViewState]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const query = viewState.findQuery.trim();
    const generation = ++findGenerationRef.current;
    if (!viewer || !viewerGeneration) return;
    if (!query) {
      viewer.clearFind();
      return;
    }

    void viewer
      .findText(query, { caseSensitive: false })
      .then((matches) => {
        if (generation !== findGenerationRef.current) return;
        setFindMatches(matches.length);
        updateViewState({
          activeFindIndex: matches[0]?.matchIndex ?? 0,
        });
      })
      .catch((error) =>
        onRenderErrorRef.current(normalizeDocxRuntimeError(error)),
      );
  }, [updateViewState, viewState.findQuery, viewerGeneration]);

  const goToPage = useCallback(
    (pageNumber: number) => {
      const next = clampPage(pageNumber, document.pageCount);
      updateViewState({ pageNumber: next });
      viewerRef.current?.scrollToPage(next - 1);
    },
    [document.pageCount, updateViewState],
  );

  const setZoom = useCallback(
    (zoom: number) => {
      const next = Math.min(Math.max(zoom, 0.1), 4);
      updateViewState({ zoom: next, zoomMode: "custom" });
      viewerRef.current?.setScale(next);
    },
    [updateViewState],
  );

  const fit = useCallback(
    (mode: Extract<DocumentZoomMode, "page" | "width">) => {
      updateViewState({ zoomMode: mode });
      if (mode === "page") viewerRef.current?.fitPage();
      else viewerRef.current?.fitWidth();
    },
    [updateViewState],
  );

  const navigateFind = useCallback(
    (direction: 1 | -1) => {
      const viewer = viewerRef.current;
      if (!viewer || !findMatches) return;
      const navigation = direction > 0 ? viewer.findNext() : viewer.findPrev();
      void navigation
        .then((match) => {
          if (match) updateViewState({ activeFindIndex: match.matchIndex });
        })
        .catch((error) =>
          onRenderErrorRef.current(normalizeDocxRuntimeError(error)),
        );
    },
    [findMatches, updateViewState],
  );

  return {
    containerRef,
    findMatches: viewState.findQuery.trim() ? findMatches : 0,
    fit,
    goToPage,
    navigateFind,
    pageCount: document.pageCount,
    setZoom,
  };
}

function applyZoomMode(
  viewer: DocxScrollViewerHandle,
  mode: DocumentZoomMode,
  zoom: number,
) {
  if (mode === "page") viewer.fitPage();
  else if (mode === "width") viewer.fitWidth();
  else viewer.setScale(zoom);
}

function clampPage(pageNumber: number, pageCount: number) {
  return Math.min(Math.max(pageNumber, 1), Math.max(pageCount, 1));
}
