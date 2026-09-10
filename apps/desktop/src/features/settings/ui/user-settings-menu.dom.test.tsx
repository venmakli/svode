import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

if (process.env.SVODE_USER_MENU_DOM_PROCESS !== "1") {
  test("user settings menu DOM integration", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_USER_MENU_DOM_PROCESS: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 20000);
} else {
  test("user menu preserves focus, explicit destinations and confirmed shared theme through failure/retry", async () => {
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
    const { UserSettingsMenu } = await import("./user-settings-menu");
    const { DogfoodUpdatesProvider } = await import("@/features/updates");
    const { AppPreferencesProvider, useAppTheme } =
      await import("../hooks/use-app-preferences");
    const { SidebarProvider } = await import("@/components/ui/sidebar");
    const { Dialog, DialogContent, DialogTitle, DialogDescription } =
      await import("@/components/ui/dialog");
    const { toast } = await import("sonner");
    let canonicalTheme = "system";
    let resolveWrite: () => void = () => {};
    let rejectWrite: () => void = () => {};
    const writes: string[] = [];
    mockNativeIpc(
      (command, args) => {
        if (command === "get_app_preferences")
          return {
            theme: canonicalTheme,
            language: "en",
            themeNeedsRecovery: false,
          };
        if (command === "set_app_theme") {
          const requested = (args as { theme: string }).theme;
          writes.push(requested);
          return new Promise<string>((resolve, reject) => {
            resolveWrite = () => {
              canonicalTheme = requested;
              resolve(requested);
            };
            rejectWrite = () => reject(new Error("Synthetic write failure"));
          });
        }
        throw new Error(`Unexpected command: ${command}`);
      },
      { shouldMockEvents: true },
    );
    const name = "Long global identity ".repeat(8);
    const email = "long-email-".repeat(12) + "@example.com";
    function Harness() {
      const [destination, setDestination] = useState<string | null>(null);
      const appearance = useAppTheme();
      return (
        <SidebarProvider>
          <output data-confirmed>{appearance.theme}</output>
          <UserSettingsMenu
            identityName={name}
            identityEmail={email}
            identityAvatarColor="#123456"
            onOpenProfile={() => setDestination("profile")}
            onOpenSettings={() => setDestination("settings")}
          />
          <Dialog
            open={destination !== null}
            onOpenChange={(open) => {
              if (!open) setDestination(null);
            }}
          >
            <DialogContent>
              <DialogTitle>{destination}</DialogTitle>
              <DialogDescription>Settings destination</DialogDescription>
              <button data-dialog-focus>Form</button>
            </DialogContent>
          </Dialog>
        </SidebarProvider>
      );
    }
    const root = createRoot(dom.window.document.getElementById("app")!);
    const doc = dom.window.document;
    async function settle() {
      await new Promise((resolve) => setTimeout(resolve, 30));
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
    function mode(label: string) {
      return doc.querySelector<HTMLButtonElement>(
        `[aria-label="${label}"][role="menuitemradio"]`,
      )!;
    }
    try {
      await act(async () => {
        root.render(
          <AppPreferencesProvider fallback={null}>
            <DogfoodUpdatesProvider version="" buildCommit="">
              <Harness />
            </DogfoodUpdatesProvider>
          </AppPreferencesProvider>,
        );
        await settle();
      });
      const trigger = doc.querySelector<HTMLButtonElement>(
        '[data-sidebar="menu-button"]',
      )!;
      expect(trigger.textContent?.includes(email)).toBe(false);
      expect(trigger.dataset.size).toBe("default");
      expect(trigger.querySelector(".truncate") !== null).toBe(true);
      await key(trigger, "ArrowDown");
      expect(
        doc
          .querySelector('[data-slot="dropdown-menu-content"]')
          ?.getAttribute("data-side"),
      ).toBe("top");
      expect(
        doc
          .querySelector('[data-slot="dropdown-menu-content"]')
          ?.textContent?.includes(email),
      ).toBe(true);
      expect(
        doc.querySelector('[data-slot="dropdown-menu-shortcut"]')?.textContent,
      ).toBe("Ctrl+,");
      expect(mode("System").getAttribute("aria-checked")).toBe("true");
      await key(doc.activeElement!, "ArrowDown");
      await key(doc.activeElement!, "ArrowDown");
      expect(doc.activeElement).toBe(mode("Light"));
      await key(doc.activeElement!, "Enter");
      expect(writes).toEqual(["light"]);
      expect(mode("System").getAttribute("aria-checked")).toBe("true");
      expect(mode("Dark").disabled).toBe(true);
      expect(doc.querySelector("[data-confirmed]")?.textContent).toBe("system");
      await act(async () => {
        rejectWrite();
        await settle();
      });
      expect(mode("Dark").disabled).toBe(false);
      expect(
        toast
          .getHistory()
          .some((entry) => "type" in entry && entry.type === "error"),
      ).toBe(true);
      await click(mode("Light"));
      await act(async () => {
        resolveWrite();
        await settle();
      });
      expect(mode("Light").getAttribute("aria-checked")).toBe("true");
      expect(doc.querySelector("[data-confirmed]")?.textContent).toBe("light");
      await click(mode("Light"));
      expect(writes).toEqual(["light", "light"]);
      await key(mode("Light"), "Escape");
      expect(
        doc.querySelector('[data-slot="dropdown-menu-content"]'),
      ).toBeNull();
      expect(doc.activeElement).toBe(trigger);
      await key(trigger, "ArrowDown");
      expect(mode("Light").getAttribute("aria-checked")).toBe("true");
      await key(doc.activeElement!, "Enter");
      expect(
        doc.querySelector('[role="dialog"]')?.textContent?.includes("profile"),
      ).toBe(true);
      expect(
        doc.querySelector('[role="dialog"]')?.contains(doc.activeElement),
      ).toBe(true);
      expect(
        doc.querySelector('[data-slot="dropdown-menu-content"]'),
      ).toBeNull();
      await key(doc.activeElement!, "Escape");
      await key(trigger, "ArrowDown");
      await key(doc.activeElement!, "ArrowDown");
      await key(doc.activeElement!, "Enter");
      expect(
        doc.querySelector('[role="dialog"]')?.textContent?.includes("settings"),
      ).toBe(true);
      await key(doc.activeElement!, "Escape");
      await key(trigger, "ArrowDown");
      await click(mode("Dark"));
      await key(mode("Dark"), "Escape");
      await act(async () => {
        resolveWrite();
        await settle();
      });
      expect(doc.querySelector("[data-confirmed]")?.textContent).toBe("dark");
      await key(trigger, "ArrowDown");
      expect(mode("Dark").getAttribute("aria-checked")).toBe("true");
      await click(mode("System"));
      await act(async () => {
        resolveWrite();
        await settle();
      });
      expect(mode("System").getAttribute("aria-checked")).toBe("true");
      expect(doc.documentElement.classList.contains("light")).toBe(true);
    } finally {
      await act(async () => {
        root.unmount();
        await settle();
      });
      clearNativeMocks();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      dom.window.close();
    }
  }, 20000);
}
