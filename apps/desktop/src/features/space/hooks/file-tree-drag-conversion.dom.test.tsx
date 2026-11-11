import { expect, test } from "bun:test";
import { act, useEffect } from "react";
import { JSDOM } from "jsdom";
import { toast } from "sonner";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import type { SpaceInfo, TreeNode } from "../model/types";
import type { Projection } from "../lib/tree-dnd-utilities";

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

function leaf(path: string): TreeNode {
  return {
    children: [],
    has_changes: false,
    has_schema: false,
    icon: null,
    kind: "page",
    name: path.split("/").pop()!,
    path,
    title: path.split("/").pop()!,
  };
}

function folderPage(folder: string): TreeNode {
  return {
    children: [],
    has_changes: false,
    has_schema: false,
    hasChildren: true,
    icon: null,
    kind: "page",
    name: folder.split("/").pop()!,
    path: `${folder}/README.md`,
    title: folder.split("/").pop()!,
  };
}

/** What the Space lists under each parent ("" for the root). */
type Listing = Record<string, TreeNode[]>;

interface Scenario {
  /** Listing before the move. */
  before: Listing;
  /** Folder Page rows shown expanded. */
  expanded: string[];
  /** Page files on disk before the move. */
  files: string[];
  /** What `move_content` does: its result, the listing and files after. */
  move: {
    newPath: string;
    convertedParents: { oldPath: string; newPath: string }[];
    after: Listing;
    relocations: [from: string, to: string][];
  };
}

/**
 * The sidebar drag over a Space whose Page at `open` is shown, with the
 * structural commands it may call recorded.
 */
async function environment(scenario: Scenario, open: string) {
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
  const spacePath = `/drag-conversion-${Math.random()}`;
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
  let listing = scenario.before;
  const files = new Set(scenario.files);
  const structural: { command: string; args: Record<string, unknown> }[] = [];
  const orders: Record<string, string[]>[] = [];
  const { emit } = await import("@/platform/native/events");
  mockNativeIpc(
    async (command, args) => {
      const input = (args ?? {}) as Record<string, unknown>;
      if (
        command === "move_content" ||
        command === "nest_page" ||
        command === "unnest_page" ||
        command === "convert_page_to_leaf" ||
        command === "convert_page_to_folder"
      ) {
        structural.push({ command, args: input });
      }
      if (command === "read_page") {
        const path = String(input.path);
        if (!files.has(path)) throw `File not found: ${path}`;
        return {
          path,
          body: "",
          meta: { title: path, icon: null, created: "", updated: "" },
        };
      }
      if (command === "move_content") {
        for (const [from, to] of scenario.move.relocations) {
          files.delete(from);
          files.add(to);
        }
        listing = scenario.move.after;
        return {
          newPath: scenario.move.newPath,
          convertedParents: scenario.move.convertedParents,
        };
      }
      if (command === "list_tree_children") {
        return listing[String(input.parentPath ?? "")] ?? [];
      }
      if (command === "save_tree_order") {
        orders.push(input.order as Record<string, string[]>);
        return null;
      }
      if (command === "navigation_expanded_paths") return scenario.expanded;
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
    expandedPaths: { root: scenario.expanded },
  });
  await useSpaceStore
    .getState()
    .reloadTreeParents("root", Object.keys(scenario.before));
  const { PageDetailProvider, usePageDetailContext } =
    await import("@/features/page/scope-surface");
  const { closeActiveContent, getActiveContentPath, useActiveContentPath } =
    await import("@/features/artifact");
  const { openPage } = await import("@/features/page/navigation");
  const { useFileTreeDragCommand } =
    await import("./use-file-tree-drag-command");
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
  const actions: { drag?: ReturnType<typeof useFileTreeDragCommand> } = {};
  function Sidebar() {
    const tree = useSpaceStore((state) => state.fileTrees.root) ?? [];
    const drag = useFileTreeDragCommand({ spaceId: "root", tree });
    useEffect(() => {
      actions.drag = drag;
    });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById("app")!);
  closeActiveContent();
  openPage(open, "root");
  await act(async () => {
    root.render(
      <>
        <OpenPage />
        <Sidebar />
      </>,
    );
    await turn();
    await turn();
  });
  return {
    spacePath,
    structural,
    orders,
    shown,
    gone: () => gone,
    opened: () => ({ page: shownPath, selection: getActiveContentPath() }),
    drag: async (fromPath: string, projection: Projection) => {
      await act(async () => {
        await actions.drag!({ fromPath, projection });
        await turn();
        await turn();
        await turn();
      });
    },
    /** The watcher reports the paths the move and its conversions left. */
    reportLeftPaths: async () => {
      await act(async () => {
        for (const [from] of scenario.move.relocations)
          await emit("file:deleted", { space: spacePath, path: from });
        await turn();
        await turn();
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

const intoLeaf: Scenario = {
  before: {
    "": [leaf("a.md"), leaf("note.md"), leaf("target.md"), leaf("z.md")],
  },
  expanded: [],
  files: ["a.md", "note.md", "target.md", "z.md"],
  move: {
    newPath: "target/note.md",
    convertedParents: [{ oldPath: "target.md", newPath: "target/README.md" }],
    after: {
      "": [leaf("a.md"), folderPage("target"), leaf("z.md")],
      target: [leaf("target/note.md")],
    },
    relocations: [
      ["note.md", "target/note.md"],
      ["target.md", "target/README.md"],
    ],
  },
};

const lastChildOut: Scenario = {
  before: {
    "": [folderPage("parent"), folderPage("archive")],
    parent: [leaf("parent/child.md")],
    archive: [leaf("archive/a.md"), leaf("archive/b.md")],
  },
  expanded: ["parent/README.md", "archive/README.md"],
  files: ["parent/README.md", "parent/child.md", "archive/README.md"],
  move: {
    newPath: "archive/child.md",
    convertedParents: [{ oldPath: "parent/README.md", newPath: "parent.md" }],
    after: {
      "": [leaf("parent.md"), folderPage("archive")],
      archive: [
        leaf("archive/a.md"),
        leaf("archive/b.md"),
        leaf("archive/child.md"),
      ],
    },
    relocations: [
      ["parent/child.md", "archive/child.md"],
      ["parent/README.md", "parent.md"],
    ],
  },
};

const betweenFolderPages: Scenario = {
  before: {
    "": [folderPage("parent"), folderPage("archive")],
    parent: [leaf("parent/child.md"), leaf("parent/keep.md")],
    archive: [leaf("archive/a.md"), leaf("archive/b.md")],
  },
  expanded: ["parent/README.md", "archive/README.md"],
  files: [
    "parent/README.md",
    "parent/child.md",
    "parent/keep.md",
    "archive/README.md",
  ],
  move: {
    newPath: "archive/child.md",
    convertedParents: [],
    after: {
      "": [folderPage("parent"), folderPage("archive")],
      parent: [leaf("parent/keep.md")],
      archive: [
        leaf("archive/a.md"),
        leaf("archive/b.md"),
        leaf("archive/child.md"),
      ],
    },
    relocations: [["parent/child.md", "archive/child.md"]],
  },
};

const lastChildIntoLeaf: Scenario = {
  before: {
    "": [folderPage("parent"), leaf("target.md")],
    parent: [leaf("parent/child.md")],
  },
  expanded: ["parent/README.md"],
  files: ["parent/README.md", "parent/child.md", "target.md"],
  move: {
    newPath: "target/child.md",
    convertedParents: [
      { oldPath: "target.md", newPath: "target/README.md" },
      { oldPath: "parent/README.md", newPath: "parent.md" },
    ],
    after: {
      "": [leaf("parent.md"), folderPage("target")],
      target: [leaf("target/child.md")],
    },
    relocations: [
      ["parent/child.md", "target/child.md"],
      ["target.md", "target/README.md"],
      ["parent/README.md", "parent.md"],
    ],
  },
};

const childOfTarget: Projection = {
  depth: 1,
  overPath: "target.md",
  parentPath: "target",
  type: "child",
};

const beforeArchiveB: Projection = {
  depth: 1,
  overPath: "archive/b.md",
  parentPath: "archive",
  type: "before",
};

const cases: {
  name: string;
  scenario: Scenario;
  from: string;
  projection: Projection;
  toParent: string;
  follows: Record<string, string>;
  order: Record<string, string[]>;
}[] = [
  {
    name: "dragging a Page into a leaf Page",
    scenario: intoLeaf,
    from: "note.md",
    projection: childOfTarget,
    toParent: "target",
    follows: {
      "target.md": "target/README.md",
      "note.md": "target/note.md",
    },
    order: { ".": ["a.md", "target", "z.md"] },
  },
  {
    name: "dragging the last child out of a folder Page",
    scenario: lastChildOut,
    from: "parent/child.md",
    projection: beforeArchiveB,
    toParent: "archive",
    follows: {
      "parent/README.md": "parent.md",
      "parent/child.md": "archive/child.md",
    },
    order: {
      ".": ["parent.md", "archive"],
      archive: ["a.md", "child.md", "b.md"],
    },
  },
  {
    name: "dragging a Page between folder Pages",
    scenario: betweenFolderPages,
    from: "parent/child.md",
    projection: beforeArchiveB,
    toParent: "archive",
    follows: {
      "parent/README.md": "parent/README.md",
      "parent/child.md": "archive/child.md",
    },
    order: {
      ".": ["parent", "archive"],
      parent: ["keep.md"],
      archive: ["a.md", "child.md", "b.md"],
    },
  },
  {
    name: "dragging the last child of a folder Page into a leaf Page",
    scenario: lastChildIntoLeaf,
    from: "parent/child.md",
    projection: childOfTarget,
    toParent: "target",
    follows: {
      "target.md": "target/README.md",
      "parent/README.md": "parent.md",
      "parent/child.md": "target/child.md",
    },
    order: { ".": ["parent.md", "target"] },
  },
];

for (const item of cases) {
  for (const [open, followed] of Object.entries(item.follows)) {
    test(`${item.name} is one move with the open Page at ${open} going on at ${followed}`, async () => {
      const env = await environment(item.scenario, open);
      try {
        expect(env.opened()).toEqual({ page: open, selection: open });
        await env.drag(item.from, item.projection);
        // The Space converts the parents itself: no nest or unnest here.
        expect(env.structural).toEqual([
          {
            command: "move_content",
            args: {
              space: env.spacePath,
              from: item.from,
              toParent: item.toParent,
              projectPath: env.spacePath,
            },
          },
        ]);
        await env.reportLeftPaths();
        expect(env.opened()).toEqual({ page: followed, selection: followed });
        expect(env.gone()).toBe(0);
        expect(env.shown).toEqual([]);
        // The last order write places the item by the drag projection.
        expect(env.orders.at(-1)).toEqual(item.order);
      } finally {
        await env.cleanup();
      }
    });
  }
}

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
