import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

import { Button } from "@/components/ui/button";
import * as m from "@/paraglide/messages.js";

import { getPdfJsRuntime } from "./pdf-runtime";

export function PdfThumbnails({
  activePage,
  onPageChange,
  pdf,
}: {
  activePage: number;
  onPageChange(page: number): void;
  pdf: PDFDocumentProxy;
}) {
  return (
    <nav
      className="scrollbar-hide flex w-40 shrink-0 flex-col gap-2 overflow-y-auto border-r bg-muted/30 p-2"
      aria-label={m.document_pdf_pages()}
    >
      {Array.from({ length: pdf.numPages }, (_, index) => {
        const pageNumber = index + 1;
        return (
          <PdfThumbnail
            active={pageNumber === activePage}
            key={pageNumber}
            onSelect={() => onPageChange(pageNumber)}
            pageNumber={pageNumber}
            pdf={pdf}
          />
        );
      })}
    </nav>
  );
}

function PdfThumbnail({
  active,
  onSelect,
  pageNumber,
  pdf,
}: {
  active: boolean;
  onSelect(): void;
  pageNumber: number;
  pdf: PDFDocumentProxy;
}) {
  const rootRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { root: root.parentElement, rootMargin: "120px" },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!visible || !canvas) {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      return;
    }
    let cancelled = false;
    let cancelRender: (() => void) | undefined;
    void (async () => {
      const [page, pdfjs] = await Promise.all([
        pdf.getPage(pageNumber),
        getPdfJsRuntime(),
      ]);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: 116 / base.width });
      canvas.width = Math.max(Math.floor(viewport.width), 1);
      canvas.height = Math.max(Math.floor(viewport.height), 1);
      const renderTask = page.render({
        annotationMode: pdfjs.AnnotationMode.DISABLE,
        canvas,
        viewport,
      });
      cancelRender = () => renderTask.cancel();
      await renderTask.promise;
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      cancelRender?.();
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [pageNumber, pdf, visible]);

  return (
    <Button
      ref={rootRef}
      type="button"
      variant="ghost"
      className="h-auto w-full flex-col gap-1 p-2 data-[active=true]:bg-accent data-[active=true]:text-accent-foreground"
      data-active={active}
      aria-current={active ? "page" : undefined}
      onClick={onSelect}
    >
      <canvas ref={canvasRef} className="max-w-full bg-white shadow-sm" />
      <span className="text-xs">{pageNumber}</span>
    </Button>
  );
}
