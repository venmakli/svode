import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_APP_VARIABLES_HOST_TEST !== "1") {
  test("App Variables host integration", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_APP_VARIABLES_HOST_TEST: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  });
} else {
  const { mock } = bunTest as typeof bunTest & {
    mock: { module(path: string, factory: () => unknown): void };
  };
  let mounts = 0;
  mock.module("@/features/apps", () => ({
    AppSurface: ({ onOpenVariables }: { onOpenVariables(): void }) => {
      const [draft, setDraft] = useState("unfinished setup");
      useEffect(() => {
        mounts += 1;
      }, []);
      return (
        <div data-app-surface>
          <button onClick={() => setDraft("changed setup")}>Edit setup</button>
          <output>{draft}</output>
          <button data-variables-trigger onClick={onOpenVariables}>
            Variables
          </button>
        </div>
      );
    },
  }));
  mock.module("@/features/settings", () => ({
    AppVariablesDialog: ({
      context,
      onClose,
      returnFocus,
    }: {
      context: unknown;
      onClose(): void;
      returnFocus(): void;
    }) => {
      useEffect(() => () => returnFocus(), [returnFocus]);
      return (
        <div data-variables-dialog data-context={JSON.stringify(context)}>
          <button onClick={onClose}>Close</button>
        </div>
      );
    },
  }));
  test("page/root and scope/space contexts retain the App host and reset on owner changes", async () => {
    const dom = new JSDOM(
      '<!doctype html><html><body><div id="app"></div></body></html>',
      { pretendToBeVisual: true, url: "http://localhost/" },
    );
    const restore = installDomGlobals(dom);
    const { AppWithVariables } = await import("./app-with-variables");
    const root = createRoot(dom.window.document.getElementById("app")!);
    const owner = {
      projectPath: "/repo",
      spacePath: "/repo",
      spaceId: "project-id",
      ownerPath: "page",
    };
    try {
      await act(async () => {
        root.render(<AppWithVariables owner={owner} />);
      });
      const trigger = dom.window.document.querySelector<HTMLButtonElement>(
        "[data-variables-trigger]",
      )!;
      await act(async () => {
        dom.window.document
          .querySelector<HTMLButtonElement>("[data-app-surface] button")!
          .click();
      });
      await act(async () => {
        trigger.focus();
        trigger.click();
      });
      expect(mounts).toBe(1);
      expect(dom.window.document.querySelector("output")?.textContent).toBe(
        "changed setup",
      );
      expect(
        JSON.parse(
          dom.window.document
            .querySelector("[data-variables-dialog]")!
            .getAttribute("data-context")!,
        ),
      ).toEqual({ projectPath: "/repo", spaceId: null, ownerPath: "page" });
      await act(async () => {
        dom.window.document
          .querySelector<HTMLButtonElement>("[data-variables-dialog] button")!
          .click();
      });
      expect(dom.window.document.activeElement === trigger).toBe(true);
      expect(mounts).toBe(1);
      await act(async () => trigger.click());
      await act(async () => {
        root.render(
          <AppWithVariables
            owner={{
              ...owner,
              spacePath: "/repo/docs",
              spaceId: "docs",
              ownerPath: "scope-app",
            }}
          />,
        );
      });
      expect(
        dom.window.document.querySelector("[data-variables-dialog]"),
      ).toBeNull();
      await act(async () =>
        dom.window.document
          .querySelector<HTMLButtonElement>("[data-variables-trigger]")!
          .click(),
      );
      expect(
        JSON.parse(
          dom.window.document
            .querySelector("[data-variables-dialog]")!
            .getAttribute("data-context")!,
        ),
      ).toEqual({
        projectPath: "/repo",
        spaceId: "docs",
        ownerPath: "scope-app",
      });
    } finally {
      await act(async () => root.unmount());
      restore();
      dom.window.close();
    }
  });
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
