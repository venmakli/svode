import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type {
  DocumentSessionState,
  DocumentSourceDescriptor,
} from "../model/types";

if (process.env.SVODE_DOCUMENT_DETAILS_DOM !== "1") {
  test("document details DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_DOCUMENT_DETAILS_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 20000);
} else {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost" },
  );
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  })) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  dom.window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;

  const doc = dom.window.document;
  const MODIFIED_AT = "2026-01-02T03:04:05Z";
  const modifiedText = new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(MODIFIED_AT));
  let inspect: () => DocumentSourceDescriptor = () => ({
    format: "doc",
    sizeBytes: 12,
    generation: "g1",
    modifiedAt: MODIFIED_AT,
  });

  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  async function setup() {
    const { mockNativeIpc } = await import("@/platform/native/testing");
    mockNativeIpc(async (command) => {
      if (command === "document_inspect_source") return inspect();
      if (command === "document_list_external_apps") return [];
      if (command.startsWith("plugin:event|")) return 1;
      throw new Error(`Unexpected command: ${command}`);
    });
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { DocumentSurface } = await import("@/features/document/app-shell");
    const { DocumentDetailsPopover } =
      await import("./document-details-popover");
    const { documentPartCount } = await import("../model/types");
    return {
      TooltipProvider,
      DocumentSurface,
      DocumentDetailsPopover,
      documentPartCount,
    };
  }

  let root: Root | null = null;

  async function render(node: React.ReactNode) {
    await act(async () => {
      root?.unmount();
      root = createRoot(doc.getElementById("app")!);
      root.render(node);
      await settle();
    });
  }

  /** Opens ⓘ inside `scope` and returns its rows as `[label, value]`. */
  async function openDetails(scope: ParentNode) {
    await act(async () => {
      scope
        .querySelector<HTMLButtonElement>('[aria-label="Document details"]')!
        .click();
      await settle();
    });
    const content = doc.querySelector('[data-slot="popover-content"]')!;
    expect(
      content.querySelector('[data-slot="popover-title"]')?.textContent,
    ).toBe("Document details");
    return [...content.querySelectorAll("dt")].map((term) => [
      term.textContent,
      term.nextElementSibling?.textContent,
    ]);
  }

  test("the popover lists the format, size, the viewer's count and the modification date", async () => {
    const { TooltipProvider, DocumentDetailsPopover, documentPartCount } =
      await setup();
    const loaded = {
      pdf: { pdf: { numPages: 12 } },
      docx: { docx: { pageCount: 3 } },
      xlsx: { workbook: { sheetNames: ["Q1", "Q2"] } },
      pptx: { presentation: { slideCount: 7 } },
    };
    const expected = {
      pdf: ["Pages", "12"],
      docx: ["Pages", "3"],
      xlsx: ["Sheets", "2"],
      pptx: ["Slides", "7"],
    };
    for (const format of ["pdf", "docx", "xlsx", "pptx"] as const) {
      const state = {
        phase: "ready",
        format,
        ...loaded[format],
      } as unknown as DocumentSessionState;
      await render(
        <TooltipProvider>
          <DocumentDetailsPopover
            source={{
              format,
              sizeBytes: 2.5 * 1024 * 1024,
              generation: "g1",
              modifiedAt: MODIFIED_AT,
            }}
            parts={documentPartCount(state)}
          />
        </TooltipProvider>,
      );
      expect(await openDetails(doc)).toEqual([
        ["Format", format.toUpperCase()],
        ["Size", "2.5 MB"],
        expected[format],
        ["Modified", modifiedText],
      ]);
      expect(doc.querySelector("time")?.getAttribute("datetime")).toBe(
        MODIFIED_AT,
      );
    }
    expect(
      documentPartCount({ phase: "password", format: "pdf", incorrect: false }),
    ).toBe(null);
  });

  test("a failed document with a known source keeps ⓘ in main and peek without a count", async () => {
    const { TooltipProvider, DocumentSurface } = await setup();
    const mount = (peek: boolean) =>
      render(
        <TooltipProvider>
          <DocumentSurface
            path="docs/report.doc"
            projectPath="/work/project"
            spaceId={null}
            spacePath="/work/project"
            {...(peek
              ? { onClose: () => undefined }
              : {
                  renderMainHeader: (header) => (
                    <header data-main-header>{header.objectActions}</header>
                  ),
                })}
          />
        </TooltipProvider>,
      );

    // Main: the external-only failure hands ⓘ to the header.
    await mount(false);
    expect(
      doc.body.textContent.includes("Preview is not available for this format"),
    ).toBe(true);
    const header = doc.querySelector("[data-main-header]")!;
    expect(await openDetails(header)).toEqual([
      ["Format", "DOC"],
      ["Size", "12 B"],
      ["Modified", modifiedText],
    ]);

    // Peek: ⓘ right after the identity.
    await mount(true);
    const bar = doc.querySelector("[data-peek-top-bar]")!;
    const identity = bar.querySelector("[data-peek-identity]")!;
    const info = bar.querySelector('[aria-label="Document details"]')!;
    expect(identity.nextElementSibling).toBe(info);

    // Without a known source there is no ⓘ.
    inspect = () => {
      throw { kind: "source_missing", message: "Document source is missing" };
    };
    await mount(true);
    expect(doc.body.textContent.includes("This document is unavailable")).toBe(
      true,
    );
    expect(doc.querySelector('[aria-label="Document details"]')).toBeNull();
    await mount(false);
    expect(doc.querySelector('[aria-label="Document details"]')).toBeNull();

    await act(async () => {
      root?.unmount();
    });
  });
}
