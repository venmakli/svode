import { expect, test } from "bun:test";
import { act, useEffect } from "react";
import { JSDOM } from "jsdom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import type { SpaceInfo, TreeNode } from "../model/types";

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
const spacePath = "/owner-retarget";
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

function folder(path: string, children: TreeNode[] = []): TreeNode {
  return {
    children,
    has_changes: false,
    has_schema: false,
    hasChildren: children.length > 0,
    icon: null,
    kind: "folder",
    name: path.split("/").pop()!,
    path,
    title: path.split("/").pop()!,
  };
}

async function environment(
  handle: (command: string, args: Record<string, unknown>) => unknown,
) {
  const dom = new JSDOM("<!doctype html><div id=app></div>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restore = installDomGlobals(dom);
  mockNativeIpc(
    async (command, args) =>
      handle(command, (args ?? {}) as Record<string, unknown>),
    { shouldMockEvents: true },
  );
  const { createRoot } = await import("react-dom/client");
  const artifact = await import("@/features/artifact");
  const { useSpaceStore } = await import("../model/space-store");
  useSpaceStore.setState({
    activeRootId: "root",
    activeRootPath: spacePath,
    rootSpaces: [space],
  });
  artifact.closeActiveContent();
  const root = createRoot(dom.window.document.getElementById("app")!);
  return {
    artifact,
    root,
    /** The path the main area shows. */
    shown: () => artifact.getActiveContentPath(),
    cleanup: async () => {
      await act(async () => root.unmount());
      artifact.closeActiveContent();
      clearNativeMocks();
      restore();
      dom.window.close();
    },
  };
}

async function renameFolder(
  env: Awaited<ReturnType<typeof environment>>,
  path: string,
  name: string,
) {
  const { useFileTreeItemRename } = await import("./use-file-tree-item-rename");
  const rename: {
    current?: ReturnType<typeof useFileTreeItemRename>;
  } = {};
  function Row() {
    const actions = useFileTreeItemRename({
      activeRootPath: spacePath,
      bareFolder: true,
      node: folder(path),
      patchPageTreeMeta: () => undefined,
      reloadTreeParents: async () => undefined,
      removeTreePath: () => undefined,
      siblingRows: [],
      space,
      spaceId: "root",
    });
    useEffect(() => {
      rename.current = actions;
    });
    return null;
  }
  await act(async () => {
    env.root.render(<Row />);
    await turn();
  });
  await act(async () => {
    rename.current!.handleStartRename();
    await turn();
  });
  await act(async () => {
    rename.current!.setEditValue(name);
    await turn();
  });
  await act(async () => {
    await rename.current!.handleRenameSubmit();
    await turn();
  });
}

test("renaming the folder of an open App or Collection without README keeps it open at the new path", async () => {
  const env = await environment((command) => {
    if (command === "rename_content") return [];
    return null;
  });
  try {
    env.artifact.openScopeOwner({
      kind: "app-directory",
      path: "tool",
      spaceId: "root",
    });
    await renameFolder(env, "tool", "toolbox");
    expect(env.shown()).toBe("toolbox");

    env.artifact.openScopeOwner({
      kind: "collection",
      path: "lists/tasks",
      spaceId: "root",
    });
    await renameFolder(env, "lists/tasks", "todo");
    expect(env.shown()).toBe("lists/todo");
  } finally {
    await env.cleanup();
  }
});

test("renaming another folder, an ancestor or failing leaves the open content as it is", async () => {
  let fail = false;
  const env = await environment((command) => {
    if (command === "rename_content") {
      if (fail) throw { kind: "io", message: "Rename failed" };
      return [];
    }
    return null;
  });
  try {
    env.artifact.openScopeOwner({
      kind: "app-directory",
      path: "apps/tool",
      spaceId: "root",
    });
    await renameFolder(env, "assets", "media");
    expect(env.shown()).toBe("apps/tool");
    // The owner under a renamed ancestor is gone; it does not follow.
    await renameFolder(env, "apps", "programs");
    expect(env.shown()).toBe("apps/tool");

    fail = true;
    await renameFolder(env, "apps/tool", "toolbox");
    expect(env.shown()).toBe("apps/tool");
  } finally {
    await env.cleanup();
  }
});

test("dragging the folder of an open App or Collection without README into another folder keeps it open there", async () => {
  let fail = false;
  const env = await environment((command, args) => {
    if (command === "move_content") {
      if (fail) throw { kind: "io", message: "Move failed" };
      return `${String(args.toParent)}/${String(args.from).split("/").pop()}`;
    }
    if (command === "list_tree_children") return [];
    return null;
  });
  const { useFileTreeDragCommand } =
    await import("./use-file-tree-drag-command");
  const tree = [folder("archive"), folder("tool"), folder("tasks")];
  const drag: { commit?: ReturnType<typeof useFileTreeDragCommand> } = {};
  function Tree() {
    const commit = useFileTreeDragCommand({ spaceId: "root", tree });
    useEffect(() => {
      drag.commit = commit;
    });
    return null;
  }
  const intoArchive = {
    depth: 1,
    overPath: "archive",
    parentPath: "archive",
    type: "after" as const,
  };
  try {
    await act(async () => {
      env.root.render(<Tree />);
      await turn();
    });

    env.artifact.openScopeOwner({
      kind: "app-directory",
      path: "tool",
      spaceId: "root",
    });
    await act(async () => {
      await drag.commit!({ fromPath: "tool", projection: intoArchive });
      await turn();
    });
    expect(env.shown()).toBe("archive/tool");

    // Another folder moving leaves the open Collection where it is.
    env.artifact.openScopeOwner({
      kind: "collection",
      path: "tasks",
      spaceId: "root",
    });
    fail = true;
    await act(async () => {
      await drag.commit!({ fromPath: "tasks", projection: intoArchive }).catch(
        () => undefined,
      );
      await turn();
    });
    expect(env.shown()).toBe("tasks");
    fail = false;
    await act(async () => {
      await drag.commit!({ fromPath: "tool", projection: intoArchive });
      await turn();
    });
    expect(env.shown()).toBe("tasks");
    await act(async () => {
      await drag.commit!({ fromPath: "tasks", projection: intoArchive });
      await turn();
    });
    expect(env.shown()).toBe("archive/tasks");
  } finally {
    await env.cleanup();
  }
});

test("structural operations over a Space count as finished only after the open content moved with them", async () => {
  // What the main area showed when the operations over the Space finished.
  const shownWhenSettled: (string | null)[] = [];
  const env = await environment((command, args) => {
    if (command === "move_content") {
      void useSpaceStoreRef
        .current!.getState()
        .treePathMutationsSettled(spacePath)
        .then(() => shownWhenSettled.push(env.shown()));
      return `${String(args.toParent)}/${String(args.from).split("/").pop()}`;
    }
    if (command === "rename_content") {
      void useSpaceStoreRef
        .current!.getState()
        .treePathMutationsSettled(spacePath)
        .then(() => shownWhenSettled.push(env.shown()));
      return [];
    }
    if (command === "list_tree_children") return [];
    return null;
  });
  const useSpaceStoreRef: {
    current?: typeof import("../model/space-store").useSpaceStore;
  } = {};
  useSpaceStoreRef.current = (
    await import("../model/space-store")
  ).useSpaceStore;
  const { useFileTreeDragCommand } =
    await import("./use-file-tree-drag-command");
  const tree = [folder("archive"), folder("tool")];
  const drag: { commit?: ReturnType<typeof useFileTreeDragCommand> } = {};
  function Tree() {
    const commit = useFileTreeDragCommand({ spaceId: "root", tree });
    useEffect(() => {
      drag.commit = commit;
    });
    return null;
  }
  try {
    // Nothing runs: settled at once.
    let settled = false;
    await useSpaceStoreRef.current
      .getState()
      .treePathMutationsSettled(spacePath)
      .then(() => (settled = true));
    expect(settled).toBe(true);

    env.artifact.openScopeOwner({
      kind: "app-directory",
      path: "tool",
      spaceId: "root",
    });
    await act(async () => {
      env.root.render(<Tree />);
      await turn();
    });
    await act(async () => {
      await drag.commit!({
        fromPath: "tool",
        projection: {
          depth: 1,
          overPath: "archive",
          parentPath: "archive",
          type: "after",
        },
      });
      await turn();
    });
    await renameFolder(env, "archive/tool", "toolbox");
    expect(shownWhenSettled).toEqual(["archive/tool", "archive/toolbox"]);
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
