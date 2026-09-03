import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

import type { DocumentViewState, PdfZoomMode } from "../model/types";
import {
  getPdfJsRuntime,
  getPdfJsViewerRuntime,
  isAbortError,
} from "./pdf-runtime";

const PDF_RENDER_PIXEL_LIMIT = 16_777_216;

type PdfJsViewerModule = Awaited<ReturnType<typeof getPdfJsViewerRuntime>>;
type PdfJsViewer = InstanceType<PdfJsViewerModule["PDFViewer"]>;
type PdfJsEventBus = InstanceType<PdfJsViewerModule["EventBus"]>;

interface PdfFindEvent {
  source: unknown;
  type: "" | "again";
  query: string;
  caseSensitive: boolean;
  entireWord: boolean;
  findPrevious: boolean;
  highlightAll: boolean;
  matchDiacritics: boolean;
}

interface PdfFindMatchesEvent {
  matchesCount: {
    current: number;
    total: number;
  };
}

interface PdfPageChangingEvent {
  pageNumber: number;
}

interface PdfPageRenderedEvent {
  error?: unknown;
}

interface PdfRotationChangingEvent {
  pagesRotation: number;
}

interface PdfScaleChangingEvent {
  presetValue?: string;
  scale: number;
}

interface PdfViewerOptionsWithAbort {
  abortSignal: AbortSignal;
}

export function usePdfJsViewer({
  onRenderError,
  onViewStateChange,
  pdf,
  viewState,
}: {
  onRenderError(error: unknown): void;
  onViewStateChange(
    update:
      | DocumentViewState
      | ((current: DocumentViewState) => DocumentViewState),
  ): void;
  pdf: PDFDocumentProxy;
  viewState: DocumentViewState;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerElementRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PdfJsViewer | null>(null);
  const eventBusRef = useRef<PdfJsEventBus | null>(null);
  const readyRef = useRef(false);
  const viewStateRef = useRef(viewState);
  const onRenderErrorRef = useRef(onRenderError);
  const onViewStateChangeRef = useRef(onViewStateChange);
  const [findMatches, setFindMatches] = useState({ current: 0, total: 0 });

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

  const dispatchFind = useCallback(
    (type: "" | "again", findPrevious = false) => {
      const query = viewStateRef.current.findQuery.trim();
      const eventBus = eventBusRef.current;
      if (!eventBus || !query) return;
      eventBus.dispatch("find", {
        caseSensitive: false,
        entireWord: false,
        findPrevious,
        highlightAll: true,
        matchDiacritics: false,
        query,
        source: viewerRef.current,
        type,
      } satisfies PdfFindEvent);
    },
    [],
  );

  useEffect(() => {
    const container = containerRef.current;
    const viewerElement = viewerElementRef.current;
    if (!container || !viewerElement) return;

    const lifecycle = new AbortController();
    let viewer: PdfJsViewer | null = null;
    let linkService: InstanceType<PdfJsViewerModule["PDFLinkService"]> | null =
      null;

    void (async () => {
      const [pdfjs, viewerRuntime] = await Promise.all([
        getPdfJsRuntime(),
        getPdfJsViewerRuntime(),
      ]);
      if (lifecycle.signal.aborted) return;

      const eventBus = new viewerRuntime.EventBus();
      linkService = new viewerRuntime.PDFLinkService({
        eventBus,
        ignoreDestinationZoom: true,
      });
      linkService.externalLinkEnabled = false;
      const findController = new viewerRuntime.PDFFindController({
        eventBus,
        linkService,
      });
      const options = {
        abortSignal: lifecycle.signal,
        annotationEditorMode: pdfjs.AnnotationEditorType.DISABLE,
        annotationMode: pdfjs.AnnotationMode.DISABLE,
        container,
        enableAutoLinking: false,
        eventBus,
        findController,
        imagesRightClickMinSize: -1,
        linkService,
        maxCanvasPixels: PDF_RENDER_PIXEL_LIMIT,
        viewer: viewerElement,
      } as ConstructorParameters<PdfJsViewerModule["PDFViewer"]>[0] &
        PdfViewerOptionsWithAbort;
      viewer = new viewerRuntime.PDFViewer(options);
      viewerRef.current = viewer;
      eventBusRef.current = eventBus;
      linkService.setViewer(viewer);
      linkService.setDocument(pdf);

      eventBus.on(
        "pagesinit",
        () => {
          if (!viewer || lifecycle.signal.aborted) return;
          const desired = viewStateRef.current;
          readyRef.current = true;
          viewer.scrollMode = viewerRuntime.ScrollMode.VERTICAL;
          viewer.pagesRotation = desired.rotation;
          viewer.currentScaleValue = scaleValue(desired.zoomMode, desired.zoom);
          viewer.currentPageNumber = clampPage(
            desired.pageNumber,
            pdf.numPages,
          );
          if (desired.findQuery.trim()) dispatchFind("");
        },
        { signal: lifecycle.signal },
      );
      eventBus.on(
        "pagechanging",
        ({ pageNumber }: PdfPageChangingEvent) => {
          if (pageNumber !== viewStateRef.current.pageNumber) {
            updateViewState({ pageNumber });
          }
        },
        { signal: lifecycle.signal },
      );
      eventBus.on(
        "scalechanging",
        ({ presetValue, scale }: PdfScaleChangingEvent) => {
          const zoomMode = zoomModeFromPreset(presetValue);
          const current = viewStateRef.current;
          if (
            Math.abs(current.zoom - scale) > 0.001 ||
            (zoomMode && current.zoomMode !== zoomMode)
          ) {
            updateViewState({
              zoom: scale,
              zoomMode: zoomMode ?? current.zoomMode,
            });
          }
        },
        { signal: lifecycle.signal },
      );
      eventBus.on(
        "rotationchanging",
        ({ pagesRotation }: PdfRotationChangingEvent) => {
          if (pagesRotation !== viewStateRef.current.rotation) {
            updateViewState({
              rotation: pagesRotation as DocumentViewState["rotation"],
            });
          }
        },
        { signal: lifecycle.signal },
      );
      const updateFindMatches = ({ matchesCount }: PdfFindMatchesEvent) => {
        setFindMatches(matchesCount);
        const activeFindIndex = Math.max(matchesCount.current - 1, 0);
        if (activeFindIndex !== viewStateRef.current.activeFindIndex) {
          updateViewState({ activeFindIndex });
        }
      };
      eventBus.on("updatefindmatchescount", updateFindMatches, {
        signal: lifecycle.signal,
      });
      eventBus.on("updatefindcontrolstate", updateFindMatches, {
        signal: lifecycle.signal,
      });
      eventBus.on(
        "pagerendered",
        ({ error }: PdfPageRenderedEvent) => {
          if (error && !isAbortError(error)) onRenderErrorRef.current(error);
        },
        { signal: lifecycle.signal },
      );

      viewer.setDocument(pdf);
    })().catch((error) => {
      if (!lifecycle.signal.aborted && !isAbortError(error)) {
        onRenderErrorRef.current(error);
      }
    });

    return () => {
      readyRef.current = false;
      lifecycle.abort();
      if (viewerRef.current === viewer) viewerRef.current = null;
      eventBusRef.current = null;
      viewer?.setDocument(null as unknown as PDFDocumentProxy);
      viewer?.cleanup();
      linkService?.setDocument(null);
      viewerElement.replaceChildren();
    };
  }, [dispatchFind, pdf, updateViewState]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !readyRef.current) return;
    const pageNumber = clampPage(viewState.pageNumber, pdf.numPages);
    if (viewer.currentPageNumber !== pageNumber) {
      viewer.currentPageNumber = pageNumber;
    }
  }, [pdf.numPages, viewState.pageNumber]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !readyRef.current) return;
    const value = scaleValue(viewState.zoomMode, viewState.zoom);
    if (viewer.currentScaleValue !== value) viewer.currentScaleValue = value;
  }, [viewState.zoom, viewState.zoomMode]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !readyRef.current) return;
    if (viewer.pagesRotation !== viewState.rotation) {
      viewer.pagesRotation = viewState.rotation;
    }
  }, [viewState.rotation]);

  useEffect(() => {
    const eventBus = eventBusRef.current;
    if (!eventBus || !readyRef.current) return;
    if (!viewState.findQuery.trim()) {
      eventBus.dispatch("findbarclose", { source: viewerRef.current });
      return;
    }
    dispatchFind("");
  }, [dispatchFind, viewState.findQuery]);

  const hasFindQuery = Boolean(viewState.findQuery.trim());
  return {
    activeFindIndex: hasFindQuery ? Math.max(findMatches.current - 1, 0) : 0,
    containerRef,
    findMatches: hasFindQuery ? findMatches.total : 0,
    navigateFind: (direction: 1 | -1) => dispatchFind("again", direction < 0),
    viewerElementRef,
  };
}

function clampPage(pageNumber: number, pageCount: number) {
  return Math.min(Math.max(pageNumber, 1), pageCount);
}

function scaleValue(zoomMode: PdfZoomMode, zoom: number) {
  switch (zoomMode) {
    case "page":
      return "page-fit";
    case "width":
      return "page-width";
    default:
      return String(zoom);
  }
}

function zoomModeFromPreset(value?: string): PdfZoomMode | null {
  if (value === "page-fit") return "page";
  if (value === "page-width") return "width";
  return null;
}
