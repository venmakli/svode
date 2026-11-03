import { expect, test } from "bun:test";
import { act, useEffect } from "react";
import { JSDOM } from "jsdom";
import { toast } from "sonner";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import type { SpaceInfo } from "../model/types";

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

type Relocation = { from: string; to: string; converted: boolean };

/**
 * A window whose Page at `open` is shown while an agent moves content of its
 * Space through Svode MCP: the files the move leaves and takes are `files`.
 */
async function environment(files: Set<string>, open: string) {
  const dom = new JSDOM("<!doctype html><div id=app></div>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restore = installDomGlobals(dom);
  const shown: string[] = [];
  const saved = { error: toast.error, warning: toast.warning };
  const record = (message: unknown) => {
    shown.push(String(message));
    return 0;
  };
  toast.error = record as never;
  toast.warning = record as never;
  const spacePath = `/agent-relocation-${Math.random()}`;
  const space: SpaceInfo = {
    description: "",
    hasSchema: false,
    hasSpaces: false,
    icon: "",
    id: "root",
    lastOpened: null,
    lfsState: "n/a",
    name: "Root",
    path: spacePath,
    status: "ready",
  };
  const { emit } = await import("@/platform/native/events");
  mockNativeIpc(
    async (command, args) => {
      const input = (args ?? {}) as Record<string, unknown>;
      if (command === "read_page") {
        const path = String(input.path);
        if (!files.has(path)) throw `File not found: ${path}`;
        return {
          path,
          body: "",
          meta: { title: path, icon: null, created: "", updated: "" },
        };
      }
      if (command === "list_tree_children") return [];
      return null;
    },
    { shouldMockEvents: true },
  );
  const { createRoot } = await import("react-dom/client");
  const { useSpaceStore } = await import("../model/space-store");
  useSpaceStore.setState({
    activeRootId: "root",
    activeRootPath: spacePath,
    rootSpaces: [space],
  });
  const { PageDetailProvider, usePageDetailContext } =
    await import("@/features/page/scope-surface");
  const { closeActiveContent, getActiveContentPath, useActiveContentPath } =
    await import("@/features/artifact");
  const { openPage } = await import("@/features/page/navigation");
  const { useAgentContentRelocation } =
    await import("./use-agent-content-relocation");
  let gone = 0;
  let shownPath: string | null = null;
  function Shown() {
    const path = usePageDetailContext().page?.path ?? null;
    useEffect(() => {
      shownPath = path;
    });
    return null;
  }
  function OpenPage() {
    const path = useActiveContentPath();
    if (!path) return null;
    return (
      <PageDetailProvider
        spacePath={spacePath}
        spaceId="root"
        readmePath={path}
        ownerPath={path}
        target="page"
        onOpenPath={() => {}}
        onPageGone={() => (gone += 1)}
      >
        <Shown />
      </PageDetailProvider>
    );
  }
  function Listener() {
    useAgentContentRelocation();
    return null;
  }
  const root = createRoot(dom.window.document.getElementById("app")!);
  closeActiveContent();
  openPage(open, "root");
  await act(async () => {
    root.render(
      <>
        <OpenPage />
        <Listener />
      </>,
    );
    await turn();
    await turn();
  });
  const settle = async () => {
    for (let index = 0; index < 4; index += 1) await turn();
  };
  return {
    shown,
    gone: () => gone,
    opened: () => ({ page: shownPath, selection: getActiveContentPath() }),
    /**
     * The agent's move: its start, the files it changes with the watcher
     * reporting the paths it left before it ends, then its end.
     */
    move: async (relocations: Relocation[], failed = false) => {
      await act(async () => {
        await emit("content:relocation", {
          space: spacePath,
          phase: "started",
        });
        await settle();
        if (!failed) {
          // A directory takes the files inside it along.
          for (const { from, to } of relocations)
            for (const file of [...files])
              if (file === from || file.startsWith(`${from}/`)) {
                files.delete(file);
                files.add(`${to}${file.slice(from.length)}`);
              }
          for (const { from } of relocations)
            await emit("file:deleted", { space: spacePath, path: from });
          await settle();
        }
        await emit("content:relocation", {
          space: spacePath,
          phase: "finished",
          relocations: failed ? [] : relocations,
        });
        await settle();
      });
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      closeActiveContent();
      Object.assign(toast, saved);
      clearNativeMocks();
      restore();
      dom.window.close();
    },
  };
}

const moved = (from: string, to: string) => ({ from, to, converted: false });
const converted = (from: string, to: string) => ({ from, to, converted: true });

const cases: {
  name: string;
  files: string[];
  relocations: Relocation[];
  follows: Record<string, string>;
}[] = [
  {
    name: "moving a Page into a leaf Page",
    files: ["note.md", "target.md"],
    relocations: [
      converted("target.md", "target/README.md"),
      moved("note.md", "target/note.md"),
    ],
    follows: {
      "target.md": "target/README.md",
      "note.md": "target/note.md",
    },
  },
  {
    name: "moving the last child out of a folder Page",
    files: ["parent/README.md", "parent/child.md"],
    relocations: [
      moved("parent/child.md", "child.md"),
      converted("parent/README.md", "parent.md"),
    ],
    follows: {
      "parent/README.md": "parent.md",
      "parent/child.md": "child.md",
    },
  },
  {
    name: "moving a folder Page by its directory",
    files: ["parent/README.md", "parent/child.md"],
    relocations: [moved("parent", "archive/parent")],
    follows: {
      "parent/README.md": "archive/parent/README.md",
      "parent/child.md": "archive/parent/child.md",
    },
  },
];

for (const item of cases) {
  for (const [open, followed] of Object.entries(item.follows)) {
    test(`an agent ${item.name} takes the open Page at ${open} to ${followed}`, async () => {
      const env = await environment(new Set(item.files), open);
      try {
        expect(env.opened()).toEqual({ page: open, selection: open });
        await env.move(item.relocations);
        expect(env.opened()).toEqual({ page: followed, selection: followed });
        expect(env.gone()).toBe(0);
        expect(env.shown).toEqual([]);
      } finally {
        await env.cleanup();
      }
    });
  }
}

test("a failed agent move leaves the open Page where it is", async () => {
  const env = await environment(new Set(["note.md", "target.md"]), "target.md");
  try {
    await env.move([converted("target.md", "target/README.md")], true);
    expect(env.opened()).toEqual({ page: "target.md", selection: "target.md" });
    expect(env.gone()).toBe(0);
  } finally {
    await env.cleanup();
  }
});

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    document: dom.window.document,
    window: dom.window,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    Element: dom.window.Element,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    localStorage: dom.window.localStorage,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}
