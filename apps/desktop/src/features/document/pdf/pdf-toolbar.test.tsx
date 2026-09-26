import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { ExternalOpenBinding } from "@/features/external-open";

import { DEFAULT_DOCUMENT_VIEW_STATE } from "../model/types";
import { PdfToolbar } from "./pdf-toolbar";

const externalOpen: ExternalOpenBinding = {
  target: {
    preferenceKey: "file:pdf",
    listApps: () => Promise.resolve([]),
    open: () => Promise.resolve(),
    reveal: () => Promise.resolve(),
  },
  onError: () => undefined,
};

test("PDF toolbar opens externally through the shared split control", () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <PdfToolbar
        activeFindIndex={0}
        externalOpen={externalOpen}
        findMatches={0}
        onFindNavigate={() => undefined}
        onPageChange={() => undefined}
        onViewStateChange={() => undefined}
        pageCount={3}
        title="guide.pdf"
        viewState={DEFAULT_DOCUMENT_VIEW_STATE}
      />
    </TooltipProvider>,
  );

  expect(html.includes("data-external-open-primary")).toBe(true);
  expect(html.includes('aria-label="Open with"')).toBe(true);
  expect(html.includes("Open externally")).toBe(false);
});
