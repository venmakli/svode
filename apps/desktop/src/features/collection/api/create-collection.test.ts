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
  let callCount = 0;
  mockNativeIpc(() => {
    callCount += 1;
    if (callCount === 1) {
      return {
        body: "",
        meta: {
          created: "",
          extra: {},
          icon: null,
          title: "A/B",
          updated: "",
        },
        path: "A-B.md",
        warnings: [
          {
            kind: "filename_projection",
            message: "adjusted",
            path: "A-B.md",
          },
        ],
      };
    }
    if (callCount === 2) {
      return {
        collectionPath: "A-B",
        entry: {
          body: "",
          meta: {
            created: "",
            extra: {},
            icon: null,
            title: "A/B",
            updated: "",
          },
          path: "A-B/README.md",
        },
        oldPath: "A-B.md",
        readmePath: "A-B/README.md",
        schemaPath: "A-B/schema.yaml",
      };
    }
    throw new Error(`Unexpected native call: ${callCount}`);
  });

  try {
    const created = await createCollection({
      projectPath: "/project",
      spacePath: "/project",
      title: "A/B",
    });

    expect(callCount).toBe(2);
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
