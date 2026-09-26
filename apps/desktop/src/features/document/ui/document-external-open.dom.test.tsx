import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_DOCUMENT_EXTERNAL_OPEN_DOM !== "1") {
  test("document external open DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_DOCUMENT_EXTERNAL_OPEN_DOM: "1" },
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

  const PAGES = {
    id: "com.apple.iWork.Pages",
    label: "Pages",
    kind: "application",
    isDefault: true,
    icon: "data:image/png;base64,UEFHRVM=",
  };
  const WORD = {
    id: "com.microsoft.Word",
    label: "Microsoft Word",
    kind: "application",
    isDefault: false,
    icon: null,
  };

  const doc = dom.window.document;
  let offered: object[] = [PAGES, WORD];
  let openFailure: Error | null = null;
  const launched: Array<{ command: string; args: unknown }> = [];

  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  async function setup() {
    const { mockNativeIpc } = await import("@/platform/native/testing");
    mockNativeIpc(async (command, args) => {
      if (command === "document_inspect_source") {
        return { format: "doc", sizeBytes: 12, generation: "g1" };
      }
      if (command === "document_list_external_apps") return offered;
      if (
        command === "document_open_external" ||
        command === "document_reveal_external"
      ) {
        launched.push({ command, args });
        if (openFailure) throw openFailure;
        return null;
      }
      if (command.startsWith("plugin:event|")) return 1;
      throw new Error(`Unexpected command: ${command}`);
    });
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { DocumentSurface } = await import("@/features/document/app-shell");
    return { TooltipProvider, DocumentSurface };
  }

  function primaries() {
    return [
      ...doc.querySelectorAll<HTMLButtonElement>(
        "[data-external-open-primary]",
      ),
    ];
  }

  async function openMenu(index: number) {
    const chevron = doc.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Open with"]',
    )[index]!;
    await act(async () => {
      chevron.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      );
      await settle();
    });
  }

  async function click(element: HTMLElement) {
    await act(async () => {
      element.click();
      await settle();
    });
  }

  test("every document entry opens through the shared control", async () => {
    const { TooltipProvider, DocumentSurface } = await setup();
    let root: Root | null = null;

    async function mount(path: string, peek = false) {
      await act(async () => {
        root?.unmount();
        root = createRoot(doc.getElementById("app")!);
        root.render(
          <TooltipProvider>
            <DocumentSurface
              path={path}
              projectPath="/work/project"
              spaceId={null}
              spacePath="/work/project"
              {...(peek
                ? {
                    onClose: () => undefined,
                    onOpenFullPage: () => undefined,
                    renderToolbarActions: () => <span data-peek-actions />,
                  }
                : {})}
            />
          </TooltipProvider>,
        );
        await settle();
      });
    }

    // Toolbar and the external-only state both show the OS default application.
    await mount("docs/report.doc");
    const [toolbar, state] = primaries();
    expect(primaries().length).toBe(2);
    expect(toolbar.getAttribute("aria-label")).toBe("Open in Pages");
    expect(toolbar.querySelector("img")?.getAttribute("src")).toBe(PAGES.icon);
    expect(state.textContent).toBe("Open in Pages");
    expect(state.dataset.variant).toBe("default");
    expect(doc.body.textContent.includes("Open externally")).toBe(false);

    // The menu: default marked first, alternatives, then reveal after a separator.
    await openMenu(1);
    const items = [...doc.querySelectorAll<HTMLElement>("[data-external-app]")];
    expect(items.map((item) => item.dataset.externalApp)).toEqual([
      PAGES.id,
      WORD.id,
    ]);
    expect(items[0].textContent.includes("default")).toBe(true);
    expect(doc.querySelector("[data-external-app-system]")).toBeNull();
    const reveal = doc.querySelector<HTMLElement>(
      "[data-external-open-reveal]",
    )!;
    expect(reveal.textContent).toBe("Show in file manager");
    expect(
      reveal.parentElement?.previousElementSibling?.getAttribute("role"),
    ).toBe("separator");

    // Reveal shows the file and is not remembered.
    await click(reveal);
    expect(launched).toEqual([
      {
        command: "document_reveal_external",
        args: {
          projectPath: "/work/project",
          spaceId: null,
          targetPath: "docs/report.doc",
        },
      },
    ]);
    expect(localStorage.getItem("svode:external-open:preferred-apps")).toBe(
      null,
    );

    // An explicit choice opens the file and becomes primary for every control of `.doc`.
    launched.length = 0;
    await openMenu(1);
    await click(
      doc.querySelector<HTMLElement>(`[data-external-app="${WORD.id}"]`)!,
    );
    expect(launched).toEqual([
      {
        command: "document_open_external",
        args: {
          projectPath: "/work/project",
          spaceId: null,
          targetPath: "docs/report.doc",
          appId: WORD.id,
        },
      },
    ]);
    expect(
      primaries().map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Open in Microsoft Word", null]);
    expect(primaries()[1].textContent).toBe("Open in Microsoft Word");

    // The choice is per extension, case-insensitive, and holds in Peek.
    await mount("docs/REPORT.DOC", true);
    expect(doc.querySelector("[data-peek-actions]") !== null).toBe(true);
    expect(primaries()[0].getAttribute("aria-label")).toBe(
      "Open in Microsoft Word",
    );
    await mount("docs/notes.odt", true);
    expect(primaries()[0].getAttribute("aria-label")).toBe("Open in Pages");

    // Without an OS default the generic OS choice stands first and opens with `null`.
    offered = [WORD];
    await mount("docs/notes.odt");
    expect(primaries()[0].getAttribute("aria-label")).toBe("Open");
    await openMenu(0);
    launched.length = 0;
    await click(doc.querySelector<HTMLElement>("[data-external-app-system]")!);
    expect((launched[0].args as { appId?: string | null }).appId).toBe(null);

    // A failed launch shows the inline error; the next attempt clears it.
    const originalConsoleError = console.error;
    console.error = () => {};
    openFailure = new Error("No application");
    try {
      await click(primaries()[0]);
    } finally {
      console.error = originalConsoleError;
      openFailure = null;
    }
    expect(doc.querySelector('[role="alert"]')?.textContent).toBe(
      "The document could not be opened in a system application.",
    );
    expect(primaries()[0].disabled).toBe(false);
    await click(primaries()[0]);
    expect(doc.querySelector('[role="alert"]')).toBeNull();

    await act(async () => {
      root?.unmount();
    });
  });
}
