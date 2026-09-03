import { expect, test } from "bun:test";
import type { PptxPresentation } from "@silurus/ooxml/pptx";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";

import { createDocumentViewState } from "../model/types";
import { PptxViewer } from "./pptx-viewer";

const presentation = {
  slideCount: 3,
} as PptxPresentation;

test("PPTX surface omits a normal-state badge and exposes slide navigation", () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <PptxViewer
        externalOpenError={null}
        onOpenExternal={() => undefined}
        onRegisterRendererDisposer={() => () => undefined}
        onRenderError={() => undefined}
        onViewStateChange={() => undefined}
        presentation={presentation}
        title="roadmap.pptx"
        viewState={createDocumentViewState("pptx")}
      />
    </TooltipProvider>,
  );

  expect(html.includes('data-document-viewer="pptx"')).toBe(true);
  expect(html.includes("Limited preview")).toBe(false);
  expect(html.includes('role="region"')).toBe(true);
  expect(html.includes('tabindex="0"')).toBe(true);
  expect(html.includes("Presentation slides")).toBe(true);
  expect(html.includes('aria-current="page"')).toBe(true);
  for (const label of [
    "Hide slide navigation",
    "Previous slide",
    "Next slide",
    "Slide number",
    "Zoom out",
    "Zoom in",
    "Find in document",
    "Open externally",
  ]) {
    expect(html.includes(label)).toBe(true);
  }
});

test("PPTX slide rail can be collapsed without replacing the active viewport", () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <PptxViewer
        externalOpenError={null}
        onOpenExternal={() => undefined}
        onRegisterRendererDisposer={() => () => undefined}
        onRenderError={() => undefined}
        onViewStateChange={() => undefined}
        presentation={presentation}
        title="roadmap.pptx"
        viewState={{
          ...createDocumentViewState("pptx"),
          thumbnailsOpen: false,
        }}
      />
    </TooltipProvider>,
  );

  expect(html.includes("Presentation slides")).toBe(false);
  expect(html.includes("Show slide navigation")).toBe(true);
  expect(html.includes("Presentation preview")).toBe(true);
});
