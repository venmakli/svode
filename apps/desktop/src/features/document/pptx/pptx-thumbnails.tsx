import { useEffect, useRef, useState } from "react";
import type { PptxPresentation } from "@silurus/ooxml/pptx";
import { FileWarning } from "lucide-react";

import { Button } from "@/components/ui/button";
import * as m from "@/paraglide/messages.js";

import { PPTX_IMAGE_RESOURCES } from "./pptx-runtime";

export function PptxThumbnails({
  activeSlide,
  limitedSlides,
  onSlideChange,
  onSlideRenderError,
  presentation,
}: {
  activeSlide: number;
  limitedSlides: ReadonlySet<number>;
  onSlideChange(slideNumber: number): void;
  onSlideRenderError(slideNumber: number, error: unknown): void;
  presentation: PptxPresentation;
}) {
  return (
    <nav
      className="scrollbar-hide flex w-44 shrink-0 flex-col gap-2 overflow-y-auto border-r bg-muted/30 p-2"
      aria-label={m.document_pptx_slides()}
    >
      {Array.from({ length: presentation.slideCount }, (_, index) => {
        const slideNumber = index + 1;
        return (
          <PptxThumbnail
            active={slideNumber === activeSlide}
            key={slideNumber}
            limited={limitedSlides.has(slideNumber)}
            onSlideRenderError={onSlideRenderError}
            onSelect={() => onSlideChange(slideNumber)}
            presentation={presentation}
            slideNumber={slideNumber}
          />
        );
      })}
    </nav>
  );
}

function PptxThumbnail({
  active,
  limited,
  onSlideRenderError,
  onSelect,
  presentation,
  slideNumber,
}: {
  active: boolean;
  limited: boolean;
  onSlideRenderError(slideNumber: number, error: unknown): void;
  onSelect(): void;
  presentation: PptxPresentation;
  slideNumber: number;
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
    if (active) rootRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!visible || !canvas || limited) {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      return;
    }
    let cancelled = false;
    void presentation
      .renderSlide(canvas, slideNumber - 1, {
        dpr: Math.min(globalThis.devicePixelRatio || 1, 2),
        imageResources: PPTX_IMAGE_RESOURCES,
        skipMediaControls: true,
        width: 132,
      })
      .catch((error) => {
        if (!cancelled) onSlideRenderError(slideNumber, error);
      });
    return () => {
      cancelled = true;
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [limited, onSlideRenderError, presentation, slideNumber, visible]);

  return (
    <Button
      ref={rootRef}
      type="button"
      variant="ghost"
      className="h-auto w-full flex-col gap-1 p-2 data-[active=true]:bg-accent data-[active=true]:text-accent-foreground"
      data-active={active}
      aria-current={active ? "page" : undefined}
      aria-label={m.document_pptx_slide_label({
        number: String(slideNumber),
      })}
      onClick={onSelect}
    >
      {limited ? (
        <span className="flex aspect-video w-full items-center justify-center bg-muted text-muted-foreground">
          <FileWarning />
        </span>
      ) : (
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className="aspect-video max-w-full bg-white shadow-sm"
        />
      )}
      <span className="text-xs">{slideNumber}</span>
    </Button>
  );
}
