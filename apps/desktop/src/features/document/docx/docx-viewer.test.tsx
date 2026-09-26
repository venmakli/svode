import { expect, test } from "bun:test";
import type { DocxDocument } from "@silurus/ooxml/docx";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";

import { DEFAULT_DOCUMENT_VIEW_STATE } from "../model/types";
import { DocxViewer } from "./docx-viewer";
import type { ExternalOpenBinding } from "@/features/external-open";

const externalOpen: ExternalOpenBinding = {
  target: {
    preferenceKey: "file:fixture",
    listApps: () => Promise.resolve([]),
    open: () => Promise.resolve(),
    reveal: () => Promise.resolve(),
  },
  onError: () => undefined,
};

test("DOCX surface omits a normal-state badge and exposes a named viewport", () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <DocxViewer
        docx={{ pageCount: 6 } as DocxDocument}
        externalOpenError={null}
        externalOpen={externalOpen}
        onRegisterRendererDisposer={() => () => undefined}
        onRenderError={() => undefined}
        onViewStateChange={() => undefined}
        title="brief.docx"
        viewState={DEFAULT_DOCUMENT_VIEW_STATE}
      />
    </TooltipProvider>,
  );

  expect(html.includes('data-document-viewer="docx"')).toBe(true);
  expect(html.includes("data-external-open-primary")).toBe(true);
  expect(html.includes('aria-label="Open with"')).toBe(true);
  expect(html.includes("Limited preview")).toBe(false);
  expect(html.includes('role="region"')).toBe(true);
  expect(html.includes('tabindex="0"')).toBe(true);
  expect(html.includes("DOCX document preview")).toBe(true);
  for (const label of [
    "Previous page",
    "Next page",
    "Zoom out",
    "Zoom in",
    "Find in document",
    "Open with",
  ]) {
    expect(html.includes(label)).toBe(true);
  }
});
