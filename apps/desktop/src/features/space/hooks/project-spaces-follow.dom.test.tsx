import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";

if (process.env.SVODE_PROJECT_SPACES_FOLLOW_DOM !== "1") {
  test("sidebar follows the spaces of the project DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_PROJECT_SPACES_FOLLOW_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 60_000);
} else {
  const { mock } = bunTest;
  const { createTestDom } = await import("@/shared/testing/dom");
  const dom = await createTestDom();
  const doc = dom.document;
  Object.defineProperty(window, "matchMedia", {
    value: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
  });

  const gitSidebar = await import("@/features/git/sidebar");
  mock.module("@/features/git/sidebar", () => ({
    ...gitSidebar,
    useSpaceSidebarGit: () => ({
      cloning: undefined,
      dirty: false,
      commitAll: () => {},
      recovery: { request: null, recoverFromError: async () => false },
    }),
  }));

  const { emit } = await import("@/platform/native/events");
  const { clearNativeMocks, mockNativeIpc } =
    await import("@/platform/native/testing");
  const { DndContext } = await import("@dnd-kit/core");
  const { SidebarProvider } = await import("@/components/ui/sidebar");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { getNavigationState } = await import("@/features/navigation");
  const { useSpaceStore } = await import("../model");
  const { NavSpaces } = await import("../ui/nav-spaces");
  const { useProjectSpacesFollow } =
    await import("./use-project-spaces-follow");
  type SpaceInfo = import("../model/types").SpaceInfo;

  const space = (id: string, name: string): SpaceInfo => ({
    id,
    name,
    icon: "",
    description: "",
    path: `/project/${id}`,
    hasSpaces: false,
    hasSchema: false,
    lastOpened: null,
    status: "ready",
    lfsState: "n/a",
  });

  // What `list_spaces` reads from the config on disk.
  let onDisk: SpaceInfo[] = [space("docs", "Docs")];
  const reads: string[] = [];
  mockNativeIpc(
    (command, args) => {
      if (command === "list_spaces") {
        reads.push((args as { spacePath: string }).spacePath);
        return onDisk;
      }
      if (command === "navigation_read") return { pinned: [], kept: [] };
      if (command.includes("expan") || command === "list_tree_children")
        return [];
      return null;
    },
    { shouldMockEvents: true },
  );

  useSpaceStore.setState({
    activeRootId: "root",
    activeRootName: "Project",
    activeRootPath: "/project",
    activeSpaceId: "docs",
    spaces: onDisk,
    rootSpaces: [],
    fileTrees: { root: [] },
  });
  await act(async () => getNavigationState().setProject("/project"));

  function Follow() {
    useProjectSpacesFollow();
    return null;
  }

  const settle = () =>
    act(async () => {
      for (let i = 0; i < 5; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
    });
  const sidebarText = () =>
    doc.querySelector("[data-sidebar=menu]")?.textContent ?? "";

  await dom.render(
    <TooltipProvider>
      <SidebarProvider>
        <DndContext>
          <Follow />
          <NavSpaces
            onActivateContent={() => {}}
            onBeforeNavigation={async () => true}
          />
        </DndContext>
      </SidebarProvider>
    </TooltipProvider>,
  );
  await settle();

  test("a space another process added appears in the sidebar without an action", async () => {
    expect(sidebarText().includes("Docs")).toBe(true);
    expect(sidebarText().includes("Clients")).toBe(false);

    onDisk = [space("docs", "Docs"), space("clients", "Clients")];
    await act(async () => {
      await emit("space:added", {
        projectPath: "/project",
        spaceId: "clients",
        spacePath: "/project/clients",
        status: "ready",
      });
    });
    await settle();

    expect(sidebarText().includes("Clients")).toBe(true);
    expect(reads).toEqual(["/project"]);
  });

  test("a change of another project reads nothing", async () => {
    await act(async () => {
      await emit("space:added", {
        projectPath: "/other",
        spaceId: "x",
        spacePath: "/other/x",
        status: "ready",
      });
    });
    await settle();
    expect(reads).toEqual(["/project"]);
  });

  test("a removed space leaves the sidebar and stops being the active space", async () => {
    onDisk = [space("clients", "Clients")];
    await act(async () => {
      await emit("space:removed", { projectPath: "/project", spaceId: "docs" });
    });
    await settle();

    expect(sidebarText().includes("Docs")).toBe(false);
    expect(sidebarText().includes("Clients")).toBe(true);
    expect(useSpaceStore.getState().activeSpaceId).toBeNull();
  });

  test("a status change reads the list again", async () => {
    onDisk = [{ ...space("clients", "Clients"), status: "missing" }];
    await act(async () => {
      await emit("space:status_changed", {
        projectPath: "/project",
        spaceId: "clients",
        oldStatus: "ready",
        newStatus: "missing",
      });
    });
    await settle();
    expect(useSpaceStore.getState().spaces[0]?.status).toBe("missing");
    clearNativeMocks();
  });
}
