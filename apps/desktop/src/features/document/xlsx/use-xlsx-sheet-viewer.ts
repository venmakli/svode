import { useCallback, useEffect, useRef, useState } from "react";
import type {
  XlsxSelectionState,
  XlsxSheetViewer,
  XlsxWorkbook,
} from "@silurus/ooxml/xlsx";

import type { DocumentViewState } from "../model/types";
import {
  getXlsxRuntime,
  normalizeXlsxRuntimeError,
  XLSX_IMAGE_RESOURCES,
  XLSX_USED_ROW_LIMIT,
} from "./xlsx-runtime";
import {
  cellAddressReference,
  inspectActiveXlsxCell,
  nextXlsxCellOnEnter,
  type XlsxCellInspection,
} from "./xlsx-selection";

type XlsxSheetViewerHandle = Omit<XlsxSheetViewer, "load">;

export function useXlsxSheetViewer({
  onRegisterRendererDisposer,
  onRenderError,
  onViewStateChange,
  viewState,
  viewportLabel,
  workbook,
}: {
  onRegisterRendererDisposer(disposer: () => void): () => void;
  onRenderError(error: unknown): void;
  onViewStateChange(
    update:
      | DocumentViewState
      | ((current: DocumentViewState) => DocumentViewState),
  ): void;
  viewState: DocumentViewState;
  viewportLabel: string;
  workbook: XlsxWorkbook;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<XlsxSheetViewerHandle | null>(null);
  const viewStateRef = useRef(viewState);
  const findGenerationRef = useRef(0);
  const onRenderErrorRef = useRef(onRenderError);
  const onViewStateChangeRef = useRef(onViewStateChange);
  const [cellInspection, setCellInspection] =
    useState<XlsxCellInspection | null>(null);
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
    const canvas = canvasRef.current;
    if (!canvas) return;
    const host = canvas.parentElement;
    if (!host) return;

    const lifecycle = new AbortController();
    let unregister: () => void = () => undefined;
    let destroy: () => void = () => undefined;
    let resizeObserver: ResizeObserver | null = null;
    let viewport: HTMLElement | null = null;
    let onViewportKeyDown: ((event: KeyboardEvent) => void) | null = null;

    void getXlsxRuntime()
      .then(async (runtime) => {
        if (lifecycle.signal.aborted) return;
        const viewer = runtime.XlsxSheetViewer.fromWorkbook(canvas, workbook, {
          comments: false,
          enableElementSelection: false,
          enableHyperlinks: false,
          imageResources: XLSX_IMAGE_RESOURCES,
          onError: (error) =>
            onRenderErrorRef.current(normalizeXlsxRuntimeError(error)),
          onScaleChange: (scale) => updateViewState({ zoom: scale }),
          onSelectionContextChange: (context) =>
            setCellInspection(inspectActiveXlsxCell(context)),
          onSelectionStateChange: (selection) =>
            updateViewState({
              spreadsheetSelection: cloneSelection(selection),
            }),
          onSheetChange: (sheetIndex) => updateViewState({ sheetIndex }),
          resizable: false,
          showScrollbars: true,
        });
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
          if (viewport && onViewportKeyDown) {
            viewport.removeEventListener("keydown", onViewportKeyDown, true);
          }
          if (viewerRef.current === viewer) viewerRef.current = null;
          viewer.destroy();
        };
        viewerRef.current = viewer;
        unregister = onRegisterRendererDisposer(destroy);

        const viewerMount = canvas.parentElement;
        if (viewerMount && viewerMount !== host) {
          viewerMount.style.display = "block";
          viewerMount.style.height = "100%";
          viewerMount.style.width = "100%";
        }

        viewport = host.querySelector<HTMLElement>(
          "[data-xlsx-viewport-input]",
        );
        viewport?.setAttribute("aria-label", viewportLabel);
        onViewportKeyDown = (event) => {
          if (
            event.key !== "Enter" ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey
          ) {
            return;
          }
          const activeCell = viewer.selectionState?.activeCell;
          if (!activeCell) return;
          const nextCell = nextXlsxCellOnEnter(activeCell, XLSX_USED_ROW_LIMIT);
          const nextReference = cellAddressReference(nextCell);
          event.preventDefault();
          event.stopPropagation();
          viewer.setSelection(nextReference);
          void viewer
            .scrollToCell(nextReference)
            .catch((error) =>
              onRenderErrorRef.current(normalizeXlsxRuntimeError(error)),
            );
        };
        viewport?.addEventListener("keydown", onViewportKeyDown, true);

        const initial = viewStateRef.current;
        await viewer.goToSheet(
          clampSheet(initial.sheetIndex, workbook.sheetCount),
        );
        if (lifecycle.signal.aborted) return;
        applyZoom(viewer, initial.zoomMode, initial.zoom);
        viewer.setSelection(initial.spreadsheetSelection ?? "A1");

        const ResizeObserverConstructor = globalThis.ResizeObserver;
        if (ResizeObserverConstructor) {
          resizeObserver = new ResizeObserverConstructor(() => {
            void viewer
              .relayout()
              .catch((error) =>
                onRenderErrorRef.current(normalizeXlsxRuntimeError(error)),
              );
          });
          resizeObserver.observe(host);
        }
        setViewerGeneration((generation) => generation + 1);
      })
      .catch((error) => {
        if (!lifecycle.signal.aborted) {
          onRenderErrorRef.current(normalizeXlsxRuntimeError(error));
        }
      });

    return () => {
      lifecycle.abort();
      unregister();
      destroy();
    };
  }, [onRegisterRendererDisposer, updateViewState, viewportLabel, workbook]);

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
        updateViewState({ activeFindIndex: matches[0]?.matchIndex ?? 0 });
      })
      .catch((error) =>
        onRenderErrorRef.current(normalizeXlsxRuntimeError(error)),
      );
  }, [updateViewState, viewState.findQuery, viewerGeneration]);

  const goToSheet = useCallback(
    (sheetIndex: number) => {
      const next = clampSheet(sheetIndex, workbook.sheetCount);
      updateViewState({ sheetIndex: next, spreadsheetSelection: null });
      setCellInspection(null);
      void viewerRef.current
        ?.goToSheet(next)
        .catch((error) =>
          onRenderErrorRef.current(normalizeXlsxRuntimeError(error)),
        );
    },
    [updateViewState, workbook.sheetCount],
  );

  const setZoom = useCallback(
    (zoom: number) => {
      const next = Math.min(Math.max(zoom, 0.1), 4);
      updateViewState({ zoom: next, zoomMode: "custom" });
      viewerRef.current?.setScale(next);
    },
    [updateViewState],
  );

  const fitWidth = useCallback(() => {
    updateViewState({ zoomMode: "width" });
    viewerRef.current?.fitWidth();
  }, [updateViewState]);

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
            sheetIndex: match.location.sheet,
          });
        })
        .catch((error) =>
          onRenderErrorRef.current(normalizeXlsxRuntimeError(error)),
        );
    },
    [findMatches, updateViewState],
  );

  return {
    canvasRef,
    cellInspection,
    findMatches: viewState.findQuery.trim() ? findMatches : 0,
    fitWidth,
    goToSheet,
    navigateFind,
    setZoom,
  };
}

function applyZoom(
  viewer: XlsxSheetViewerHandle,
  mode: DocumentViewState["zoomMode"],
  zoom: number,
) {
  if (mode === "width") viewer.fitWidth();
  else if (mode === "page") viewer.fitPage();
  else viewer.setScale(zoom);
}

function cloneSelection(selection: XlsxSelectionState | null) {
  return selection ? structuredClone(selection) : null;
}

function clampSheet(sheetIndex: number, sheetCount: number) {
  return Math.min(Math.max(sheetIndex, 0), Math.max(sheetCount - 1, 0));
}
