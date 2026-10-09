import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_MEDIA_EXTERNAL_OPEN_DOM !== "1") {
  test("media external open DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_MEDIA_EXTERNAL_OPEN_DOM: "1" },
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
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  dom.window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;

  const PREVIEW = {
    id: "com.apple.Preview",
    label: "Preview",
    kind: "application",
    isDefault: true,
    icon: "data:image/png;base64,UFJFVklFVw==",
  };
  const PIXELMATOR = {
    id: "com.pixelmatorteam.pixelmator.x",
    label: "Pixelmator Pro",
    kind: "application",
    isDefault: false,
    icon: null,
  };

  const doc = dom.window.document;
  let openFailure: Error | null = null;
  const launched: Array<{ command: string; args: unknown }> = [];

  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  async function click(element: HTMLElement) {
    await act(async () => {
      element.click();
      await settle();
    });
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

  function primaries() {
    return [
      ...doc.querySelectorAll<HTMLButtonElement>(
        "[data-external-open-primary]",
      ),
    ];
  }

  test("media entries open through the shared control", async () => {
    const { mockNativeIpc } = await import("@/platform/native/testing");
    mockNativeIpc(async (command, args) => {
      if (command === "media_create_source") {
        throw { kind: "unsupported_format", message: "Not previewable" };
      }
      if (command === "media_list_external_apps") return [PREVIEW, PIXELMATOR];
      if (
        command === "media_open_external" ||
        command === "media_reveal_external"
      ) {
        launched.push({ command, args });
        if (openFailure) throw openFailure;
        return null;
      }
      if (command.startsWith("plugin:event|")) return 1;
      throw new Error(`Unexpected command: ${command}`);
    });
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { MediaSurface } = await import("@/features/media/app-shell");
    let root: Root | null = null;

    await act(async () => {
      root = createRoot(doc.getElementById("app")!);
      root.render(
        <TooltipProvider>
          <MediaSurface
            path="photos/shot.heic"
            projectPath="/work/project"
            spaceId={null}
            spacePath="/work/project"
            onClose={() => undefined}
            onOpenFullPage={() => undefined}
          />
        </TooltipProvider>,
      );
      await settle();
    });

    // The peek top bar and the external-only state show the OS default
    // application; without a source there is no ⓘ yet.
    const bar = doc.querySelector("[data-peek-top-bar]")!;
    expect(bar.querySelector("[data-peek-identity]")?.textContent).toBe(
      "shot.heic",
    );
    expect(bar.querySelector('[aria-label="Media details"]')).toBeNull();
    expect(doc.querySelector('[aria-label="Pin"]')).toBeNull();
    const [toolbar, state] = primaries();
    expect(toolbar.getAttribute("aria-label")).toBe("Open in Preview");
    expect(state.textContent).toBe("Open in Preview");
    expect(state.dataset.variant).toBe("default");

    await click(state);
    expect(launched.at(-1)).toEqual({
      command: "media_open_external",
      args: {
        projectPath: "/work/project",
        spaceId: null,
        targetPath: "photos/shot.heic",
        appId: PREVIEW.id,
      },
    });

    await openMenu(0);
    await click(
      doc.querySelector<HTMLElement>(`[data-external-app="${PIXELMATOR.id}"]`)!,
    );
    expect(
      (launched.at(-1)?.args as { appId?: string } | undefined)?.appId,
    ).toBe(PIXELMATOR.id);
    expect(primaries()[1].textContent).toBe("Open in Pixelmator Pro");

    await openMenu(0);
    await click(doc.querySelector<HTMLElement>("[data-external-open-reveal]")!);
    expect(launched.at(-1)?.command).toBe("media_reveal_external");

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
      "The media file could not be opened in a system application.",
    );

    await act(async () => {
      root?.unmount();
    });
  });

  function precede(elements: Element[]) {
    return elements.every(
      (element, index) =>
        index === 0 ||
        Boolean(
          elements[index - 1].compareDocumentPosition(element) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
    );
  }

  test("an image puts ⓘ after the name and its tools before Open with, in main and peek", async () => {
    const { mockNativeIpc } = await import("@/platform/native/testing");
    mockNativeIpc(async (command) => {
      if (command === "media_create_source") {
        return {
          animated: false,
          capabilityToken: "token",
          family: "image",
          format: "png",
          generation: "g1",
          height: 600,
          inlinePreview: true,
          intrinsicOversized: false,
          mimeType: "image/png",
          requiresRangeRequests: false,
          sizeBytes: 2048,
          width: 800,
        };
      }
      if (command === "media_list_external_apps") return [PREVIEW, PIXELMATOR];
      if (command === "list_project_openers") {
        return [
          {
            id: "file_manager",
            label: "Finder",
            kind: "file_manager",
            isDefault: true,
            icon: null,
          },
        ];
      }
      if (command === "media_revoke_source") return null;
      if (command.startsWith("plugin:event|")) return 1;
      throw new Error(`Unexpected command: ${command}`);
    });
    (
      window as unknown as {
        __TAURI_INTERNALS__: {
          convertFileSrc: (path: string, protocol: string) => string;
        };
      }
    ).__TAURI_INTERNALS__.convertFileSrc = (path, protocol) =>
      `${protocol}://localhost/${path}`;
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { MediaSurface } = await import("@/features/media/app-shell");
    const { ProjectExternalOpenButton } =
      await import("@/features/external-open");
    let root: Root | null = null;

    async function mount(peek: boolean) {
      await act(async () => {
        root?.unmount();
        root = createRoot(doc.getElementById("app")!);
        root.render(
          <TooltipProvider>
            {peek ? (
              <MediaSurface
                path="photos/shot.png"
                projectPath="/work/project"
                spaceId={null}
                spacePath="/work/project"
                onClose={() => undefined}
                onOpenFullPage={() => undefined}
              />
            ) : (
              <MediaSurface
                path="photos/shot.png"
                projectPath="/work/project"
                spaceId={null}
                spacePath="/work/project"
                renderMainHeader={(header) => (
                  <header data-main-header>
                    {header.objectActions}
                    {header.viewTools}
                    <ProjectExternalOpenButton
                      projectPath="/work/project"
                      objectGroup={header.openWith}
                    />
                  </header>
                )}
              />
            )}
          </TooltipProvider>,
        );
        await settle();
      });
    }

    // Main: ⓘ, the image tools and Open with go to the header; the surface
    // keeps no row of its own and no Pin.
    await mount(false);
    const header = doc.querySelector("[data-main-header]")!;
    expect(
      precede([
        header.querySelector('[aria-label="Media details"]')!,
        header.querySelector('[aria-label="Zoom out"]')!,
        header.querySelector("[data-external-open-primary]")!,
      ]),
    ).toBe(true);
    expect(
      header
        .querySelector("[data-external-open-primary]")
        ?.getAttribute("aria-label"),
    ).toBe("Open in Preview");
    expect(doc.querySelector("[data-peek-top-bar]")).toBeNull();
    expect(doc.querySelectorAll("[data-external-open-primary]").length).toBe(1);
    expect(doc.querySelector('[aria-label="Pin"]')).toBeNull();

    // Peek: identity · ⓘ · tools · Open with · Expand · ×, one row.
    await mount(true);
    expect(doc.querySelectorAll("[data-peek-top-bar]").length).toBe(1);
    const bar = doc.querySelector("[data-peek-top-bar]")!;
    const tools = bar.querySelector("[data-view-tools]")!;
    expect(tools.querySelector('[aria-label="Zoom out"]') === null).toBe(false);
    expect(
      precede([
        bar.querySelector("[data-peek-identity]")!,
        bar.querySelector('[aria-label="Media details"]')!,
        tools,
        bar.querySelector("[data-external-open-primary]")!,
        bar.querySelector('[aria-label="Expand"]')!,
        bar.querySelector('[aria-label="Close"]')!,
      ]),
    ).toBe(true);
    expect(doc.querySelector('[aria-label="Pin"]')).toBeNull();

    await act(async () => {
      root?.unmount();
    });
  });
}
