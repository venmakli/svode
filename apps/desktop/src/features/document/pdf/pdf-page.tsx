import { useEffect, useRef } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

import { getPdfJsRuntime, isAbortError } from "./pdf-runtime";

const PDF_RENDER_PIXEL_LIMIT = 16_777_216;

export function PdfPage({
  availableHeight,
  availableWidth,
  findQuery,
  pageNumber,
  onRenderError,
  pdf,
  rotation,
  zoom,
  zoomMode,
}: {
  availableHeight: number;
  availableWidth: number;
  findQuery: string;
  pageNumber: number;
  onRenderError(error: unknown): void;
  pdf: PDFDocumentProxy;
  rotation: 0 | 90 | 180 | 270;
  zoom: number;
  zoomMode: "custom" | "page" | "width";
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const findQueryRef = useRef(findQuery);

  useEffect(() => {
    findQueryRef.current = findQuery;
    const layer = layerRef.current;
    if (layer) markFindMatches(layer, findQuery);
  }, [findQuery]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const layer = layerRef.current;
    if (!canvas || !layer || availableWidth <= 0 || availableHeight <= 0)
      return;
    const controller = new AbortController();
    let cancelRender: (() => void) | undefined;
    let cancelText: (() => void) | undefined;

    void (async () => {
      const [page, pdfjs] = await Promise.all([
        pdf.getPage(pageNumber),
        getPdfJsRuntime(),
      ]);
      if (controller.signal.aborted) return;
      const base = page.getViewport({ rotation, scale: 1 });
      const widthScale = Math.max((availableWidth - 32) / base.width, 0.25);
      const pageScale = Math.max(
        Math.min(widthScale, (availableHeight - 32) / base.height),
        0.25,
      );
      const scale = Math.min(
        zoomMode === "width"
          ? widthScale
          : zoomMode === "page"
            ? pageScale
            : zoom,
        4,
      );
      const viewport = page.getViewport({ rotation, scale });
      const requestedPixelRatio = window.devicePixelRatio || 1;
      const boundedPixelRatio = Math.min(
        requestedPixelRatio,
        Math.sqrt(PDF_RENDER_PIXEL_LIMIT / (viewport.width * viewport.height)),
      );
      canvas.width = Math.max(
        Math.floor(viewport.width * boundedPixelRatio),
        1,
      );
      canvas.height = Math.max(
        Math.floor(viewport.height * boundedPixelRatio),
        1,
      );
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      layer.replaceChildren();
      layer.style.width = `${viewport.width}px`;
      layer.style.height = `${viewport.height}px`;
      layer.style.setProperty("--scale-factor", String(scale));
      layer.style.setProperty("--total-scale-factor", String(scale));

      const renderTask = page.render({
        annotationMode: pdfjs.AnnotationMode.DISABLE,
        canvas,
        transform:
          boundedPixelRatio === 1
            ? undefined
            : [boundedPixelRatio, 0, 0, boundedPixelRatio, 0, 0],
        viewport,
      });
      cancelRender = () => renderTask.cancel();
      const textContent = await page.getTextContent();
      if (controller.signal.aborted) return;
      const textLayer = new pdfjs.TextLayer({
        container: layer,
        textContentSource: textContent,
        viewport,
      });
      cancelText = () => textLayer.cancel();
      await Promise.all([renderTask.promise, textLayer.render()]);
      if (!controller.signal.aborted) {
        markFindMatches(layer, findQueryRef.current);
      }
    })().catch((error) => {
      if (!controller.signal.aborted && !isAbortError(error)) {
        canvas.dataset.renderError = "true";
        onRenderError(error);
      }
    });

    return () => {
      controller.abort();
      cancelRender?.();
      cancelText?.();
      canvas.width = 0;
      canvas.height = 0;
      layer.replaceChildren();
    };
  }, [
    availableHeight,
    availableWidth,
    pageNumber,
    onRenderError,
    pdf,
    rotation,
    zoom,
    zoomMode,
  ]);

  return (
    <div
      className="relative shrink-0 bg-white shadow-sm"
      aria-label={`PDF page ${pageNumber}`}
      data-pdf-page={pageNumber}
    >
      <canvas ref={canvasRef} className="block" />
      <div
        ref={layerRef}
        className="document-pdf-text-layer"
        data-testid="pdf-text-layer"
      />
    </div>
  );
}

function markFindMatches(layer: HTMLElement, query: string) {
  for (const span of layer.querySelectorAll("span[data-find-match]")) {
    delete (span as HTMLElement).dataset.findMatch;
  }
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return;
  for (const span of layer.querySelectorAll("span")) {
    if (span.textContent?.toLocaleLowerCase().includes(normalized)) {
      span.dataset.findMatch = "true";
    }
  }
}
