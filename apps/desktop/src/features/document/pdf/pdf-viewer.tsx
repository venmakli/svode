import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

import { Alert, AlertDescription } from "@/components/ui/alert";
import * as m from "@/paraglide/messages.js";

import type { DocumentViewState, PdfTextIndex } from "../model/types";
import { PdfPage } from "./pdf-page";
import { PdfThumbnails } from "./pdf-thumbnails";
import { findPdfTextMatches } from "./pdf-text-index";
import { PdfToolbar } from "./pdf-toolbar";
import "./pdf-viewer.css";

export function PdfViewer({
  externalOpenError,
  onOpenExternal,
  onRenderError,
  onViewStateChange,
  pdf,
  textIndex,
  title,
  toolbarActions,
  viewState,
}: {
  externalOpenError: string | null;
  onOpenExternal(): void;
  onRenderError(error: unknown): void;
  onViewStateChange(
    update:
      | DocumentViewState
      | ((current: DocumentViewState) => DocumentViewState),
  ): void;
  pdf: PDFDocumentProxy;
  textIndex: PdfTextIndex;
  title: string;
  toolbarActions?: ReactNode;
  viewState: DocumentViewState;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportSize, setViewportSize] = useState({ height: 0, width: 0 });
  const matches = useMemo(
    () => findPdfTextMatches(textIndex, viewState.findQuery),
    [textIndex, viewState.findQuery],
  );
  const activeFindIndex = matches.length
    ? viewState.activeFindIndex % matches.length
    : 0;

  useEffect(() => {
    if (viewState.pageNumber > pdf.numPages) {
      onViewStateChange((current) => ({
        ...current,
        pageNumber: pdf.numPages,
      }));
    }
  }, [onViewStateChange, pdf.numPages, viewState.pageNumber]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () =>
      setViewportSize({
        height: viewport.clientHeight,
        width: viewport.clientWidth,
      });
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    update();
    return () => observer.disconnect();
  }, []);

  const setPage = (pageNumber: number) =>
    onViewStateChange((current) => ({
      ...current,
      pageNumber: Math.min(Math.max(pageNumber, 1), pdf.numPages),
    }));
  const navigateFind = (direction: 1 | -1) => {
    if (!matches.length) return;
    const nextIndex =
      (activeFindIndex + direction + matches.length) % matches.length;
    onViewStateChange((current) => ({
      ...current,
      activeFindIndex: nextIndex,
      pageNumber: matches[nextIndex].pageNumber,
    }));
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden"
      data-document-viewer="pdf"
      aria-label={`${title}: ${m.document_read_only_preview()}`}
    >
      <PdfToolbar
        activeFindIndex={activeFindIndex}
        findMatches={matches.length}
        onFindNavigate={navigateFind}
        onOpenExternal={onOpenExternal}
        onPageChange={setPage}
        onViewStateChange={onViewStateChange}
        pageCount={pdf.numPages}
        title={title}
        toolbarActions={toolbarActions}
        viewState={viewState}
      />
      {externalOpenError ? (
        <Alert
          variant="destructive"
          className="shrink-0 rounded-none border-x-0 border-t-0"
        >
          <AlertDescription>
            {m.document_external_open_error()}
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {viewState.thumbnailsOpen ? (
          <PdfThumbnails
            activePage={viewState.pageNumber}
            onPageChange={setPage}
            pdf={pdf}
          />
        ) : null}
        <div
          ref={viewportRef}
          className="scrollbar-hide flex min-h-0 min-w-0 flex-1 items-start justify-center overflow-auto bg-muted/40 p-4"
          aria-label={m.document_pdf_viewport()}
          tabIndex={0}
        >
          <PdfPage
            availableHeight={viewportSize.height}
            availableWidth={viewportSize.width}
            findQuery={viewState.findQuery}
            onRenderError={onRenderError}
            pageNumber={viewState.pageNumber}
            pdf={pdf}
            rotation={viewState.rotation}
            zoom={viewState.zoom}
            zoomMode={viewState.zoomMode}
          />
        </div>
      </div>
    </div>
  );
}
