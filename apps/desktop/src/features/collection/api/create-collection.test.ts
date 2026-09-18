import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import { createCollection } from "./create-collection";

test("collection create uses Page filename projection and reports the final README path", async () => {
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
    return {
      body: "",
      meta: {
        created: "",
        extra: {},
        icon: null,
        title: "A/B",
        updated: "",
      },
      path: "A-B/README.md",
      warnings: [
        {
          kind: "filename_projection",
          message: "adjusted",
          path: "A-B/README.md",
        },
      ],
    };
  });

  try {
    const created = await createCollection({
      projectPath: "/project",
      spacePath: "/project",
      title: "A/B",
    });

    expect(calls).toEqual([
      {
        command: "create_collection",
        args: {
          parentPath: null,
          projectPath: "/project",
          space: "/project",
          title: "A/B",
        },
      },
    ]);
    expect(created.path).toBe("A-B/README.md");
    expect(created.warnings?.[0]?.path).toBe("A-B/README.md");
  } finally {
    clearNativeMocks();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
    dom.window.close();
  }
});
