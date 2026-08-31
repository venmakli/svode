import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import { makeRelativePageLink, resolvePageLink } from "./page-links-api";
import { createPage } from "./pages-api";

test("Page adapters expose canonical contracts over private native commands", async () => {
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
    calls.push({ command, args: args ?? {} });
    if (command === "create_entry") {
      return {
        body: "",
        meta: {
          created: "",
          extra: {},
          icon: null,
          title: "Page",
          updated: "",
        },
        path: "Page.md",
      };
    }
    if (command === "make_relative_link") return "../Target.md";
    if (command === "resolve_doc_link") {
      return {
        exists: true,
        spaceName: "Space",
        status: "ready",
        targetPath: "Target.md",
        targetSpaceId: "space",
        targetSpacePath: "/project/space",
      };
    }
    throw new Error(`Unexpected command: ${command}`);
  });

  try {
    const page = await createPage({
      space: "/project/space",
      parentPath: null,
      title: "Page",
      projectPath: "/project",
    });
    const relative = await makeRelativePageLink({
      sourcePagePath: "/project/space/Source.md",
      targetPagePath: "/project/space/Target.md",
    });
    const resolved = await resolvePageLink({
      projectPath: "/project",
      sourceSpaceId: "space",
      sourcePath: "Source.md",
      url: "./Target.md",
    });

    expect(page.path).toBe("Page.md");
    expect(relative).toBe("../Target.md");
    expect(resolved.targetPath).toBe("Target.md");
    expect(calls.map((call) => call.command)).toEqual([
      "create_entry",
      "make_relative_link",
      "resolve_doc_link",
    ]);
    expect(calls[1]?.args).toEqual({
      sourceDocPath: "/project/space/Source.md",
      targetDocPath: "/project/space/Target.md",
    });
  } finally {
    clearNativeMocks();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
    dom.window.close();
  }
});
