import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";

if (process.env.SVODE_GENERAL_SPACES_FOLLOW_DOM !== "1") {
  test("Settings General follows the spaces of the project DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_GENERAL_SPACES_FOLLOW_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 60_000);
} else {
  const { mock } = bunTest as typeof bunTest & {
    mock: { module(path: string, factory: () => unknown): void };
  };
  const { createTestDom } = await import("@/shared/testing/dom");
  const dom = await createTestDom();
  const doc = dom.document;
  mock.module("@/components/ui/emoji-picker", () => ({
    EmojiPicker: ({ value }: { value: string }) => <span>{value}</span>,
  }));

  const { emit } = await import("@/platform/native/events");
  const { clearNativeMocks, mockNativeIpc } =
    await import("@/platform/native/testing");
  const { setLocale } = await import("@/paraglide/runtime");
  const { getSpaceSnapshot, useSpace } = await import("@/features/space");
  const { SpaceFileWatcher } = await import("@/features/space/app-shell");
  const { ProjectGeneralSection } = await import("./project-general-section");
  type SpaceInfo = import("@/features/space").SpaceInfo;

  const space = (id: string, name: string, path: string): SpaceInfo => ({
    id,
    name,
    icon: "",
    description: "",
    path,
    hasSpaces: false,
    hasSchema: false,
    lastOpened: null,
    status: "ready",
    lfsState: "n/a",
  });
  const project = space("project", "Project", "/project");

  // What `list_spaces` reads from the config on disk.
  let onDisk: SpaceInfo[] = [space("docs", "Docs", "/project/docs")];
  mockNativeIpc(
    (command, args) => {
      const { spacePath } = (args ?? {}) as { spacePath?: string };
      switch (command) {
        case "list_projects":
          return [project];
        case "open_project":
          return {
            kind: "opened",
            config: { name: "Project", icon: "" },
            project,
          };
        case "list_spaces":
          return onDisk;
        case "get_space_config":
          return {
            name:
              onDisk.find((item) => item.path === spacePath)?.name ?? "Project",
            description: "",
            icon: "",
          };
        case "repository_access_get":
          return {
            repositoryId: spacePath,
            generation: 1,
            status: "writable",
          };
        default:
          return command.includes("expan") || command.includes("tree")
            ? []
            : null;
      }
    },
    { shouldMockEvents: true },
  );

  function GeneralSettings() {
    const spaces = useSpace((state) => state.spaces);
    return (
      <ProjectGeneralSection
        projectPath="/project"
        projectName="Project"
        projectIcon=""
        spaces={spaces}
        gitTypes={{}}
        reveal={{ owner: null, request: {} }}
      />
    );
  }

  const settle = () =>
    act(async () => {
      for (let i = 0; i < 5; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
    });
  const ownerNames = () =>
    Array.from(doc.querySelectorAll("section[aria-labelledby]"))
      .map(
        (section) =>
          doc.getElementById(section.getAttribute("aria-labelledby") ?? "")
            ?.textContent ?? "",
      )
      .filter((name) => name !== "");

  setLocale("en", { reload: false });
  await act(async () => {
    await getSpaceSnapshot().openRoot("project");
  });
  await dom.render(
    <>
      <SpaceFileWatcher />
      <GeneralSettings />
    </>,
  );
  await settle();

  test("Settings General lists a space another process added without an action", async () => {
    expect(ownerNames().includes("Docs")).toBe(true);
    expect(ownerNames().includes("Clients")).toBe(false);

    onDisk = [
      space("docs", "Docs", "/project/docs"),
      space("clients", "Clients", "/project/clients"),
    ];
    await act(async () => {
      await emit("space:added", {
        projectPath: "/project",
        spaceId: "clients",
        spacePath: "/project/clients",
        status: "ready",
      });
    });
    await settle();
    expect(ownerNames().includes("Clients")).toBe(true);
  });

  test("Settings General drops a space another process removed", async () => {
    onDisk = [space("clients", "Clients", "/project/clients")];
    await act(async () => {
      await emit("space:removed", { projectPath: "/project", spaceId: "docs" });
    });
    await settle();
    expect(ownerNames().includes("Docs")).toBe(false);
    expect(ownerNames().includes("Clients")).toBe(true);
    clearNativeMocks();
  });
}
