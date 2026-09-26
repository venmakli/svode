import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_EXTERNAL_OPEN_DOM !== "1") {
  test("project external open button DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_EXTERNAL_OPEN_DOM: "1" },
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

  const FINDER = {
    id: "file_manager",
    label: "Finder",
    kind: "file_manager",
    isDefault: true,
    icon: "data:image/png;base64,RklOREVS",
  };
  const VSCODE = {
    id: "vscode",
    label: "Visual Studio Code",
    kind: "editor",
    isDefault: false,
    icon: "data:image/png;base64,VlNDT0RF",
  };
  const CURSOR = {
    id: "cursor",
    label: "Cursor",
    kind: "editor",
    isDefault: false,
    icon: null,
  };

  const doc = dom.window.document;
  let installed = [VSCODE, CURSOR, FINDER];
  let listCalls = 0;
  let listGate: Promise<void> | null = null;
  let openGate: Promise<void> | null = null;
  let openFailure: Error | null = null;
  const opened: unknown[] = [];

  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  async function setup() {
    const { mockNativeIpc } = await import("@/platform/native/testing");
    mockNativeIpc(async (command, args) => {
      if (command === "list_project_openers") {
        listCalls += 1;
        if (listGate) await listGate;
        return installed;
      }
      if (command === "open_project_in_tool") {
        opened.push(args);
        if (openGate) await openGate;
        if (openFailure) throw openFailure;
        return null;
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { ProjectExternalOpenButton } =
      await import("@/features/external-open");
    return { TooltipProvider, ProjectExternalOpenButton };
  }

  function primary() {
    return doc.querySelector<HTMLButtonElement>(
      "[data-external-open-primary]",
    )!;
  }

  function chevron() {
    return doc.querySelector<HTMLButtonElement>('[aria-label="Open with"]')!;
  }

  async function openMenu() {
    await act(async () => {
      chevron().dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      );
      await settle();
    });
  }

  async function closeMenu() {
    await act(async () => {
      doc.activeElement?.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
      await settle();
    });
  }

  function menuItem(id: string) {
    return doc.querySelector<HTMLElement>(`[data-external-app="${id}"]`)!;
  }

  async function select(id: string) {
    await act(async () => {
      menuItem(id).click();
      await settle();
    });
  }

  async function clickPrimary() {
    await act(async () => {
      primary().click();
      await settle();
    });
  }

  test("primary app, remembered choice, removed app, pending and failure", async () => {
    const { TooltipProvider, ProjectExternalOpenButton } = await setup();
    let root: Root | null = null;

    async function mount(projectPath = "/work/project") {
      await act(async () => {
        root?.unmount();
        root = createRoot(doc.getElementById("app")!);
        root.render(
          <TooltipProvider>
            <ProjectExternalOpenButton projectPath={projectPath} />
          </TooltipProvider>,
        );
        await settle();
      });
    }

    // Until the list is known the primary button hands the choice to the OS default.
    let releaseList = () => {};
    listGate = new Promise((resolve) => {
      releaseList = resolve;
    });
    await mount();
    expect(primary().getAttribute("aria-label")).toBe("Open");
    expect(
      primary()
        .querySelector("[data-external-app-icon]")
        ?.getAttribute("data-external-app-icon"),
    ).toBe("fallback");
    await clickPrimary();
    expect(opened).toEqual([{ projectPath: "/work/project", app: null }]);
    await act(async () => {
      releaseList();
      listGate = null;
      await settle();
    });

    // Before any choice the OS default (file manager) is primary, with its OS icon.
    expect(primary().getAttribute("aria-label")).toBe("Open in Finder");
    expect(primary().querySelector("img")?.getAttribute("src")).toBe(
      FINDER.icon,
    );
    opened.length = 0;
    await clickPrimary();
    expect(opened).toEqual([
      { projectPath: "/work/project", app: "file_manager" },
    ]);

    // The menu re-requests the list on every opening and keeps catalog order.
    const callsBeforeMenu = listCalls;
    await openMenu();
    expect(listCalls).toBe(callsBeforeMenu + 1);
    const items = [...doc.querySelectorAll<HTMLElement>("[data-external-app]")];
    expect(items.map((item) => item.dataset.externalApp)).toEqual([
      "vscode",
      "cursor",
      "file_manager",
    ]);
    expect(menuItem("vscode").querySelector("img")?.getAttribute("src")).toBe(
      VSCODE.icon,
    );
    expect(
      menuItem("cursor")
        .querySelector("[data-external-app-icon]")
        ?.getAttribute("data-external-app-icon"),
    ).toBe("fallback");
    expect(menuItem("file_manager").textContent.includes("default")).toBe(true);
    expect(menuItem("vscode").textContent.includes("default")).toBe(false);

    // An explicit choice opens the app and becomes primary.
    opened.length = 0;
    await select("cursor");
    expect(opened).toEqual([{ projectPath: "/work/project", app: "cursor" }]);
    expect(primary().getAttribute("aria-label")).toBe("Open in Cursor");

    // The primary button does not change the remembered choice.
    opened.length = 0;
    await clickPrimary();
    expect(opened).toEqual([{ projectPath: "/work/project", app: "cursor" }]);

    // The choice survives a restart and is shared by other projects.
    await mount("/work/other");
    expect(primary().getAttribute("aria-label")).toBe("Open in Cursor");
    expect(
      JSON.parse(localStorage.getItem("svode:external-open:preferred-apps")!),
    ).toEqual({ directory: "cursor" });

    // A removed app falls back to the OS default without losing the button.
    installed = [VSCODE, FINDER];
    await mount();
    expect(primary().getAttribute("aria-label")).toBe("Open in Finder");
    opened.length = 0;
    await clickPrimary();
    expect(opened).toEqual([
      { projectPath: "/work/project", app: "file_manager" },
    ]);

    // While opening, the control blocks another launch.
    let releaseOpen = () => {};
    openGate = new Promise((resolve) => {
      releaseOpen = resolve;
    });
    opened.length = 0;
    await clickPrimary();
    expect(primary().disabled).toBe(true);
    expect(chevron().disabled).toBe(true);
    await clickPrimary();
    expect(opened.length).toBe(1);
    await act(async () => {
      releaseOpen();
      openGate = null;
      await settle();
    });
    expect(primary().disabled).toBe(false);

    // A failed launch reports a toast and re-enables the control.
    const { toast } = await import("sonner");
    const toasts: unknown[] = [];
    const originalError = toast.error;
    const originalConsoleError = console.error;
    toast.error = ((message: unknown) => {
      toasts.push(message);
      return 0;
    }) as typeof toast.error;
    console.error = () => {};
    openFailure = new Error("App is gone");
    try {
      await clickPrimary();
    } finally {
      toast.error = originalError;
      console.error = originalConsoleError;
      openFailure = null;
    }
    expect(toasts).toEqual(["Could not open Finder"]);
    expect(primary().disabled).toBe(false);

    await closeMenu();
    await act(async () => {
      root?.unmount();
    });
  });
}
