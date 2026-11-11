import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { JSDOM } from "jsdom";
import type { Page } from "@/features/page";
import type { ScopePeekContext } from "@/features/scope-surfaces";

// A Collection item whose frontmatter is in conflict, opened in its peek
// (DF-292 R6): the header shows the property panel in conflict mode and the
// title and description read only until the editor writes the decisions.
if (process.env.SVODE_PEEK_CONFLICT_DOM !== "1") {
  test("Collection Peek of an item in conflict DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_PEEK_CONFLICT_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 60_000);
} else {
  const { mock } = bunTest;
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
    HTMLButtonElement: dom.window.HTMLButtonElement,
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
    DOMRect: dom.window.DOMRect,
    CSS: { escape: (value: string) => value },
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

  const PATH = "Задачи/Починить вход.md";
  /** As the core reads an item whose frontmatter is in conflict. */
  const item: Page = {
    path: PATH,
    body: "---\ntitle: Починить вход\n<<<<<<< ours\n...",
    source_version: "v1",
    meta: {
      title: "Починить вход",
      icon: null,
      created: "",
      updated: "",
      extra: {},
    },
    warnings: [{ kind: "malformed_frontmatter", message: "invalid YAML" }],
  };
  mock.module("@/features/page/ui/page-detail-actions", () => ({
    PageDetailActions: () => null,
  }));
  mock.module("@/features/page/ui/page-system-fields", () => ({
    PageSystemFields: () => null,
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
      if (command === "get_page_schema")
        return {
          collectionRootPath: "Задачи",
          schema: {
            columns: [
              {
                name: "Статус",
                type: "select",
                options: [{ name: "Открыта" }, { name: "Готово" }],
              },
              { name: "Исполнитель", type: "text" },
            ],
          },
        };
      return null;
    },
    { shouldMockEvents: true },
  );

  const { createRoot } = await import("react-dom/client");
  const { setLocale } = await import("@/paraglide/runtime.js");
  const { ThemeProvider } = await import("@/components/ui/theme-provider");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { setPageMerge, getPageMergeState } = await import("@/features/page");
  const {
    PageDetailHeader,
    PageDetailProvider,
    PageSurfaceSessionProvider,
    usePageDetailContext,
  } = await import("@/features/page/scope-surface");
  const { PagePeekSheet } = await import("./page-peek-sheet");

  function PeekHeader({ context }: { context: ScopePeekContext }) {
    const detail = usePageDetailContext();
    return (
      <PageDetailHeader
        presentation="compact"
        actions={
          detail.page ? context.renderHeaderActions?.(detail.page, false) : null
        }
      />
    );
  }

  async function settle() {
    for (let index = 0; index < 5; index += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
  }

  test("the peek of an item in conflict shows its property panel in conflict mode", async () => {
    await setLocale("ru", { reload: false });
    setPageMerge("/space", PATH, {
      type: "merged",
      body: "Описание задачи.\n",
      properties: [
        {
          key: "title",
          base: "Починить вход",
          ours: "Починить вход",
          theirs: "Починить вход",
          disputed: false,
          merged: "Починить вход",
        },
        {
          key: "Статус",
          base: "Открыта",
          ours: "Открыта",
          theirs: "Готово",
          disputed: false,
          merged: "Готово",
        },
        {
          key: "Исполнитель",
          base: "Анна",
          ours: "Борис",
          theirs: "Вера",
          disputed: true,
          merged: undefined,
        },
      ],
    });
    const root = createRoot(document.getElementById("app")!);
    await act(async () => {
      root.render(
        <ThemeProvider theme="light" setTheme={() => {}}>
          <TooltipProvider>
            <PagePeekSheet
              target={{ page: item, nested: false }}
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
    try {
      expect(
        document.querySelector("[data-collection-panel-conflict-summary]")
          ?.textContent,
      ).toBe("Свойства изменили обе стороны · спорных: 1");
      const owner = document.querySelector(
        '[data-collection-panel-property="Исполнитель"]',
      )!;
      expect(
        owner.querySelector('[data-collection-panel-conflict-variant="ours"]')
          ?.textContent,
      ).toBe("БорисПринять моё");
      expect(
        document.querySelector('[data-collection-panel-property="Статус"]')
          ?.children[1]?.textContent,
      ).toBe("Готово");
      // The header is read only until the decisions are written.
      expect(
        document.querySelector<HTMLInputElement>("[data-page-title-input]")
          ?.readOnly,
      ).toBe(true);

      const accept = Array.from(owner.querySelectorAll("button")).find(
        (button) => button.textContent === "Принять входящее",
      )!;
      await act(async () => {
        accept.click();
        await settle();
      });
      expect(getPageMergeState("/space", PATH)?.decisions).toEqual({
        Исполнитель: { type: "theirs" },
      });
    } finally {
      await act(async () => root.unmount());
      setPageMerge("/space", PATH, null);
    }
  });
}
