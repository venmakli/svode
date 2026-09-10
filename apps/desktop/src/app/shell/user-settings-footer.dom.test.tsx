import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

if (process.env.SVODE_UPDATE_FOOTER_DOM_PROCESS !== "1") {
  test("update footer DOM integration", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_UPDATE_FOOTER_DOM_PROCESS: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 20000);
} else {
  test("menu and footer share checks, downloads, recovery and focus with About and toast", async () => {
    const dom = new JSDOM(
      "<!doctype html><html><body><div id=app></div></body></html>",
      { pretendToBeVisual: true, url: "http://localhost" },
    );
    const previous = new Map<string, PropertyDescriptor | undefined>();
    const values: Record<string, unknown> = {
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      HTMLElement: dom.window.HTMLElement,
      HTMLInputElement: dom.window.HTMLInputElement,
      Element: dom.window.Element,
      Node: dom.window.Node,
      NodeFilter: dom.window.NodeFilter,
      Event: dom.window.Event,
      CustomEvent: dom.window.CustomEvent,
      MutationObserver: dom.window.MutationObserver,
      ResizeObserver: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
      getComputedStyle: dom.window.getComputedStyle,
      requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
      cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [key, value] of Object.entries(values)) {
      previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
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
    const { UserSettingsFooter } = await import("./user-settings-footer");
    const { DogfoodUpdatesProvider, DogfoodUpdateSettingsControls } =
      await import("@/features/updates");
    const { AppPreferencesProvider } = await import("@/features/settings");
    const { SidebarProvider } = await import("@/components/ui/sidebar");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { setLocale } = await import("@/paraglide/runtime.js");
    const { toast } = await import("sonner");
    const doc = dom.window.document;
    const root = createRoot(doc.getElementById("app")!);
    const name = "Long global identity ".repeat(8);
    const requests: { resolve: (response: Response) => void }[] = [];
    const urls: string[] = [];
    const destinations: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        requests.push({ resolve });
      })) as typeof fetch;
    let autoCheck: (() => void) | undefined;
    const originalTimeout = dom.window.setTimeout.bind(dom.window);
    dom.window.setTimeout = ((handler: () => void, timeout: number) => {
      if (timeout === 5000) {
        autoCheck = handler;
        return 98765;
      }
      return originalTimeout(handler, timeout);
    }) as typeof dom.window.setTimeout;
    mockNativeIpc(
      (command, args) => {
        if (command === "get_app_preferences")
          return {
            theme: "system",
            language: "en",
            themeNeedsRecovery: false,
          };
        if (command === "plugin:shell|open") {
          urls.push((args as { path: string }).path);
          return;
        }
        throw new Error(`Unexpected command: ${command}`);
      },
      { shouldMockEvents: true },
    );
    async function settle() {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    async function waitForDestination(count: number) {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (destinations.length === count && !menu()) return;
        await act(async () => {
          await settle();
        });
      }
      throw new Error("Menu did not finish its destination focus handoff");
    }
    async function render(version = "0.0.8", about = true, project = "one") {
      await act(async () => {
        root.render(
          <AppPreferencesProvider fallback={null}>
            <DogfoodUpdatesProvider version={version} buildCommit="installed">
              <TooltipProvider delayDuration={0}>
                <SidebarProvider key={project}>
                  <UserSettingsFooter
                    identityName={name}
                    identityEmail="user@example.test"
                    identityAvatarColor="#123456"
                    onOpenProfile={() => destinations.push("profile")}
                    onOpenSettings={() => destinations.push("settings")}
                  />
                  {about && (
                    <div data-about>
                      <DogfoodUpdateSettingsControls />
                    </div>
                  )}
                  <button data-other>Other focus target</button>
                </SidebarProvider>
              </TooltipProvider>
            </DogfoodUpdatesProvider>
          </AppPreferencesProvider>,
        );
        await settle();
      });
    }
    async function key(element: Element, value: string) {
      await act(async () => {
        element.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: value,
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
    function trigger() {
      return doc.querySelector<HTMLButtonElement>(
        "[data-settings-return-focus]",
      )!;
    }
    function footer() {
      return doc.querySelector<HTMLButtonElement>("[data-update-download]");
    }
    function menu() {
      return doc.querySelector('[data-slot="dropdown-menu-content"]');
    }
    function items() {
      return [...doc.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    }
    function updateItem() {
      return items()[2];
    }
    function aboutCheck() {
      return doc.querySelector<HTMLButtonElement>("[data-about] button")!;
    }
    async function open() {
      await key(trigger(), "ArrowDown");
    }
    async function close() {
      await key(doc.activeElement!, "Escape");
    }
    async function answer(version: string | null, status = 200) {
      await act(async () => {
        requests[requests.length - 1].resolve(
          new Response(
            JSON.stringify({
              schema: 1,
              channel: "dogfood",
              items: version
                ? [
                    {
                      kind: "stage-release",
                      version,
                      commit: version,
                      publishedAt: "2026-09-09T00:00:00Z",
                      platforms: {
                        linux: {
                          url: `https://example.test/${version}`,
                          fallbackUrl: "https://example.test/fallback",
                        },
                      },
                    },
                  ]
                : [],
            }),
            { status },
          ),
        );
        await settle();
      });
    }
    function latestToast() {
      const entry = toast
        .getHistory()
        .filter((item) => "action" in item && item.action)
        .at(-1);
      if (!entry || !("action" in entry))
        throw new Error("Expected update toast");
      return entry;
    }
    try {
      await render("");
      await open();
      expect(updateItem().textContent).toBe("Check for updates");
      expect(updateItem().getAttribute("aria-disabled")).toBe("true");
      expect(footer()).toBeNull();
      expect(requests.length).toBe(0);
      await close();

      await render();
      dom.window.localStorage.setItem(
        "svode.updates.dogfood.lastCheckAt",
        String(Date.now()),
      );
      await open();
      expect(items()[1].textContent?.includes("Settings")).toBe(true);
      expect(updateItem().textContent).toBe("Check for updates");
      expect(updateItem().querySelector(".lucide-refresh-cw") !== null).toBe(
        true,
      );
      expect(updateItem().getAttribute("aria-disabled")).toBeNull();
      await key(doc.activeElement!, "ArrowDown");
      await key(doc.activeElement!, "ArrowDown");
      expect(doc.activeElement).toBe(updateItem());
      await key(doc.activeElement!, "Enter");
      expect(menu()).toBeNull();
      expect(doc.activeElement).toBe(trigger());
      expect(requests.length).toBe(1);
      expect(aboutCheck().disabled).toBe(true);
      await open();
      expect(updateItem().textContent).toBe("Checking…");
      expect(updateItem().querySelector(".animate-spin") !== null).toBe(true);
      expect(updateItem().getAttribute("aria-disabled")).toBe("true");
      await click(updateItem());
      expect(requests.length).toBe(1);
      await close();
      await render("0.0.8", false);
      await answer(null);
      expect(
        toast
          .getHistory()
          .some(
            (entry) => "title" in entry && entry.title === "You're up to date",
          ),
      ).toBe(true);
      expect(footer()).toBeNull();
      await open();
      await click(updateItem());
      expect(requests.length).toBe(2);
      await answer(null, 503);
      await open();
      expect(updateItem().textContent).toBe("Check for updates");
      expect(
        toast
          .getHistory()
          .some(
            (entry) =>
              "title" in entry && entry.title === "Could not check for updates",
          ),
      ).toBe(true);
      await click(updateItem());
      expect(requests.length).toBe(3);
      await answer("0.0.9");
      expect(footer()?.getAttribute("aria-label")).toBe("Download update");
      expect(footer()?.getAttribute("data-size")).toBe("icon");
      expect(footer()?.querySelector(".lucide-download") !== null).toBe(true);
      expect(trigger().contains(footer())).toBe(false);
      expect(trigger().querySelector(".truncate") !== null).toBe(true);
      expect(trigger().closest("ul")?.classList.contains("min-w-0")).toBe(true);
      expect(destinations).toEqual([]);
      await click(footer()!);
      expect(menu()).toBeNull();
      expect(urls).toEqual(["https://example.test/0.0.9"]);
      await act(async () => {
        footer()!.focus();
        await settle();
      });
      expect(doc.querySelector('[role="tooltip"]')?.textContent).toBe(
        "Download update",
      );
      await key(footer()!, "Escape");
      await open();
      expect(updateItem().textContent).toBe("Download update");
      expect(updateItem().querySelector(".lucide-download") !== null).toBe(
        true,
      );
      await click(updateItem());
      expect(menu()).toBeNull();
      expect(doc.activeElement).toBe(trigger());
      expect(requests.length).toBe(3);
      expect(urls.length).toBe(2);
      await act(async () => {
        const action = latestToast().action;
        if (action && typeof action === "object" && "onClick" in action)
          action.onClick({} as never);
        toast.dismiss();
        await settle();
      });
      expect(urls.length).toBe(3);
      await render("0.0.8", true, "two");
      expect(footer() !== null).toBe(true);
      const aboutDownload = doc.querySelectorAll<HTMLButtonElement>(
        "[data-about] button",
      )[1];
      await click(aboutDownload);
      expect(urls).toEqual(Array(4).fill("https://example.test/0.0.9"));
      await click(aboutCheck());
      expect(requests.length).toBe(4);
      expect(footer() !== null).toBe(true);
      await open();
      expect(updateItem().textContent).toBe("Checking…");
      await close();
      await click(footer()!);
      await answer(null, 503);
      await open();
      expect(updateItem().textContent).toBe("Download update");
      await close();
      expect(footer() !== null).toBe(true);
      await click(aboutCheck());
      await act(async () => {
        footer()!.focus();
        await settle();
      });
      await answer(null);
      expect(footer()).toBeNull();
      expect(doc.activeElement).toBe(trigger());

      dom.window.localStorage.removeItem("svode.updates.dogfood.lastCheckAt");
      await act(async () => {
        autoCheck!();
        await settle();
      });
      expect(requests.length).toBe(6);
      await answer("0.0.10");
      expect(footer() !== null).toBe(true);
      await open();
      expect(updateItem().textContent).toBe("Download update");
      await close();
      await click(aboutCheck());
      const other = doc.querySelector<HTMLButtonElement>("[data-other]")!;
      await act(async () => {
        other.focus();
      });
      await answer(null);
      expect(footer()).toBeNull();
      expect(doc.activeElement).toBe(other);

      await act(async () => {
        setLocale("ru", { reload: false });
      });
      await render();
      await open();
      expect(updateItem().textContent).toBe("Проверить обновления");
      await click(updateItem());
      await open();
      expect(updateItem().textContent).toBe("Проверяем…");
      await close();
      await answer(null);
      expect(
        toast
          .getHistory()
          .some(
            (entry) =>
              "title" in entry && entry.title === "У вас последняя версия",
          ),
      ).toBe(true);
      await open();
      await click(updateItem());
      await answer("0.0.10");
      await open();
      expect(updateItem().textContent).toBe("Скачать обновление");
      expect(footer()?.getAttribute("aria-label")).toBe("Скачать обновление");
      await click(items()[1]);
      await waitForDestination(1);
      expect(destinations).toEqual(["settings"]);
      await open();
      await click(items()[0]);
      await waitForDestination(2);
      expect(destinations).toEqual(["settings", "profile"]);
    } finally {
      await act(async () => {
        root.unmount();
        await settle();
      });
      globalThis.fetch = originalFetch;
      clearNativeMocks();
      setLocale("en", { reload: false });
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      dom.window.close();
    }
  }, 20000);
}
