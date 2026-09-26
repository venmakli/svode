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
            renderToolbarActions={() => <span data-peek-actions />}
          />
        </TooltipProvider>,
      );
      await settle();
    });

    // Frame toolbar and the external-only state show the OS default application.
    expect(doc.querySelector("[data-peek-actions]") !== null).toBe(true);
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
}
