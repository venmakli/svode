import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

const isolatedSettingsDialogsDomProcess =
  process.env.SVODE_SETTINGS_DIALOGS_DOM_PROCESS === "1";

if (!isolatedSettingsDialogsDomProcess) {
  test("settings dialog lifecycle DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: {
          ...process.env,
          SVODE_SETTINGS_DIALOGS_DOM_PROCESS: "1",
        },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) {
      throw new Error([child.stdout, child.stderr].filter(Boolean).join("\n"));
    }
    expect(child.status).toBe(0);
  });
} else {
  const bunMock = (
    bunTest as typeof bunTest & {
      mock: { module(specifier: string, factory: () => unknown): void };
    }
  ).mock;
  let appSettingsMounts = 0;
  let appSettingsUnmounts = 0;

  bunMock.module("@/features/settings", () => ({
    SettingsDialog: ({
      destination,
      onClose,
    }: {
      destination: { section: string };
      onClose(): void;
    }) => {
      const [section, setSection] = useState(destination.section);
      useEffect(() => {
        appSettingsMounts += 1;
        return () => {
          appSettingsUnmounts += 1;
        };
      }, []);
      return (
        <div data-app-settings data-section={section}>
          <button onClick={() => setSection("changed")}>Change section</button>
          <button onClick={() => onClose()}>Close app settings</button>
        </div>
      );
    },
  }));

  test("reopening App Settings does not retain the previous Variables lifecycle", async () => {
    const dom = new JSDOM(
      "<!doctype html><html><body><div id=app></div></body></html>",
      { pretendToBeVisual: true, url: "http://localhost/" },
    );
    const restoreGlobals = installDomGlobals(dom);
    const [{ SettingsDialogs }, { useShellStore }] = await Promise.all([
      import("./settings-dialogs"),
      import("@/app/shell/model"),
    ]);
    useShellStore.getState().closeSettings();
    const root = createRoot(dom.window.document.getElementById("app")!);

    try {
      await act(async () => {
        root.render(<SettingsDialogs />);
        await nextTurn();
      });
      expect(
        dom.window.document.querySelector("[data-app-settings]"),
      ).toBeNull();

      await act(async () => {
        useShellStore.getState().openAppSettings("variables");
        await nextTurn();
      });
      expect(
        dom.window.document
          .querySelector("[data-app-settings]")
          ?.getAttribute("data-section"),
      ).toBe("variables");

      await act(async () => {
        dom.window.document
          .querySelector<HTMLButtonElement>("[data-app-settings] button")
          ?.click();
        await nextTurn();
      });
      expect(
        dom.window.document
          .querySelector("[data-app-settings]")
          ?.getAttribute("data-section"),
      ).toBe("changed");

      await act(async () => {
        useShellStore.getState().closeSettings();
        await nextTurn();
      });
      expect(
        dom.window.document.querySelector("[data-app-settings]"),
      ).toBeNull();
      expect(appSettingsUnmounts).toBe(1);

      await act(async () => {
        useShellStore.getState().openAppSettings();
        await nextTurn();
      });
      expect(
        dom.window.document
          .querySelector("[data-app-settings]")
          ?.getAttribute("data-section"),
      ).toBe("git-identity");
      expect(appSettingsMounts).toBe(2);
    } finally {
      await act(async () => root.unmount());
      useShellStore.getState().closeSettings();
      restoreGlobals();
      dom.window.close();
    }
  });
}

function nextTurn() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    CustomEvent: dom.window.CustomEvent,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: dom.window.Node,
    document: dom.window.document,
    navigator: dom.window.navigator,
    window: dom.window,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}
