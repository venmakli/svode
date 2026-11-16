import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import type { Page } from "@/features/page";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import { saveCollectionTreeOrder } from "./items-api";

function item(path: string): Page {
  return {
    body: "",
    meta: { created: "", icon: null, title: path, updated: "" },
    path,
  } as Page;
}

test("Collection view order saves only the Collection section without reading the whole order", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  });
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });
  const calls: Array<{ command: string; args: unknown }> = [];
  mockNativeIpc((command, args) => {
    calls.push({ command, args });
    return null;
  });

  try {
    await saveCollectionTreeOrder({
      spacePath: "/project",
      orderKey: "tasks",
      items: [item("tasks/b.md"), item("tasks/a/README.md")],
      projectPath: "/project",
    });

    expect(calls).toEqual([
      {
        command: "save_tree_order",
        args: {
          space: "/project",
          order: { tasks: ["b.md", "a"] },
          projectPath: "/project",
        },
      },
    ]);
  } finally {
    clearNativeMocks();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
    dom.window.close();
  }
});
