import type { ReactNode } from "react";
import type { PptxPresentation } from "@silurus/ooxml/pptx";

import { Alert, AlertDescription } from "@/components/ui/alert";
import * as m from "@/paraglide/messages.js";

import type { DocumentViewState } from "../model/types";
import { PptxThumbnails } from "./pptx-thumbnails";
import { PptxToolbar } from "./pptx-toolbar";
import { usePptxSlideViewer } from "./use-pptx-slide-viewer";

export function PptxViewer({
  externalOpenError,
  onOpenExternal,
  onRegisterRendererDisposer,
  onRenderError,
  onViewStateChange,
  presentation,
  title,
  toolbarActions,
  viewState,
}: {
  externalOpenError: string | null;
  onOpenExternal(): void;
  onRegisterRendererDisposer(disposer: () => void): () => void;
  onRenderError(error: unknown): void;
  onViewStateChange(
    update:
      | DocumentViewState
      | ((current: DocumentViewState) => DocumentViewState),
  ): void;
  presentation: PptxPresentation;
  title: string;
  toolbarActions?: ReactNode;
  viewState: DocumentViewState;
}) {
  const {
    canvasRef,
    findMatches,
    fit,
    goToSlide,
    limitedSlides,
    navigateFind,
    reportSlideError,
    setZoom,
    viewportRef,
  } = usePptxSlideViewer({
    onRegisterRendererDisposer,
    onRenderError,
    onViewStateChange,
    presentation,
    viewState,
  });
  const activeSlideLimited = limitedSlides.has(viewState.slideNumber);

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden"
      data-document-viewer="pptx"
      aria-label={`${title}: ${m.document_limited_preview()}`}
    >
      <PptxToolbar
        findMatches={findMatches}
        fit={fit}
        goToSlide={goToSlide}
        navigateFind={navigateFind}
        onOpenExternal={onOpenExternal}
        onViewStateChange={onViewStateChange}
        setZoom={setZoom}
        slideCount={presentation.slideCount}
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
          <PptxThumbnails
            activeSlide={viewState.slideNumber}
            limitedSlides={limitedSlides}
            onSlideChange={goToSlide}
            onSlideRenderError={reportSlideError}
            presentation={presentation}
          />
        ) : null}
        <div className="relative min-h-0 min-w-0 flex-1 bg-muted/40">
          <div
            ref={viewportRef}
            className="scrollbar-hide absolute inset-0 overflow-auto overscroll-contain p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            role="region"
            aria-label={m.document_pptx_viewport()}
            tabIndex={0}
          >
            <div className="flex min-h-full min-w-full items-center justify-center">
              <canvas ref={canvasRef} className="bg-white shadow-sm">
                {m.document_pptx_canvas_fallback()}
              </canvas>
            </div>
          </div>
          {activeSlideLimited ? (
            <Alert className="absolute bottom-3 left-3 right-3">
              <AlertDescription>
                {m.document_pptx_slide_limited()}
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
      </div>
    </div>
  );
}
