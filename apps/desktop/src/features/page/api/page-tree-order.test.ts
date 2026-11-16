import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import { savePageTreeOrderNames } from "./page-api";

async function recordCommands(run: () => Promise<void>) {
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
    await run();
    return calls;
  } finally {
    clearNativeMocks();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
    dom.window.close();
  }
}

test("subpage order saves only its folder section without reading the whole order", async () => {
  const calls = await recordCommands(() =>
    savePageTreeOrderNames({
      spacePath: "/project",
      orderKey: "docs",
      names: ["b.md", "a"],
      projectPath: "/project",
    }),
  );

  expect(calls).toEqual([
    {
      command: "save_tree_order",
      args: {
        space: "/project",
        order: { docs: ["b.md", "a"] },
        projectPath: "/project",
      },
    },
  ]);
});

test("subpage order of the Space root saves only the root section", async () => {
  const calls = await recordCommands(() =>
    savePageTreeOrderNames({
      spacePath: "/project",
      orderKey: "",
      names: ["z.md"],
    }),
  );

  expect(calls).toEqual([
    {
      command: "save_tree_order",
      args: { space: "/project", order: { ".": ["z.md"] }, projectPath: null },
    },
  ]);
});
