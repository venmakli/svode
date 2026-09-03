import type { ReactNode } from "react";
import type { DocxDocument } from "@silurus/ooxml/docx";

import { Alert, AlertDescription } from "@/components/ui/alert";
import * as m from "@/paraglide/messages.js";

import type { DocumentViewState } from "../model/types";
import { DocxToolbar } from "./docx-toolbar";
import { useDocxScrollViewer } from "./use-docx-scroll-viewer";

export function DocxViewer({
  docx,
  externalOpenError,
  onOpenExternal,
  onRegisterRendererDisposer,
  onRenderError,
  onViewStateChange,
  title,
  toolbarActions,
  viewState,
}: {
  docx: DocxDocument;
  externalOpenError: string | null;
  onOpenExternal(): void;
  onRegisterRendererDisposer(disposer: () => void): () => void;
  onRenderError(error: unknown): void;
  onViewStateChange(
    update:
      | DocumentViewState
      | ((current: DocumentViewState) => DocumentViewState),
  ): void;
  title: string;
  toolbarActions?: ReactNode;
  viewState: DocumentViewState;
}) {
  const {
    containerRef,
    findMatches,
    fit,
    goToPage,
    navigateFind,
    pageCount,
    setZoom,
  } = useDocxScrollViewer({
    document: docx,
    onRegisterRendererDisposer,
    onRenderError,
    onViewStateChange,
    viewState,
  });

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden"
      data-document-viewer="docx"
    >
      <DocxToolbar
        findMatches={findMatches}
        fit={fit}
        goToPage={goToPage}
        navigateFind={navigateFind}
        onOpenExternal={onOpenExternal}
        onViewStateChange={onViewStateChange}
        pageCount={pageCount}
        setZoom={setZoom}
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
      <div className="relative min-h-0 flex-1 bg-muted/40">
        <div
          ref={containerRef}
          className="absolute inset-0 overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          role="region"
          aria-label={m.document_docx_viewport()}
          tabIndex={0}
        />
      </div>
    </div>
  );
}
