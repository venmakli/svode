import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect } from "react";
import { JSDOM } from "jsdom";
import type { Page } from "@/features/page";
import type { CollectionEntryMenu } from "../model";

if (process.env.SVODE_COLLECTION_ENTRY_MENU_HOOK_DOM !== "1") {
  test("Collection row menu operations DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_COLLECTION_ENTRY_MENU_HOOK_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 60_000);
} else {
  const dom = new JSDOM("<!doctype html><div id='app'></div>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  function page(path: string, title = "Roadmap"): Page {
    return {
      path,
      body: "",
      meta: { title, icon: null, created: "", updated: "", extra: {} },
    };
  }
  const leaf = page("Tasks/Roadmap.md");
  const commands: string[] = [];
  Object.defineProperty(dom.window, "__TAURI_INTERNALS__", {
    value: {
      transformCallback: () => 0,
      invoke: async (command: string) => {
        commands.push(command);
        if (command === "convert_page_to_folder")
          return page("Tasks/Roadmap/README.md");
        if (command === "create_page")
          return page("Tasks/Roadmap/Untitled.md", "Untitled");
        if (command === "create_folder") return "Tasks/Roadmap/New folder";
        if (command === "convert_page_to_leaf") return page("Tasks/Launch.md");
        if (command === "convert_to_collection")
          return { entry: page("Tasks/Roadmap/README.md") };
        return [];
      },
    },
  });

  const { createRoot } = await import("react-dom/client");
  const { useCollectionEntryMenu } =
    await import("./use-collection-entry-menu");

  const events: string[] = [];
  const latest: { menu: CollectionEntryMenu | null } = { menu: null };
  function Harness({ readOnly }: { readOnly: boolean }) {
    const menu = useCollectionEntryMenu({
      readOnly,
      spacePath: "/space",
      projectPath: "/project",
      spaceId: "space",
      refreshEntries: () => events.push("refresh"),
      openPeek: (target, options) =>
        events.push(
          `peek:${target.path}${options?.focusTitle ? ":title" : ""}`,
        ),
      duplicateRow: async (target) => {
        events.push(`duplicate:${target.path}`);
      },
      requestRowDelete: (target) => events.push(`delete:${target.path}`),
    });
    useEffect(() => {
      latest.menu = menu;
    });
    return null;
  }

  const root = createRoot(document.getElementById("app")!);
  async function run(readOnly: boolean, action: string, entry = leaf) {
    commands.length = 0;
    events.length = 0;
    await act(async () => root.render(<Harness readOnly={readOnly} />));
    const handlers = latest.menu!.handlers(entry) as Record<string, () => void>;
    await act(async () => {
      handlers[action]!();
      for (let index = 0; index < 5; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    return {
      commands: commands.filter((command) => command !== "list_tree_children"),
      events: [...events],
    };
  }

  test("row items run the Peek's operations of the item and refresh the rows", async () => {
    expect(await run(false, "nest-page")).toEqual({
      commands: ["convert_page_to_folder", "create_page"],
      events: ["peek:Tasks/Roadmap/Untitled.md", "refresh"],
    });
    expect(
      await run(false, "new-item", page("Tasks/Backlog/README.md")),
    ).toEqual({
      commands: ["create_page"],
      events: ["peek:Tasks/Roadmap/Untitled.md", "refresh"],
    });
    expect(await run(false, "new-folder")).toEqual({
      commands: ["convert_page_to_folder", "create_folder"],
      events: ["refresh"],
    });
    expect(
      await run(false, "new-folder", page("Tasks/Launch/README.md")),
    ).toEqual({ commands: ["create_folder"], events: ["refresh"] });
    expect(await run(false, "make-collection")).toEqual({
      commands: ["convert_to_collection"],
      events: ["refresh"],
    });
    expect(
      await run(false, "make-leaf", page("Tasks/Launch/README.md")),
    ).toEqual({ commands: ["convert_page_to_leaf"], events: ["refresh"] });
  });

  test("rename opens the item's peek on its title; duplicate and delete keep their row flows", async () => {
    expect((await run(false, "rename")).events).toEqual([
      `peek:${leaf.path}:title`,
    ]);
    expect((await run(false, "duplicate")).events).toEqual([
      `duplicate:${leaf.path}`,
    ]);
    expect((await run(false, "delete")).events).toEqual([
      `delete:${leaf.path}`,
    ]);
  });

  test("read-only rows change nothing", async () => {
    for (const action of [
      "nest-page",
      "new-item",
      "new-folder",
      "make-collection",
      "make-leaf",
      "rename",
      "duplicate",
    ]) {
      const result = await run(true, action);
      expect([action, ...result.commands, ...result.events]).toEqual([action]);
    }
  });

  test("pinning a row pins the item as a page", async () => {
    await act(async () => root.render(<Harness readOnly={false} />));
    expect(latest.menu!.pinItem(leaf)?.title).toBe("Roadmap");
    const { artifactNavigationKey } = await import("@/features/navigation");
    expect(latest.menu!.pinItem(leaf)?.key).toEqual(
      artifactNavigationKey("page", leaf.path, "space", null),
    );
  });
}
