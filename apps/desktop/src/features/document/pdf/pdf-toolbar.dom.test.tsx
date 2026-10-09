import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createTestDom } from "@/shared/testing/dom";

if (process.env.SVODE_PDF_TOOLBAR_TEST !== "1") {
  test("PDF view tools in the top bar", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_PDF_TOOLBAR_TEST: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  // Radix picks its layout effect when first loaded, so the DOM comes first.
  const dom = await createTestDom();
  const doc = dom.document;

  // Layout input of the view tools: the width given to the group and the
  // natural width of the tools; the observer reports both on demand.
  let groupWidth = 1000;
  const toolsWidth = 400;
  const observers = new Set<() => void>();
  globalThis.ResizeObserver = class {
    callback: () => void;
    constructor(callback: () => void) {
      this.callback = callback;
    }
    // Only the view tools group and its tools report resizes here.
    observe(target: Element) {
      if (
        target.hasAttribute("data-view-tools") ||
        (target.tagName === "DIV" &&
          target.parentElement?.hasAttribute("data-view-tools"))
      )
        observers.add(this.callback);
    }
    unobserve() {}
    disconnect() {
      observers.delete(this.callback);
    }
  } as unknown as typeof ResizeObserver;
  doc.defaultView!.HTMLElement.prototype.getBoundingClientRect = function (
    this: HTMLElement,
  ) {
    const width = this.hasAttribute("data-view-tools")
      ? groupWidth
      : this.parentElement?.hasAttribute("data-view-tools")
        ? toolsWidth
        : 0;
    return { width, height: 0, top: 0, left: 0, right: width, bottom: 0 };
  } as typeof HTMLElement.prototype.getBoundingClientRect;
  async function resize(width: number) {
    groupWidth = width;
    await act(async () => {
      observers.forEach((observer) => observer());
    });
  }
  async function click(element: Element) {
    await act(async () => {
      (element as HTMLElement).click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  }

  const m = await import("@/paraglide/messages.js");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { PeekIdentity, PeekTopBar } = await import("@/shared/ui/peek-top-bar");
  const { DEFAULT_DOCUMENT_VIEW_STATE } = await import("../model/types");
  const { PdfToolbar } = await import("./pdf-toolbar");

  /** Names of the controls in DOM order, inputs with their values. */
  function controls(root: Element) {
    return [...root.querySelectorAll("button, input")].map((element) =>
      element instanceof HTMLInputElement
        ? `${element.getAttribute("aria-label")}=${element.value}`
        : (element.getAttribute("aria-label") ??
          element.querySelector(".sr-only")?.textContent ??
          ""),
    );
  }

  test("the PDF tools sit between the identity and Open with, and collapse with their state", async () => {
    const viewState = {
      ...DEFAULT_DOCUMENT_VIEW_STATE,
      findQuery: "term",
      pageNumber: 2,
      zoom: 1.5,
    };
    await dom.render(
      <TooltipProvider>
        <PeekTopBar
          identity={<PeekIdentity icon="📄" name="guide.pdf" />}
          viewTools={
            <PdfToolbar
              activeFindIndex={0}
              findMatches={0}
              onFindNavigate={() => undefined}
              onPageChange={() => undefined}
              onViewStateChange={() => undefined}
              pageCount={3}
              viewState={viewState}
            />
          }
          openWith={<button type="button" data-slot-name="open-with" />}
          onExpand={() => {}}
          onClose={() => {}}
        />
      </TooltipProvider>,
    );
    const expected = [
      m.document_hide_thumbnails(),
      m.document_previous_page(),
      `${m.document_page_number()}=2`,
      m.document_next_page(),
      m.document_zoom_out(),
      m.document_zoom_in(),
      m.document_fit_page(),
      m.document_rotate_clockwise(),
      m.document_find_in_document(),
    ];

    // Wide: the tools stand in the row, without a title or Open with of their own.
    const group = doc.querySelector<HTMLElement>("[data-view-tools]")!;
    expect(group.dataset.viewTools).toBe("inline");
    expect(controls(group)).toEqual(expected);
    expect(group.textContent?.includes("guide.pdf")).toBe(false);
    expect(group.textContent?.includes("150%")).toBe(true);
    expect(
      group.textContent?.includes(m.document_page_count({ count: "3" })),
    ).toBe(true);
    expect(group.querySelector("[data-external-open-primary]")).toBeNull();
    const bar = doc.querySelector("[data-peek-top-bar]")!;
    const identity = bar.querySelector("[data-peek-identity]")!;
    const openWith = bar.querySelector("[data-slot-name=open-with]")!;
    expect(
      Boolean(
        identity.compareDocumentPosition(group) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    expect(
      Boolean(
        group.compareDocumentPosition(openWith) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);

    // Narrow: one button opens the same tools with the same values.
    await resize(toolsWidth - 1);
    expect(group.dataset.viewTools).toBe("collapsed");
    expect(controls(group)).toEqual([m.view_tools()]);
    await click(group.querySelector(`[aria-label="${m.view_tools()}"]`)!);
    const popover = doc.querySelector("[data-slot=popover-content]")!;
    expect(controls(popover)).toEqual(expected);
    expect(popover.textContent?.includes("150%")).toBe(true);
    await click(
      popover.querySelector(`[aria-label="${m.document_find_in_document()}"]`)!,
    );
    const find = doc.querySelector<HTMLInputElement>(
      `input[aria-label="${m.document_find_in_document()}"]`,
    )!;
    expect(find.value).toBe("term");

    // Wide again: the tools return to the row.
    await resize(toolsWidth + 100);
    expect(group.dataset.viewTools).toBe("inline");
    expect(controls(group)).toEqual(expected);
    await dom.dispose();
  });
}
