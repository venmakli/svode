import { useCallback, useEffect, useRef, useState } from "react";
import type { PptxPresentation, PptxViewer } from "@silurus/ooxml/pptx";

import type { DocumentViewState, DocumentZoomMode } from "../model/types";
import {
  getPptxRuntime,
  normalizePptxRuntimeError,
  PPTX_IMAGE_RESOURCES,
  PptxRuntimeFailure,
} from "./pptx-runtime";

type PptxViewerHandle = Omit<PptxViewer, "load">;

export function usePptxSlideViewer({
  onRegisterRendererDisposer,
  onRenderError,
  onViewStateChange,
  presentation,
  viewState,
}: {
  onRegisterRendererDisposer(disposer: () => void): () => void;
  onRenderError(error: unknown): void;
  onViewStateChange(
    update:
      | DocumentViewState
      | ((current: DocumentViewState) => DocumentViewState),
  ): void;
  presentation: PptxPresentation;
  viewState: DocumentViewState;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PptxViewerHandle | null>(null);
  const viewStateRef = useRef(viewState);
  const findGenerationRef = useRef(0);
  const onRenderErrorRef = useRef(onRenderError);
  const onViewStateChangeRef = useRef(onViewStateChange);
  const [findMatches, setFindMatches] = useState(0);
  const [limitedSlides, setLimitedSlides] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
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

  const reportSlideError = useCallback(
    (slideNumber: number, error: unknown) => {
      const failure = normalizePptxRuntimeError(error);
      if (
        failure instanceof PptxRuntimeFailure &&
        failure.kind === "renderer_error"
      ) {
        setLimitedSlides((current) => {
          if (current.has(slideNumber)) return current;
          return new Set([...current, slideNumber]);
        });
        return;
      }
      onRenderErrorRef.current(failure);
    },
    [],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport) return;
    const fitHost = canvas.parentElement;
    if (!fitHost) return;

    const lifecycle = new AbortController();
    let unregister: () => void = () => undefined;
    let destroy: () => void = () => undefined;
    let resizeObserver: ResizeObserver | null = null;

    void getPptxRuntime()
      .then(async (runtime) => {
        if (lifecycle.signal.aborted) return;
        let viewer: PptxViewerHandle;
        try {
          viewer = runtime.PptxViewer.fromPresentation(canvas, presentation, {
            enableElementSelection: false,
            enableHyperlinks: false,
            enableMediaPlayback: false,
            enableTextSelection: true,
            hiddenSlideMode: "show",
            imageResources: PPTX_IMAGE_RESOURCES,
            onError: (error) => {
              if (!lifecycle.signal.aborted) {
                reportSlideError(
                  (viewerRef.current?.slideIndex ?? 0) + 1,
                  error,
                );
              }
            },
            onScaleChange: (scale) => updateViewState({ zoom: scale }),
            onSlideChange: (slideIndex) =>
              updateViewState({ slideNumber: slideIndex + 1 }),
          });
        } catch (error) {
          onRenderErrorRef.current(normalizePptxRuntimeError(error));
          return;
        }
        if (lifecycle.signal.aborted) {
          viewer.destroy();
          return;
        }

        let destroyed = false;
        destroy = () => {
          if (destroyed) return;
          destroyed = true;
          resizeObserver?.disconnect();
          resizeObserver = null;
          if (viewerRef.current === viewer) viewerRef.current = null;
          viewer.destroy();
        };
        viewerRef.current = viewer;
        unregister = onRegisterRendererDisposer(destroy);

        const initial = viewStateRef.current;
        try {
          await applyZoom(viewer, initial.zoomMode, initial.zoom);
          const initialSlide = clampSlide(
            initial.slideNumber,
            presentation.slideCount,
          );
          if (initialSlide !== 1) await viewer.goToSlide(initialSlide - 1);
        } catch (error) {
          reportSlideError(
            clampSlide(initial.slideNumber, presentation.slideCount),
            error,
          );
        }
        if (lifecycle.signal.aborted) return;

        const ResizeObserverConstructor = globalThis.ResizeObserver;
        if (ResizeObserverConstructor) {
          resizeObserver = new ResizeObserverConstructor(() => {
            const mode = viewStateRef.current.zoomMode;
            if (mode === "custom") return;
            const fit = mode === "page" ? viewer.fitPage() : viewer.fitWidth();
            void fit.catch((error) =>
              reportSlideError(viewStateRef.current.slideNumber, error),
            );
          });
          resizeObserver.observe(fitHost);
        }
        setViewerGeneration((generation) => generation + 1);
      })
      .catch((error) => {
        if (!lifecycle.signal.aborted) {
          onRenderErrorRef.current(normalizePptxRuntimeError(error));
        }
      });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      const current = viewStateRef.current.slideNumber;
      let next: number | null = null;
      if (event.key === "ArrowLeft" || event.key === "PageUp")
        next = current - 1;
      if (event.key === "ArrowRight" || event.key === "PageDown")
        next = current + 1;
      if (event.key === "Home") next = 1;
      if (event.key === "End") next = presentation.slideCount;
      if (next === null) return;
      event.preventDefault();
      const slideNumber = clampSlide(next, presentation.slideCount);
      updateViewState({ slideNumber });
      void viewerRef.current
        ?.goToSlide(slideNumber - 1)
        .catch((error) => reportSlideError(slideNumber, error));
    };
    viewport.addEventListener("keydown", onKeyDown);

    return () => {
      lifecycle.abort();
      viewport.removeEventListener("keydown", onKeyDown);
      unregister();
      destroy();
    };
  }, [
    onRegisterRendererDisposer,
    presentation,
    reportSlideError,
    updateViewState,
  ]);

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
        const first = matches[0];
        updateViewState(
          first
            ? {
                activeFindIndex: first.matchIndex,
                slideNumber: first.location.slide + 1,
              }
            : { activeFindIndex: 0 },
        );
      })
      .catch((error) =>
        reportSlideError(viewStateRef.current.slideNumber, error),
      );
  }, [
    reportSlideError,
    updateViewState,
    viewState.findQuery,
    viewerGeneration,
  ]);

  const goToSlide = useCallback(
    (slideNumber: number) => {
      const next = clampSlide(slideNumber, presentation.slideCount);
      updateViewState({ slideNumber: next });
      void viewerRef.current
        ?.goToSlide(next - 1)
        .catch((error) => reportSlideError(next, error));
    },
    [presentation.slideCount, reportSlideError, updateViewState],
  );

  const setZoom = useCallback(
    (zoom: number) => {
      const next = Math.min(Math.max(zoom, 0.1), 4);
      updateViewState({ zoom: next, zoomMode: "custom" });
      void viewerRef.current
        ?.setScale(next)
        .catch((error) =>
          reportSlideError(viewStateRef.current.slideNumber, error),
        );
    },
    [reportSlideError, updateViewState],
  );

  const fit = useCallback(
    (mode: Extract<DocumentZoomMode, "page" | "width">) => {
      updateViewState({ zoomMode: mode });
      const operation =
        mode === "page"
          ? viewerRef.current?.fitPage()
          : viewerRef.current?.fitWidth();
      void operation?.catch((error) =>
        reportSlideError(viewStateRef.current.slideNumber, error),
      );
    },
    [reportSlideError, updateViewState],
  );

  const navigateFind = useCallback(
    (direction: 1 | -1) => {
      const viewer = viewerRef.current;
      if (!viewer || !findMatches) return;
      const navigation = direction > 0 ? viewer.findNext() : viewer.findPrev();
      void navigation
        .then((match) => {
          if (!match) return;
          updateViewState({
            activeFindIndex: match.matchIndex,
            slideNumber: match.location.slide + 1,
          });
        })
        .catch((error) =>
          reportSlideError(viewStateRef.current.slideNumber, error),
        );
    },
    [findMatches, reportSlideError, updateViewState],
  );

  return {
    canvasRef,
    findMatches: viewState.findQuery.trim() ? findMatches : 0,
    fit,
    goToSlide,
    limitedSlides,
    navigateFind,
    reportSlideError,
    setZoom,
    viewportRef,
  };
}

async function applyZoom(
  viewer: PptxViewerHandle,
  mode: DocumentZoomMode,
  zoom: number,
) {
  if (mode === "page") await viewer.fitPage();
  else if (mode === "width") await viewer.fitWidth();
  else await viewer.setScale(zoom);
}

function clampSlide(slideNumber: number, slideCount: number) {
  return Math.min(Math.max(slideNumber, 1), Math.max(slideCount, 1));
}
