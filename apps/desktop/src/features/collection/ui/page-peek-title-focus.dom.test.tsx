import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { JSDOM } from "jsdom";
import type { Page } from "@/features/page";
import type { ScopePeekContext } from "@/features/scope-surfaces";

if (process.env.SVODE_PEEK_TITLE_FOCUS_DOM !== "1") {
  test("Collection Peek title focus DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_PEEK_TITLE_FOCUS_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 60_000);
} else {
  const { mock } = bunTest as typeof bunTest & {
    mock: { module(path: string, factory: () => unknown): void };
  };
  const dom = new JSDOM("<!doctype html><div id='app'></div>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    SVGElement: dom.window.SVGElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    PointerEvent: dom.window.MouseEvent,
    FocusEvent: dom.window.FocusEvent,
    DocumentFragment: dom.window.DocumentFragment,
    MutationObserver: dom.window.MutationObserver,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  const item: Page = {
    path: "Tasks/Roadmap.md",
    body: "",
    meta: { title: "Roadmap", icon: null, created: "", updated: "", extra: {} },
  };
  mock.module("@/features/page/ui/page-detail-actions", () => ({
    PageDetailActions: () => null,
  }));
  mock.module("@/features/page/ui/page-system-fields", () => ({
    PageSystemFields: () => null,
  }));
  mock.module("@/features/properties/panel", () => ({
    PropertyPanel: () => null,
    CollectionPropertyPanel: () => null,
  }));

  const { mockNativeIpc } = await import("@/platform/native/testing");
  mockNativeIpc(
    (command) => {
      if (command === "repository_access_get")
        return {
          status: "local",
          repositoryId: "/space",
          generation: 1,
          checkedAt: null,
          expiresAt: null,
          reason: null,
          lastKnownStatus: null,
        };
      if (command === "read_page") return structuredClone(item);
      if (command === "get_page_schema") return null;
      return null;
    },
    { shouldMockEvents: true },
  );

  const { createRoot } = await import("react-dom/client");
  const { ThemeProvider } = await import("@/components/ui/theme-provider");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const {
    PageDetailHeader,
    PageDetailProvider,
    PageSurfaceSessionProvider,
    usePageDetailContext,
  } = await import("@/features/page/scope-surface");
  const { PagePeekSheet } = await import("./page-peek-sheet");

  /** The Peek host's header: the item's title and the Peek's actions. */
  function PeekHeader({ context }: { context: ScopePeekContext }) {
    const detail = usePageDetailContext();
    return (
      <PageDetailHeader
        actions={
          detail.page ? context.renderHeaderActions?.(detail.page, false) : null
        }
      />
    );
  }

  async function settle() {
    for (let index = 0; index < 5; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  async function openPeek(focusTitle: boolean) {
    const root = createRoot(document.getElementById("app")!);
    await act(async () => {
      root.render(
        <ThemeProvider theme="light" setTheme={() => {}}>
          <TooltipProvider>
            <PagePeekSheet
              target={{ page: item, nested: false, focusTitle }}
              readOnly={false}
              spacePath="/space"
              spaceId="space"
              projectPath="/space"
              onOpenChange={() => {}}
              onOpenPath={() => {}}
              onDuplicatePage={() => {}}
              onDeletePage={() => {}}
              onConvertedPage={() => {}}
              renderPeek={(context) => (
                <PageSurfaceSessionProvider
                  displayName={item.meta.title}
                  displayPath={context.path}
                  spacePath={context.spacePath}
                  targetKey={context.sessionKey}
                >
                  <PageDetailProvider
                    spacePath={context.spacePath}
                    spaceId={context.spaceId}
                    readmePath={context.path}
                    ownerPath={context.path}
                    target="page"
                    onOpenPath={() => {}}
                  >
                    <PeekHeader context={context} />
                  </PageDetailProvider>
                </PageSurfaceSessionProvider>
              )}
            />
          </TooltipProvider>
        </ThemeProvider>,
      );
      await settle();
    });
    await act(async () => settle());
    return root;
  }

  const titleInput = () =>
    document.querySelector<HTMLInputElement>("[data-page-title-input]");

  test("rename from a row opens its peek with the title focused and selected", async () => {
    const root = await openPeek(true);
    const input = titleInput()!;
    expect(input.value).toBe("Roadmap");
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 7]);
    await act(async () => root.unmount());
  });

  test("opening a peek otherwise leaves the title alone", async () => {
    const root = await openPeek(false);
    const input = titleInput()!;
    expect(input.value).toBe("Roadmap");
    expect(document.activeElement === input).toBe(false);
    await act(async () => root.unmount());
  });
}
