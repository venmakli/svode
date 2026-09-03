import { useCallback, useEffect, type ReactNode } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

import { Alert, AlertDescription } from "@/components/ui/alert";
import * as m from "@/paraglide/messages.js";

import type { DocumentViewState } from "../model/types";
import { PdfThumbnails } from "./pdf-thumbnails";
import { PdfToolbar } from "./pdf-toolbar";
import { usePdfJsViewer } from "./use-pdfjs-viewer";
import "./pdf-viewer.css";

export function PdfViewer({
  externalOpenError,
  onOpenExternal,
  onRenderError,
  onViewStateChange,
  pdf,
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
  title: string;
  toolbarActions?: ReactNode;
  viewState: DocumentViewState;
}) {
  useEffect(() => {
    if (viewState.pageNumber > pdf.numPages) {
      onViewStateChange((current) => ({
        ...current,
        pageNumber: pdf.numPages,
      }));
    }
  }, [onViewStateChange, pdf.numPages, viewState.pageNumber]);

  const setPage = useCallback(
    (pageNumber: number) => {
      const nextPage = Math.min(Math.max(pageNumber, 1), pdf.numPages);
      if (nextPage === viewState.pageNumber) return;
      onViewStateChange((current) => ({
        ...current,
        pageNumber: nextPage,
      }));
    },
    [onViewStateChange, pdf.numPages, viewState.pageNumber],
  );
  const {
    activeFindIndex,
    containerRef,
    findMatches,
    navigateFind,
    viewerElementRef,
  } = usePdfJsViewer({
    onRenderError,
    onViewStateChange,
    pdf,
    viewState,
  });

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden"
      data-document-viewer="pdf"
      aria-label={`${title}: ${m.document_read_only_preview()}`}
    >
      <PdfToolbar
        activeFindIndex={activeFindIndex}
        findMatches={findMatches}
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
        <div className="relative min-h-0 min-w-0 flex-1 bg-muted/40">
          <div
            ref={containerRef}
            className="document-pdf-viewport scrollbar-hide absolute inset-0 overflow-auto overscroll-contain"
            aria-label={m.document_pdf_viewport()}
            tabIndex={0}
          >
            <div ref={viewerElementRef} className="pdfViewer" />
          </div>
        </div>
      </div>
    </div>
  );
}
